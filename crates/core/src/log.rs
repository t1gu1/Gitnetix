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

fn push(error: bool, text: String) {
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
    if let Some(tx) = EVENTS.get() {
        let _ = tx.send(Event::Log { entry });
    }
}

pub fn all() -> Vec<Entry> {
    LOG.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
}

pub fn clear() {
    LOG.lock().unwrap_or_else(|e| e.into_inner()).clear();
}
