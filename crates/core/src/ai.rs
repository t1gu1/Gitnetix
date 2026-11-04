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
use crate::store::{AiConfig, ConnectMethod, ProviderConf, Route};

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
            methods: vec!["cli", "api"], effort: true, local: false, needs_url: false, models: vec![],
        },
        // Antigravity CLI, which replaced Gemini CLI: cli_path falls back to `gemini`.
        ProviderInfo {
            id: "gemini", name: "Gemini", mono: "GM", maker: "Google", bin: Some("agy"),
            methods: vec!["cli", "api"], effort: false, local: false, needs_url: false, models: vec![],
        },
        ProviderInfo {
            id: "copilot", name: "GitHub Copilot", mono: "CP", maker: "GitHub", bin: Some("copilot"),
            methods: vec!["cli"], effort: true, local: false, needs_url: false, models: vec![],
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
        if self.effort.is_empty() { model } else { format!("{model} · {}", self.effort) }
    }
}

pub fn resolve(cfg: &AiConfig, task: &str, template_model: Option<&str>) -> Result<Resolved> {
    resolve_route(cfg, cfg.routing.get(task).cloned().unwrap_or_default(), template_model)
}

/// Like `resolve`, with an explicit route instead of the task's routing.
pub fn resolve_route(cfg: &AiConfig, route: Route, template_model: Option<&str>) -> Result<Resolved> {
    let provider = route.provider.clone().unwrap_or_else(|| cfg.default_provider.clone());
    // A CLI found on this computer works without setup: it uses its own sign-in.
    let detected = || cli_path(&provider).ok().map(|_| ProviderConf::default());
    let conf = cfg
        .providers
        .get(&provider)
        .cloned()
        .or_else(detected)
        .ok_or_else(|| Error::NotConnected(format!("AI provider {provider} is not set up")))?;
    let model = template_model
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or(route.model.filter(|s| !s.is_empty()))
        .unwrap_or(conf.model.clone());
    let effort = route.effort.filter(|s| !s.is_empty()).unwrap_or(conf.effort.clone());
    Ok(Resolved { provider, method: conf.method, model, effort, base_url: conf.base_url })
}

/// Look a binary up on PATH, the login shell's PATH, plus the usual install dirs a GUI app's PATH
/// misses on macOS.
pub fn which(bin: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    // nvm, or the line Codex.app adds to ~/.zshrc: read once at startup, so empty until then.
    dirs.extend_from_slice(crate::project_commands::login_dirs_now());
    if let Some(home) = dirs::home_dir() {
        for d in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".cargo/bin", ".volta/bin"] {
            dirs.push(home.join(d));
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(d));
    }
    // The native Claude Code installer on Windows puts claude.exe in ~/.local/bin, npm puts a claude.cmd shim on PATH.
    let names = if cfg!(windows) { vec![format!("{bin}.exe"), format!("{bin}.cmd")] } else { vec![bin.to_string()] };
    first_file(&dirs, &names)
}

/// The first of `names` found in any of `dirs`: a later dir's .exe wins over an earlier dir's .cmd.
fn first_file(dirs: &[PathBuf], names: &[String]) -> Option<PathBuf> {
    names.iter().find_map(|n| dirs.iter().map(|d| d.join(n)).find(|p| p.is_file()))
}

/// The newest copy of Claude Code that Claude Desktop downloads for its Code tab, in a `claude-code/<version>/` folder.
// shortcut: undocumented layout, seen in Windows Desktop 4.4212 (Store build); check a Mac install if Mac users can't find it.
fn desktop_claude() -> Option<PathBuf> {
    let mut roots = vec![dirs::config_dir()?.join("Claude").join("claude-code")];
    // The Store (MSIX) build keeps it in %LOCALAPPDATA%\Claude-Data\claude_<package id>\claude-code.
    if let Some(local) = dirs::data_local_dir() {
        roots.extend(std::fs::read_dir(local.join("Claude-Data")).into_iter().flatten().flatten().map(|e| e.path().join("claude-code")));
    }
    newest_version(&roots, if cfg!(windows) { "claude.exe" } else { "claude" })
}

/// `file` in the highest `<root>/<version>/` folder, or a few folders below it:
/// `<version>/<hash>/claude.exe` on Windows, `claude.app/Contents/MacOS/claude` in a Mac app bundle.
fn newest_version(roots: &[PathBuf], file: &str) -> Option<PathBuf> {
    let version = |e: &std::fs::DirEntry| -> Vec<u64> { e.file_name().to_string_lossy().split('.').map(|n| n.parse().unwrap_or(0)).collect() };
    roots
        .iter()
        .flat_map(|r| std::fs::read_dir(r).into_iter().flatten().flatten())
        .filter_map(|e| Some((version(&e), find_file(&e.path(), file, 4)?)))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, p)| p)
}

/// `name` in `dir` or up to `depth` folders below it.
fn find_file(dir: &Path, name: &str, depth: u8) -> Option<PathBuf> {
    let here = dir.join(name);
    if here.is_file() {
        return Some(here);
    }
    if depth == 0 {
        return None;
    }
    // file_type() does not follow symlinks, so a link loop can't recurse forever.
    std::fs::read_dir(dir).ok()?.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).find_map(|e| find_file(&e.path(), name, depth - 1))
}

/// `bin` in a Mac app's Resources folder, where the ChatGPT (Codex until July 2026) and Ollama apps keep their CLI.
// shortcut: paths from 2026 reports, not checked on a Mac; look inside the bundles if Mac users can't find them.
fn mac_app(app: &str, bin: &str) -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let rel = format!("Applications/{app}.app/Contents/Resources/{bin}");
    std::iter::once(PathBuf::from("/")).chain(dirs::home_dir()).map(|d| d.join(&rel)).find(|p| p.is_file())
}

/// codex.exe in the ChatGPT app from the Microsoft Store (package OpenAI.Codex, seen at 26.1029).
/// Its folder name holds the version and a limited user can't list WindowsApps, so the folder comes from the registry.
#[cfg(windows)]
fn store_codex() -> Option<PathBuf> {
    let packages = windows_registry::CURRENT_USER
        .open(r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages")
        .ok()?;
    // A local: as the tail expression, the key iterator would outlive `packages`.
    let found = packages
        .keys()
        .ok()?
        .filter(|k| k.starts_with("OpenAI.Codex_"))
        .filter_map(|k| packages.open(&k).ok()?.get_string("PackageRootFolder").ok())
        .map(|root| PathBuf::from(root).join(r"app\resources\codex.exe"))
        .find(|p| p.is_file());
    found
}

#[cfg(not(windows))]
fn store_codex() -> Option<PathBuf> {
    None
}

/// Where `gh copilot` downloads the Copilot CLI when `copilot` isn't on PATH: `copilot` in gh's data dir.
fn gh_copilot() -> Option<PathBuf> {
    let data = match std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        Some(x) => PathBuf::from(x).join("gh"),
        None if cfg!(windows) => dirs::data_local_dir()?.join("GitHub CLI"),
        None => dirs::home_dir()?.join(".local").join("share").join("gh"),
    };
    Some(data.join("copilot").join(if cfg!(windows) { "copilot.exe" } else { "copilot" })).filter(|p| p.is_file())
}

/// Run a one-shot completion.
pub async fn complete(r: &Resolved, prompt: &str, cwd: Option<&Path>) -> Result<String> {
    let text = match r.method {
        ConnectMethod::Cli => complete_cli(r, prompt, cwd).await?,
        ConnectMethod::Api => complete_api(r, prompt).await?,
    };
    Ok(clean(&text))
}

/// The provider's CLI binary name and its location: on PATH, or the copy a desktop app or `gh copilot` keeps off it.
pub fn cli_path(provider: &str) -> Result<(&'static str, PathBuf)> {
    let info = provider_info(provider)?;
    let bin = info.bin.ok_or_else(|| Error::Unsupported(format!("{} has no CLI", info.name)))?;
    let found = which(bin).or_else(|| match bin {
        "claude" => desktop_claude(),
        "codex" => mac_app("ChatGPT", bin).or_else(|| mac_app("Codex", bin)).or_else(store_codex),
        "ollama" => mac_app("Ollama", bin),
        "copilot" => gh_copilot(),
        _ => None,
    });
    if let Some(path) = found {
        return Ok((bin, path));
    }
    // Gemini CLI stopped serving individual Google accounts on 2026-06-18; paid API keys still work with it.
    if let Some(path) = (bin == "agy").then(|| which("gemini")).flatten() {
        return Ok(("gemini", path));
    }
    Err(Error::NotConnected(format!("`{bin}` not found on your PATH")))
}

async fn complete_cli(r: &Resolved, prompt: &str, cwd: Option<&Path>) -> Result<String> {
    let (bin, path) = cli_path(&r.provider)?;
    let mut cmd = Command::new(path);
    crate::shell::without_appimage(cmd.as_std_mut());
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
            if !r.effort.is_empty() {
                cmd.args(["--effort", &r.effort]);
            }
            // No working dir = text in, text out: without tools, MCP, skills, hooks and Claude Code's own prompt, each call starts ~0.9 s sooner and sends ~30k fewer tokens.
            if cwd.is_none() {
                cmd.args(["--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--settings", r#"{"disableAllHooks":true}"#]);
                cmd.args(["--system-prompt", "Follow the user's instructions exactly."]);
            }
            true
        }
        "codex" => {
            cmd.args(["exec", "--skip-git-repo-check"]);
            if !r.model.is_empty() {
                cmd.args(["-m", &r.model]);
            }
            if !r.effort.is_empty() {
                cmd.args(["-c", &format!("model_reasoning_effort={}", r.effort)]);
            }
            cmd.arg("-");
            true
        }
        "ollama" => {
            let model = if r.model.is_empty() { "llama3.2" } else { r.model.as_str() };
            cmd.args(["run", model]);
            true
        }
        "gemini" if bin == "agy" => {
            if !r.model.is_empty() {
                cmd.args(["--model", &r.model]);
            }
            cmd.args(["--disable-slash-commands", "-p", prompt]);
            false
        }
        "gemini" => {
            if !r.model.is_empty() {
                cmd.args(["-m", &r.model]);
            }
            cmd.args(["-p", prompt]);
            false
        }
        "copilot" => {
            if !r.model.is_empty() {
                cmd.args(["--model", &r.model]);
            }
            if !r.effort.is_empty() {
                cmd.args(["--reasoning-effort", &r.effort]);
            }
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

/// Model calls can run for minutes.
fn http(method: reqwest::Method, url: impl reqwest::IntoUrl) -> reqwest::RequestBuilder {
    crate::net::client().request(method, url).timeout(Duration::from_secs(600))
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
    let mut req = http(reqwest::Method::POST, "https://api.anthropic.com/v1/messages")
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
    let mut body = json!({ "model": r.model, "messages": [{ "role": "user", "content": prompt }] });
    // Only for providers with an effort setting: routing keeps the old effort when a task moves to another provider.
    if !r.effort.is_empty() && provider_info(&r.provider).is_ok_and(|p| p.effort) {
        body["reasoning_effort"] = json!(r.effort);
    }
    let res = http(reqwest::Method::POST, format!("{base}/chat/completions"))
        .bearer_auth(key)
        .json(&body)
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
    provider_info(id)?;
    let conf = cfg.providers.get(id);
    let cli_path = cli_path(id).ok().map(|(_, p)| p.to_string_lossy().to_string());
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
    fn exe_beats_cmd_shim() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        std::fs::write(a.path().join("claude.cmd"), "").unwrap();
        std::fs::write(b.path().join("claude.exe"), "").unwrap();
        let dirs = [a.path().to_path_buf(), b.path().to_path_buf()];
        let names = ["claude.exe".to_string(), "claude.cmd".to_string()];
        assert_eq!(first_file(&dirs, &names), Some(b.path().join("claude.exe")));
        std::fs::remove_file(b.path().join("claude.exe")).unwrap();
        assert_eq!(first_file(&dirs, &names), Some(a.path().join("claude.cmd")));
    }

    #[test]
    fn picks_newest_desktop_copy() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let put = |p: PathBuf| {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "").unwrap();
            p
        };
        put(a.path().join("2.1.99").join("claude"));
        std::fs::create_dir(a.path().join("2.2.0-empty")).unwrap();
        // Windows Store Desktop: <version>/<hash>/claude.exe. Mac Desktop: claude.app/Contents/MacOS/claude.
        let hashed = put(b.path().join("2.1.309").join("9078b9c1d466").join("claude"));
        let roots = [a.path().to_path_buf(), b.path().to_path_buf(), a.path().join("missing")];
        assert_eq!(newest_version(&roots, "claude"), Some(hashed));
        let bundle = put(a.path().join("2.1.310").join("claude.app").join("Contents").join("MacOS").join("claude"));
        assert_eq!(newest_version(&roots, "claude"), Some(bundle));
        assert_eq!(newest_version(&roots[2..], "claude"), None);
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
