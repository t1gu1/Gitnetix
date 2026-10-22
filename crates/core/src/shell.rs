//! Shell commands run from the UI, one terminal per checkout: the main
//! checkout (shared by every branch on it) and each worktree. In memory only;
//! a worktree's terminal goes with it.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, oneshot};

use crate::agents::LogLine;
use crate::error::{Error, Result};
use crate::events::Event;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
    /// Canonical checkout path, the terminal's key.
    pub cwd: String,
    pub lines: Vec<LogLine>,
    pub running: bool,
}

#[derive(Default)]
struct Inner {
    terms: HashMap<String, Terminal>,
    kills: HashMap<String, oneshot::Sender<()>>,
}

#[derive(Clone)]
pub struct Shells {
    inner: Arc<Mutex<Inner>>,
    events: broadcast::Sender<Event>,
}

const MAX_LINES: usize = 2000;

/// The same folder reached through a symlink or a trailing slash is one terminal.
pub fn key(path: &str) -> String {
    std::fs::canonicalize(path).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| path.to_string())
}

impl Shells {
    pub fn new(events: broadcast::Sender<Event>) -> Self {
        Shells { inner: Arc::default(), events }
    }

    pub fn get(&self, path: &str) -> Terminal {
        let cwd = key(path);
        self.inner.lock().unwrap().terms.get(&cwd).cloned().unwrap_or(Terminal { cwd, ..Default::default() })
    }

    fn push(&self, cwd: &str, line: LogLine) {
        {
            let mut g = self.inner.lock().unwrap();
            let t = g.terms.entry(cwd.to_string()).or_insert_with(|| Terminal { cwd: cwd.to_string(), ..Default::default() });
            t.lines.push(line.clone());
            if t.lines.len() > MAX_LINES {
                let drop = t.lines.len() - MAX_LINES;
                t.lines.drain(..drop);
            }
        }
        let _ = self.events.send(Event::ShellLine { cwd: cwd.to_string(), line });
    }

    fn set_running(&self, cwd: &str, running: bool) {
        if let Some(t) = self.inner.lock().unwrap().terms.get_mut(cwd) {
            t.running = running;
        }
        let _ = self.events.send(Event::ShellChanged { cwd: cwd.to_string() });
    }

    /// Runs `command` with the user's login shell in `path`, one at a time per terminal.
    pub fn run(&self, path: &str, command: &str) -> Result<()> {
        let cwd = key(path);
        if self.inner.lock().unwrap().terms.get(&cwd).is_some_and(|t| t.running) {
            return Err(Error::Invalid("A command is already running in this terminal".into()));
        }
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", command]);
            c
        } else {
            // Login shell: a desktop app's PATH lacks what the user's profile adds.
            let mut c = Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
            c.args(["-lc", command]);
            c
        };
        cmd.current_dir(Path::new(&cwd)).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        // Its own process group, so stopping also stops what it started (dev servers, test runners).
        #[cfg(unix)]
        cmd.process_group(0);
        self.push(&cwd, LogLine { kind: "cmd".into(), text: command.into() });
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.push(&cwd, LogLine { kind: "err".into(), text: e.to_string() });
                return Err(e.into());
            }
        };
        let pid = child.id();
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
        self.inner.lock().unwrap().kills.insert(cwd.clone(), kill_tx);
        self.set_running(&cwd, true);

        let out = self.pipe(&cwd, "run", child.stdout.take().expect("stdout"));
        let err = self.pipe(&cwd, "dim", child.stderr.take().expect("stderr"));
        let me = self.clone();
        tokio::spawn(async move {
            let exit = tokio::select! {
                s = child.wait() => Some(s),
                _ = &mut kill_rx => {
                    #[cfg(unix)]
                    if let Some(pid) = pid {
                        let _ = std::process::Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
                    }
                    let _ = child.kill().await;
                    None
                }
            };
            let _ = tokio::join!(out, err);
            me.inner.lock().unwrap().kills.remove(&cwd);
            match exit {
                None => me.push(&cwd, LogLine { kind: "dim".into(), text: "■ Stopped".into() }),
                Some(Ok(s)) if s.success() => {}
                Some(Ok(s)) => me.push(&cwd, LogLine { kind: "err".into(), text: format!("Exited with {}", s.code().map_or("a signal".into(), |c| format!("code {c}"))) }),
                Some(Err(e)) => me.push(&cwd, LogLine { kind: "err".into(), text: e.to_string() }),
            }
            me.set_running(&cwd, false);
        });
        Ok(())
    }

    fn pipe(&self, cwd: &str, kind: &'static str, r: impl AsyncRead + Unpin + Send + 'static) -> tokio::task::JoinHandle<()> {
        let me = self.clone();
        let cwd = cwd.to_string();
        tokio::spawn(async move {
            // Lossy: output that is not UTF-8 must not stop the pipe from draining.
            let mut r = BufReader::new(r);
            let mut buf = Vec::new();
            while r.read_until(b'\n', &mut buf).await.is_ok_and(|n| n > 0) {
                let l = String::from_utf8_lossy(&buf);
                me.push(&cwd, LogLine { kind: kind.into(), text: l.trim_end_matches(['\n', '\r']).to_string() });
                buf.clear();
            }
        })
    }

    pub fn stop(&self, path: &str) {
        if let Some(tx) = self.inner.lock().unwrap().kills.remove(&key(path)) {
            let _ = tx.send(());
        }
    }

    /// Stops the running command and forgets the terminal (its worktree is going away).
    pub fn remove(&self, path: &str) {
        let cwd = key(path);
        self.stop(&cwd);
        self.inner.lock().unwrap().terms.remove(&cwd);
        let _ = self.events.send(Event::ShellChanged { cwd });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_in_the_checkout_and_forgets_it_on_remove() {
        let (tx, mut rx) = broadcast::channel(64);
        let sh = Shells::new(tx);
        let dir = std::env::temp_dir();
        let path = dir.to_string_lossy().to_string();
        sh.run(&path, "pwd; echo oops >&2; exit 3").unwrap();
        assert!(sh.run(&path, "true").is_err(), "one command at a time");
        while let Ok(e) = rx.recv().await {
            if matches!(e, Event::ShellChanged { .. }) && !sh.get(&path).running {
                break;
            }
        }
        let t = sh.get(&path);
        let texts: Vec<(&str, &str)> = t.lines.iter().map(|l| (l.kind.as_str(), l.text.as_str())).collect();
        assert_eq!(texts[0], ("cmd", "pwd; echo oops >&2; exit 3"));
        assert!(texts.contains(&("run", key(&path).as_str())));
        assert!(texts.contains(&("dim", "oops")));
        assert_eq!(texts.last(), Some(&("err", "Exited with code 3")));
        sh.remove(&path);
        assert!(sh.get(&path).lines.is_empty());
    }
}
