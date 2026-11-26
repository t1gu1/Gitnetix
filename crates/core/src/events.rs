use serde::Serialize;

use crate::agents::{AgentStatus, LogLine, SubTask};

/// Pushed to every UI (desktop window, mobile companion) as it happens.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    AgentLine { session_id: String, line: LogLine },
    #[serde(rename_all = "camelCase")]
    AgentStatus { session_id: String, status: AgentStatus },
    /// What a session's run has going in the background now (Claude Code sub agents, workflows, commands).
    #[serde(rename_all = "camelCase")]
    AgentTasks { session_id: String, tasks: Vec<SubTask> },
    #[serde(rename_all = "camelCase")]
    ProjectChanged { project_id: String },
    /// Files of a checkout changed (a save, a `git add`): its uncommitted files are worth re-reading.
    /// `branch`: the one checked out there; none: every checkout of the project.
    #[serde(rename_all = "camelCase")]
    FilesChanged { project_id: String, branch: Option<String> },
    #[serde(rename_all = "camelCase")]
    ConfigChanged {},
    /// Debug builds (scripts/two-apps.mjs): the desktop app saves a picture of its window as `window.png` in its settings folder.
    Screenshot {},
    /// Another instance on the same settings folder switched to `profile`, and this one followed.
    ProfileSwitched { profile: crate::store::UserProfile },
    /// Events went past this UI while it was behind (a busy terminal writes one per read): what it shows may be stale,
    /// read it all again.
    Missed {},
    /// One branch of a running cleanup is done with (deleted or kept).
    #[serde(rename_all = "camelCase")]
    CleanupStep { project_id: String, branch: String },
    /// AI starts resolving these conflicted files; it takes a while.
    #[serde(rename_all = "camelCase")]
    ConflictResolving { project_id: String, files: Vec<String> },
    /// A rebase AI carries through moved on (a commit, a file resolved), or ended (`run.state`).
    RebaseRun { run: crate::app::RebaseRun },
    /// A new line in the Logs page.
    Log { entry: crate::log::Entry },
    /// One of the project's hooks ran: its last runs on the Hooks page changed.
    #[serde(rename_all = "camelCase")]
    HookRan { project_id: String },
    /// Output of terminal `tab` of a checkout, base64; `end` counts its bytes so far.
    #[serde(rename_all = "camelCase")]
    ShellData { cwd: String, tab: u32, data: String, end: u64 },
    /// A checkout's shell exited or its terminal was removed.
    #[serde(rename_all = "camelCase")]
    ShellExit { cwd: String, tab: u32 },
    /// A long rebuild of a project's branches: `done` of the `total` it redoes so far.
    #[serde(rename_all = "camelCase")]
    OverviewProgress { project_id: String, done: u32, total: u32 },
    /// A long stage, unstage or discard: `done` of the `total` files it handles so far.
    #[serde(rename_all = "camelCase")]
    FilesProgress { project_id: String, done: u32, total: u32 },
    /// The speech model's first download, for voice dictation: `done` bytes of `total`.
    #[serde(rename_all = "camelCase")]
    DictationModel { done: u64, total: u64 },
    /// An AI CLI failed because its own sign-in expired: the UI offers to sign in again.
    AiSignedOut { provider: String },
    /// api.github.com turned down the saved token, renewed or not: the UI offers to sign in to GitHub again.
    GithubSignedOut,
    /// A GitHub webhook of the project fired (live.rs): its pull requests and checks are worth reading again; `push`, its branches.
    #[serde(rename_all = "camelCase")]
    RemoteChanged { project_id: String, event: String },
    /// This computer joined or left the relay that brings the webhooks.
    LiveChanged {},
}
