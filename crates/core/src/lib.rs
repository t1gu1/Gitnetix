//! Gitnetix engine: release-centric Git workflow with AI built in.
//!
//! Front ends (Tauri desktop, companion HTTP API, MCP) call [`rpc::call`].

pub mod agents;
pub mod ai;
pub mod analytics;
pub mod app;
pub mod error;
pub mod events;
pub mod git;
pub mod providers;
pub mod rpc;
pub mod secrets;
pub mod store;
pub mod templates;
pub mod tickets;
pub mod watch;

pub use app::Gitnetix;
pub use error::{Error, ErrorBody, Result};
pub use events::Event;
