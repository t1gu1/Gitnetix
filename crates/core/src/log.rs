//! What the app tried and what failed, kept in memory for the Logs page: easy to copy and share.
//! Also appended to `<data dir>/logs/gitnetix.log` (macOS: `~/Library/Application Support/gitnetix/logs/`), read it to debug a run.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock};

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

/// Past this size the log file moves to `gitnetix.old.log` and a new one starts: the logs never take more than twice this.
const FILE_MAX: u64 = 5 << 20;

struct LogFile {
    path: PathBuf,
    file: File,
    size: u64,
}

static LOG: Mutex<VecDeque<Entry>> = Mutex::new(VecDeque::new());
static EVENTS: OnceLock<broadcast::Sender<Event>> = OnceLock::new();
static FILE: Mutex<Option<LogFile>> = Mutex::new(None);

/// Push each new entry to the UIs as it's written, and append it to `<dir>/logs/gitnetix.log`.
pub fn attach(events: broadcast::Sender<Event>, dir: &Path) {
    let _ = EVENTS.set(events);
    let path = dir.join("logs").join("gitnetix.log");
    let _ = std::fs::create_dir_all(dir.join("logs"));
    *FILE.lock().unwrap_or_else(|e| e.into_inner()) = open(&path).map(|file| LogFile { size: file.metadata().map(|m| m.len()).unwrap_or(0), path, file });
}

/// Open for appending, readable by its owner only: entries can hold paths and AI answers.
fn open(path: &Path) -> Option<File> {
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(path).ok()
}

fn write(entry: &Entry) {
    let mut guard = FILE.lock().unwrap_or_else(|e| e.into_inner());
    if guard.as_mut().is_some_and(|log| !log.append(entry)) {
        *guard = None;
    }
}

impl LogFile {
    /// False when the file could not be opened again after moving it aside.
    fn append(&mut self, entry: &Entry) -> bool {
        if self.size >= FILE_MAX {
            let _ = std::fs::rename(&self.path, self.path.with_extension("old.log"));
            let Some(file) = open(&self.path) else { return false };
            self.file = file;
            self.size = 0;
        }
        let line = format!("{} {} {}\n", entry.at, if entry.error { "ERROR" } else { "INFO " }, entry.text);
        if self.file.write_all(line.as_bytes()).is_ok() {
            self.size += line.len() as u64;
        }
        true
    }
}

/// The first line of a run: the version, and for a dev build the release it starts from, its branch and commit.
pub fn started() {
    static LINE: LazyLock<String> = LazyLock::new(|| {
        let os = std::env::consts::OS;
        if !cfg!(debug_assertions) {
            // The release workflow sets the tag: Cargo.toml keeps 0.1.0, the bundle gets its version from `tauri build --config`.
            let version = option_env!("GITNETIX_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")).trim_start_matches('v');
            return format!("Started Gitnetix {version} on {os}");
        }
        // shortcut: reads the source tree when the app starts, not when it was built; fine while dev builds rebuild on every change.
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").current_dir(env!("CARGO_MANIFEST_DIR")).args(args).output().ok()?;
            out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        };
        let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|| "unknown".into());
        // "v0.26.2-3-g857d660": the last tag, the commits since, and the commit.
        let describe = git(&["describe", "--tags", "--long", "--match", "v*"]).unwrap_or_default();
        match describe.rsplitn(3, '-').collect::<Vec<_>>()[..] {
            [sha, ahead, tag] => format!("Started Gitnetix dev build on {os}, based on {tag} plus {ahead} commits, branch {branch} at commit {}", sha.trim_start_matches('g')),
            _ => format!("Started Gitnetix dev build on {os}, branch {branch} at commit {}", git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into())),
        }
    });
    info(LINE.as_str());
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
    write(&entry);
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
fn the_file_moves_aside_past_its_limit() {
    let dir = std::env::temp_dir().join(format!("gitnetix-log-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("gitnetix.log");
    let mut log = LogFile { file: open(&path).unwrap(), path, size: 0 };
    let entry = |text: &str| Entry { at: "now".into(), error: false, text: text.into() };
    assert!(log.append(&entry("before the limit")));
    log.size = FILE_MAX;
    assert!(log.append(&entry("after the limit")));
    assert_eq!(std::fs::read_to_string(dir.join("gitnetix.old.log")).unwrap(), "now INFO  before the limit\n");
    assert_eq!(std::fs::read_to_string(dir.join("gitnetix.log")).unwrap(), "now INFO  after the limit\n");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn urls_lose_their_credentials() {
    assert_eq!(redact("git clone -- https://oauth2:glpat-x1@gitlab.com/g/r.git dest"), "git clone -- https://***@gitlab.com/g/r.git dest");
    assert_eq!(redact("https://github.com/a/b@v1 and ssh://git@host/r"), "https://github.com/a/b@v1 and ssh://***@host/r");
    assert_eq!(redact("Done projects.clone in 3ms"), "Done projects.clone in 3ms");
}
