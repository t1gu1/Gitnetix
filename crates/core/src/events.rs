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
}
