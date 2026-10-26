//! Long-running AI agent sessions (Claude Code CLI and friends), one per
//! branch or worktree. They keep running when the UI switches project.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, oneshot};

use crate::ai::{self, Resolved};
use crate::error::{Error, Result};
use crate::events::Event;
use crate::store::{now, ConnectMethod};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Running,
    Waiting,
    Paused,
    Failed,
    Done,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    /// cmd | ai | ok | dim | err | wait | run
    pub kind: String,
    pub text: String,
}

impl LogLine {
    pub fn new(kind: &str, text: impl Into<String>) -> Self {
        LogLine { kind: kind.into(), text: text.into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub project_id: String,
    pub branch: String,
    pub cwd: String,
    pub worktree: bool,
    pub status: AgentStatus,
    pub request: String,
    pub agent_label: String,
    pub lines: Vec<LogLine>,
    pub started_at: String,
    pub updated_at: String,
    /// Claude Code session id, used to resume the conversation.
    pub resume_id: Option<String>,
    /// What the session was started on; follow-ups reuse it.
    #[serde(default)]
    pub ai: Option<Resolved>,
    #[serde(skip)]
    pub pid: Option<u32>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, AgentSession>,
    kills: HashMap<String, oneshot::Sender<()>>,
}

#[derive(Clone)]
pub struct AgentManager {
    inner: Arc<Mutex<Inner>>,
    events: broadcast::Sender<Event>,
    file: PathBuf,
    /// Serializes writes to `file` so concurrent persists cannot interleave.
    write_lock: Arc<Mutex<()>>,
}

const MAX_LINES: usize = 2000;

fn agent_label(r: &Resolved) -> Result<String> {
    Ok(format!("{} CLI · {}", ai::provider_info(&r.provider)?.name, r.label()))
}

pub struct StartArgs {
    pub project_id: String,
    pub branch: String,
    pub cwd: PathBuf,
    pub worktree: bool,
    /// What the user asked, shown in the list.
    pub request: String,
    /// Full prompt sent to the agent (template applied).
    pub prompt: String,
    pub ai: Resolved,
    /// Shown under the request line, e.g. what was added to the context.
    pub notes: Vec<LogLine>,
}

impl AgentManager {
    pub fn new(events: broadcast::Sender<Event>, dir: &std::path::Path) -> Self {
        let file = dir.join("agents.json");
        let mut sessions: HashMap<String, AgentSession> = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<AgentSession>>(&s).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|s| (s.id.clone(), s))
            .collect();
        // Processes do not survive an app restart.
        for s in sessions.values_mut() {
            if matches!(s.status, AgentStatus::Running | AgentStatus::Paused) {
                s.status = AgentStatus::Stopped;
                s.lines.push(LogLine::new("dim", "  ■ Stopped when Gitnetix quit"));
            }
        }
        AgentManager { inner: Arc::new(Mutex::new(Inner { sessions, kills: HashMap::new() })), events, file, write_lock: Arc::default() }
    }

    pub fn list(&self) -> Vec<AgentSession> {
        let g = self.inner.lock().unwrap();
        // A worktree removed outside Gitnetix takes its session with it.
        let mut v: Vec<AgentSession> = g.sessions.values().filter(|s| !s.worktree || std::path::Path::new(&s.cwd).exists()).cloned().collect();
        v.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        v
    }

    pub fn get(&self, id: &str) -> Result<AgentSession> {
        self.inner.lock().unwrap().sessions.get(id).cloned().ok_or_else(|| Error::NotFound(format!("agent session {id}")))
    }

    fn persist(&self) {
        // Snapshot under the session lock, serialize and write outside it so
        // log readers are not blocked. Order does not matter on disk: `new`
        // loads sessions into a map.
        let snapshot: Vec<AgentSession> = self.inner.lock().unwrap().sessions.values().cloned().collect();
        let Ok(json) = serde_json::to_string(&snapshot) else { return };
        // Write to a temp file and rename so a reader never sees a torn file.
        let _guard = self.write_lock.lock().unwrap();
        let tmp = self.file.with_extension("json.tmp");
        if crate::store::write_private(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &self.file);
        }
    }

    fn push(&self, id: &str, line: LogLine) {
        {
            let mut g = self.inner.lock().unwrap();
            if let Some(s) = g.sessions.get_mut(id) {
                s.lines.push(line.clone());
                if s.lines.len() > MAX_LINES {
                    let cut = s.lines.len() - MAX_LINES;
                    s.lines.drain(..cut);
                }
                s.updated_at = now();
            }
        }
        let _ = self.events.send(Event::AgentLine { session_id: id.into(), line });
    }

    fn set_status(&self, id: &str, status: AgentStatus) {
        {
            let mut g = self.inner.lock().unwrap();
            if let Some(s) = g.sessions.get_mut(id) {
                s.status = status;
                s.updated_at = now();
                if status != AgentStatus::Running && status != AgentStatus::Paused {
                    s.pid = None;
                }
            }
        }
        let _ = self.events.send(Event::AgentStatus { session_id: id.into(), status });
        self.persist();
    }

    pub fn start(&self, args: StartArgs) -> Result<AgentSession> {
        if args.ai.method != ConnectMethod::Cli {
            return Err(Error::Unsupported(
                "Agents run through a local CLI (Claude Code, Codex, Gemini…). Route “Free-form agent” to a CLI provider in AI setup.".into(),
            ));
        }
        let id = crate::store::new_id();
        let session = AgentSession {
            id: id.clone(),
            project_id: args.project_id,
            branch: args.branch,
            cwd: args.cwd.to_string_lossy().into(),
            worktree: args.worktree,
            status: AgentStatus::Running,
            request: args.request.clone(),
            agent_label: agent_label(&args.ai)?,
            lines: std::iter::once(LogLine::new("cmd", format!("$ {} · {}", args.ai.provider, args.request))).chain(args.notes).collect(),
            started_at: now(),
            updated_at: now(),
            resume_id: None,
            ai: Some(args.ai.clone()),
            pid: None,
        };
        self.inner.lock().unwrap().sessions.insert(id.clone(), session.clone());
        self.spawn_or_fail(&id, &args.cwd, &args.ai, &args.prompt, None)?;
        Ok(session)
    }

    /// Change what the next follow-up runs on. A new provider cannot resume
    /// the old conversation, so it starts a fresh one in the same directory.
    pub fn set_ai(&self, id: &str, r: Resolved) -> Result<AgentSession> {
        if r.method != ConnectMethod::Cli {
            return Err(Error::Unsupported(format!("{} is not set up as a local CLI, so it cannot run agents.", r.provider)));
        }
        let label = agent_label(&r)?;
        let name = ai::provider_info(&r.provider)?.name;
        let switched = {
            let mut g = self.inner.lock().unwrap();
            let s = g.sessions.get_mut(id).ok_or_else(|| Error::NotFound(format!("agent session {id}")))?;
            let switched = s.ai.as_ref().is_some_and(|old| old.provider != r.provider);
            // A running Claude turn would store its resume id after the switch.
            if switched && matches!(s.status, AgentStatus::Running | AgentStatus::Paused) {
                return Err(Error::Invalid("Wait for the agent to finish or stop it before switching provider.".into()));
            }
            if switched {
                s.resume_id = None;
            }
            s.agent_label = label;
            s.ai = Some(r);
            switched
        };
        if switched {
            self.push(id, LogLine::new("dim", format!("  ↻ Switched to {name} · starts without the earlier conversation")));
        }
        self.persist();
        self.get(id)
    }

    /// Send a follow-up message. Claude Code resumes the same conversation;
    /// other CLIs get a fresh run in the same directory.
    pub fn message(&self, id: &str, text: &str, ai: &Resolved) -> Result<()> {
        let s = self.get(id)?;
        if s.status == AgentStatus::Running || s.status == AgentStatus::Paused {
            return Err(Error::Invalid("The agent is still working. Wait for it or stop it first.".into()));
        }
        if !std::path::Path::new(&s.cwd).exists() {
            return Err(Error::Invalid(format!("{} no longer exists. Start a new session.", s.cwd)));
        }
        self.push(id, LogLine::new("cmd", format!("› {text}")));
        self.set_status(id, AgentStatus::Running);
        self.spawn_or_fail(id, &PathBuf::from(&s.cwd), ai, text, s.resume_id.as_deref())
    }

    /// Like `spawn`, but a session that never got a process is marked failed
    /// instead of being left `Running`.
    fn spawn_or_fail(&self, id: &str, cwd: &std::path::Path, r: &Resolved, prompt: &str, resume: Option<&str>) -> Result<()> {
        let res = self.spawn(id, cwd, r, prompt, resume);
        if let Err(e) = &res {
            self.push(id, LogLine::new("err", format!("✕ Could not start the agent: {e}")));
            self.set_status(id, AgentStatus::Failed);
        }
        res
    }

    pub fn stop(&self, id: &str) -> Result<()> {
        let kill = self.inner.lock().unwrap().kills.remove(id);
        if let Some(k) = kill {
            let _ = k.send(());
        }
        self.push(id, LogLine::new("dim", "  ■ Agent stopped"));
        self.set_status(id, AgentStatus::Stopped);
        Ok(())
    }

    pub fn pause(&self, id: &str) -> Result<()> {
        self.signal(id, "-STOP")?;
        self.push(id, LogLine::new("dim", "  ⏸ Paused by you"));
        self.set_status(id, AgentStatus::Paused);
        Ok(())
    }

    pub fn resume(&self, id: &str) -> Result<()> {
        self.signal(id, "-CONT")?;
        self.push(id, LogLine::new("dim", "  ▶ Resumed"));
        self.set_status(id, AgentStatus::Running);
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let _ = self.stop(id);
        self.inner.lock().unwrap().sessions.remove(id);
        self.persist();
        Ok(())
    }

    fn signal(&self, id: &str, sig: &str) -> Result<()> {
        let pid = self.get(id)?.pid.ok_or_else(|| Error::Invalid("No running process".into()))?;
        if cfg!(windows) {
            return Err(Error::Unsupported("pause/resume on Windows".into()));
        }
        std::process::Command::new("kill").args([sig, &pid.to_string()]).status()?;
        Ok(())
    }

    fn spawn(&self, id: &str, cwd: &std::path::Path, r: &Resolved, prompt: &str, resume: Option<&str>) -> Result<()> {
        let (_, path) = ai::cli_path(&r.provider)?;
        let mut cmd = Command::new(path);
        crate::shell::without_appimage(cmd.as_std_mut());
        cmd.current_dir(cwd);
        let structured = r.provider == "claude";
        let mut stdin_prompt = true;
        match r.provider.as_str() {
            "claude" => {
                cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"]);
                if !r.model.is_empty() {
                    cmd.args(["--model", &r.model]);
                }
                if !r.effort.is_empty() {
                    cmd.args(["--effort", &r.effort]);
                }
                if let Some(rid) = resume {
                    cmd.args(["--resume", rid]);
                }
            }
            "codex" => {
                cmd.args(["exec", "--dangerously-bypass-approvals-and-sandbox"]);
                if !r.model.is_empty() {
                    cmd.args(["-m", &r.model]);
                }
                if !r.effort.is_empty() {
                    cmd.args(["-c", &format!("model_reasoning_effort={}", r.effort)]);
                }
                cmd.arg("-");
            }
            "gemini" => {
                if !r.model.is_empty() {
                    cmd.args(["-m", &r.model]);
                }
                cmd.args(["--yolo", "-p", prompt]);
                stdin_prompt = false;
            }
            "copilot" => {
                if !r.model.is_empty() {
                    cmd.args(["--model", &r.model]);
                }
                if !r.effort.is_empty() {
                    cmd.args(["--reasoning-effort", &r.effort]);
                }
                cmd.args(["--allow-all-tools", "-p", prompt]);
                stdin_prompt = false;
            }
            "ollama" => {
                let model = if r.model.is_empty() { "llama3.2" } else { r.model.as_str() };
                cmd.args(["run", model]);
            }
            other => return Err(Error::Unsupported(format!("agent CLI {other}"))),
        }
        cmd.stdin(if stdin_prompt { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn()?;
        if let Some(pid) = child.id() {
            if let Some(s) = self.inner.lock().unwrap().sessions.get_mut(id) {
                s.pid = Some(pid);
            }
        }
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
        self.inner.lock().unwrap().kills.insert(id.to_string(), kill_tx);

        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        let me = self.clone();
        let sid = id.to_string();
        let prompt = prompt.to_string();
        tokio::spawn(async move {
            if let Some(mut w) = stdin {
                let _ = w.write_all(prompt.as_bytes()).await;
                drop(w);
            }
            let out_me = me.clone();
            let out_id = sid.clone();
            let out_task = tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                let mut outcome = None;
                while let Ok(Some(l)) = lines.next_line().await {
                    if structured {
                        if let Some(o) = out_me.handle_stream_json(&out_id, &l) {
                            outcome = Some(o);
                        }
                    } else if !l.trim().is_empty() {
                        out_me.push(&out_id, LogLine::new("ai", l));
                    }
                }
                outcome
            });
            let err_me = me.clone();
            let err_id = sid.clone();
            let err_task = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    if !l.trim().is_empty() {
                        err_me.push(&err_id, LogLine::new("dim", format!("  {l}")));
                    }
                }
            });
            let exit = tokio::select! {
                s = child.wait() => Some(s),
                _ = &mut kill_rx => { let _ = child.kill().await; None }
            };
            let outcome = out_task.await.ok().flatten();
            let _ = err_task.await;
            // Stopped by user: `stop` took the kill handle; one here now belongs to a newer run.
            let Some(exit) = exit else { return };
            me.inner.lock().unwrap().kills.remove(&sid);
            let ok = exit.map(|s| s.success()).unwrap_or(false);
            match (ok, outcome) {
                (_, Some(false)) | (false, None) => {
                    me.push(&sid, LogLine::new("err", "✕ Agent run failed"));
                    me.set_status(&sid, AgentStatus::Failed);
                }
                _ => {
                    me.push(&sid, LogLine::new("wait", "◆ Waiting for your review"));
                    me.set_status(&sid, AgentStatus::Waiting);
                }
            }
        });
        Ok(())
    }

    /// Turn one Claude Code `stream-json` event into log lines.
    /// Returns Some(success) on the final `result` event.
    fn handle_stream_json(&self, id: &str, raw: &str) -> Option<bool> {
        let Ok(v) = serde_json::from_str::<Value>(raw) else {
            if !raw.trim().is_empty() {
                self.push(id, LogLine::new("dim", format!("  {raw}")));
            }
            return None;
        };
        match v["type"].as_str() {
            Some("system") if v["subtype"] == "init" => {
                if let Some(sid) = v["session_id"].as_str() {
                    if let Some(s) = self.inner.lock().unwrap().sessions.get_mut(id) {
                        s.resume_id = Some(sid.to_string());
                    }
                }
                None
            }
            Some("assistant") => {
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") => {
                            // One line per reply, blank lines kept, so the UI can render it as Markdown.
                            let text = block["text"].as_str().unwrap_or("").trim();
                            if !text.is_empty() {
                                self.push(id, LogLine::new("ai", format!("✦ {text}")));
                            }
                        }
                        Some("tool_use") => {
                            let name = block["name"].as_str().unwrap_or("tool");
                            let input = &block["input"];
                            let detail = input["command"]
                                .as_str()
                                .or(input["file_path"].as_str())
                                .or(input["pattern"].as_str())
                                .or(input["path"].as_str())
                                .unwrap_or("");
                            let kind = if name == "Bash" { "run" } else { "dim" };
                            self.push(id, LogLine::new(kind, format!("  {name} {detail}")));
                        }
                        _ => {}
                    }
                }
                None
            }
            Some("user") => {
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    if block["type"] == "tool_result" && block["is_error"] == true {
                        let msg = match &block["content"] {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        };
                        let first = msg.lines().next().unwrap_or("").chars().take(200).collect::<String>();
                        self.push(id, LogLine::new("err", format!("✕ {first}")));
                    }
                }
                None
            }
            Some("result") => {
                let ok = v["is_error"] != true && v["subtype"] == "success";
                let cost = v["total_cost_usd"].as_f64().map(|c| format!(" · ${c:.2}")).unwrap_or_default();
                let turns = v["num_turns"].as_u64().map(|n| format!("{n} turns")).unwrap_or_default();
                if ok {
                    self.push(id, LogLine::new("ok", format!("✓ Finished · {turns}{cost}")));
                } else {
                    let why = v["result"].as_str().unwrap_or("error");
                    self.push(id, LogLine::new("err", format!("✕ {why}")));
                }
                Some(ok)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cli(provider: &str) -> Resolved {
        Resolved { provider: provider.into(), method: ConnectMethod::Cli, model: String::new(), effort: String::new(), base_url: None }
    }

    #[test]
    fn switching_provider_drops_the_claude_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let m = AgentManager::new(broadcast::channel(8).0, dir.path());
        let s = AgentSession {
            id: "a".into(), project_id: "p".into(), branch: "b".into(), cwd: ".".into(), worktree: false,
            status: AgentStatus::Waiting, request: "r".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: now(), resume_id: Some("rid".into()), ai: Some(cli("claude")), pid: None,
        };
        m.inner.lock().unwrap().sessions.insert("a".into(), s);

        // Same provider: only the model changes, the conversation is kept.
        let mut r = cli("claude");
        r.model = "opus".into();
        assert_eq!(m.set_ai("a", r).unwrap().resume_id.as_deref(), Some("rid"));

        let s = m.set_ai("a", cli("gemini")).unwrap();
        assert_eq!(s.resume_id, None);
        assert!(s.lines.last().unwrap().text.contains("Switched to"));

        // Not while a turn runs: it would store a resume id after the switch.
        m.inner.lock().unwrap().sessions.get_mut("a").unwrap().status = AgentStatus::Running;
        assert!(m.set_ai("a", cli("claude")).is_err());
    }
}
