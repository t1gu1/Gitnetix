use serde::Serialize;

use crate::agents::{AgentStatus, LogLine};

/// Pushed to every UI (desktop window, mobile companion) as it happens.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    AgentLine { session_id: String, line: LogLine },
    #[serde(rename_all = "camelCase")]
    AgentStatus { session_id: String, status: AgentStatus },
    #[serde(rename_all = "camelCase")]
    ProjectChanged { project_id: String },
    #[serde(rename_all = "camelCase")]
    ConfigChanged {},
    /// One branch of a running cleanup is done with (deleted or kept).
    #[serde(rename_all = "camelCase")]
    CleanupStep { project_id: String, branch: String },
    /// AI starts resolving these conflicted files; it takes a while.
    #[serde(rename_all = "camelCase")]
    ConflictResolving { project_id: String, files: Vec<String> },
    /// A new line in the Logs page.
    Log { entry: crate::log::Entry },
    /// Output of a checkout's terminal, base64; `end` counts its bytes so far.
    #[serde(rename_all = "camelCase")]
    ShellData { cwd: String, data: String, end: u64 },
    /// A checkout's shell exited or its terminal was removed.
    #[serde(rename_all = "camelCase")]
    ShellExit { cwd: String },
    /// A long rebuild of a project's branches: `done` of the `total` it redoes so far.
    #[serde(rename_all = "camelCase")]
    OverviewProgress { project_id: String, done: u32, total: u32 },
    /// The speech model's first download, for voice dictation: `done` bytes of `total`.
    #[serde(rename_all = "camelCase")]
    DictationModel { done: u64, total: u64 },
}
