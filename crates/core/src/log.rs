//! What the app tried and what failed, kept in memory for the Logs page: easy to copy and share.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tokio::sync::broadcast;

use crate::events::Event;

/// Oldest entries go past this many.
const MAX: usize = 2000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub at: String,
    pub error: bool,
    pub text: String,
}

static LOG: Mutex<VecDeque<Entry>> = Mutex::new(VecDeque::new());
static EVENTS: OnceLock<broadcast::Sender<Event>> = OnceLock::new();

/// Push each new entry to the UIs as it's written.
pub fn attach(events: broadcast::Sender<Event>) {
    let _ = EVENTS.set(events);
}

pub fn info(text: impl Into<String>) {
    push(false, text.into());
}

pub fn error(text: impl Into<String>) {
    push(true, text.into());
}

/// `text` with the `user:password@` of any URL hidden: clone and remote URLs can carry a token, and logs get shared.
fn redact(text: &str) -> String {
    static CREDENTIALS: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"([A-Za-z][A-Za-z0-9+.-]*://)[^/\s@]+@").unwrap());
    CREDENTIALS.replace_all(text, "${1}***@").into_owned()
}

fn push(error: bool, text: String) {
    let text = redact(&text);
    if error {
        tracing::warn!("{text}");
    } else {
        tracing::info!("{text}");
    }
    let entry = Entry { at: crate::store::now(), error, text };
    {
        let mut log = LOG.lock().unwrap_or_else(|e| e.into_inner());
        if log.len() == MAX {
            log.pop_front();
        }
        log.push_back(entry.clone());
    }
    emit(Event::Log { entry });
}

/// Send `event` to the UIs. Does nothing before `attach`.
pub fn emit(event: Event) {
    if let Some(tx) = EVENTS.get() {
        let _ = tx.send(event);
    }
}

pub fn all() -> Vec<Entry> {
    LOG.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
}

pub fn clear() {
    LOG.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[test]
fn urls_lose_their_credentials() {
    assert_eq!(redact("git clone -- https://oauth2:glpat-x1@gitlab.com/g/r.git dest"), "git clone -- https://***@gitlab.com/g/r.git dest");
    assert_eq!(redact("https://github.com/a/b@v1 and ssh://git@host/r"), "https://github.com/a/b@v1 and ssh://***@host/r");
    assert_eq!(redact("Done projects.clone in 3ms"), "Done projects.clone in 3ms");
}
