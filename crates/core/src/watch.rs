//! Watches each project's `.git` so changes made outside Gitnetix (a pull in a
//! terminal, a commit from an editor) refresh every UI. Git records each ref
//! move, checkout, fetch and rebase step as a file write there.
//!
//! Also watches the files of every checkout (the folders git ignores left out), so a save
//! refreshes the list of uncommitted files instead of a timer re-reading it with 4 git processes.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use notify::event::{EventKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::broadcast;

use crate::events::Event;
use crate::store::Project;

/// Writes in a burst (a pull moves several refs, an editor saves through a temp file) become one refresh.
const SETTLE: Duration = Duration::from_millis(300);
/// A checkout that keeps changing (an agent at work) re-reads its files at most this often: the old timer's rate.
const GAP: Duration = Duration::from_millis(if cfg!(test) { 600 } else { 4000 });

/// Watching stops when this is dropped.
pub struct Watch {
    _watcher: Arc<Mutex<RecommendedWatcher>>,
}

enum Msg {
    /// A path written, created or removed; `new`: it may be a folder that just appeared.
    Path { path: PathBuf, new: bool },
    /// Events were lost (a full kernel queue): anything may have changed.
    Lost,
}

/// What a refresh is due for.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
enum Key {
    /// The project's branches and everything else ([`Event::ProjectChanged`]).
    Refs(String),
    /// The uncommitted files of the checkout of a branch; none: of every checkout of the project.
    Files(String, Option<String>),
}

struct Repo {
    id: String,
    path: PathBuf,
    git_dir: PathBuf,
    checkouts: Vec<Checkout>,
}

struct Checkout {
    root: PathBuf,
    branch: Option<String>,
    /// Its folder under `.git/worktrees`, which holds its index; none for the main checkout.
    admin: Option<String>,
    ignored: Ignored,
    /// Could not be fully watched (the inotify limit): its files are re-read on the old timer instead.
    polled: bool,
}

/// What git ignores in a checkout, as `git status --ignored=matching` says: folders matched by a rule
/// (never one holding a tracked file), and ignored files in the other folders. Paths relative to the checkout,
/// with `/` as git writes them, whatever separator the OS reports.
#[derive(Default, Debug)]
struct Ignored {
    dirs: HashSet<String>,
    files: HashSet<String>,
}

impl Ignored {
    fn read(root: &Path) -> Ignored {
        parse_ignored(&git(root, &["status", "--porcelain=v1", "-z", "--ignored=matching", "-unormal"]).unwrap_or_default())
    }

    fn covers(&self, rel: &Path) -> bool {
        self.files.contains(&slashed(rel)) || rel.ancestors().any(|a| self.dirs.contains(&slashed(a)))
    }
}

/// Watch the git dirs and checkouts of `projects`; dropping the result stops watching.
pub fn watch(projects: &[Project], events: broadcast::Sender<Event>) -> Option<Watch> {
    let repos: Vec<Repo> = projects
        .iter()
        .filter_map(|p| Some(Repo { id: p.id.clone(), path: PathBuf::from(&p.path), git_dir: real(&git_dir(Path::new(&p.path))?), checkouts: Vec::new() }))
        .collect();
    let (tx, rx) = mpsc::channel::<Msg>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if ev.need_rescan() {
            let _ = tx.send(Msg::Lost);
            return;
        }
        // Reads (git opening HEAD or a ref, Gitnetix's own included) aren't changes. Windows reports a
        // full event buffer as an `Any` on the watched folder, which counts as a change there.
        if ev.kind.is_access() {
            return;
        }
        let new = ev.kind.is_create() || matches!(ev.kind, EventKind::Modify(ModifyKind::Name(_)));
        // Windows also reports a folder as modified when a file in it is: that file's own event says it.
        let touched = matches!(ev.kind, EventKind::Modify(_)) && !new;
        for path in ev.paths {
            if !(touched && path.is_dir()) {
                let _ = tx.send(Msg::Path { path, new });
            }
        }
    })
    .map_err(|e| tracing::warn!("not watching git changes: {e}"))
    .ok()?;
    for r in &repos {
        if let Err(e) = watcher.watch(&r.git_dir, RecursiveMode::Recursive) {
            tracing::warn!("not watching {}: {e}", r.git_dir.display());
        }
    }
    let watcher = Arc::new(Mutex::new(watcher));
    // Checkouts are listed and watched off the caller's thread: that takes git processes. Holding only a weak
    // reference, the thread ends once the watcher (and with it the sender) is dropped.
    let weak = Arc::downgrade(&watcher);
    std::thread::spawn(move || run(repos, &rx, &weak, &events));
    Some(Watch { _watcher: watcher })
}

fn run(mut repos: Vec<Repo>, rx: &Receiver<Msg>, w: &Weak<Mutex<RecommendedWatcher>>, events: &broadcast::Sender<Event>) {
    let mut due: HashMap<Key, Instant> = HashMap::new();
    let mut last: HashMap<Key, Instant> = HashMap::new();
    for r in &mut repos {
        if relist(w, r).is_none() {
            return;
        }
        // A save made while this was setting up went unseen.
        mark(&mut due, &last, Key::Files(r.id.clone(), None), Instant::now());
    }
    let mut next_poll = Instant::now() + GAP;
    loop {
        let polling = repos.iter().any(|r| r.checkouts.iter().any(|c| c.polled));
        let wake = due.values().min().copied().into_iter().chain(polling.then_some(next_poll)).min();
        let first = match wake {
            Some(t) => rx.recv_timeout(t.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        let mut batch = match first {
            Ok(m) => vec![m],
            Err(RecvTimeoutError::Timeout) => Vec::new(),
            Err(RecvTimeoutError::Disconnected) => return,
        };
        batch.extend(rx.try_iter());
        if handle(&mut repos, batch, w, &mut due, &last).is_none() {
            return;
        }
        let now = Instant::now();
        if polling && now >= next_poll {
            for r in &repos {
                for c in r.checkouts.iter().filter(|c| c.polled) {
                    mark(&mut due, &last, Key::Files(r.id.clone(), c.branch.clone()), now);
                }
            }
            next_poll = now + GAP;
        }
        let ready: Vec<Key> = due.iter().filter(|(_, t)| **t <= now).map(|(k, _)| k.clone()).collect();
        // A project refreshed whole needs no separate file refresh.
        let whole: HashSet<String> = ready.iter().filter_map(|k| if let Key::Refs(id) = k { Some(id.clone()) } else { None }).collect();
        due.retain(|k, t| match k {
            Key::Refs(_) => *t > now,
            Key::Files(id, _) => *t > now && !whole.contains(id),
        });
        for k in ready {
            match k {
                Key::Refs(project_id) => {
                    let _ = events.send(Event::ProjectChanged { project_id });
                }
                Key::Files(ref project_id, ref branch) if !whole.contains(project_id) => {
                    let _ = events.send(Event::FilesChanged { project_id: project_id.clone(), branch: branch.clone() });
                    last.insert(k, now);
                }
                Key::Files(..) => {}
            }
        }
    }
}

/// Mark `key` for a refresh once writes settle; a checkout's files no sooner than [`GAP`] after their last one.
fn mark(due: &mut HashMap<Key, Instant>, last: &HashMap<Key, Instant>, key: Key, now: Instant) {
    let mut at = now + SETTLE;
    if let (Key::Files(..), Some(l)) = (&key, last.get(&key)) {
        at = at.max(*l + GAP);
    }
    due.entry(key).or_insert(at);
}

/// Sort a batch of changed paths into refreshes. None once the watcher is gone.
fn handle(repos: &mut [Repo], batch: Vec<Msg>, w: &Weak<Mutex<RecommendedWatcher>>, due: &mut HashMap<Key, Instant>, last: &HashMap<Key, Instant>) -> Option<()> {
    let now = Instant::now();
    // First what changes the checkouts themselves: worktrees added or switched, ignore rules, new folders.
    let mut relists = HashSet::new();
    let mut rereads = HashSet::new();
    for m in &batch {
        match m {
            Msg::Lost => {
                for r in repos.iter() {
                    mark(due, last, Key::Refs(r.id.clone()), now);
                }
            }
            Msg::Path { path, new } => match locate(repos, path) {
                Some(Place::Git(i, rel)) => match git_change(&rel) {
                    GitChange::Checkouts => {
                        relists.insert(i);
                    }
                    GitChange::Exclude => rereads.extend(repos[i].checkouts.iter().map(|c| (i, c.root.clone()))),
                    _ => {}
                },
                Some(Place::Tree(i, j, rel)) => {
                    let c = &repos[i].checkouts[j];
                    let folder = *new && !c.ignored.covers(&rel) && !has_git(&rel) && path.is_dir();
                    if rel.file_name().is_some_and(|n| n == ".gitignore") || folder {
                        rereads.insert((i, c.root.clone()));
                    }
                }
                None => {}
            },
        }
    }
    for &i in &relists {
        for branch in relist(w, &mut repos[i])? {
            mark(due, last, Key::Files(repos[i].id.clone(), branch), now);
        }
    }
    let mut fresh = HashSet::new();
    for (i, root) in rereads {
        let Some(j) = repos[i].checkouts.iter().position(|c| c.root == root) else { continue };
        let c = &mut repos[i].checkouts[j];
        c.ignored = Ignored::read(&c.root);
        // Watch the new folders git doesn't ignore. Elsewhere than Linux the one recursive watch covers them.
        if cfg!(target_os = "linux") {
            let arc = w.upgrade()?;
            let mut w = arc.lock().unwrap_or_else(|e| e.into_inner());
            c.polled = watch_tree(&mut w, &c.root, &c.ignored, &c.root).is_err();
        }
        fresh.insert((i, j));
    }
    // Then what changed. A file created since its checkout's ignore list was read may be ignored (a build log):
    // asked to git, unless that checkout refreshes anyway.
    let created: HashSet<&Path> = batch.iter().filter_map(|m| if let Msg::Path { path, new: true } = m { Some(path.as_path()) } else { None }).collect();
    let mut hit = HashSet::new();
    let mut unknown: HashMap<(usize, usize), Vec<PathBuf>> = HashMap::new();
    for m in &batch {
        let Msg::Path { path, .. } = m else { continue };
        match locate(repos, path) {
            Some(Place::Git(i, rel)) => {
                let r = &repos[i];
                match git_change(&rel) {
                    GitChange::Refs | GitChange::Checkouts => mark(due, last, Key::Refs(r.id.clone()), now),
                    GitChange::Index(admin) => {
                        if let Some(j) = r.checkouts.iter().position(|c| c.admin == admin) {
                            hit.insert((i, j));
                        }
                    }
                    GitChange::Exclude => mark(due, last, Key::Files(r.id.clone(), None), now),
                    GitChange::None => {}
                }
            }
            Some(Place::Tree(i, j, rel)) => {
                if has_git(&rel) || repos[i].checkouts[j].ignored.covers(&rel) {
                    continue;
                }
                if created.contains(path.as_path()) && !fresh.contains(&(i, j)) {
                    unknown.entry((i, j)).or_default().push(rel);
                } else {
                    hit.insert((i, j));
                }
            }
            None => {}
        }
    }
    for ((i, j), mut rels) in unknown {
        if hit.contains(&(i, j)) {
            continue;
        }
        rels.sort();
        rels.dedup();
        let c = &mut repos[i].checkouts[j];
        match check_ignored(&c.root, &rels) {
            Some(ignored) => {
                if rels.iter().any(|r| !ignored.contains(&slashed(r))) {
                    hit.insert((i, j));
                }
                c.ignored.files.extend(ignored);
            }
            None => {
                hit.insert((i, j));
            }
        }
    }
    for (i, j) in hit {
        mark(due, last, Key::Files(repos[i].id.clone(), repos[i].checkouts[j].branch.clone()), now);
    }
    Some(())
}

/// Which of `rels`, paths in the checkout at `root`, git ignores. None when git can't tell.
fn check_ignored(root: &Path, rels: &[PathBuf]) -> Option<HashSet<String>> {
    use std::io::Write;
    // Written whole before reading: more than fits the pipes would block both sides.
    if rels.len() > 200 {
        return None;
    }
    let mut child = crate::shell::without_appimage(&mut Command::new("git"))
        .current_dir(root)
        .args(["check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let input: String = rels.iter().map(|r| format!("{}\0", slashed(r))).collect();
    child.stdin.take()?.write_all(input.as_bytes()).ok()?;
    let out = child.wait_with_output().ok()?;
    // Exit 1: none of them is ignored.
    matches!(out.status.code(), Some(0 | 1)).then(|| String::from_utf8_lossy(&out.stdout).split('\0').filter(|s| !s.is_empty()).map(String::from).collect())
}

/// `rel` as git writes paths, with `/`.
fn slashed(rel: &Path) -> String {
    rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

/// Bring the watched checkouts of `r` in line with `git worktree list`; returns the branches of the ones it added.
/// None once the watcher is gone.
fn relist(w: &Weak<Mutex<RecommendedWatcher>>, r: &mut Repo) -> Option<Vec<Option<String>>> {
    let Some(out) = git(&r.path, &["worktree", "list", "--porcelain"]) else { return Some(Vec::new()) };
    let arc = w.upgrade()?;
    let mut w = arc.lock().unwrap_or_else(|e| e.into_inner());
    let mut old = std::mem::take(&mut r.checkouts);
    let mut added = Vec::new();
    for (n, (path, branch)) in parse_worktrees(&out).into_iter().enumerate() {
        let root = real(&path);
        if let Some(k) = old.iter().position(|c| c.root == root) {
            let mut c = old.swap_remove(k);
            c.branch = branch;
            r.checkouts.push(c);
            continue;
        }
        // A folder deleted outside git (still listed, prunable) has nothing to watch.
        if !root.is_dir() {
            continue;
        }
        let admin = (n > 0).then(|| admin_of(&root)).flatten();
        let ignored = Ignored::read(&root);
        let polled = match watch_tree(&mut w, &root, &ignored, &root) {
            Ok(()) => false,
            Err(e) => {
                tracing::warn!("re-reading {} on a timer, not watching it: {e}", root.display());
                true
            }
        };
        added.push(branch.clone());
        r.checkouts.push(Checkout { root, branch, admin, ignored, polled });
    }
    for c in old {
        // shortcut: on Linux the folder watches of a checkout git no longer lists stay until the folder goes; unwatch them if they pile up.
        let _ = w.unwatch(&c.root);
    }
    Some(added)
}

/// Watch `dir` of the checkout at `root` and the folders under it git doesn't ignore. Inotify (Linux) watches one
/// folder at a time, so ignored ones (`target/`, `node_modules/`) are left out. Elsewhere one recursive watch holds
/// one handle: a handle on every folder would stop Windows renaming or deleting them.
fn watch_tree(w: &mut RecommendedWatcher, root: &Path, ignored: &Ignored, dir: &Path) -> notify::Result<()> {
    if !cfg!(target_os = "linux") {
        return w.watch(root, RecursiveMode::Recursive);
    }
    w.watch(dir, RecursiveMode::NonRecursive)?;
    // Read after the watch: a folder created in between still shows up as an event.
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for e in entries.flatten() {
        let path = e.path();
        if !e.file_type().is_ok_and(|t| t.is_dir()) || e.file_name() == ".git" || ignored.covers(rel(root, &path)) {
            continue;
        }
        match watch_tree(w, root, ignored, &path) {
            Err(e) if matches!(e.kind, notify::ErrorKind::PathNotFound) => {}
            r => r?,
        }
    }
    Ok(())
}

enum Place {
    Git(usize, PathBuf),
    Tree(usize, usize, PathBuf),
}

/// The git dir or checkout `path` is in, with the path relative to it. The deepest wins: the main checkout holds `.git`,
/// and may hold other worktrees.
fn locate(repos: &[Repo], path: &Path) -> Option<Place> {
    let mut best: Option<(usize, Place)> = None;
    for (i, r) in repos.iter().enumerate() {
        let places = std::iter::once((&r.git_dir, None)).chain(r.checkouts.iter().enumerate().map(|(j, c)| (&c.root, Some(j))));
        for (dir, j) in places {
            let Ok(rel) = path.strip_prefix(dir) else { continue };
            let depth = dir.components().count();
            if best.as_ref().is_some_and(|(d, _)| *d >= depth) {
                continue;
            }
            let place = match j {
                None => Place::Git(i, rel.to_path_buf()),
                Some(j) => Place::Tree(i, j, rel.to_path_buf()),
            };
            best = Some((depth, place));
        }
    }
    best.map(|(_, p)| p)
}

#[derive(Debug, PartialEq)]
enum GitChange {
    /// A ref or an operation in progress.
    Refs,
    /// A ref change that may also add, remove or switch a checkout.
    Checkouts,
    /// The index of the main checkout (none) or of a worktree (its folder under `worktrees`): something staged.
    Index(Option<String>),
    /// `info/exclude`: what every checkout ignores.
    Exclude,
    None,
}

fn git_change(rel: &Path) -> GitChange {
    let parts: Vec<&str> = rel.components().filter_map(|c| if let Component::Normal(s) = c { s.to_str() } else { None }).collect();
    match parts.as_slice() {
        ["index"] => GitChange::Index(None),
        ["worktrees", name, "index"] => GitChange::Index(Some(name.to_string())),
        ["info", "exclude"] => GitChange::Exclude,
        ["HEAD"] | ["worktrees"] | ["worktrees", _] | ["worktrees", _, "HEAD"] => GitChange::Checkouts,
        _ if relevant(rel) => GitChange::Refs,
        _ => GitChange::None,
    }
}

/// The repository's common git dir (shared by its worktrees).
fn git_dir(repo: &Path) -> Option<PathBuf> {
    let dir = PathBuf::from(git(repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim());
    dir.is_dir().then_some(dir)
}

/// Stdout of a git read in `dir`, None when it fails.
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = crate::shell::without_appimage(&mut Command::new("git")).current_dir(dir).env("GIT_OPTIONAL_LOCKS", "0").args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The path events name: macOS reports the real one (`/private/var`, not `/var`). Not on Windows, where it
/// would turn `C:\` into `\\?\C:\`.
fn real(p: &Path) -> PathBuf {
    if cfg!(windows) {
        return p.to_path_buf();
    }
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn rel<'a>(root: &Path, path: &'a Path) -> &'a Path {
    path.strip_prefix(root).unwrap_or(path)
}

/// Inside a `.git` folder: the git dir's own watch handles that one.
fn has_git(rel: &Path) -> bool {
    rel.components().any(|c| c.as_os_str() == ".git")
}

/// A linked worktree's folder under `.git/worktrees`, from its `.git` file (`gitdir: …/worktrees/<name>`).
fn admin_of(root: &Path) -> Option<String> {
    let s = std::fs::read_to_string(root.join(".git")).ok()?;
    Some(Path::new(s.strip_prefix("gitdir:")?.trim()).file_name()?.to_str()?.to_string())
}

/// (path, branch) of each checkout in `git worktree list --porcelain`, the main one first; a bare repository's entry left out.
fn parse_worktrees(out: &str) -> Vec<(PathBuf, Option<String>)> {
    out.split("\n\n")
        .filter_map(|block| {
            let mut path = None;
            let mut branch = None;
            for line in block.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    path = Some(PathBuf::from(p));
                } else if let Some(b) = line.strip_prefix("branch ") {
                    branch = Some(b.trim_start_matches("refs/heads/").to_string());
                } else if line == "bare" {
                    return None;
                }
            }
            Some((path?, branch))
        })
        .collect()
}

/// The `!!` entries of `git status --porcelain=v1 -z --ignored=matching`; a folder ends with `/`.
fn parse_ignored(out: &str) -> Ignored {
    let mut ig = Ignored::default();
    let mut it = out.split('\0');
    while let Some(entry) = it.next() {
        let Some((code, path)) = entry.split_at_checked(3) else { continue };
        if code[..2].contains(['R', 'C']) {
            // A rename's source path follows as its own entry.
            it.next();
        } else if code == "!! " {
            match path.strip_suffix('/') {
                Some(dir) => ig.dirs.insert(dir.into()),
                None => ig.files.insert(path.into()),
            };
        }
    }
    ig
}

/// Refs, HEADs and in-progress operations. Not `index` (see [`git_change`]), not `objects` or `logs`:
/// they only change alongside a ref.
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

    #[test]
    fn sorts_git_dir_writes() {
        assert_eq!(git_change(Path::new("index")), GitChange::Index(None));
        assert_eq!(git_change(Path::new("worktrees/wt/index")), GitChange::Index(Some("wt".into())));
        assert_eq!(git_change(Path::new("index.lock")), GitChange::None);
        assert_eq!(git_change(Path::new("info/exclude")), GitChange::Exclude);
        for p in ["HEAD", "worktrees/wt", "worktrees/wt/HEAD"] {
            assert_eq!(git_change(Path::new(p)), GitChange::Checkouts, "{p}");
        }
        assert_eq!(git_change(Path::new("refs/heads/main")), GitChange::Refs);
        assert_eq!(git_change(Path::new("objects/ab/cd")), GitChange::None);
    }

    #[test]
    fn reads_what_git_ignores() {
        let ig = parse_ignored("!! target/\0R  new.rs\0!! not-a-path\0 M src/a.rs\0!! src/x.log\0?? b\0");
        assert!(ig.covers(Path::new("target")) && ig.covers(Path::new("target/debug/x")));
        assert!(ig.covers(Path::new("src/x.log")));
        assert!(!ig.covers(Path::new("src/a.rs")) && !ig.covers(Path::new("src")) && !ig.covers(Path::new("")));
        // "!! not-a-path" was the rename's source, not an ignored file.
        assert!(!ig.covers(Path::new("not-a-path")));
    }

    #[test]
    fn lists_worktrees_without_the_bare_one() {
        let out = "worktree /r\nbare\n\nworktree /r/wt\nHEAD abc\nbranch refs/heads/feat/x\n\nworktree /r/d\nHEAD abc\ndetached\n";
        assert_eq!(parse_worktrees(out), vec![(PathBuf::from("/r/wt"), Some("feat/x".into())), (PathBuf::from("/r/d"), None)]);
    }

    #[test]
    fn a_busy_checkout_waits_out_the_gap() {
        let (mut due, mut last) = (HashMap::new(), HashMap::new());
        let k = Key::Files("p".into(), None);
        let t = Instant::now();
        mark(&mut due, &last, k.clone(), t);
        assert_eq!(due[&k], t + SETTLE);
        due.clear();
        last.insert(k.clone(), t);
        mark(&mut due, &last, k.clone(), t + SETTLE);
        assert_eq!(due[&k], t + GAP);
        // Branches refresh at once, as before.
        mark(&mut due, &last, Key::Refs("p".into()), t);
        assert_eq!(due[&Key::Refs("p".into())], t + SETTLE);
    }

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").current_dir(dir).args(["-c", "user.name=A", "-c", "user.email=a@x", "-c", "commit.gpgsign=false"]).args(args).status().unwrap().success();
        assert!(ok, "git {args:?}");
    }

    /// The next FilesChanged within `secs`, skipping other events.
    async fn files_changed(rx: &mut broadcast::Receiver<Event>, secs: f64) -> Option<Option<String>> {
        tokio::time::timeout(Duration::from_secs_f64(secs), async {
            loop {
                if let Ok(Event::FilesChanged { branch, .. }) = rx.recv().await {
                    return branch;
                }
            }
        })
        .await
        .ok()
    }

    #[tokio::test]
    async fn saves_and_staging_refresh_the_files_but_ignored_writes_dont() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("r");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "core.autocrlf", "false"]);
        sh(&repo, &["config", "core.longpaths", "true"]);
        std::fs::write(repo.join(".gitignore"), "target/\n*.log\n").unwrap();
        std::fs::write(repo.join("src/a.rs"), "a\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "a"]);
        std::fs::create_dir_all(repo.join("target/debug")).unwrap();
        let project = Project { id: "p".into(), path: repo.to_string_lossy().into(), ..Default::default() };
        let (tx, mut rx) = broadcast::channel(256);
        let _w = watch(&[project], tx).unwrap();
        assert_eq!(files_changed(&mut rx, 5.0).await, Some(None), "one refresh once set up");

        std::fs::write(repo.join("target/debug/out"), "x").unwrap();
        std::fs::write(repo.join("src/build.log"), "x").unwrap();
        assert_eq!(files_changed(&mut rx, 1.0).await, None, "ignored files are no change");

        std::fs::write(repo.join("src/a.rs"), "b\n").unwrap();
        assert_eq!(files_changed(&mut rx, 2.0).await, Some(Some("main".into())), "a save");

        // A new folder gets watched too.
        std::fs::create_dir_all(repo.join("src/deep/er")).unwrap();
        assert_eq!(files_changed(&mut rx, 3.0).await, Some(Some("main".into())));
        tokio::time::sleep(Duration::from_millis(300)).await;
        std::fs::write(repo.join("src/deep/er/b.rs"), "b\n").unwrap();
        assert_eq!(files_changed(&mut rx, 3.0).await, Some(Some("main".into())), "a file in a new folder");

        // Staged from a terminal: only the index changes.
        sh(&repo, &["add", "src/a.rs"]);
        assert_eq!(files_changed(&mut rx, 3.0).await, Some(Some("main".into())), "git add");

        // The UI re-reads on each refresh: that read must not write the index back and refresh forever.
        let file = std::fs::File::options().append(true).open(repo.join("src/deep/er/b.rs")).unwrap();
        file.set_modified(std::time::SystemTime::now()).unwrap();
        let mut seen = 0;
        while files_changed(&mut rx, 2.5).await.is_some() {
            crate::git::Git::new(&repo).wip_split().await.unwrap();
            seen += 1;
            assert!(seen <= 3, "the UI's own reads keep refreshing it");
        }
    }

    #[tokio::test]
    async fn a_new_worktree_refreshes_under_its_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("r");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "core.autocrlf", "false"]);
        sh(&repo, &["config", "core.longpaths", "true"]);
        std::fs::write(repo.join("a"), "a\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "a"]);
        let project = Project { id: "p".into(), path: repo.to_string_lossy().into(), ..Default::default() };
        let (tx, mut rx) = broadcast::channel(256);
        let _w = watch(&[project], tx).unwrap();
        assert_eq!(files_changed(&mut rx, 5.0).await, Some(None));

        let wt = tmp.path().join("wt");
        sh(&repo, &["worktree", "add", "-q", "-b", "feat/x", wt.to_str().unwrap()]);
        tokio::time::sleep(Duration::from_secs(1)).await;
        while files_changed(&mut rx, 0.5).await.is_some() {}
        std::fs::write(wt.join("a"), "b\n").unwrap();
        assert_eq!(files_changed(&mut rx, 3.0).await, Some(Some("feat/x".into())));
    }
}
