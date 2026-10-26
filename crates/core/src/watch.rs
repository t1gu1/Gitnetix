//! Watches each project's `.git` so changes made outside Gitnetix (a pull in a
//! terminal, a commit from an editor) refresh every UI. Git records each ref
//! move, checkout, fetch and rebase step as a file write there.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::broadcast;

use crate::events::Event;
use crate::store::Project;

/// Writes in a burst (a pull moves several refs) become one refresh.
const SETTLE: Duration = Duration::from_millis(300);

/// Watch the git dirs of `projects`; dropping the result stops watching.
pub fn watch(projects: &[Project], events: broadcast::Sender<Event>) -> Option<RecommendedWatcher> {
    let dirs: Vec<(PathBuf, String)> = projects.iter().filter_map(|p| Some((git_dir(Path::new(&p.path))?, p.id.clone()))).collect();
    let (tx, rx) = mpsc::channel::<String>();
    let owners = dirs.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        // Reads (git opening HEAD or a ref, Gitnetix's own included) aren't changes.
        if !(ev.kind.is_create() || ev.kind.is_modify() || ev.kind.is_remove()) {
            return;
        }
        for path in &ev.paths {
            if let Some((dir, id)) = owners.iter().find(|(d, _)| path.starts_with(d)) {
                if relevant(path.strip_prefix(dir).unwrap_or(path)) {
                    let _ = tx.send(id.clone());
                }
            }
        }
    })
    .map_err(|e| tracing::warn!("not watching git changes: {e}"))
    .ok()?;
    for (dir, _) in &dirs {
        if let Err(e) = watcher.watch(dir, RecursiveMode::Recursive) {
            tracing::warn!("not watching {}: {e}", dir.display());
        }
    }
    // Ends when the watcher (and with it `tx`) is dropped.
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut ids = BTreeSet::from([first]);
            let until = Instant::now() + SETTLE;
            while let Some(left) = until.checked_duration_since(Instant::now()) {
                match rx.recv_timeout(left) {
                    Ok(id) => {
                        ids.insert(id);
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            for project_id in ids {
                let _ = events.send(Event::ProjectChanged { project_id });
            }
        }
    });
    Some(watcher)
}

/// The repository's common git dir (shared by its worktrees).
fn git_dir(repo: &Path) -> Option<PathBuf> {
    let out = crate::shell::without_appimage(&mut Command::new("git")).current_dir(repo).args(["rev-parse", "--path-format=absolute", "--git-common-dir"]).output().ok()?;
    let dir = PathBuf::from(String::from_utf8(out.stdout).ok()?.trim());
    (out.status.success() && dir.is_dir()).then_some(dir)
}

/// Refs, HEADs and in-progress operations. Not `index`: Gitnetix's own `git status`
/// rewrites it, which would refresh forever (uncommitted files are polled instead).
/// Not `objects` or `logs`: they only change alongside a ref.
fn relevant(rel: &Path) -> bool {
    let Some(Component::Normal(first)) = rel.components().next() else { return false };
    match first.to_str().unwrap_or("") {
        "refs" | "packed-refs" | "worktrees" | "rebase-merge" | "rebase-apply" => !rel.ends_with("index") && !rel.ends_with("index.lock"),
        name => name.ends_with("HEAD") || name.ends_with("HEAD.lock"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_ref_changes_only() {
        for p in ["HEAD", "FETCH_HEAD", "ORIG_HEAD", "refs/heads/feat/x", "refs/remotes/origin/main", "packed-refs", "worktrees/wt/HEAD", "rebase-merge/done"] {
            assert!(relevant(Path::new(p)), "{p}");
        }
        for p in ["index", "index.lock", "objects/ab/cdef", "logs/HEAD", "config", "worktrees/wt/index"] {
            assert!(!relevant(Path::new(p)), "{p}");
        }
    }
}
