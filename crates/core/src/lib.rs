//! Gitnetix engine: release-centric Git workflow with AI built in.
//!
//! Front ends (Tauri desktop, companion HTTP API, MCP) call [`rpc::call`].

pub mod account;
pub mod agents;
pub mod ai;
pub mod analytics;
pub mod app;
pub mod auto_resolve;
pub mod backup;
pub mod cache;
pub mod dictation;
pub mod error;
pub mod events;
pub mod git;
pub mod hooks;
pub mod limits;
pub mod live;
pub mod log;
pub mod net;
pub mod project_commands;
pub mod providers;
pub mod rpc;
pub mod secrets;
pub mod shell;
pub mod skills;
pub mod sprints;
pub mod store;
pub mod submodules;
pub mod templates;
pub mod tickets;
pub mod vault;
pub mod watch;

pub use app::Gitnetix;
pub use error::{Error, ErrorBody, Result};
pub use events::Event;

/// The async runtime the server and the desktop app run on. Its worker threads get 8 MiB of stack, not tokio's 2 MiB: in a
/// debug build the RPC dispatch alone takes about 1.6 MB, and a project's first overview overflowed the rest.
pub fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(8 << 20).build()
}
