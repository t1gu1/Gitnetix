//! Thin async wrapper around the `git` CLI.
//!
//! We shell out instead of linking libgit2: worktrees, rebases, signing and
//! credential helpers then behave exactly like the user's own `git`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::error::{Error, Result};

#[derive(Debug, Clone)]
pub struct Git {
    cwd: PathBuf,
    /// Extra `-c key=value` pairs (author identity, signing).
    config: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    /// A added, M modified, D deleted, R renamed, C conflict.
    pub status: char,
    pub additions: u32,
    pub deletions: u32,
    /// WIP split only: true = in the index, false = working tree only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffLine {
    /// ' ' context, '+' added, '-' removed.
    pub kind: char,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub header: String,
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    pub sha: String,
    pub upstream: Option<String>,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagInfo {
    pub name: String,
    pub date: String,
    pub sha: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Commit {
    pub sha: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub main: bool,
}

/// Commit identity applied with `-c` so the repo config is never touched.
#[derive(Debug, Clone, Default)]
pub struct Identity {
    pub name: String,
    pub email: String,
    pub ssh_signing_key: Option<String>,
}

impl Git {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Git { cwd: cwd.into(), config: Vec::new() }
    }

    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    pub fn with_identity(mut self, id: &Identity) -> Self {
        if !id.name.is_empty() {
            self.config.push(("user.name".into(), id.name.clone()));
        }
        if !id.email.is_empty() {
            self.config.push(("user.email".into(), id.email.clone()));
        }
        if let Some(key) = &id.ssh_signing_key {
            self.config.push(("gpg.format".into(), "ssh".into()));
            self.config.push(("user.signingkey".into(), key.clone()));
            self.config.push(("commit.gpgsign".into(), "true".into()));
        }
        self
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new("git");
        cmd.current_dir(&self.cwd);
        for (k, v) in &self.config {
            cmd.arg("-c").arg(format!("{k}={v}"));
        }
        cmd.args(args);
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.env("LC_ALL", "C");
        // Never let git open an editor inside the app.
        cmd.env("GIT_EDITOR", "true");
        cmd.kill_on_drop(true);
        cmd
    }

    /// Run git and return stdout; non-zero exit becomes `Error::Git`.
    pub async fn run(&self, args: &[&str]) -> Result<String> {
        let out = self.command(args).output().await?;
        if !out.status.success() {
            return Err(Error::Git {
                cmd: args.first().copied().unwrap_or("").to_string(),
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Run git and return (exit success, stdout, stderr) without failing.
    pub async fn try_run(&self, args: &[&str]) -> Result<(bool, String, String)> {
        let out = self.command(args).output().await?;
        Ok((
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ))
    }

    // ---------- repository ----------

    pub async fn toplevel(&self) -> Result<PathBuf> {
        let out = self.run(&["rev-parse", "--show-toplevel"]).await?;
        Ok(PathBuf::from(out.trim()))
    }

    pub async fn current_branch(&self) -> Result<Option<String>> {
        let (ok, out, _) = self.try_run(&["symbolic-ref", "--short", "-q", "HEAD"]).await?;
        Ok(if ok { Some(out.trim().to_string()) } else { None })
    }

    pub async fn ref_exists(&self, r: &str) -> Result<bool> {
        let (ok, _, _) = self.try_run(&["rev-parse", "--verify", "-q", r]).await?;
        Ok(ok)
    }

    /// Revision to start from for branch `name`: the local branch, else its origin copy.
    pub async fn branch_rev(&self, name: &str) -> Result<Option<String>> {
        if self.ref_exists(&format!("refs/heads/{name}")).await? {
            Ok(Some(name.to_string()))
        } else if self.ref_exists(&format!("refs/remotes/origin/{name}")).await? {
            Ok(Some(format!("origin/{name}")))
        } else {
            Ok(None)
        }
    }

    /// `branch_rev`, else `name` as given (a tag or SHA, or a branch git will report missing).
    pub async fn rev_of(&self, name: &str) -> String {
        self.branch_rev(name).await.ok().flatten().unwrap_or_else(|| name.to_string())
    }

    pub async fn rev_parse(&self, r: &str) -> Result<String> {
        Ok(self.run(&["rev-parse", r]).await?.trim().to_string())
    }

    /// `main`, `master`, or whatever origin/HEAD points to.
    pub async fn default_branch(&self) -> Result<String> {
        let (ok, out, _) = self
            .try_run(&["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
            .await?;
        if ok {
            if let Some(name) = out.trim().strip_prefix("origin/") {
                return Ok(name.to_string());
            }
        }
        for name in ["main", "master", "trunk", "develop"] {
            if self.ref_exists(&format!("refs/heads/{name}")).await? {
                return Ok(name.to_string());
            }
        }
        Ok(self.current_branch().await?.unwrap_or_else(|| "main".into()))
    }

    pub async fn remote_url(&self, remote: &str) -> Result<Option<String>> {
        let (ok, out, _) = self.try_run(&["remote", "get-url", remote]).await?;
        Ok(if ok { Some(out.trim().to_string()) } else { None })
    }

    /// Resolve paths inside the git dir (handles worktrees), in one call.
    async fn git_paths(&self, names: &[&str]) -> Result<Vec<PathBuf>> {
        let args: Vec<&str> = ["rev-parse"].into_iter().chain(names.iter().flat_map(|n| ["--git-path", n])).collect();
        let out = self.run(&args).await?;
        Ok(out.lines().map(|l| self.cwd.join(l.trim())).collect())
    }

    pub async fn is_rebasing(&self) -> Result<bool> {
        Ok(self.git_paths(&["rebase-merge", "rebase-apply"]).await?.iter().any(|p| p.exists()))
    }

    // ---------- refs ----------

    pub async fn branches(&self) -> Result<Vec<BranchInfo>> {
        let out = self
            .run(&[
                "for-each-ref",
                "refs/heads",
                "--format=%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(committerdate:iso-strict)",
            ])
            .await?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\x1f').collect();
                (f.len() == 4).then(|| BranchInfo {
                    name: f[0].into(),
                    sha: f[1].into(),
                    upstream: (!f[2].is_empty()).then(|| f[2].to_string()),
                    date: f[3].into(),
                })
            })
            .collect())
    }

    /// Branches on origin (names without the `origin/` prefix, `HEAD` left out).
    pub async fn remote_branches(&self) -> Result<Vec<BranchInfo>> {
        let out = self
            .run(&["for-each-ref", "refs/remotes/origin", "--format=%(refname:short)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(symref)"])
            .await?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\x1f').collect();
                let name = f.first()?.strip_prefix("origin/")?;
                (f.len() == 4 && f[3].is_empty() && name != "HEAD").then(|| BranchInfo { name: name.into(), sha: f[1].into(), upstream: None, date: f[2].into() })
            })
            .collect())
    }

    /// Subjects of recent merge commits, keyed by each merged-in (non-first) parent.
    pub async fn merge_subjects(&self, limit: u32) -> Result<HashMap<String, String>> {
        let out = self.run(&["log", "--all", "--merges", &format!("--max-count={limit}"), "--format=%P%x1f%s"]).await?;
        let mut map = HashMap::new();
        for l in out.lines() {
            let Some((parents, subject)) = l.split_once('\x1f') else { continue };
            for p in parents.split_whitespace().skip(1) {
                map.entry(p.to_string()).or_insert_with(|| subject.to_string());
            }
        }
        Ok(map)
    }

    pub async fn tags(&self) -> Result<Vec<TagInfo>> {
        let out = self
            .run(&[
                "for-each-ref",
                "refs/tags",
                "--sort=-creatordate",
                "--format=%(refname:short)%1f%(creatordate:iso-strict)%1f%(objectname)%1f%(*objectname)",
            ])
            .await?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\x1f').collect();
                (f.len() == 4).then(|| TagInfo {
                    name: f[0].into(),
                    date: f[1].into(),
                    // Annotated tags point at a tag object; prefer the commit.
                    sha: if f[3].is_empty() { f[2].into() } else { f[3].into() },
                })
            })
            .collect())
    }

    pub async fn count(&self, range: &str) -> Result<u32> {
        let out = self.run(&["rev-list", "--count", range]).await?;
        Ok(out.trim().parse().unwrap_or(0))
    }

    /// (commits only in `a`, commits only in `b`).
    pub async fn left_right(&self, a: &str, b: &str) -> Result<(u32, u32)> {
        let out = self.run(&["rev-list", "--left-right", "--count", &format!("{a}...{b}")]).await?;
        let mut n = out.split_whitespace().map(|x| x.parse().unwrap_or(0));
        Ok((n.next().unwrap_or(0), n.next().unwrap_or(0)))
    }

    pub async fn is_ancestor(&self, a: &str, b: &str) -> Result<bool> {
        let (ok, _, _) = self.try_run(&["merge-base", "--is-ancestor", a, b]).await?;
        Ok(ok)
    }

    /// True when `branch` had commits of its own that all landed in `base`:
    /// a merge commit in `base` has the branch tip as a parent, or the branch
    /// moved since it was created (reflog) and is fully contained in `base`.
    /// A fresh branch with no commits yet is not "merged". `branch` may be a
    /// remote-tracking name (`origin/x`).
    pub async fn is_merged_into(&self, branch: &str, base: &str) -> Result<bool> {
        let (tip, base_tip) = (self.rev_parse(branch).await?, self.rev_parse(base).await?);
        if tip == base_tip || !self.is_ancestor(&tip, &base_tip).await? {
            return Ok(false);
        }
        let merges = self.run(&["rev-list", "--merges", "--parents", "--ancestry-path", &format!("{tip}..{base_tip}")]).await?;
        if merges.lines().any(|l| l.split_whitespace().skip(2).any(|p| p == tip)) {
            return Ok(true);
        }
        let local = format!("refs/heads/{branch}");
        let r = if self.ref_exists(&local).await? { local } else { format!("refs/remotes/{branch}") };
        let (ok, log, _) = self.try_run(&["reflog", "show", "--format=%H", &r]).await?;
        Ok(ok && log.lines().last().is_some_and(|created| created.trim() != tip))
    }

    pub async fn create_branch(&self, name: &str, from: &str) -> Result<()> {
        self.run(&["branch", "--no-track", name, from]).await.map(|_| ())
    }

    /// Switch branch. Uncommitted work comes along (git's default when it
    /// does not conflict with the target).
    pub async fn switch(&self, name: &str) -> Result<()> {
        self.run(&["switch", name]).await.map(|_| ())
    }

    pub async fn switch_create(&self, name: &str, from: &str) -> Result<()> {
        self.run(&["switch", "--no-track", "-c", name, from]).await.map(|_| ())
    }

    pub async fn delete_branch(&self, name: &str, force: bool) -> Result<()> {
        self.run(&["branch", if force { "-D" } else { "-d" }, name]).await.map(|_| ())
    }

    pub async fn tag(&self, name: &str, target: &str, message: &str) -> Result<()> {
        self.run(&["tag", "-a", name, target, "-m", message]).await.map(|_| ())
    }

    pub async fn update_ref(&self, r: &str, sha: &str) -> Result<()> {
        self.run(&["update-ref", r, sha]).await.map(|_| ())
    }

    // ---------- worktrees ----------

    pub async fn worktrees(&self) -> Result<Vec<WorktreeInfo>> {
        let out = self.run(&["worktree", "list", "--porcelain"]).await?;
        let mut list = Vec::new();
        let mut cur: Option<WorktreeInfo> = None;
        for line in out.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                if let Some(w) = cur.take() {
                    list.push(w);
                }
                cur = Some(WorktreeInfo { path: p.into(), branch: None, head: String::new(), main: list.is_empty() });
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                if let Some(w) = cur.as_mut() {
                    w.head = h.into();
                }
            } else if let Some(b) = line.strip_prefix("branch ") {
                if let Some(w) = cur.as_mut() {
                    w.branch = Some(b.trim_start_matches("refs/heads/").into());
                }
            }
        }
        if let Some(w) = cur {
            list.push(w);
        }
        Ok(list)
    }

    pub async fn worktree_add(&self, path: &Path, branch: &str, from: Option<&str>) -> Result<()> {
        let p = path.to_string_lossy();
        match from {
            Some(base) => self.run(&["worktree", "add", "--no-track", "-b", branch, &p, base]).await?,
            None => self.run(&["worktree", "add", &p, branch]).await?,
        };
        Ok(())
    }

    pub async fn worktree_remove(&self, path: &Path, force: bool) -> Result<()> {
        let p = path.to_string_lossy();
        if force {
            self.run(&["worktree", "remove", "--force", &p]).await?;
        } else {
            self.run(&["worktree", "remove", &p]).await?;
        }
        Ok(())
    }

    // ---------- working tree ----------

    /// Uncommitted changes (staged + unstaged + untracked) against HEAD.
    pub async fn wip_changes(&self) -> Result<Vec<FileChange>> {
        let status = self.run(&["status", "--porcelain=v1", "-z", "-uall"]).await?;
        let mut entries = parse_status_z(&status);
        let has_head = self.ref_exists("HEAD").await?;
        let stats = if has_head {
            parse_numstat_z(&self.run(&["diff", "--numstat", "-z", "HEAD"]).await?)
        } else {
            HashMap::new()
        };
        for e in entries.iter_mut() {
            if let Some((a, d)) = stats.get(&e.path) {
                e.additions = *a;
                e.deletions = *d;
            } else if e.status == 'A' {
                e.additions = count_lines(&self.cwd.join(&e.path));
            }
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    /// Uncommitted changes split by side: staged (index vs HEAD) and
    /// unstaged (working tree vs index, plus untracked). A partially staged
    /// file appears once on each side.
    pub async fn wip_split(&self) -> Result<Vec<FileChange>> {
        let status = self.run(&["status", "--porcelain=v1", "-z", "-uall"]).await?;
        let staged_stats = parse_numstat_z(&self.run(&["diff", "--cached", "--numstat", "-z"]).await?);
        let unstaged_stats = parse_numstat_z(&self.run(&["diff", "--numstat", "-z"]).await?);
        let mut out = parse_status_split_z(&status);
        for e in out.iter_mut() {
            let stats = if e.staged == Some(true) { &staged_stats } else { &unstaged_stats };
            if let Some((a, d)) = stats.get(&e.path) {
                e.additions = *a;
                e.deletions = *d;
            } else if e.status == 'A' && e.staged == Some(false) {
                e.additions = count_lines(&self.cwd.join(&e.path));
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// Everything a branch changed since it left `base` (three-dot range).
    pub async fn branch_changes(&self, base: &str, branch: &str) -> Result<Vec<FileChange>> {
        self.range_changes(&format!("{base}...{branch}")).await
    }

    /// Files changed in a diff range, with line counts.
    pub async fn range_changes(&self, range: &str) -> Result<Vec<FileChange>> {
        let ns = self.run(&["diff", "--name-status", "-z", "-M", range]).await?;
        let stats = parse_numstat_z(&self.run(&["diff", "--numstat", "-z", "-M", range]).await?);
        let mut out = parse_name_status_z(&ns);
        for e in out.iter_mut() {
            if let Some((a, d)) = stats.get(&e.path) {
                e.additions = *a;
                e.deletions = *d;
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// Diff range of one commit against its first parent (the empty tree for a root commit).
    pub async fn commit_range(&self, sha: &str) -> Result<String> {
        const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
        let parent = format!("{sha}^");
        let base = if self.try_run(&["rev-parse", "--verify", "-q", &parent]).await?.0 { parent } else { EMPTY_TREE.into() };
        Ok(format!("{base}..{sha}"))
    }

    pub async fn conflicted_files(&self) -> Result<Vec<String>> {
        let out = self.run(&["diff", "--name-only", "--diff-filter=U", "-z"]).await?;
        Ok(out.split('\0').filter(|s| !s.is_empty()).map(String::from).collect())
    }

    pub async fn ls_files(&self) -> Result<Vec<String>> {
        let out = self.run(&["ls-files", "-z"]).await?;
        Ok(out.split('\0').filter(|s| !s.is_empty()).map(String::from).collect())
    }

    /// Diff of one file. `range` None = working tree vs HEAD.
    pub async fn file_diff(&self, path: &str, range: Option<&str>) -> Result<Vec<Hunk>> {
        let out = match range {
            Some(r) => self.run(&["diff", "-M", r, "--", path]).await?,
            None => {
                let tracked = self.try_run(&["ls-files", "--error-unmatch", "--", path]).await?.0;
                if tracked && self.ref_exists("HEAD").await? {
                    self.run(&["diff", "HEAD", "--", path]).await?
                } else {
                    // Untracked: diff against nothing. Exit code 1 = "differences".
                    self.try_run(&["diff", "--no-index", "--", "/dev/null", path]).await?.1
                }
            }
        };
        Ok(parse_unified(&out))
    }

    /// Diff of one side of a file's uncommitted work.
    pub async fn file_diff_side(&self, path: &str, staged: bool) -> Result<Vec<Hunk>> {
        let out = if staged {
            self.run(&["diff", "--cached", "-M", "--", path]).await?
        } else if self.is_tracked(path).await? {
            self.run(&["diff", "--", path]).await?
        } else {
            self.try_run(&["diff", "--no-index", "--", "/dev/null", path]).await?.1
        };
        Ok(parse_unified(&out))
    }

    async fn is_tracked(&self, path: &str) -> Result<bool> {
        Ok(self.try_run(&["ls-files", "--error-unmatch", "--", path]).await?.0)
    }

    /// Stage paths (all when empty), including deletions.
    pub async fn stage(&self, paths: &[String]) -> Result<()> {
        let mut args = vec!["add", "-A", "--"];
        args.extend(paths.iter().map(String::as_str));
        self.run(&args).await.map(|_| ())
    }

    /// Move paths (all when empty) back out of the index; the working tree is untouched.
    pub async fn unstage(&self, paths: &[String]) -> Result<()> {
        let all = [".".to_string()];
        let paths = if paths.is_empty() { &all[..] } else { paths };
        let mut args = if self.ref_exists("HEAD").await? { vec!["reset", "-q", "--"] } else { vec!["rm", "-r", "-q", "--cached", "--"] };
        args.extend(paths.iter().map(String::as_str));
        self.run(&args).await.map(|_| ())
    }

    /// Throw away working-tree changes to `paths`: tracked files go back to
    /// their staged state, untracked ones are deleted.
    pub async fn discard_unstaged(&self, paths: &[String]) -> Result<()> {
        let (mut tracked, mut untracked) = (Vec::new(), Vec::new());
        for p in paths {
            if self.is_tracked(p).await? {
                tracked.push(p.as_str());
            } else {
                untracked.push(p.as_str());
            }
        }
        if !tracked.is_empty() {
            let mut args = vec!["checkout", "--"];
            args.extend(tracked);
            self.run(&args).await?;
        }
        if !untracked.is_empty() {
            let mut args = vec!["clean", "-f", "-q", "--"];
            args.extend(untracked);
            self.run(&args).await?;
        }
        Ok(())
    }

    /// Throw away staged changes to `paths` entirely: index and working tree
    /// go back to HEAD (files added since HEAD are deleted, rename sources restored).
    pub async fn discard_staged(&self, paths: &[String]) -> Result<()> {
        let has_head = self.ref_exists("HEAD").await?;
        let mut targets: Vec<String> = paths.to_vec();
        if has_head {
            // A staged rename only lists its new path; bring the old one back too.
            let ns = self.run(&["diff", "--cached", "--name-status", "-z", "-M"]).await?;
            let mut parts = ns.split('\0').filter(|p| !p.is_empty());
            while let Some(code) = parts.next() {
                if code.starts_with('R') || code.starts_with('C') {
                    let (old, new) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                    if code.starts_with('R') && paths.iter().any(|p| p == new) {
                        targets.push(old.to_string());
                    }
                } else {
                    parts.next();
                }
            }
        }
        for p in &targets {
            let in_head = has_head && self.try_run(&["cat-file", "-e", &format!("HEAD:{p}")]).await?.0;
            if in_head {
                self.run(&["checkout", "HEAD", "--", p]).await?;
            } else {
                self.run(&["rm", "-f", "-q", "--ignore-unmatch", "--", p]).await?;
                let _ = std::fs::remove_file(self.cwd.join(p));
            }
        }
        Ok(())
    }

    pub async fn staged_diff(&self, max_bytes: usize) -> Result<String> {
        let mut d = self.run(&["diff", "--cached", "--stat", "-p"]).await?;
        truncate_utf8(&mut d, max_bytes);
        Ok(d)
    }

    pub async fn range_diff(&self, range: &str, max_bytes: usize) -> Result<String> {
        let mut d = self.run(&["diff", "--stat", "-p", range]).await?;
        truncate_utf8(&mut d, max_bytes);
        Ok(d)
    }

    pub async fn add_all(&self) -> Result<()> {
        self.run(&["add", "-A"]).await.map(|_| ())
    }

    pub async fn add(&self, path: &str) -> Result<()> {
        self.run(&["add", "--", path]).await.map(|_| ())
    }

    pub async fn has_staged(&self) -> Result<bool> {
        let (ok, _, _) = self.try_run(&["diff", "--cached", "--quiet"]).await?;
        Ok(!ok)
    }

    pub async fn commit(&self, message: &str) -> Result<String> {
        self.run(&["commit", "-m", message]).await?;
        self.rev_parse("HEAD").await
    }

    pub async fn push(&self, branch: &str, set_upstream: bool) -> Result<String> {
        let mut args = vec!["push"];
        if set_upstream {
            args.push("-u");
        }
        args.extend(["origin", branch]);
        let (ok, out, err) = self.try_run(&args).await?;
        if !ok {
            return Err(Error::Git { cmd: "push".into(), stderr: err.trim().into() });
        }
        Ok(format!("{out}{err}").trim().to_string())
    }

    pub async fn push_tag(&self, tag: &str) -> Result<()> {
        self.run(&["push", "origin", &format!("refs/tags/{tag}")]).await.map(|_| ())
    }

    /// Fast-forward `branch` to its upstream. In the branch's own checkout
    /// this pulls; elsewhere it fetches straight into the ref (ff-only too).
    pub async fn pull_ff(&self, branch: &str, upstream: &str, checked_out: bool) -> Result<String> {
        let (ok, out, err) = if checked_out {
            self.try_run(&["pull", "--ff-only"]).await?
        } else {
            let (remote, rbranch) = upstream.split_once('/').unwrap_or(("origin", upstream));
            self.try_run(&["fetch", remote, &format!("refs/heads/{rbranch}:refs/heads/{branch}")]).await?
        };
        if !ok {
            return Err(Error::Git { cmd: "pull".into(), stderr: err.trim().into() });
        }
        Ok(format!("{out}{err}").trim().to_string())
    }

    pub async fn fetch(&self) -> Result<()> {
        self.run(&["fetch", "--prune", "--tags", "origin"]).await.map(|_| ())
    }

    /// Rebase the current branch. Returns false when it stopped on conflicts.
    pub async fn rebase(&self, onto: &str) -> Result<bool> {
        let (ok, _, err) = self.try_run(&["rebase", "--autostash", onto]).await?;
        if ok {
            return Ok(true);
        }
        if self.is_rebasing().await? {
            return Ok(false);
        }
        Err(Error::Git { cmd: "rebase".into(), stderr: err.trim().into() })
    }

    pub async fn rebase_continue(&self) -> Result<bool> {
        let (ok, _, err) = self.try_run(&["-c", "core.editor=true", "rebase", "--continue"]).await?;
        if ok {
            return Ok(true);
        }
        if self.is_rebasing().await? && !self.conflicted_files().await?.is_empty() {
            return Ok(false);
        }
        Err(Error::Git { cmd: "rebase".into(), stderr: err.trim().into() })
    }

    pub async fn rebase_abort(&self) -> Result<()> {
        self.run(&["rebase", "--abort"]).await.map(|_| ())
    }

    /// Undo a commit with a new one. On conflict nothing changes.
    pub async fn revert(&self, sha: &str) -> Result<String> {
        self.apply_commit("revert", sha).await
    }

    /// Copy a commit onto the checked-out branch. On conflict nothing changes.
    pub async fn cherry_pick(&self, sha: &str) -> Result<String> {
        self.apply_commit("cherry-pick", sha).await
    }

    /// `revert` / `cherry-pick` one commit; a merge commit is taken against its first parent.
    async fn apply_commit(&self, cmd: &str, sha: &str) -> Result<String> {
        let merge = self.try_run(&["rev-parse", "--verify", "-q", &format!("{sha}^2")]).await?.0;
        let mut args = vec![cmd, "--no-edit"];
        if merge {
            args.extend(["-m", "1"]);
        }
        args.push(sha);
        let (ok, _, err) = self.try_run(&args).await?;
        if !ok {
            let _ = self.try_run(&[cmd, "--abort"]).await;
            return Err(Error::Git { cmd: cmd.into(), stderr: err.trim().into() });
        }
        self.rev_parse("HEAD").await
    }

    /// Move the checked-out branch to `sha`; `mode` is soft, mixed or hard.
    pub async fn reset(&self, sha: &str, mode: &str) -> Result<()> {
        if !matches!(mode, "soft" | "mixed" | "hard") {
            return Err(Error::Invalid(format!("unknown reset mode {mode:?}")));
        }
        self.run(&["reset", &format!("--{mode}"), sha]).await.map(|_| ())
    }

    pub async fn merge_ff_only(&self, from: &str) -> Result<()> {
        self.run(&["merge", "--ff-only", from]).await.map(|_| ())
    }

    /// Merge commit in the current checkout. On failure the merge is aborted.
    pub async fn merge_no_ff(&self, from: &str, message: &str) -> Result<String> {
        let (ok, _, err) = self.try_run(&["merge", "--no-ff", "-m", message, from]).await?;
        if !ok {
            let _ = self.try_run(&["merge", "--abort"]).await;
            return Err(Error::Git { cmd: "merge".into(), stderr: err.trim().into() });
        }
        self.rev_parse("HEAD").await
    }

    /// Merge `from` into `into` in memory, touching no checkout.
    /// Ok(tree) when clean, Err(conflicted paths) otherwise.
    pub async fn merge_tree(&self, into: &str, from: &str) -> Result<std::result::Result<String, Vec<String>>> {
        let out = self.command(&["merge-tree", "--write-tree", "--name-only", "--no-messages", into, from]).output().await?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut lines = stdout.lines();
        let tree = lines.next().unwrap_or("").trim().to_string();
        match out.status.code() {
            Some(0) => Ok(Ok(tree)),
            Some(1) => Ok(Err(lines.map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())),
            _ => Err(Error::Git { cmd: "merge-tree".into(), stderr: String::from_utf8_lossy(&out.stderr).trim().into() }),
        }
    }

    pub async fn commit_tree(&self, tree: &str, parents: &[&str], message: &str) -> Result<String> {
        let mut args = vec!["commit-tree", tree];
        for p in parents {
            args.extend(["-p", p]);
        }
        args.extend(["-m", message]);
        Ok(self.run(&args).await?.trim().to_string())
    }

    /// Move `r` to `new` only if it still points at `old`.
    pub async fn update_ref_from(&self, r: &str, new: &str, old: &str) -> Result<()> {
        self.run(&["update-ref", r, new, old]).await.map(|_| ())
    }

    // ---------- history ----------

    /// `range` like "v2.3.0..release/2.4.0", or "--all", or a branch.
    pub async fn log(&self, range: &str, limit: Option<u32>) -> Result<Vec<Commit>> {
        let mut args = vec!["log".to_string(), "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e".to_string()];
        if let Some(n) = limit {
            args.push(format!("-n{n}"));
        }
        args.push(range.to_string());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = self.run(&refs).await?;
        Ok(out
            .split('\x1e')
            .filter_map(|rec| {
                let rec = rec.trim_start_matches('\n');
                let f: Vec<&str> = rec.splitn(6, '\x1f').collect();
                (f.len() == 6).then(|| Commit {
                    sha: f[0].into(),
                    author: f[1].into(),
                    email: f[2].into(),
                    date: f[3].into(),
                    subject: f[4].into(),
                    body: f[5].trim().into(),
                })
            })
            .collect())
    }
}

// ---------- parsers (pure, unit-tested) ----------

pub fn parse_status_z(s: &str) -> Vec<FileChange> {
    let mut out = Vec::new();
    let mut parts = s.split('\0').filter(|p| !p.is_empty());
    while let Some(entry) = parts.next() {
        if entry.len() < 4 {
            continue;
        }
        let xy = &entry[..2];
        let path = entry[3..].to_string();
        let (x, y) = (xy.as_bytes()[0] as char, xy.as_bytes()[1] as char);
        if x == 'R' || x == 'C' {
            // Next field is the original path; we keep the new one.
            parts.next();
        }
        let status = match xy {
            "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU" => 'C',
            "??" => 'A',
            _ if x == 'R' => 'R',
            _ if x == 'A' => 'A',
            _ if x == 'D' || y == 'D' => 'D',
            _ => 'M',
        };
        out.push(FileChange { path, status, additions: 0, deletions: 0, staged: None });
    }
    out
}

/// Porcelain v1 split by side: X (index) becomes a staged entry, Y (working
/// tree, `?` = untracked) an unstaged one. Conflicts are unstaged only.
pub fn parse_status_split_z(s: &str) -> Vec<FileChange> {
    let mut out = Vec::new();
    let mut parts = s.split('\0').filter(|p| !p.is_empty());
    while let Some(entry) = parts.next() {
        if entry.len() < 4 {
            continue;
        }
        let xy = &entry[..2];
        let path = entry[3..].to_string();
        let (x, y) = (xy.as_bytes()[0] as char, xy.as_bytes()[1] as char);
        if x == 'R' || x == 'C' {
            parts.next();
        }
        let entry = |status, staged| FileChange { path: path.clone(), status, additions: 0, deletions: 0, staged: Some(staged) };
        if matches!(xy, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") {
            out.push(entry('C', false));
            continue;
        }
        let side = |c: char| match c {
            'A' | 'C' | '?' => Some('A'),
            'D' => Some('D'),
            'R' => Some('R'),
            'M' | 'T' => Some('M'),
            _ => None,
        };
        if x != '?' {
            if let Some(st) = side(x) {
                out.push(entry(st, true));
            }
        }
        if let Some(st) = side(y) {
            out.push(entry(st, false));
        }
    }
    out
}

pub fn parse_name_status_z(s: &str) -> Vec<FileChange> {
    let mut out = Vec::new();
    let mut parts = s.split('\0').filter(|p| !p.is_empty());
    while let Some(code) = parts.next() {
        let c = code.chars().next().unwrap_or('M');
        let path = if c == 'R' || c == 'C' {
            parts.next();
            parts.next()
        } else {
            parts.next()
        };
        if let Some(p) = path {
            let status = match c {
                'A' | 'C' => 'A',
                'D' => 'D',
                'R' => 'R',
                'U' => 'C',
                _ => 'M',
            };
            out.push(FileChange { path: p.into(), status, additions: 0, deletions: 0, staged: None });
        }
    }
    out
}

/// `--numstat -z`: "add\tdel\tpath\0" or, for renames, "add\tdel\t\0old\0new\0".
pub fn parse_numstat_z(s: &str) -> HashMap<String, (u32, u32)> {
    let mut map = HashMap::new();
    let mut parts = s.split('\0');
    while let Some(rec) = parts.next() {
        if rec.is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.splitn(3, '\t').collect();
        if f.len() < 3 {
            continue;
        }
        let a = f[0].parse().unwrap_or(0);
        let d = f[1].parse().unwrap_or(0);
        let path = if f[2].is_empty() {
            parts.next();
            parts.next().unwrap_or("").to_string()
        } else {
            f[2].to_string()
        };
        map.insert(path, (a, d));
    }
    map
}

pub fn parse_unified(s: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix("@@ ") {
            let mut nums = rest.split_whitespace();
            let old = nums.next().unwrap_or("-0");
            let new = nums.next().unwrap_or("+0");
            let start = |t: &str| t[1..].split(',').next().unwrap_or("0").parse().unwrap_or(0);
            hunks.push(Hunk { header: line.to_string(), old_start: start(old), new_start: start(new), lines: Vec::new() });
            continue;
        }
        let Some(h) = hunks.last_mut() else { continue };
        if line.starts_with('\\') {
            continue; // "\ No newline at end of file"
        }
        let (kind, text) = match line.chars().next() {
            Some('+') => ('+', &line[1..]),
            Some('-') => ('-', &line[1..]),
            Some(' ') => (' ', &line[1..]),
            None => (' ', ""),
            _ => continue,
        };
        h.lines.push(DiffLine { kind, text: text.to_string() });
    }
    hunks
}

fn count_lines(p: &Path) -> u32 {
    std::fs::read(p).map(|b| bytecount_newlines(&b)).unwrap_or(0)
}

fn bytecount_newlines(b: &[u8]) -> u32 {
    let n = b.iter().filter(|c| **c == b'\n').count() as u32;
    if !b.is_empty() && *b.last().unwrap() != b'\n' {
        n + 1
    } else {
        n
    }
}

pub fn truncate_utf8(s: &mut String, max: usize) {
    if s.len() <= max {
        return;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    s.push_str("\n… [diff truncated]");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_parsing() {
        let s = " M src/a.ts\0?? new.txt\0UU conflict.rs\0R  new.rs\0old.rs\0 D gone.md\0";
        let v = parse_status_z(s);
        let st: Vec<(String, char)> = v.into_iter().map(|f| (f.path, f.status)).collect();
        assert_eq!(
            st,
            vec![
                ("src/a.ts".into(), 'M'),
                ("new.txt".into(), 'A'),
                ("conflict.rs".into(), 'C'),
                ("new.rs".into(), 'R'),
                ("gone.md".into(), 'D'),
            ]
        );
    }

    #[test]
    fn status_split_parsing() {
        let s = "MM src/a.ts\0?? new.txt\0UU conflict.rs\0R  new.rs\0old.rs\0 D gone.md\0A  added.rs\0";
        let v = parse_status_split_z(s);
        let st: Vec<(String, char, bool)> = v.into_iter().map(|f| (f.path, f.status, f.staged.unwrap())).collect();
        assert_eq!(
            st,
            vec![
                ("src/a.ts".into(), 'M', true),
                ("src/a.ts".into(), 'M', false),
                ("new.txt".into(), 'A', false),
                ("conflict.rs".into(), 'C', false),
                ("new.rs".into(), 'R', true),
                ("gone.md".into(), 'D', false),
                ("added.rs".into(), 'A', true),
            ]
        );
    }

    #[test]
    fn numstat_parsing() {
        let s = "3\t1\tsrc/a.ts\0" .to_string() + "2\t0\t\0old.rs\0new.rs\0-\t-\timg.png\0";
        let m = parse_numstat_z(&s);
        assert_eq!(m["src/a.ts"], (3, 1));
        assert_eq!(m["new.rs"], (2, 0));
        assert_eq!(m["img.png"], (0, 0));
    }

    #[test]
    fn unified_parsing() {
        let d = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,4 @@ fn x\n a\n-b\n+c\n+d\n e\n\\ No newline at end of file\n";
        let h = parse_unified(d);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].old_start, 1);
        assert_eq!(h[0].new_start, 1);
        assert_eq!(h[0].lines.len(), 5);
        assert_eq!(h[0].lines[1].kind, '-');
    }
}
