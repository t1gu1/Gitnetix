//! Long-running AI agent sessions (Claude Code CLI and friends), one per
//! branch or worktree. They keep running when the UI switches project.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, oneshot};

use crate::ai::{self, Resolved};
use crate::error::{Error, Result};
use crate::events::Event;
use crate::git::Git;
use crate::limits::{self, Limit};
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
    /// cmd | ai | ok | dim | err | wait | run | files | limit
    pub kind: String,
    pub text: String,
    /// When it was logged, in ms since the Unix epoch. Lines from before timestamps have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
}

impl LogLine {
    pub fn new(kind: &str, text: impl Into<String>) -> Self {
        LogLine { kind: kind.into(), text: text.into(), at: Some(chrono::Utc::now().timestamp_millis()) }
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
    /// Messages sent while it works, in order; they go out together when the run ends.
    #[serde(default)]
    pub queued: Vec<String>,
    /// The CLI's process while it works. Saved so another Gitnetix on this folder sees the run is still going.
    #[serde(default)]
    pub pid: Option<u32>,
    /// What its last run was asked, which Retry asks again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_prompt: Option<String>,
    /// The usage limit its last run stopped at: it waits, status `Waiting`, until the limit resets or you continue it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<Limit>,
}

/// The usage limit a run stopped on: what its CLI said, whether credits lift it, and when the CLI said it resets.
struct Hit {
    message: String,
    credits: bool,
    resets_at: Option<i64>,
}

/// What a session's current run said about usage limits.
#[derive(Default)]
struct Seen {
    hit: Option<Hit>,
    /// When the limit a Claude Code `rate_limit_event` refused requests at resets.
    told: Option<i64>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, AgentSession>,
    /// Each session's run: its number and what kills it. A run's task ends the turn only while it is still the one here.
    kills: HashMap<String, (u64, oneshot::Sender<()>)>,
    /// The last run's number.
    runs: u64,
    /// Sessions whose run Send now killed: its task sends their queue once the process is gone.
    send_now: HashSet<String>,
    /// Claude Code runs the last quit cut off, for `resume_interrupted`.
    interrupted: Vec<String>,
    /// Set by `shutdown`: nothing is saved after it.
    quitting: bool,
    /// Deleted here: `persist` must not keep them from the file.
    removed: HashSet<String>,
    /// What each session's current run said about usage limits, read when it ends.
    seen: HashMap<String, Seen>,
}

#[derive(Clone)]
pub struct AgentManager {
    inner: Arc<Mutex<Inner>>,
    events: broadcast::Sender<Event>,
    file: PathBuf,
    /// Serializes writes to `file` so concurrent persists cannot interleave.
    write_lock: Arc<Mutex<()>>,
    /// Held by `message`, `end_run` and `stop`: a message never queues after its run took the queue, nor a stop slips between them.
    turn: Arc<Mutex<()>>,
}

const MAX_LINES: usize = 2000;

/// Closes the messages sent while the agent worked: it reads them only after its last reply.
const QUEUED_NOTE: &str = "(I sent this while you were still working, before your last reply. If that reply asked me questions this does not answer, ask them again at the end of this reply, unless I told you not to ask questions.)";

/// Closes the messages sent with Send now: the agent was cut off to read them.
const SEND_NOW_NOTE: &str = "(I stopped you to send this. Take it into account and carry on with the task.)";

/// Closes what a Claude Code run that a usage limit stopped picks its conversation back up with.
const LIMIT_NOTE: &str = "(A usage limit stopped you before you finished. Continue the task where you left off.)";

/// Closes the task asked again of another agent, which can't pick that conversation up, after a usage limit stopped it.
const LIMIT_TASK_NOTE: &str = "(A usage limit stopped the agent working on this before it finished. Its changes so far are in the working tree: check them, then finish the task.)";

/// Files a "files" line lists; it counts the rest.
const MAX_FILES: usize = 300;

/// The files in `cwd` as a tree in its object database, untracked ones too, staged into a copy of its index so the
/// user's own stays as it was. None when that fails.
// shortcut: big untracked files that aren't ignored get hashed each turn; skip them by size if a repo shows it.
async fn snapshot(cwd: &Path) -> Option<String> {
    let git = Git::new(cwd);
    let index = git.git_paths(&["index"]).await.ok()?.pop()?;
    // Outside the git dir: the watcher would refresh the UI on each write there.
    let copy = std::env::temp_dir().join(format!("gitnetix-turn-{}.index", crate::store::new_id()));
    // A repo where nothing was ever staged has no index: the copy starts empty.
    let _ = tokio::fs::copy(&index, &copy).await;
    let staged = git.with_index(&copy);
    // An unreadable file fails the add but not the others it stages.
    let _ = staged.run(&["add", "-A", "--ignore-errors"]).await;
    let tree = staged.run(&["write-tree"]).await.ok();
    let _ = tokio::fs::remove_file(&copy).await;
    tree.map(|t| t.trim().to_string())
}

/// What changed in `cwd` since snapshot `from`, as a "files" line: `{from, to, files: [[path, added, removed]], more}`,
/// the counts null for a binary file. None when nothing did.
async fn turn_files(cwd: &Path, from: &str) -> Option<LogLine> {
    let to = snapshot(cwd).await?;
    if to == from {
        return None;
    }
    let out = Git::new(cwd).run(&["diff", "--numstat", "-z", "--no-renames", from, &to]).await.ok()?;
    let files: Vec<Value> = out
        .split('\0')
        .filter_map(|r| {
            let mut f = r.splitn(3, '\t');
            let (add, del, path) = (f.next()?, f.next()?, f.next()?);
            Some(json!([path, add.parse::<u64>().ok(), del.parse::<u64>().ok()]))
        })
        .collect();
    if files.is_empty() {
        return None;
    }
    let more = files.len().saturating_sub(MAX_FILES);
    Some(LogLine::new("files", json!({ "from": from, "to": to, "files": &files[..files.len() - more], "more": more }).to_string()))
}

/// The sessions saved in `file`; none when it is missing or unreadable.
fn saved(file: &std::path::Path) -> Vec<AgentSession> {
    std::fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// The line shown for a failed tool call. Claude Code starts a failed command's output with
/// "Exit code N" and puts the error under it, so that line is shown with the code after it.
fn tool_error_line(msg: &str) -> String {
    let mut lines = msg.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.next().unwrap_or("");
    let cut = |s: &str| s.chars().take(200).collect::<String>();
    match (first.strip_prefix("Exit code "), lines.next()) {
        (Some(code), Some(err)) => format!("{} (exit {code})", cut(err)),
        _ => cut(first),
    }
}

/// What `s`, which `limit` stopped, is asked when it continues on `ai`, and the Claude Code conversation it picks up.
/// Claude Code goes on in its conversation, after the messages queued meanwhile. Another CLI, which keeps none, is asked
/// its last prompt again, or the task once you picked another agent, then the messages.
fn carried<'a>(s: &'a AgentSession, ai: &Resolved, limit: &Limit) -> (String, Option<&'a str>) {
    let resume = s.resume_id.as_deref().filter(|_| ai.provider == "claude");
    let said = s.queued.iter().map(String::as_str);
    let prompt: Vec<&str> = match (resume, &s.last_prompt) {
        (Some(_), _) => said.chain([LIMIT_NOTE]).collect(),
        (None, Some(p)) if ai.provider == limit.provider => [p.as_str()].into_iter().chain(said).collect(),
        _ => [s.request.as_str(), LIMIT_TASK_NOTE].into_iter().chain(said).collect(),
    };
    (prompt.join("\n\n"), resume)
}

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
        let mut sessions: HashMap<String, AgentSession> = saved(&file).into_iter().map(|s| (s.id.clone(), s)).collect();
        // Processes do not survive an app restart.
        let mut interrupted = Vec::new();
        for s in sessions.values_mut() {
            // Still working in its checkout: another Gitnetix on this folder (a dev build next to the installed app) runs it,
            // so it is neither stopped nor resumed here, and its process is not ours to pause or kill.
            // shortcut: Linux only (/proc); elsewhere such a run still resumes twice, check the process another way if that shows up.
            if s.pid.take().is_some_and(|p| std::fs::read_link(format!("/proc/{p}/cwd")).is_ok_and(|d| d == std::path::Path::new(&s.cwd))) {
                continue;
            }
            // Only Claude Code can pick its conversation back up; a paused run stays as the user left it.
            if s.status == AgentStatus::Running && s.resume_id.is_some() && s.ai.as_ref().is_some_and(|r| r.provider == "claude") {
                interrupted.push(s.id.clone());
            } else if s.limit.is_none() {
                // No run ends to send it: it would go out after your next message instead. A usage limit's continue sends it.
                s.queued.clear();
            }
            if matches!(s.status, AgentStatus::Running | AgentStatus::Paused) {
                s.status = AgentStatus::Stopped;
                s.lines.push(LogLine::new("dim", "  ■ Stopped when Gitnetix quit"));
            }
        }
        AgentManager { inner: Arc::new(Mutex::new(Inner { sessions, interrupted, ..Inner::default() })), events, file, write_lock: Arc::default(), turn: Arc::default() }
    }

    /// On quit: save the sessions, then kill their processes, which a quit never drops (`kill_on_drop`), so a
    /// resumed run can't race one still going. Nothing is saved after: the next launch still finds the runs it cut off.
    pub fn shutdown(&self) {
        self.persist();
        let pids: Vec<String> = {
            let mut g = self.inner.lock().unwrap();
            g.quitting = true;
            g.sessions.values().filter_map(|s| s.pid).map(|p| p.to_string()).collect()
        };
        // shortcut: Unix only; on Windows a run may outlive the app until its pipes break, use taskkill if that shows up.
        if !pids.is_empty() && !cfg!(windows) {
            let _ = std::process::Command::new("kill").arg("-KILL").args(&pids).status();
        }
    }

    /// Resume the Claude Code runs the last quit cut off, and wait again for the usage limits sessions stopped at: one
    /// that reset meanwhile continues now. Needs a tokio runtime.
    pub fn resume_interrupted(&self) {
        let ids = std::mem::take(&mut self.inner.lock().unwrap().interrupted);
        for id in ids {
            let Some(ai) = self.get(&id).ok().and_then(|s| s.ai) else { continue };
            // A removed checkout errors before anything is logged: the session stays stopped.
            let _ = self.message(&id, "Gitnetix quit while you were working. Continue the task where you left off.", &ai);
        }
        let held: Vec<(String, i64)> = self.inner.lock().unwrap().sessions.values().filter_map(|s| Some((s.id.clone(), s.limit.as_ref()?.continue_at?))).collect();
        for (id, at) in held {
            self.arm(&id, at);
        }
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

    /// Move the project's sessions on `from` over to its new name.
    pub fn rename_branch(&self, project_id: &str, from: &str, to: &str) {
        for s in self.inner.lock().unwrap().sessions.values_mut().filter(|s| s.project_id == project_id && s.branch == from) {
            s.branch = to.into();
        }
        self.persist();
    }

    fn persist(&self) {
        // Held from the snapshot to the rename, so a slower save never lands an older snapshot.
        let _guard = self.write_lock.lock().unwrap();
        // Snapshot under the session lock, serialize and write outside it so
        // log readers are not blocked. Order does not matter on disk: `new`
        // loads sessions into a map.
        let (mut snapshot, removed) = {
            let g = self.inner.lock().unwrap();
            if g.quitting {
                return;
            }
            (g.sessions.clone(), g.removed.clone())
        };
        // Another Gitnetix on this folder (a dev build next to the installed app) saves its sessions here too:
        // keep the ones only it holds, and its copy of a shared one when newer, so neither wipes the other's.
        // shortcut: a session deleted here comes back if the other one still holds it and saves after; save deletions in the file if that bites.
        for s in saved(&self.file) {
            if !removed.contains(&s.id) && snapshot.get(&s.id).is_none_or(|m| s.updated_at > m.updated_at) {
                snapshot.insert(s.id.clone(), s);
            }
        }
        let Ok(json) = serde_json::to_string(&snapshot.into_values().collect::<Vec<_>>()) else { return };
        // Write to a temp file and rename so a reader never sees a torn file.
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
                // Working again: the limit it waited on is behind it.
                if status == AgentStatus::Running {
                    s.limit = None;
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
            queued: Vec::new(),
            pid: None,
            last_prompt: None,
            limit: None,
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
    /// other CLIs get a fresh run in the same directory. While the agent
    /// works, it waits for the run to end (`end_run`).
    pub fn message(&self, id: &str, text: &str, ai: &Resolved) -> Result<()> {
        let _turn = self.turn.lock().unwrap();
        let s = self.get(id)?;
        if s.status == AgentStatus::Running || s.status == AgentStatus::Paused {
            if let Some(s) = self.inner.lock().unwrap().sessions.get_mut(id) {
                s.queued.push(text.into());
            }
            self.persist();
            return Ok(());
        }
        if !std::path::Path::new(&s.cwd).exists() {
            return Err(Error::Invalid(format!("{} no longer exists. Start a new session.", s.cwd)));
        }
        // Stopped at a usage limit: this continues it now, with the messages queued for its continue.
        let held = if s.limit.is_some() { s.queued } else { Vec::new() };
        if !held.is_empty() {
            if let Some(x) = self.inner.lock().unwrap().sessions.get_mut(id) {
                x.queued.clear();
            }
        }
        let said: Vec<&str> = held.iter().map(String::as_str).chain([text]).collect();
        for t in &said {
            self.push(id, LogLine::new("cmd", format!("› {t}")));
        }
        self.set_status(id, AgentStatus::Running);
        self.spawn_or_fail(id, &PathBuf::from(&s.cwd), ai, &said.join("\n\n"), s.resume_id.as_deref())
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

    /// After run `run` (on `r`): its changes (`files`) show, then the messages sent during it go out together as the
    /// next run and the session keeps running; without any, it waits for you. A run Stop took, or a newer run replaced,
    /// only shows its changes; one Send now killed sends the queue.
    fn end_run(&self, id: &str, run: u64, failed: bool, files: Option<LogLine>, r: &Resolved) {
        let _turn = self.turn.lock().unwrap();
        let (ours, now, seen) = {
            let mut g = self.inner.lock().unwrap();
            let ours = g.kills.get(id).is_some_and(|(n, _)| *n == run);
            if ours {
                g.kills.remove(id);
            }
            // What a newer run said is that run's.
            let seen = if ours { g.seen.remove(id) } else { None };
            (ours, g.send_now.remove(id), seen)
        };
        let Ok(s) = self.get(id) else { return };
        if !ours && !now {
            // shortcut: a message sent within ms of Stop starts a run before this, which would take them for its own, so they don't show; carry `files` into that run if it bites.
            if let Some(l) = files.filter(|_| s.status != AgentStatus::Running) {
                self.push(id, l);
                self.persist();
            }
            return;
        }
        if let Some(l) = files {
            self.push(id, l);
        }
        if now {
            // All taken back off the queue meanwhile (Edit, Remove): nothing to send, so it stays stopped.
            if s.queued.is_empty() {
                self.push(id, LogLine::new("dim", "  ■ Agent stopped"));
                return self.set_status(id, AgentStatus::Stopped);
            }
            self.push(id, LogLine::new("dim", "  ■ Stopped to send your message"));
            return self.send_queued(&s, r, SEND_NOW_NOTE);
        }
        if failed {
            if let Some(Seen { hit: Some(hit), told }) = seen {
                return self.hold(&s, r, hit, told);
            }
            self.push(id, LogLine::new("err", "✕ Agent run failed"));
        }
        // Quitting, nothing new starts: the saved queue goes out after the resumed run.
        if s.queued.is_empty() || self.inner.lock().unwrap().quitting {
            if !failed {
                self.push(id, LogLine::new("wait", "◆ Waiting for your review"));
            }
            self.set_status(id, if failed { AgentStatus::Failed } else { AgentStatus::Waiting });
            return;
        }
        self.send_queued(&s, r, QUEUED_NOTE);
    }

    /// The run on `r` stopped at usage limit `hit`: the session waits, its queue kept, for the limit to reset (`told`, when
    /// the CLI said it apart), then continues by itself (`arm`). With no reset ahead it waits for you. Hold `turn`.
    fn hold(&self, s: &AgentSession, r: &Resolved, hit: Hit, told: Option<i64>) {
        let since = chrono::Utc::now().timestamp_millis();
        let resets_at = hit.resets_at.or(told);
        let limit = Limit {
            message: hit.message,
            provider: s.ai.as_ref().unwrap_or(r).provider.clone(),
            credits: hit.credits,
            since,
            resets_at,
            // A reset already past that still refused it would only refuse it again, each minute.
            continue_at: resets_at.filter(|t| *t > since).map(|t| t + limits::MARGIN_MS),
        };
        self.push(&s.id, LogLine::new("limit", limit.message.clone()));
        let at = limit.continue_at;
        if let Some(x) = self.inner.lock().unwrap().sessions.get_mut(&s.id) {
            x.limit = Some(limit);
        }
        self.set_status(&s.id, AgentStatus::Waiting);
        if let Some(at) = at {
            self.arm(&s.id, at);
        }
    }

    /// Continue `id` at `at`, a minute after its limit resets, unless that wait is over by then (continued, cancelled).
    /// Checks every 30 s: tokio's timers stop while the computer sleeps, the wall clock does not.
    fn arm(&self, id: &str, at: i64) {
        // Tests end runs without a runtime: nothing to wait on.
        let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
        let me = self.clone();
        let id = id.to_string();
        // Another Gitnetix on this folder (a dev build next to the installed app) waits for the same reset: seconds apart,
        // the later one finds the session moved on in the file (`wake`).
        let due = at + i64::from(std::process::id() % 8) * 1000;
        rt.spawn(async move {
            loop {
                if me.get(&id).ok().and_then(|s| s.limit?.continue_at) != Some(at) {
                    return;
                }
                let left = due - chrono::Utc::now().timestamp_millis();
                if left <= 0 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(left.min(30_000) as u64)).await;
            }
            me.wake(&id, at);
        });
    }

    /// The limit `id` waited on reset (`at`): it continues, unless another Gitnetix on this folder saved it moving on
    /// since (continued there, or stopped), whose copy it takes instead.
    fn wake(&self, id: &str, at: i64) {
        let waits = |s: &AgentSession| s.limit.as_ref().and_then(|l| l.continue_at) == Some(at);
        let Ok(s) = self.get(id) else { return };
        if let Some(theirs) = saved(&self.file).into_iter().find(|x| x.id == id && x.updated_at > s.updated_at && !waits(x)) {
            let status = theirs.status;
            self.inner.lock().unwrap().sessions.insert(id.into(), theirs);
            let _ = self.events.send(Event::AgentStatus { session_id: id.into(), status });
            return;
        }
        // A session from before routing has no AI of its own: Continue (`carry_on`) routes it.
        let Some(r) = s.ai.clone() else { return };
        if let Err(e) = self.carry(id, &r, Some(at)) {
            // Still waiting: its checkout is gone. A CLI that fails to start already said so, and stopped the wait.
            if self.get(id).is_ok_and(|s| waits(&s)) {
                if let Some(x) = self.inner.lock().unwrap().sessions.get_mut(id) {
                    x.limit = None;
                }
                self.push(id, LogLine::new("err", format!("✕ Could not continue after the usage limit: {e}")));
                self.set_status(id, AgentStatus::Failed);
            }
        }
    }

    /// Continue `id` now after the usage limit its run stopped at, without waiting for the reset: credits were added, or
    /// another agent picked. `r`: when the session has no AI set.
    pub fn carry_on(&self, id: &str, r: &Resolved) -> Result<()> {
        self.carry(id, r, None)
    }

    /// Continue `id` after the usage limit it stopped at; `due`: only the wait for this continue time, from its timer.
    /// Claude Code picks its conversation back up. Another CLI is asked its last prompt again, or the task once you picked
    /// another agent, which can't pick that conversation up. What was queued goes with it.
    fn carry(&self, id: &str, r: &Resolved, due: Option<i64>) -> Result<()> {
        let _turn = self.turn.lock().unwrap();
        let s = self.get(id)?;
        let limit = s
            .limit
            .clone()
            .filter(|l| due.is_none_or(|d| l.continue_at == Some(d)))
            .ok_or_else(|| Error::Invalid("The agent is not waiting for a usage limit.".into()))?;
        if !Path::new(&s.cwd).exists() {
            return Err(Error::Invalid(format!("{} no longer exists. Start a new session.", s.cwd)));
        }
        let ai = s.ai.clone().unwrap_or_else(|| r.clone());
        let (prompt, resume) = carried(&s, &ai, &limit);
        if let Some(x) = self.inner.lock().unwrap().sessions.get_mut(id) {
            x.queued.clear();
        }
        self.push(id, LogLine::new("dim", "  ▶ Continuing after the usage limit"));
        for t in &s.queued {
            self.push(id, LogLine::new("cmd", format!("› {t}")));
        }
        self.set_status(id, AgentStatus::Running);
        self.spawn_or_fail(id, Path::new(&s.cwd), &ai, &prompt, resume)
    }

    /// The messages queued on `s` go out together as its next run, `note` after them. Hold `turn`.
    fn send_queued(&self, s: &AgentSession, r: &Resolved, note: &str) {
        if let Some(s) = self.inner.lock().unwrap().sessions.get_mut(&s.id) {
            s.queued.clear();
        }
        for t in &s.queued {
            self.push(&s.id, LogLine::new("cmd", format!("› {t}")));
        }
        // Already running: this saves the emptied queue and has the UI refetch it.
        self.set_status(&s.id, AgentStatus::Running);
        let prompt = format!("{}\n\n{note}", s.queued.join("\n\n"));
        let _ = self.spawn_or_fail(&s.id, Path::new(&s.cwd), s.ai.as_ref().unwrap_or(r), &prompt, s.resume_id.as_deref());
    }

    /// Take queued message `index` off the queue before its run ends, when it is still `text`; returns it.
    pub fn unqueue(&self, id: &str, index: usize, text: &str) -> Result<String> {
        let _turn = self.turn.lock().unwrap();
        let (taken, status) = {
            let mut g = self.inner.lock().unwrap();
            // No run here: another Gitnetix on this folder runs it and sends its own copy of the queue. Waiting for a
            // usage limit to reset, nothing runs it: its continue sends the queue.
            if !g.kills.contains_key(id) && g.sessions.get(id).is_none_or(|s| s.limit.is_none()) {
                return Err(Error::Invalid("Another Gitnetix runs this agent: change its queue from there.".into()));
            }
            let s = g.sessions.get_mut(id).ok_or_else(|| Error::NotFound(format!("agent session {id}")))?;
            if s.queued.get(index).map(String::as_str) != Some(text) {
                return Err(Error::Invalid("That message went out already.".into()));
            }
            (s.queued.remove(index), s.status)
        };
        // Saves it, and has other screens (the phone) refetch the queue.
        self.set_status(id, status);
        Ok(taken)
    }

    /// Stop the run and send the queued messages now, instead of when it ends: its task sends them once the process is
    /// gone and its output is in, so the next run never works beside it.
    pub fn send_now(&self, id: &str) -> Result<()> {
        let _turn = self.turn.lock().unwrap();
        let s = self.get(id)?;
        if s.queued.is_empty() {
            return Ok(());
        }
        // Another CLI (or Claude before it named its session) starts over: the task would be lost.
        if s.resume_id.is_none() || s.ai.as_ref().is_none_or(|a| a.provider != "claude") {
            return Err(Error::Invalid("This agent can't pick its task back up: your message goes out when its run ends.".into()));
        }
        let mut g = self.inner.lock().unwrap();
        // No handle: another Gitnetix on this folder runs it, and a second run would work beside that one.
        let Some((_, kill)) = g.kills.remove(id) else {
            return Err(Error::Invalid("Another Gitnetix runs this agent: send it from there.".into()));
        };
        g.send_now.insert(id.into());
        drop(g);
        let _ = kill.send(());
        Ok(())
    }

    /// Ask the last run's prompt again, after it failed (`r` when the session has no AI set).
    pub fn retry(&self, id: &str, r: &Resolved) -> Result<()> {
        let _turn = self.turn.lock().unwrap();
        let s = self.get(id)?;
        if matches!(s.status, AgentStatus::Running | AgentStatus::Paused) {
            return Err(Error::Invalid("The agent is still working.".into()));
        }
        let prompt = s.last_prompt.ok_or_else(|| Error::Invalid("Nothing to try again: send your message once more.".into()))?;
        if !Path::new(&s.cwd).exists() {
            return Err(Error::Invalid(format!("{} no longer exists. Start a new session.", s.cwd)));
        }
        self.push(id, LogLine::new("dim", "  ▶ Trying again"));
        self.set_status(id, AgentStatus::Running);
        self.spawn_or_fail(id, Path::new(&s.cwd), s.ai.as_ref().unwrap_or(r), &prompt, s.resume_id.as_deref())
    }

    pub fn stop(&self, id: &str) -> Result<()> {
        let _turn = self.turn.lock().unwrap();
        let (kill, held) = {
            let mut g = self.inner.lock().unwrap();
            // Dropped with the run it waited for; the UI puts it back in the prompt box. Stopping one that waits for a
            // usage limit cancels its continue.
            let held = g.sessions.get_mut(id).and_then(|s| {
                s.queued.clear();
                s.limit.take()
            });
            g.send_now.remove(id);
            (g.kills.remove(id), held)
        };
        if let Some((_, k)) = kill {
            let _ = k.send(());
        }
        let said = if held.is_some_and(|l| l.continue_at.is_some()) { "  ■ Auto-continue cancelled" } else { "  ■ Agent stopped" };
        self.push(id, LogLine::new("dim", said));
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
        {
            let mut g = self.inner.lock().unwrap();
            g.sessions.remove(id);
            g.removed.insert(id.into());
        }
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
        let (bin, path) = ai::cli_path(&r.provider)?;
        let mut cmd = Command::new(path);
        crate::shell::below_app(crate::shell::without_appimage(cmd.as_std_mut()));
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
            "gemini" if bin == "agy" => {
                if !r.model.is_empty() {
                    cmd.args(["--model", &r.model]);
                }
                cmd.args(["--dangerously-skip-permissions", "-p", prompt]);
                stdin_prompt = false;
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
        let run = {
            let mut g = self.inner.lock().unwrap();
            g.runs += 1;
            let run = g.runs;
            g.kills.insert(id.to_string(), (run, kill_tx));
            g.seen.remove(id);
            if let Some(s) = g.sessions.get_mut(id) {
                s.last_prompt = Some(prompt.to_string());
            }
            run
        };

        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        let me = self.clone();
        let sid = id.to_string();
        let prompt = prompt.to_string();
        let r = r.clone();
        let cwd = cwd.to_path_buf();
        tokio::spawn(async move {
            // Before the prompt goes in, so the agent has changed nothing yet. The CLI is starting meanwhile (seconds for
            // Claude Code), so this rarely delays it; one given its prompt as an argument takes that long to edit anything.
            let base = snapshot(&cwd).await;
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
            let provider = r.provider.clone();
            let err_task = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    ai::flag_signed_out(&provider, &l);
                    // Plain CLIs say a usage limit stopped them only in words, here. Claude Code says it in its stream.
                    if let (false, Some(credits)) = (structured, limits::kind(&l)) {
                        let hit = Hit { message: l.trim().into(), credits, resets_at: limits::resets_at(&l, chrono::Local::now()) };
                        err_me.saw(&err_id, Some(hit), None);
                    }
                    if !l.trim().is_empty() {
                        err_me.push(&err_id, LogLine::new("dim", format!("  {l}")));
                    }
                }
            });
            let exit = tokio::select! {
                s = child.wait() => Some(s),
                _ = &mut kill_rx => {
                    // A .cmd shim runs the CLI as a child of cmd.exe, which killing cmd.exe alone leaves working.
                    if let (true, Some(pid)) = (cfg!(windows), child.id()) {
                        let mut kill = Command::new("taskkill");
                        crate::shell::without_appimage(kill.as_std_mut());
                        let _ = kill.args(["/T", "/F", "/PID", &pid.to_string()]).status().await;
                    }
                    let _ = child.kill().await;
                    None
                }
            };
            let outcome = out_task.await.ok().flatten();
            let _ = err_task.await;
            // The process is gone and all it printed is in: what the turn changed, its last edits included.
            let files = match &base {
                Some(b) => turn_files(&cwd, b).await,
                None => None,
            };
            // Killed (Stop, Send now): not a failure.
            let failed = exit.is_some_and(|e| {
                let ok = e.map(|s| s.success()).unwrap_or(false);
                matches!((ok, outcome), (_, Some(false)) | (false, None))
            });
            me.end_run(&sid, run, failed, files, &r);
        });
        Ok(())
    }

    /// Turn one Claude Code `stream-json` event into log lines.
    /// Returns Some(success) on the final `result` event.
    fn handle_stream_json(&self, id: &str, raw: &str) -> Option<bool> {
        let Ok(v) = serde_json::from_str::<Value>(raw) else {
            ai::flag_signed_out("claude", raw);
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
                    // Saved now so a quit mid-run can resume it.
                    self.persist();
                }
                None
            }
            Some("rate_limit_event") => {
                let info = &v["rate_limit_info"];
                if info["status"] == "rejected" {
                    self.saw(id, None, limits::info_resets_at(info));
                }
                None
            }
            // The API refused the request at a usage limit: the CLI says it as a reply, then in its result. The run's end
            // says it once (`hold`).
            Some("assistant") if limits::refusal(&v).is_some() => {
                let texts: Vec<&str> = v["message"]["content"].as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect();
                let message = texts.join("\n").trim().to_string();
                let credits = limits::refusal(&v) == Some(true) || limits::kind(&message) == Some(true);
                // Its words come last: the CLI's own numbers are exact, its words round to the minute and leave the date out.
                let told = self.inner.lock().unwrap().seen.get(id).and_then(|s| s.told);
                let resets_at = limits::info_resets_at(&v["api_error_params"]["rate_limit_info"])
                    .or(told)
                    .or_else(|| limits::resets_at(&message, chrono::Local::now()));
                self.saw(id, Some(Hit { message, credits, resets_at }), None);
                None
            }
            Some("assistant") => {
                let mut replied = false;
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") => {
                            // One line per reply, blank lines kept, so the UI can render it as Markdown.
                            let text = block["text"].as_str().unwrap_or("").trim();
                            if !text.is_empty() {
                                self.push(id, LogLine::new("ai", format!("✦ {text}")));
                                replied = true;
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
                // Each reply is saved, with the tool calls before it, so a crash or kill loses little.
                if replied {
                    self.persist();
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
                        self.push(id, LogLine::new("err", format!("✕ {}", tool_error_line(&msg))));
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
                    ai::flag_signed_out("claude", why);
                    // A usage limit: the run's end says it, and waits for its reset.
                    if !self.saw_end(id, why) {
                        // Claude Desktop's copy of the CLI is signed in only inside Desktop, and is not on PATH to run /login by hand.
                        let hint = if why.contains("/login") { " · Settings › AI setup › Claude › Sign in with the CLI" } else { "" };
                        self.push(id, LogLine::new("err", format!("✕ {why}{hint}")));
                    }
                }
                Some(ok)
            }
            _ => None,
        }
    }

    /// Note what the current run of `id` said about usage limits: `hit`, one it stopped on (the last said is the one), or
    /// `told`, when one that refused its requests resets.
    fn saw(&self, id: &str, hit: Option<Hit>, told: Option<i64>) {
        let mut g = self.inner.lock().unwrap();
        let seen = g.seen.entry(id.into()).or_default();
        if hit.is_some() {
            seen.hit = hit;
        }
        seen.told = told.or(seen.told);
    }

    /// Note the error `why` a Claude Code run ended on, when it is a usage limit or a refusal at one came before it: true
    /// then. The refusal's words, when it had any, stay what it says: the result repeats them.
    fn saw_end(&self, id: &str, why: &str) -> bool {
        let mut g = self.inner.lock().unwrap();
        let seen = g.seen.entry(id.into()).or_default();
        let told = seen.told;
        let at = || told.or_else(|| limits::resets_at(why, chrono::Local::now()));
        if let Some(h) = seen.hit.as_mut() {
            if h.message.is_empty() {
                h.message = why.into();
            }
            h.resets_at = h.resets_at.or_else(at);
        } else if let Some(credits) = limits::kind(why) {
            seen.hit = Some(Hit { message: why.into(), credits, resets_at: at() });
        } else {
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cli(provider: &str) -> Resolved {
        Resolved { provider: provider.into(), method: ConnectMethod::Cli, model: String::new(), effort: String::new(), base_url: None }
    }

    /// Session `id`'s run ends by itself: the run here gets run number 0 (spawn counts from 1), then its task ends it.
    fn ended(m: &AgentManager, id: &str, failed: bool, r: &Resolved) {
        m.inner.lock().unwrap().kills.insert(id.into(), (0, oneshot::channel().0));
        m.end_run(id, 0, failed, None, r);
    }

    #[test]
    fn failed_command_shows_its_error_and_exit_code() {
        let msg = "Exit code 1\ncat: illegal option -- A\nusage: cat [-belnstuv] [file ...]";
        assert_eq!(tool_error_line(msg), "cat: illegal option -- A (exit 1)");
        // No output: the code is all there is.
        assert_eq!(tool_error_line("Exit code 2\n"), "Exit code 2");
        // Other tool errors keep their first line.
        assert_eq!(tool_error_line("File does not exist.\nmore"), "File does not exist.");
    }

    #[test]
    fn switching_provider_drops_the_claude_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let m = AgentManager::new(broadcast::channel(8).0, dir.path());
        let s = AgentSession {
            id: "a".into(), project_id: "p".into(), branch: "b".into(), cwd: ".".into(), worktree: false,
            status: AgentStatus::Waiting, request: "r".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: now(), resume_id: Some("rid".into()), ai: Some(cli("claude")), queued: vec![], pid: None, last_prompt: None, limit: None,
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

    #[test]
    fn only_running_claude_sessions_resume_after_quit() {
        let dir = tempfile::tempdir().unwrap();
        let s = |id: &str, status, rid: Option<&str>, provider| AgentSession {
            id: id.into(), project_id: "p".into(), branch: "b".into(), cwd: "/gone".into(), worktree: false,
            status, request: "r".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: now(), resume_id: rid.map(Into::into), ai: Some(cli(provider)), queued: vec!["q".into()], pid: None, last_prompt: None, limit: None,
        };
        let saved = vec![
            s("run", AgentStatus::Running, Some("rid"), "claude"),
            s("norid", AgentStatus::Running, None, "claude"),
            s("paused", AgentStatus::Paused, Some("rid"), "claude"),
            s("gemini", AgentStatus::Running, Some("rid"), "gemini"),
            s("done", AgentStatus::Waiting, Some("rid"), "claude"),
        ];
        std::fs::write(dir.path().join("agents.json"), serde_json::to_string(&saved).unwrap()).unwrap();

        let m = AgentManager::new(broadcast::channel(8).0, dir.path());
        assert_eq!(m.inner.lock().unwrap().interrupted, vec!["run".to_string()]);
        assert!(saved.iter().take(4).all(|x| m.get(&x.id).unwrap().status == AgentStatus::Stopped));
        // What was queued goes out when the resumed run ends; the others never end.
        assert!(saved.iter().all(|x| m.get(&x.id).unwrap().queued.is_empty() == (x.id != "run")));

        // Its checkout is gone, so it stays stopped instead of spawning.
        m.resume_interrupted();
        assert!(m.inner.lock().unwrap().interrupted.is_empty());
        assert_eq!(m.get("run").unwrap().status, AgentStatus::Stopped);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_run_another_instance_still_works_on_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        // This test's own process stands in for the other instance's agent, working in its checkout.
        let cwd = std::env::current_dir().unwrap().to_string_lossy().to_string();
        let s = |id: &str, pid| AgentSession {
            id: id.into(), project_id: "p".into(), branch: "b".into(), cwd: cwd.clone(), worktree: false,
            status: AgentStatus::Running, request: "r".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: now(), resume_id: Some("rid".into()), ai: Some(cli("claude")), queued: vec!["q".into()], pid: Some(pid), last_prompt: None, limit: None,
        };
        let saved = vec![s("live", std::process::id()), s("killed", u32::MAX)];
        std::fs::write(dir.path().join("agents.json"), serde_json::to_string(&saved).unwrap()).unwrap();

        let m = AgentManager::new(broadcast::channel(8).0, dir.path());
        assert_eq!(m.inner.lock().unwrap().interrupted, vec!["killed".to_string()]);
        let live = m.get("live").unwrap();
        assert_eq!((live.status, live.queued.len(), live.pid), (AgentStatus::Running, 1, None));
        assert_eq!(m.get("killed").unwrap().status, AgentStatus::Stopped);
    }

    #[test]
    fn messages_sent_while_working_go_out_when_the_run_ends() {
        let dir = tempfile::tempdir().unwrap();
        let m = AgentManager::new(broadcast::channel(64).0, dir.path());
        // No such CLI: the follow-up fails to start instead of running anything.
        let r = cli("none");
        let s = AgentSession {
            id: "a".into(), project_id: "p".into(), branch: "b".into(), cwd: ".".into(), worktree: false,
            status: AgentStatus::Running, request: "r".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: now(), resume_id: Some("rid".into()), ai: Some(r.clone()), queued: vec![], pid: None, last_prompt: None, limit: None,
        };
        m.inner.lock().unwrap().sessions.insert("a".into(), s);
        let running = || m.inner.lock().unwrap().sessions.get_mut("a").unwrap().status = AgentStatus::Running;

        m.message("a", "also the tests", &r).unwrap();
        m.message("a", "and the docs", &r).unwrap();
        let s = m.get("a").unwrap();
        assert_eq!(s.queued, ["also the tests", "and the docs"]);
        assert!(s.lines.is_empty());

        // They go out together, without waiting for you in between.
        ended(&m, "a", false, &r);
        let s = m.get("a").unwrap();
        assert!(s.queued.is_empty());
        let said: Vec<&str> = s.lines.iter().filter(|l| l.kind == "cmd").map(|l| l.text.as_str()).collect();
        assert_eq!(said, ["› also the tests", "› and the docs"]);
        assert!(!s.lines.iter().any(|l| l.kind == "wait"));

        running();
        ended(&m, "a", false, &r);
        assert_eq!(m.get("a").unwrap().status, AgentStatus::Waiting);

        // Stopping drops what was queued.
        running();
        m.message("a", "never mind", &r).unwrap();
        m.stop("a").unwrap();
        assert!(m.get("a").unwrap().queued.is_empty());
    }

    #[test]
    fn shutdown_keeps_runs_resumable() {
        let dir = tempfile::tempdir().unwrap();
        let m = AgentManager::new(broadcast::channel(8).0, dir.path());
        let s = AgentSession {
            id: "a".into(), project_id: "p".into(), branch: "b".into(), cwd: ".".into(), worktree: false,
            status: AgentStatus::Running, request: "r".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: now(), resume_id: Some("rid".into()), ai: Some(cli("claude")), queued: vec![], pid: None, last_prompt: None, limit: None,
        };
        // No such CLI for "q": a follow-up started by mistake fails instead of running anything.
        let q = AgentSession { id: "q".into(), ai: Some(cli("none")), queued: vec!["later".into()], ..s.clone() };
        m.inner.lock().unwrap().sessions.insert("a".into(), s);
        m.inner.lock().unwrap().sessions.insert("q".into(), q);
        m.shutdown();
        // Its killed process ending the run after: not saved, so the next launch resumes it.
        m.set_status("a", AgentStatus::Failed);
        let next = AgentManager::new(broadcast::channel(8).0, dir.path());
        assert_eq!(next.inner.lock().unwrap().interrupted, vec!["a".to_string()]);
        // A killed run with messages queued starts nothing on quit; they stay for the resumed run.
        ended(&m, "q", true, &cli("none"));
        let q = m.get("q").unwrap();
        assert_eq!(q.queued, ["later"]);
        assert!(!q.lines.iter().any(|l| l.kind == "cmd"));
    }

    #[test]
    fn resume_id_and_replies_are_saved_mid_run() {
        let dir = tempfile::tempdir().unwrap();
        let m = AgentManager::new(broadcast::channel(8).0, dir.path());
        let s = AgentSession {
            id: "a".into(), project_id: "p".into(), branch: "b".into(), cwd: ".".into(), worktree: false,
            status: AgentStatus::Running, request: "r".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: now(), resume_id: None, ai: Some(cli("claude")), queued: vec![], pid: None, last_prompt: None, limit: None,
        };
        m.inner.lock().unwrap().sessions.insert("a".into(), s);
        let saved = || std::fs::read_to_string(dir.path().join("agents.json")).unwrap_or_default();

        m.handle_stream_json("a", r#"{"type":"system","subtype":"init","session_id":"rid"}"#);
        assert!(saved().contains(r#""resumeId":"rid""#));
        m.handle_stream_json("a", r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"x.rs"}}]}}"#);
        assert!(!saved().contains("x.rs"));
        m.handle_stream_json("a", r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Done reading"}]}}"#);
        assert!(saved().contains("x.rs") && saved().contains("Done reading"));
        m.handle_stream_json("a", r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#);
        let last = m.inner.lock().unwrap().sessions["a"].lines.last().unwrap().text.clone();
        assert!(last.ends_with("Sign in with the CLI"), "{last}");
    }

    #[test]
    fn another_instance_on_the_folder_keeps_our_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let s = |id: &str| AgentSession {
            id: id.into(), project_id: "p".into(), branch: "b".into(), cwd: ".".into(), worktree: false,
            status: AgentStatus::Waiting, request: "r".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: "2000-01-01T00:00:00+00:00".into(), resume_id: None, ai: None, queued: vec![], pid: None, last_prompt: None, limit: None,
        };
        std::fs::write(dir.path().join("agents.json"), serde_json::to_string(&[s("shared")]).unwrap()).unwrap();
        // The installed app and a dev build, both opened before either started a session.
        let app = AgentManager::new(broadcast::channel(8).0, dir.path());
        let dev = AgentManager::new(broadcast::channel(8).0, dir.path());
        app.inner.lock().unwrap().sessions.insert("mine".into(), s("mine"));
        app.persist();
        dev.inner.lock().unwrap().sessions.insert("gone".into(), s("gone"));
        dev.push("shared", LogLine::new("ai", "newer"));
        dev.persist();
        // Its older copy of "shared" and its lack of "mine" undo nothing.
        app.persist();
        let next = AgentManager::new(broadcast::channel(8).0, dir.path());
        assert!(next.get("mine").is_ok() && next.get("gone").is_ok());
        assert_eq!(next.get("shared").unwrap().lines.len(), 1);

        // A deleted session does not come back from the file.
        dev.remove("gone").unwrap();
        app.persist();
        assert!(AgentManager::new(broadcast::channel(8).0, dir.path()).get("gone").is_err());
    }

    #[tokio::test]
    async fn a_turn_lists_the_files_it_changed_and_leaves_the_index_alone() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(repo).output().unwrap().status.success());
        git(&["init", "-q"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(repo.join("keep.txt"), "same\n").unwrap();
        git(&["add", "."]);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
        let index = std::fs::read(repo.join(".git/index")).unwrap();

        let base = snapshot(repo).await.unwrap();
        // Nothing changed: no line.
        assert!(turn_files(repo, &base).await.is_none());
        std::fs::write(repo.join("a.txt"), "one\n2\nthree\n").unwrap();
        std::fs::write(repo.join("new.txt"), "x\n").unwrap();
        let line = turn_files(repo, &base).await.unwrap();
        assert_eq!(line.kind, "files");
        let v: Value = serde_json::from_str(&line.text).unwrap();
        assert_eq!(v["files"], json!([["a.txt", 2, 1], ["new.txt", 1, 0]]));
        assert_eq!(v["from"], base.as_str());
        // The user's index is as it was: the new file is still untracked.
        assert_eq!(std::fs::read(repo.join(".git/index")).unwrap(), index);
        let diff = Git::new(repo).file_diff("a.txt", Some(&format!("{base}..{}", v["to"].as_str().unwrap())), false).await.unwrap();
        assert_eq!(diff.len(), 1);
    }

    #[test]
    fn a_queued_message_comes_off_only_while_still_queued() {
        let dir = tempfile::tempdir().unwrap();
        let m = AgentManager::new(broadcast::channel(8).0, dir.path());
        let s = AgentSession {
            id: "a".into(), project_id: "p".into(), branch: "b".into(), cwd: ".".into(), worktree: false,
            status: AgentStatus::Running, request: "r".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: now(), resume_id: None, ai: Some(cli("claude")), queued: vec!["one".into(), "two".into()], pid: None, last_prompt: None, limit: None,
        };
        m.inner.lock().unwrap().sessions.insert("a".into(), s);
        // Another Gitnetix runs it (no run here): its queue is that one's to change.
        assert!(m.unqueue("a", 1, "two").is_err());
        m.inner.lock().unwrap().kills.insert("a".into(), (1, oneshot::channel().0));
        // The index moved (another device took "one" off): refused.
        assert!(m.unqueue("a", 0, "two").is_err());
        assert_eq!(m.unqueue("a", 1, "two").unwrap(), "two");
        assert!(m.unqueue("a", 1, "two").is_err());
        assert_eq!(m.get("a").unwrap().queued, vec!["one".to_string()]);
    }

    #[test]
    fn send_now_hands_the_queue_to_the_run_it_stops() {
        let dir = tempfile::tempdir().unwrap();
        let m = AgentManager::new(broadcast::channel(64).0, dir.path());
        let s = AgentSession {
            id: "a".into(), project_id: "p".into(), branch: "b".into(), cwd: ".".into(), worktree: false,
            status: AgentStatus::Running, request: "r".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: now(), resume_id: None, ai: Some(cli("claude")), queued: vec!["now".into()], pid: None, last_prompt: None, limit: None,
        };
        m.inner.lock().unwrap().sessions.insert("a".into(), s);
        let (kill, mut killed) = oneshot::channel();
        m.inner.lock().unwrap().kills.insert("a".into(), (3, kill));
        // Claude before it named its session can't pick the task back up.
        assert!(m.send_now("a").is_err());
        m.inner.lock().unwrap().sessions.get_mut("a").unwrap().resume_id = Some("rid".into());
        m.send_now("a").unwrap();
        // Killed, but nothing sent yet: that waits for the run's task, once its process is gone.
        assert!(killed.try_recv().is_ok());
        assert_eq!(m.get("a").unwrap().queued, ["now"]);
        // No such CLI from here on: the next run fails to start instead of running the real claude.
        m.inner.lock().unwrap().sessions.get_mut("a").unwrap().ai = Some(cli("none"));
        // A newer run's handle is not the old task's to take.
        m.inner.lock().unwrap().kills.insert("a".into(), (4, oneshot::channel().0));
        m.end_run("a", 3, false, Some(LogLine::new("files", "{}")), &cli("none"));
        let s = m.get("a").unwrap();
        assert!(m.inner.lock().unwrap().kills.get("a").is_some_and(|(n, _)| *n == 4));
        let kinds: Vec<&str> = s.lines.iter().map(|l| l.kind.as_str()).collect();
        // Its changes first, then the note, then your message.
        assert_eq!(kinds[..3], ["files", "dim", "cmd"]);
        assert!(s.queued.is_empty());

        // Another CLI can't resume: Send now refuses, the queue waits for the run's end.
        m.inner.lock().unwrap().sessions.get_mut("a").unwrap().ai = Some(cli("codex"));
        m.inner.lock().unwrap().sessions.get_mut("a").unwrap().queued = vec!["later".into()];
        assert!(m.send_now("a").is_err());
        // Not our run to stop (no kill handle): Send now leaves it and its queue alone.
        m.inner.lock().unwrap().sessions.get_mut("a").unwrap().ai = Some(cli("claude"));
        m.inner.lock().unwrap().kills.clear();
        assert!(m.send_now("a").is_err());
        assert_eq!(m.get("a").unwrap().queued, ["later"]);
    }

    #[test]
    fn a_stopped_run_shows_its_changes_and_does_not_wait_for_review() {
        let dir = tempfile::tempdir().unwrap();
        let m = AgentManager::new(broadcast::channel(64).0, dir.path());
        let s = AgentSession {
            id: "a".into(), project_id: "p".into(), branch: "b".into(), cwd: ".".into(), worktree: false,
            status: AgentStatus::Running, request: "r".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: now(), resume_id: Some("rid".into()), ai: Some(cli("claude")), queued: vec![], pid: None, last_prompt: None, limit: None,
        };
        m.inner.lock().unwrap().sessions.insert("a".into(), s);
        m.inner.lock().unwrap().kills.insert("a".into(), (7, oneshot::channel().0));
        // Stop lands while the task still reads the last output (or takes the snapshot): Stop wins.
        m.stop("a").unwrap();
        m.end_run("a", 7, false, Some(LogLine::new("files", "{}")), &cli("none"));
        let s = m.get("a").unwrap();
        assert_eq!(s.status, AgentStatus::Stopped);
        assert_eq!(s.lines.last().unwrap().kind, "files");
        assert!(!s.lines.iter().any(|l| l.kind == "wait"));
    }

    #[test]
    fn retry_asks_the_last_prompt_again() {
        let dir = tempfile::tempdir().unwrap();
        let m = AgentManager::new(broadcast::channel(64).0, dir.path());
        let s = AgentSession {
            id: "a".into(), project_id: "p".into(), branch: "b".into(), cwd: ".".into(), worktree: false,
            status: AgentStatus::Failed, request: "r".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: now(), resume_id: None, ai: Some(cli("none")), queued: vec![], pid: None, last_prompt: None, limit: None,
        };
        m.inner.lock().unwrap().sessions.insert("a".into(), s);
        // A session from before saved prompts: nothing to ask again.
        assert!(m.retry("a", &cli("none")).is_err());
        // Every run saves what it was asked, even one whose CLI then fails to start.
        assert!(m.spawn_or_fail("a", Path::new("."), &cli("none"), "the full prompt", None).is_err());
        assert_eq!(m.get("a").unwrap().last_prompt, None, "never started");
        m.inner.lock().unwrap().sessions.get_mut("a").unwrap().last_prompt = Some("the full prompt".into());
        // No such CLI: it fails to start, after saying it tries again.
        assert!(m.retry("a", &cli("none")).is_err());
        let s = m.get("a").unwrap();
        assert!(s.lines.iter().any(|l| l.text.contains("Trying again")));
        assert_eq!(s.status, AgentStatus::Failed);
        // Not while it works.
        m.inner.lock().unwrap().sessions.get_mut("a").unwrap().status = AgentStatus::Running;
        assert!(m.retry("a", &cli("none")).is_err());
    }

    #[test]
    fn lines_saved_before_timestamps_still_load() {
        let l: LogLine = serde_json::from_str(r#"{"kind":"ai","text":"hi"}"#).unwrap();
        assert_eq!(l.at, None);
        assert!(serde_json::to_string(&l).unwrap().ends_with(r#""text":"hi"}"#));
        assert!(LogLine::new("ai", "hi").at.is_some());
    }

    /// Session `id`, running on `r` in this checkout, asked "the task".
    fn working(id: &str, r: &Resolved) -> AgentSession {
        AgentSession {
            id: id.into(), project_id: "p".into(), branch: "b".into(), cwd: ".".into(), worktree: false,
            status: AgentStatus::Running, request: "the task".into(), agent_label: String::new(), lines: vec![],
            started_at: now(), updated_at: now(), resume_id: None, ai: Some(r.clone()), queued: vec![], pid: None,
            last_prompt: Some("the full task".into()), limit: None,
        }
    }

    #[test]
    fn a_run_stopped_at_a_usage_limit_waits_for_its_reset_with_its_queue() {
        let dir = tempfile::tempdir().unwrap();
        let m = AgentManager::new(broadcast::channel(64).0, dir.path());
        // No such CLI: the continue fails to start instead of running anything.
        let r = cli("none");
        m.inner.lock().unwrap().sessions.insert("a".into(), AgentSession { queued: vec!["also the docs".into()], ..working("a", &r) });
        let reset = chrono::Utc::now().timestamp() + 3 * 3600;
        // Claude Code: told the reset, then refused, then the result.
        m.handle_stream_json("a", &format!(r#"{{"type":"rate_limit_event","rate_limit_info":{{"status":"rejected","resetsAt":{reset},"rateLimitType":"five_hour"}}}}"#));
        m.handle_stream_json("a", r#"{"type":"assistant","is_api_error_message":true,"error":"rate_limit","api_error":"usage_limit_reached","message":{"content":[{"type":"text","text":"You've hit your 5-hour limit · resets 3pm"}]}}"#);
        m.handle_stream_json("a", r#"{"type":"result","subtype":"success","is_error":true,"result":"You've hit your 5-hour limit · resets 3pm"}"#);
        // Said once, at the run's end.
        assert!(m.get("a").unwrap().lines.is_empty());
        ended(&m, "a", true, &r);
        let s = m.get("a").unwrap();
        assert_eq!(s.status, AgentStatus::Waiting);
        let kinds: Vec<&str> = s.lines.iter().map(|l| l.kind.as_str()).collect();
        assert_eq!(kinds, ["limit"]);
        assert_eq!(s.lines[0].text, "You've hit your 5-hour limit · resets 3pm");
        let l = s.limit.clone().unwrap();
        assert_eq!((l.resets_at, l.continue_at, l.credits, l.provider.as_str()), (Some(reset * 1000), Some(reset * 1000 + limits::MARGIN_MS), false, "none"));
        // Its queue waits for the continue, and can change meanwhile: nothing runs it.
        assert_eq!(s.queued, ["also the docs"]);
        m.message("a", "and the tests", &r).unwrap_err();
        let s = m.get("a").unwrap();
        // A message continues it at once, with what was queued: that run failed to start here.
        let said: Vec<&str> = s.lines.iter().filter(|l| l.kind == "cmd").map(|l| l.text.as_str()).collect();
        assert_eq!(said, ["› also the docs", "› and the tests"]);
        assert!(s.queued.is_empty() && s.limit.is_none());
        assert_eq!(s.status, AgentStatus::Failed);
    }

    #[test]
    fn a_limit_without_a_reset_waits_for_you_and_stop_cancels_a_wait() {
        let dir = tempfile::tempdir().unwrap();
        let m = AgentManager::new(broadcast::channel(64).0, dir.path());
        let r = cli("none");
        m.inner.lock().unwrap().sessions.insert("a".into(), working("a", &r));
        m.handle_stream_json("a", r#"{"type":"result","subtype":"success","is_error":true,"result":"Credit balance is too low"}"#);
        ended(&m, "a", true, &r);
        let l = m.get("a").unwrap().limit.unwrap();
        assert!(l.credits && l.resets_at.is_none() && l.continue_at.is_none());

        // A plain CLI says it on stderr, with a reset already past: it would only be refused again.
        m.inner.lock().unwrap().sessions.insert("b".into(), working("b", &r));
        let past = chrono::Utc::now().timestamp_millis() - 60_000;
        m.saw("b", Some(Hit { message: "You've hit your usage limit.".into(), credits: false, resets_at: Some(past) }), None);
        ended(&m, "b", true, &r);
        assert_eq!(m.get("b").unwrap().limit.unwrap().continue_at, None);

        // Stop cancels the continue, and drops the queue back to the prompt box.
        let ahead = chrono::Utc::now().timestamp_millis() + 3_600_000;
        m.inner.lock().unwrap().sessions.insert("c".into(), AgentSession { queued: vec!["q".into()], ..working("c", &r) });
        m.saw("c", Some(Hit { message: "You've hit your usage limit.".into(), credits: false, resets_at: Some(ahead) }), None);
        ended(&m, "c", true, &r);
        m.stop("c").unwrap();
        let s = m.get("c").unwrap();
        assert!(s.limit.is_none() && s.queued.is_empty());
        assert_eq!(s.status, AgentStatus::Stopped);
        assert_eq!(s.lines.last().unwrap().text, "  ■ Auto-continue cancelled");

        // Another failure is still one.
        m.inner.lock().unwrap().sessions.insert("d".into(), working("d", &r));
        m.handle_stream_json("d", r#"{"type":"result","subtype":"success","is_error":true,"result":"Context limit reached · /compact or /clear to continue"}"#);
        ended(&m, "d", true, &r);
        let s = m.get("d").unwrap();
        assert_eq!((s.status, s.limit.is_none()), (AgentStatus::Failed, true));
        assert_eq!(s.lines.iter().filter(|l| l.kind == "err").count(), 2);
    }

    #[test]
    fn a_continue_picks_the_conversation_up_or_asks_again() {
        let limit = |provider: &str| Limit { message: String::new(), provider: provider.into(), credits: false, since: 0, resets_at: None, continue_at: None };
        let mut s = AgentSession { queued: vec!["also the docs".into()], resume_id: Some("rid".into()), ..working("a", &cli("claude")) };
        // Claude Code goes on in its conversation.
        let (prompt, resume) = carried(&s, &cli("claude"), &limit("claude"));
        assert_eq!((prompt, resume), (format!("also the docs\n\n{LIMIT_NOTE}"), Some("rid")));
        // Another CLI is asked its last prompt again.
        s.resume_id = None;
        assert_eq!(carried(&s, &cli("codex"), &limit("codex")).0, "the full task\n\nalso the docs");
        // Picked after another one stopped: the task, and where that one left it.
        assert_eq!(carried(&s, &cli("codex"), &limit("claude")).0, format!("the task\n\n{LIMIT_TASK_NOTE}\n\nalso the docs"));
    }

    #[test]
    fn a_wait_survives_a_restart_and_another_instance_can_take_it() {
        let dir = tempfile::tempdir().unwrap();
        let ahead = chrono::Utc::now().timestamp_millis() + 3_600_000;
        let l = Limit { message: "m".into(), provider: "none".into(), credits: false, since: 0, resets_at: Some(ahead), continue_at: Some(ahead) };
        let held = AgentSession { status: AgentStatus::Waiting, queued: vec!["q".into()], limit: Some(l), ..working("a", &cli("none")) };
        let other = AgentSession { id: "b".into(), ..held.clone() };
        std::fs::write(dir.path().join("agents.json"), serde_json::to_string(&[held.clone(), other]).unwrap()).unwrap();
        let m = AgentManager::new(broadcast::channel(8).0, dir.path());
        let s = m.get("a").unwrap();
        assert_eq!((s.status, s.queued.len(), s.limit.is_some()), (AgentStatus::Waiting, 1, true));

        // The installed app continued it first: its copy is the one to show, and nothing runs here.
        let theirs = AgentSession { status: AgentStatus::Running, limit: None, updated_at: "9999".into(), ..held };
        std::fs::write(dir.path().join("agents.json"), serde_json::to_string(&[theirs]).unwrap()).unwrap();
        m.wake("a", ahead);
        let s = m.get("a").unwrap();
        assert_eq!((s.status, s.limit.is_none()), (AgentStatus::Running, true));
        assert!(!s.lines.iter().any(|l| l.text.contains("Continuing")));

        // The timer of another wait leaves this one alone; its own continues it, queue and all (no such CLI here: it fails to start).
        assert!(m.carry("b", &cli("none"), Some(ahead + 1)).is_err());
        assert!(m.get("b").unwrap().limit.is_some());
        m.wake("b", ahead);
        let s = m.get("b").unwrap();
        let said: Vec<&str> = s.lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(said[..2], ["  ▶ Continuing after the usage limit", "› q"]);
        assert_eq!((s.status, s.limit.is_none(), s.queued.is_empty()), (AgentStatus::Failed, true, true));

        // Its checkout gone meanwhile: it says so and stops waiting, instead of counting down to nothing.
        let gone = AgentSession { id: "c".into(), cwd: "/gone".into(), status: AgentStatus::Waiting, limit: held_limit(ahead), ..working("c", &cli("none")) };
        m.inner.lock().unwrap().sessions.insert("c".into(), gone);
        m.wake("c", ahead);
        let s = m.get("c").unwrap();
        assert_eq!((s.status, s.limit.is_none()), (AgentStatus::Failed, true));
        assert!(s.lines.last().unwrap().text.starts_with("✕ Could not continue after the usage limit"));
    }

    fn held_limit(at: i64) -> Option<Limit> {
        Some(Limit { message: "m".into(), provider: "none".into(), credits: false, since: 0, resets_at: Some(at), continue_at: Some(at) })
    }
}
