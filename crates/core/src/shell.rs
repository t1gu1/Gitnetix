//! Interactive terminals, one per checkout: the main checkout (shared by
//! every branch on it) and each worktree. Each runs the user's login shell
//! in a pseudo-terminal; the UI renders it with a terminal emulator. In
//! memory only; a worktree's terminal goes with it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tokio::sync::broadcast;

use crate::error::{Error, Result};
use crate::events::Event;

/// What a UI needs to show a terminal: its recent output, then `shellData` events past `end`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Canonical checkout path, the terminal's key.
    pub cwd: String,
    /// Recent output, base64 (raw bytes: a chunk may split a UTF-8 character).
    pub data: String,
    /// Bytes output since the terminal was first opened; `data` ends there.
    pub end: u64,
}

struct Live {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
struct Term {
    backlog: Vec<u8>,
    end: u64,
    /// None once the shell exited; opening it again starts a new one.
    live: Option<Live>,
}

#[derive(Clone)]
pub struct Shells {
    terms: Arc<Mutex<HashMap<String, Term>>>,
    events: broadcast::Sender<Event>,
}

/// Output kept for a UI that opens the terminal later.
const BACKLOG: usize = 512 * 1024;

/// The same folder reached through a symlink or a trailing slash is one terminal.
pub fn key(path: &str) -> String {
    std::fs::canonicalize(path).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| path.to_string())
}

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 }
}

impl Shells {
    pub fn new(events: broadcast::Sender<Event>) -> Self {
        Shells { terms: Arc::default(), events }
    }

    /// The terminal of `path`, starting its shell if none runs.
    pub fn open(&self, path: &str, cols: u16, rows: u16) -> Result<Snapshot> {
        let cwd = key(path);
        let mut g = self.terms.lock().unwrap();
        let t = g.entry(cwd.clone()).or_default();
        match &t.live {
            Some(l) => {
                let _ = l.master.resize(size(cols, rows));
            }
            None => t.live = Some(self.spawn(&cwd, cols, rows)?),
        }
        Ok(Snapshot { cwd, data: b64(&t.backlog), end: t.end })
    }

    fn spawn(&self, cwd: &str, cols: u16, rows: u16) -> Result<Live> {
        let pair = native_pty_system().openpty(size(cols, rows))?;
        // The user's login shell: a desktop app's PATH lacks what their profile adds.
        let mut cmd = CommandBuilder::new_default_prog();
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Gitnetix");
        // Apps started from the Dock get no locale, and shells then mangle non-ASCII input.
        if std::env::var_os("LANG").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }
        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let writer = Arc::new(Mutex::new(pair.master.take_writer()?));
        let mut reader = pair.master.try_clone_reader()?;

        let me = self.clone();
        let cwd = cwd.to_string();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut g = me.terms.lock().unwrap();
                let Some(t) = g.get_mut(&cwd) else { break };
                t.backlog.extend_from_slice(&buf[..n]);
                if t.backlog.len() > BACKLOG {
                    let drop = t.backlog.len() - BACKLOG;
                    t.backlog.drain(..drop);
                }
                t.end += n as u64;
                // Sent under the lock, so a snapshot and the events after it never overlap or leave a gap.
                let _ = me.events.send(Event::ShellData { cwd: cwd.clone(), data: b64(&buf[..n]), end: t.end });
            }
            let _ = child.wait();
            if let Some(t) = me.terms.lock().unwrap().get_mut(&cwd) {
                t.live = None;
            }
            let _ = me.events.send(Event::ShellExit { cwd });
        });
        Ok(Live { master: pair.master, writer, killer })
    }

    /// Types `data` (keystrokes, a paste) into the terminal of `path`.
    pub async fn write(&self, path: &str, data: &str) -> Result<()> {
        let w = {
            let g = self.terms.lock().unwrap();
            g.get(&key(path)).and_then(|t| t.live.as_ref()).map(|l| l.writer.clone()).ok_or_else(|| Error::NotFound("No shell runs in this checkout".into()))?
        };
        let data = data.as_bytes().to_vec();
        // A shell that does not read blocks a big paste; that must not stall the engine.
        tokio::task::spawn_blocking(move || w.lock().unwrap().write_all(&data)).await.map_err(|e| Error::Other(e.to_string()))??;
        Ok(())
    }

    pub fn resize(&self, path: &str, cols: u16, rows: u16) -> Result<()> {
        if let Some(l) = self.terms.lock().unwrap().get(&key(path)).and_then(|t| t.live.as_ref()) {
            l.master.resize(size(cols, rows))?;
        }
        Ok(())
    }

    /// Ends the shell and forgets the terminal (its worktree is going away).
    pub fn remove(&self, path: &str) {
        let cwd = key(path);
        if let Some(mut l) = self.terms.lock().unwrap().remove(&cwd).and_then(|t| t.live) {
            let _ = l.killer.kill();
        }
        let _ = self.events.send(Event::ShellExit { cwd });
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn decode(s: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.decode(s).unwrap()
    }

    #[tokio::test]
    async fn runs_a_shell_in_the_checkout_and_forgets_it_on_remove() {
        let (tx, mut rx) = broadcast::channel(1024);
        let sh = Shells::new(tx);
        let path = std::env::temp_dir().to_string_lossy().to_string();
        let first = sh.open(&path, 80, 24).unwrap();
        sh.write(&path, "echo gnx-$((40+2)); exit\n").await.unwrap();
        let mut out = decode(&first.data);
        let mut end = first.end;
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv()).await.expect("shell output").unwrap() {
                Event::ShellData { data, end: e, .. } => {
                    let d = decode(&data);
                    assert_eq!(e - d.len() as u64, end, "no gap between snapshot and events");
                    end = e;
                    out.extend(d);
                }
                Event::ShellExit { .. } => break,
                _ => {}
            }
        }
        assert!(String::from_utf8_lossy(&out).contains("gnx-42"));
        assert_eq!(sh.open(&path, 80, 24).unwrap().end, end, "reopening keeps the output and starts a new shell");
        sh.remove(&path);
        assert!(sh.write(&path, "x").await.is_err());
    }
}
