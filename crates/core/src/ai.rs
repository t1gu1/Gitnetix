//! AI providers. Each one is reached either through its local CLI (uses the
//! CLI's own sign-in, no key stored here) or its HTTP API with a key kept in
//! the OS keychain. Tasks are routed to a provider/model/effort in settings.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::error::{Error, Result};
use crate::secrets;
use crate::store::{AiConfig, ConnectMethod};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub mono: &'static str,
    pub maker: &'static str,
    pub bin: Option<&'static str>,
    pub methods: Vec<&'static str>,
    pub effort: bool,
    pub local: bool,
    pub needs_url: bool,
    /// Suggested models; providers without a fixed list take a free model id.
    pub models: Vec<ModelInfo>,
}

fn m(id: &str, label: &str) -> ModelInfo {
    ModelInfo { id: id.into(), label: label.into() }
}

pub fn catalog() -> Vec<ProviderInfo> {
    vec![
        ProviderInfo {
            id: "claude", name: "Claude", mono: "CL", maker: "Anthropic", bin: Some("claude"),
            methods: vec!["cli", "api"], effort: true, local: false, needs_url: false,
            models: vec![
                m("claude-opus-5-5", "Claude Opus 5.5"),
                m("claude-sonnet-5-5", "Claude Sonnet 5.5"),
                m("claude-haiku-5-5", "Claude Haiku 5.5"),
                m("claude-fable-5-1", "Claude Fable 5.1"),
            ],
        },
        ProviderInfo {
            id: "codex", name: "Codex", mono: "CX", maker: "OpenAI", bin: Some("codex"),
            methods: vec!["cli", "api"], effort: false, local: false, needs_url: false, models: vec![],
        },
        ProviderInfo {
            id: "gemini", name: "Gemini", mono: "GM", maker: "Google", bin: Some("gemini"),
            methods: vec!["cli", "api"], effort: false, local: false, needs_url: false, models: vec![],
        },
        ProviderInfo {
            id: "copilot", name: "GitHub Copilot", mono: "CP", maker: "GitHub", bin: Some("copilot"),
            methods: vec!["cli"], effort: false, local: false, needs_url: false, models: vec![],
        },
        ProviderInfo {
            id: "mistral", name: "Mistral", mono: "MI", maker: "Mistral AI", bin: None,
            methods: vec!["api"], effort: false, local: false, needs_url: false, models: vec![],
        },
        ProviderInfo {
            id: "ollama", name: "Ollama", mono: "OL", maker: "Local models", bin: Some("ollama"),
            methods: vec!["cli"], effort: false, local: true, needs_url: false, models: vec![],
        },
        ProviderInfo {
            id: "other", name: "Other", mono: "++", maker: "Any OpenAI-compatible endpoint", bin: None,
            methods: vec!["api"], effort: false, local: false, needs_url: true, models: vec![],
        },
    ]
}

pub fn provider_info(id: &str) -> Result<ProviderInfo> {
    catalog().into_iter().find(|p| p.id == id).ok_or_else(|| Error::NotFound(format!("AI provider {id}")))
}

/// What a task actually runs on after routing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub provider: String,
    pub method: ConnectMethod,
    pub model: String,
    pub effort: String,
    pub base_url: Option<String>,
}

impl Resolved {
    pub fn label(&self) -> String {
        let model = provider_info(&self.provider)
            .ok()
            .and_then(|p| p.models.into_iter().find(|m| m.id == self.model).map(|m| m.label))
            .unwrap_or_else(|| if self.model.is_empty() { "default model".into() } else { self.model.clone() });
        format!("{model} · {}", self.effort)
    }
}

pub fn resolve(cfg: &AiConfig, task: &str, template_model: Option<&str>) -> Result<Resolved> {
    let route = cfg.routing.get(task).cloned().unwrap_or_default();
    let provider = route.provider.clone().unwrap_or_else(|| cfg.default_provider.clone());
    let conf = cfg
        .providers
        .get(&provider)
        .cloned()
        .ok_or_else(|| Error::NotConnected(format!("AI provider {provider} is not set up")))?;
    let model = template_model
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or(route.model.filter(|s| !s.is_empty()))
        .unwrap_or(conf.model.clone());
    let effort = route.effort.filter(|s| !s.is_empty()).unwrap_or(conf.effort.clone());
    Ok(Resolved { provider, method: conf.method, model, effort, base_url: conf.base_url })
}

/// Look a binary up on PATH, plus the usual install dirs a GUI app's PATH
/// misses on macOS.
pub fn which(bin: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        for d in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".cargo/bin", ".volta/bin"] {
            dirs.push(home.join(d));
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(d));
    }
    dirs.into_iter().map(|d| d.join(bin)).find(|p| p.is_file())
}

/// Run a one-shot completion.
pub async fn complete(r: &Resolved, prompt: &str, cwd: Option<&Path>) -> Result<String> {
    let text = match r.method {
        ConnectMethod::Cli => complete_cli(r, prompt, cwd).await?,
        ConnectMethod::Api => complete_api(r, prompt).await?,
    };
    Ok(clean(&text))
}

async fn complete_cli(r: &Resolved, prompt: &str, cwd: Option<&Path>) -> Result<String> {
    let info = provider_info(&r.provider)?;
    let bin = info.bin.ok_or_else(|| Error::Unsupported(format!("{} has no CLI", info.name)))?;
    let path = which(bin).ok_or_else(|| Error::NotConnected(format!("`{bin}` not found on your PATH")))?;
    let mut cmd = Command::new(path);
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    // Prompt goes through stdin when the CLI supports it: diffs can be large.
    let via_stdin = match r.provider.as_str() {
        "claude" => {
            cmd.args(["-p", "--output-format", "text"]);
            if !r.model.is_empty() {
                cmd.args(["--model", &r.model]);
            }
            true
        }
        "codex" => {
            cmd.args(["exec", "--skip-git-repo-check"]);
            if !r.model.is_empty() {
                cmd.args(["-m", &r.model]);
            }
            cmd.arg("-");
            true
        }
        "ollama" => {
            let model = if r.model.is_empty() { "llama3.2" } else { r.model.as_str() };
            cmd.args(["run", model]);
            true
        }
        "gemini" => {
            if !r.model.is_empty() {
                cmd.args(["-m", &r.model]);
            }
            cmd.args(["-p", prompt]);
            false
        }
        "copilot" => {
            cmd.args(["-p", prompt]);
            false
        }
        other => return Err(Error::Unsupported(format!("CLI for {other}"))),
    };
    cmd.stdin(if via_stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn()?;
    if via_stdin {
        let mut stdin = child.stdin.take().expect("piped stdin");
        stdin.write_all(prompt.as_bytes()).await?;
        drop(stdin);
    }
    let out = tokio::time::timeout(Duration::from_secs(600), child.wait_with_output())
        .await
        .map_err(|_| Error::Ai(format!("{bin} timed out after 10 minutes")))??;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = if err.trim().is_empty() { String::from_utf8_lossy(&out.stdout).to_string() } else { err.to_string() };
        return Err(Error::Ai(format!("{bin}: {}", msg.trim())));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .user_agent(concat!("Gitnetix/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

async fn complete_api(r: &Resolved, prompt: &str) -> Result<String> {
    let key = secrets::require(&secrets::ai_key(&r.provider), &format!("No API key saved for {}", r.provider))?;
    match r.provider.as_str() {
        "claude" => anthropic(&key, r, prompt).await,
        "codex" => openai_compat("https://api.openai.com/v1", &key, r, prompt).await,
        "gemini" => openai_compat("https://generativelanguage.googleapis.com/v1beta/openai", &key, r, prompt).await,
        "mistral" => openai_compat("https://api.mistral.ai/v1", &key, r, prompt).await,
        "other" => {
            let base = r.base_url.clone().filter(|s| !s.is_empty()).ok_or_else(|| Error::Invalid("Base URL is required".into()))?;
            openai_compat(base.trim_end_matches('/'), &key, r, prompt).await
        }
        other => Err(Error::Unsupported(format!("API for {other}"))),
    }
}

/// Claude Messages API over raw HTTP (no official Rust SDK).
async fn anthropic(key: &str, r: &Resolved, prompt: &str) -> Result<String> {
    let model = if r.model.is_empty() { "claude-opus-5-5" } else { r.model.as_str() };
    let mut body = json!({
        "model": model,
        "max_tokens": 16000,
        "messages": [{ "role": "user", "content": prompt }],
    });
    if !r.effort.is_empty() {
        body["output_config"] = json!({ "effort": r.effort });
    }
    let mut req = http()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");
    // Server-side fallback when a safety classifier declines the request.
    if matches!(model, "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-fable-5-1") {
        body["fallbacks"] = json!("default");
        req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
    }
    let res = req.json(&body).send().await?;
    let status = res.status();
    let v: Value = res.json().await?;
    if !status.is_success() {
        let msg = v["error"]["message"].as_str().unwrap_or("request failed");
        return Err(Error::Ai(format!("Claude API {status}: {msg}")));
    }
    if v["stop_reason"] == "refusal" {
        let why = v["stop_details"]["explanation"].as_str().unwrap_or("declined");
        return Err(Error::Ai(format!("Claude declined the request: {why}")));
    }
    let text: String = v["content"]
        .as_array()
        .map(|blocks| blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(""))
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(Error::Ai("Claude returned no text".into()));
    }
    Ok(text)
}

async fn openai_compat(base: &str, key: &str, r: &Resolved, prompt: &str) -> Result<String> {
    if r.model.is_empty() {
        return Err(Error::Invalid("Pick a model id for this provider in AI setup".into()));
    }
    let res = http()
        .post(format!("{base}/chat/completions"))
        .bearer_auth(key)
        .json(&json!({ "model": r.model, "messages": [{ "role": "user", "content": prompt }] }))
        .send()
        .await?;
    let status = res.status();
    let v: Value = res.json().await?;
    if !status.is_success() {
        let msg = v["error"]["message"].as_str().map(String::from).unwrap_or_else(|| v.to_string());
        return Err(Error::Ai(format!("{} API {status}: {msg}", r.provider)));
    }
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| Error::Ai("empty completion".into()))
}

/// Strip wrapping code fences and surrounding whitespace models sometimes add.
pub fn clean(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let rest = rest.split_once('\n').map(|(_, b)| b).unwrap_or("");
        if let Some(inner) = rest.strip_suffix("```") {
            return inner.trim().to_string();
        }
    }
    t.to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    /// connected | detected | none
    pub status: String,
    pub cli_path: Option<String>,
    pub has_key: bool,
}

pub fn status(cfg: &AiConfig, id: &str) -> Result<ProviderStatus> {
    let info = provider_info(id)?;
    let conf = cfg.providers.get(id);
    let cli_path = info.bin.and_then(which).map(|p| p.to_string_lossy().to_string());
    let has_key = secrets::get(&secrets::ai_key(id)).ok().flatten().is_some_and(|k| !k.is_empty());
    let status = match conf {
        Some(c) if c.connected => "connected",
        Some(c) if c.method == ConnectMethod::Api && has_key => "connected",
        _ if cli_path.is_some() => "detected",
        _ => "none",
    };
    Ok(ProviderStatus { id: id.into(), status: status.into(), cli_path, has_key })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_fences() {
        assert_eq!(clean("```text\nfeat: x\n```"), "feat: x");
        assert_eq!(clean("  feat: y \n"), "feat: y");
    }

    #[test]
    fn routes_tasks() {
        let cfg = AiConfig::default();
        let r = resolve(&cfg, "commit", None).unwrap();
        assert_eq!(r.model, "claude-haiku-5-5");
        let r = resolve(&cfg, "commit", Some("claude-opus-5-5")).unwrap();
        assert_eq!(r.model, "claude-opus-5-5");
    }
}
