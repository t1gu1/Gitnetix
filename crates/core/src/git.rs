//! Thin async wrapper around the `git` CLI.
//!
//! We shell out instead of linking libgit2: worktrees, rebases, signing and
//! credential helpers then behave exactly like the user's own `git`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::error::{Error, Result};

/// Git's empty tree: the base to diff a root commit (or a stash's untracked files) against.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// `git log -E` filter for pull request squashes named after their branch.
const PR_GREP: &str = "--grep=^Merged PR [0-9]+: [^ ]+$";

/// `git log -E` filter for every pull request squash.
pub(crate) const PR_ANY_GREP: &str = "--grep=^Merged PR [0-9]+: ";

/// Branch a pull request squash came from: `Merged PR 12: feature/x` → `feature/x`.
/// An edited title (spaces in it) names no branch.
fn pr_source(subject: &str) -> Option<&str> {
    let rest = subject.strip_prefix("Merged PR ")?;
    let (n, source) = rest.split_once(": ")?;
    let source = source.trim();
    (!n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && source_name(source)).then_some(source)
}

/// Whether a pull request title is the bare name of its branch.
fn source_name(title: &str) -> bool {
    !title.is_empty() && !title.contains(char::is_whitespace)
}

/// A pull request squash commit.
#[derive(Debug, Clone)]
pub struct PrSquash {
    pub sha: String,
    /// Commit time, Unix seconds.
    pub time: i64,
    pub title: String,
}

impl PrSquash {
    /// The branch its title names, when the title was left as the branch name.
    pub fn source(&self) -> Option<&str> {
        source_name(&self.title).then_some(self.title.as_str())
    }
}

/// Ticket keys in `s`, upper-cased: `feature/MNC-7187-x` → MNC-7187; `MNC-7187_&_MNC-7185` → both.
/// Unless `any_case`, only keys written in capitals (`expo-54` is no ticket in a title).
pub fn ticket_keys(s: &str, any_case: bool) -> Vec<String> {
    let b = s.as_bytes();
    let mut keys = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_alphabetic() || (i > 0 && b[i - 1].is_ascii_alphanumeric()) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_alphabetic() {
            i += 1;
        }
        let letters = i - start;
        if !(2..=10).contains(&letters) || b.get(i) != Some(&b'-') {
            continue;
        }
        let digits = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 || b.get(i + 1 + digits).is_some_and(|c| c.is_ascii_alphabetic()) || !(any_case || b[start..i].iter().all(u8::is_ascii_uppercase)) {
            continue;
        }
        keys.push(s[start..i + 1 + digits].to_ascii_uppercase());
        i += 1 + digits;
    }
    keys
}

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

/// Where to read one version of a file from.
#[derive(Debug, Clone, Copy)]
pub enum Side<'a> {
    Rev(&'a str),
    Index,
    Worktree,
}

/// Both versions of a file, base64; None when absent on that side.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Blobs {
    pub old: Option<String>,
    pub new: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    pub sha: String,
    pub upstream: Option<String>,
    pub date: String,
    /// Author of its tip commit.
    pub author: String,
    pub email: String,
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
    /// Tags pointing at it.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Tip of the listed branch's local copy (set for one branch's commit list only).
    #[serde(default)]
    pub local: bool,
    /// Tip of the listed branch's copy on origin (set for one branch's commit list only).
    #[serde(default)]
    pub origin: bool,
    /// On origin but not pulled into the local branch yet.
    #[serde(default)]
    pub unpulled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StashInfo {
    /// Identity of the stash: its `stash@{n}` position shifts as others come and go.
    pub sha: String,
    /// Branch it was made on; None from a detached HEAD.
    pub branch: Option<String>,
    pub message: String,
    /// When it was made (ISO 8601).
    pub date: String,
    /// Holds untracked files too.
    pub untracked: bool,
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
        Self::stdout_or_err(args, out)
    }

    fn stdout_or_err(args: &[&str], out: std::process::Output) -> Result<String> {
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
    pub(crate) async fn git_paths(&self, names: &[&str]) -> Result<Vec<PathBuf>> {
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
                // Not refname:short: a branch named like a tag would come out as "heads/<name>".
                "--format=%(refname:lstrip=2)%1f%(objectname)%1f%(upstream:short)%1f%(committerdate:iso-strict)%1f%(authorname)%1f%(authoremail)",
            ])
            .await?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\x1f').collect();
                (f.len() == 6).then(|| BranchInfo {
                    name: f[0].into(),
                    sha: f[1].into(),
                    upstream: (!f[2].is_empty()).then(|| f[2].to_string()),
                    date: f[3].into(),
                    author: f[4].into(),
                    email: f[5].trim_matches(['<', '>']).into(),
                })
            })
            .collect())
    }

    /// Branches on origin (names without the `origin/` prefix, `HEAD` left out).
    pub async fn remote_branches(&self) -> Result<Vec<BranchInfo>> {
        let out = self
            .run(&["for-each-ref", "refs/remotes/origin", "--format=%(refname:lstrip=2)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(symref)%1f%(authorname)%1f%(authoremail)"])
            .await?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\x1f').collect();
                let name = f.first()?.strip_prefix("origin/")?;
                (f.len() == 6 && f[3].is_empty() && name != "HEAD").then(|| BranchInfo {
                    name: name.into(),
                    sha: f[1].into(),
                    upstream: None,
                    date: f[2].into(),
                    author: f[4].into(),
                    email: f[5].trim_matches(['<', '>']).into(),
                })
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

    /// Pull requests squashed in (Azure DevOps: `Merged PR 12: <title>`), newest first:
    /// commit, commit time and the title.
    pub async fn pr_squashes(&self, limit: u32) -> Result<Vec<PrSquash>> {
        let max = format!("--max-count={limit}");
        let out = self.run(&["log", "--all", "--no-merges", &max, "-E", PR_ANY_GREP, "--format=%H%x1f%ct%x1f%s"]).await?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let mut f = l.split('\x1f');
                let (sha, time, subject) = (f.next()?, f.next()?.parse().ok()?, f.next()?);
                let title = subject.strip_prefix("Merged PR ")?.split_once(": ")?.1;
                Some(PrSquash { sha: sha.into(), time, title: title.trim().into() })
            })
            .collect())
    }

    /// Local and origin branches holding `sha`, spelled `x` and `origin/x`.
    pub async fn branches_containing(&self, sha: &str) -> Result<Vec<String>> {
        let contains = format!("--contains={sha}");
        let out = self.run(&["for-each-ref", &contains, "--format=%(refname:lstrip=2)", "refs/heads", "refs/remotes/origin"]).await?;
        Ok(out.lines().map(str::to_string).collect())
    }

    /// Whether `base` holds a pull request of branch `name` (tip `rev`) squashed in after its last commit.
    pub async fn pr_merged_into(&self, name: &str, rev: &str, base: &str) -> Result<bool> {
        let tip: i64 = self.run(&["log", "-1", "--format=%ct", rev]).await?.trim().parse().unwrap_or(i64::MAX);
        let not_rev = format!("^{rev}");
        let out = self.run(&["log", "--no-merges", "-E", PR_GREP, "--format=%ct%x1f%s", base, &not_rev, "--"]).await?;
        Ok(out.lines().filter_map(|l| l.split_once('\x1f')).any(|(t, s)| pr_source(s) == Some(name) && t.parse::<i64>().is_ok_and(|t| t >= tip)))
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

    /// Commit SHAs in `range`, newest first.
    pub async fn rev_list(&self, range: &str) -> Result<Vec<String>> {
        Ok(self.run(&["rev-list", range]).await?.lines().map(Into::into).collect())
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

    /// `left_right(base, b)` for every local and origin branch `b` at once, keyed
    /// like a revision (`x` for a local branch, `origin/x` for an origin one).
    pub async fn left_right_all(&self, base: &str) -> Result<HashMap<String, (u32, u32)>> {
        let format = format!("--format=%(refname)%1f%(ahead-behind:{base})");
        let out = self.run(&["for-each-ref", &format, "refs/heads", "refs/remotes/origin"]).await?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let (r, counts) = l.split_once('\x1f')?;
                let name = r.strip_prefix("refs/heads/").map(String::from).or_else(|| r.strip_prefix("refs/remotes/").map(String::from))?;
                let (ahead, behind) = counts.split_once(' ')?;
                Some((name, (behind.parse().ok()?, ahead.parse().ok()?)))
            })
            .collect())
    }

    /// `left_right(branch, upstream)` for every local branch whose upstream is a
    /// remote-tracking branch that still exists.
    pub async fn upstream_counts(&self) -> Result<HashMap<String, (u32, u32)>> {
        let out = self.run(&["for-each-ref", "refs/heads", "--format=%(refname:lstrip=2)%1f%(upstream)%1f%(upstream:track,nobracket)"]).await?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\x1f').collect();
                if f.len() != 3 || !f[1].starts_with("refs/remotes/") || f[2] == "gone" {
                    return None;
                }
                let (mut ahead, mut behind) = (0, 0);
                for part in f[2].split(", ") {
                    match part.split_once(' ') {
                        Some(("ahead", n)) => ahead = n.parse().ok()?,
                        Some(("behind", n)) => behind = n.parse().ok()?,
                        _ => {}
                    }
                }
                Some((f[0].to_string(), (ahead, behind)))
            })
            .collect())
    }

    /// Configured upstream of `branch` (`origin/x`), if any.
    pub async fn upstream(&self, branch: &str) -> Result<Option<String>> {
        let (ok, out, _) = self.try_run(&["rev-parse", "--abbrev-ref", &format!("{branch}@{{upstream}}")]).await?;
        Ok(ok.then(|| out.trim().to_string()).filter(|u| !u.is_empty()))
    }

    /// `sha` was the tip of local `branch` at some point (its reflog): the
    /// branch has had it, so replacing it upstream loses nothing unseen.
    pub async fn in_reflog(&self, branch: &str, sha: &str) -> Result<bool> {
        let (ok, out, _) = self.try_run(&["reflog", "show", "--format=%H", &format!("refs/heads/{branch}")]).await?;
        Ok(ok && out.lines().any(|l| l == sha))
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
        if tip == base_tip {
            return Ok(false);
        }
        match self.merge_evidence(&tip, &base_tip).await? {
            (false, _) => Ok(false),
            (true, true) => Ok(true),
            (true, false) => self.moved_since_created(branch, &tip).await,
        }
    }

    /// The part of [`Git::is_merged_into`] fixed for a pair of commits:
    /// (`tip` is in `base_tip`, a merge commit there has `tip` as a parent).
    pub async fn merge_evidence(&self, tip: &str, base_tip: &str) -> Result<(bool, bool)> {
        if !self.is_ancestor(tip, base_tip).await? {
            return Ok((false, false));
        }
        let merges = self.run(&["rev-list", "--merges", "--parents", "--ancestry-path", &format!("{tip}..{base_tip}")]).await?;
        Ok((true, merges.lines().any(|l| l.split_whitespace().skip(2).any(|p| p == tip))))
    }

    /// The branch moved since it was created: its oldest reflog entry is not `tip`.
    /// `branch` may be a remote-tracking name (`origin/x`).
    pub async fn moved_since_created(&self, branch: &str, tip: &str) -> Result<bool> {
        let local = format!("refs/heads/{branch}");
        let r = if self.ref_exists(&local).await? { local } else { format!("refs/remotes/{branch}") };
        let (ok, log, _) = self.try_run(&["reflog", "show", "--format=%H", &r]).await?;
        Ok(ok && log.lines().last().is_some_and(|created| created.trim() != tip))
    }

    /// Every branch, origin branch and tag with its commit and upstream: changes whenever any of them moves.
    pub async fn ref_fingerprint(&self) -> Result<String> {
        self.run(&["for-each-ref", "--format=%(refname) %(objectname) %(upstream)", "refs/heads", "refs/remotes", "refs/tags"]).await
    }

    /// True when `branch` landed in `base` as new commits rather than its own:
    /// every commit was rebased onto `base` (same patches), or all of it was
    /// squashed into one commit there. Compares patch ids with `git cherry`;
    /// the squash check builds a throwaway commit holding the whole branch diff.
    pub async fn is_squash_merged(&self, branch: &str, base: &str) -> Result<bool> {
        let picked = |out: &str| !out.trim().is_empty() && out.lines().all(|l| l.starts_with('-'));
        let cherry = self.run(&["cherry", base, branch]).await?;
        if picked(&cherry) {
            return Ok(true);
        }
        // Oldest commits already upstream (other work the branch pulled in) were not part of its
        // squash: squash from the last of them. Otherwise from where the branch forked.
        let lines: Vec<&str> = cherry.lines().collect();
        let upstream = lines.iter().take_while(|l| l.starts_with('-')).count();
        let parent = match upstream {
            n if n > 0 && lines[n..].iter().all(|l| l.starts_with('+')) => lines[n - 1][1..].trim().to_string(),
            _ => self.run(&["merge-base", base, branch]).await?.trim().to_string(),
        };
        let tree = format!("{branch}^{{tree}}");
        let out = self
            .command(&["commit-tree", &tree, "-p", &parent, "-m", "squash"])
            .env("GIT_AUTHOR_NAME", "gitnetix")
            .env("GIT_AUTHOR_EMAIL", "gitnetix@localhost")
            .env("GIT_COMMITTER_NAME", "gitnetix")
            .env("GIT_COMMITTER_EMAIL", "gitnetix@localhost")
            .output()
            .await?;
        if !out.status.success() {
            return Ok(false);
        }
        let squash = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Ok(picked(&self.run(&["cherry", base, &squash]).await?))
    }

    pub async fn create_branch(&self, name: &str, from: &str) -> Result<()> {
        self.run(&["branch", "--no-track", name, from]).await.map(|_| ())
    }

    /// Switch branch. Uncommitted work comes along (git's default when it
    /// does not conflict with the target).
    pub async fn switch(&self, name: &str) -> Result<()> {
        self.run(&["switch", name]).await.map(|_| ())
    }

    /// Detach HEAD at `rev` (uncommitted work comes along, like a switch).
    pub async fn switch_detach(&self, rev: &str) -> Result<()> {
        self.run(&["switch", "--detach", rev]).await.map(|_| ())
    }

    pub async fn switch_create(&self, name: &str, from: &str) -> Result<()> {
        self.run(&["switch", "--no-track", "-c", name, from]).await.map(|_| ())
    }

    pub async fn delete_branch(&self, name: &str, force: bool) -> Result<()> {
        self.run(&["branch", if force { "-D" } else { "-d" }, name]).await.map(|_| ())
    }

    pub async fn delete_remote_branch(&self, name: &str) -> Result<()> {
        // Lease on the last fetched tip: a push made since then is never deleted unseen.
        // Full ref: a bare name also matching a tag on origin is refused as ambiguous.
        let r = format!("refs/heads/{name}");
        let (ok, _, err) = self.try_run(&["push", "--force-with-lease", "origin", "--delete", &r]).await?;
        if ok {
            return Ok(());
        }
        // The lease reads "stale info" when origin already dropped the branch (e.g. deleted on PR merge):
        // nothing left to delete, only our leftover tracking ref.
        if err.contains("stale info") && self.run(&["ls-remote", "origin", &r]).await?.trim().is_empty() {
            return self.run(&["update-ref", "-d", &format!("refs/remotes/origin/{name}")]).await.map(|_| ());
        }
        Err(Error::Git { cmd: "push".into(), stderr: err.trim().into() })
    }

    pub async fn tag(&self, name: &str, target: &str, message: &str) -> Result<()> {
        self.run(&["tag", "-a", name, target, "-m", message]).await.map(|_| ())
    }

    pub async fn delete_tag(&self, name: &str) -> Result<()> {
        self.run(&["tag", "-d", name]).await.map(|_| ())
    }

    /// Move annotated tag `name` to `target`, keeping its original date so it
    /// keeps its place among the other tags. Returns the old tag object, to
    /// put it back with [`Git::update_ref`] if needed.
    pub async fn retag(&self, name: &str, target: &str, message: &str) -> Result<String> {
        let r = format!("refs/tags/{name}");
        let old = self.rev_parse(&r).await?;
        let date = self.run(&["for-each-ref", "--format=%(creatordate:iso-strict)", &r]).await?;
        let out = self.command(&["tag", "-f", "-a", name, target, "-m", message]).env("GIT_COMMITTER_DATE", date.trim()).output().await?;
        if !out.status.success() {
            return Err(Error::Git { cmd: "tag".into(), stderr: String::from_utf8_lossy(&out.stderr).trim().to_string() });
        }
        Ok(old)
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
        // Folder already deleted by hand: drop git's stale record instead of failing.
        if !path.exists() {
            self.run(&["worktree", "prune"]).await?;
            return Ok(());
        }
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
        let (status, has_head) = tokio::try_join!(self.run(&["status", "--porcelain=v1", "-z", "-uall"]), self.ref_exists("HEAD"))?;
        let mut entries = parse_status_z(&status);
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

    /// Number of files with uncommitted changes (staged, unstaged or untracked), each counted once.
    pub async fn wip_count(&self) -> Result<u32> {
        let status = self.run(&["status", "--porcelain=v1", "-z", "-uall"]).await?;
        Ok(parse_status_z(&status).len() as u32)
    }

    /// Set aside every uncommitted change, untracked files included.
    pub async fn stash(&self, message: &str) -> Result<()> {
        self.run(&["stash", "push", "--include-untracked", "-m", message]).await?;
        Ok(())
    }

    /// Every stash of the repository (shared by all its worktrees), newest first.
    pub async fn stashes(&self) -> Result<Vec<StashInfo>> {
        let out = self.run(&["stash", "list", "--format=%H%x1f%cI%x1f%P%x1f%gs%x1e"]).await?;
        Ok(out
            .split('\x1e')
            .filter_map(|rec| {
                let f: Vec<&str> = rec.trim_start_matches('\n').splitn(4, '\x1f').collect();
                (f.len() == 4).then(|| {
                    let (branch, message) = parse_stash_subject(f[3]);
                    StashInfo { sha: f[0].into(), date: f[1].into(), untracked: f[2].split(' ').count() == 3, branch, message }
                })
            })
            .collect())
    }

    /// `stash@{n}` of the stash `sha`, as of now.
    async fn stash_ref(&self, sha: &str) -> Result<String> {
        let i = self
            .stashes()
            .await?
            .iter()
            .position(|s| s.sha == sha)
            .ok_or_else(|| Error::Invalid("That stash no longer exists.".into()))?;
        Ok(format!("stash@{{{i}}}"))
    }

    /// Diff ranges of a stash: its tracked changes, and its untracked files when it has some.
    pub async fn stash_ranges(&self, sha: &str) -> Result<(String, Option<String>)> {
        let untracked = format!("{sha}^3");
        let has = self.try_run(&["rev-parse", "--verify", "-q", &untracked]).await?.0;
        Ok((format!("{sha}^1..{sha}"), has.then(|| format!("{EMPTY_TREE}..{untracked}"))))
    }

    /// Put a stash's changes back into this checkout; the stash stays.
    /// Returns the files left conflicted (empty: applied cleanly).
    pub async fn stash_apply(&self, sha: &str) -> Result<Vec<String>> {
        let r = self.stash_ref(sha).await?;
        let (ok, _, err) = self.try_run(&["stash", "apply", &r]).await?;
        if ok {
            return Ok(Vec::new());
        }
        let conflicts = self.conflicted_files().await?;
        if conflicts.is_empty() {
            return Err(Error::Git { cmd: "stash".into(), stderr: err.trim().into() });
        }
        Ok(conflicts)
    }

    pub async fn stash_drop(&self, sha: &str) -> Result<()> {
        let r = self.stash_ref(sha).await?;
        self.run(&["stash", "drop", &r]).await.map(|_| ())
    }

    /// Uncommitted changes split by side: staged (index vs HEAD) and
    /// unstaged (working tree vs index, plus untracked). A partially staged
    /// file appears once on each side.
    pub async fn wip_split(&self) -> Result<Vec<FileChange>> {
        let (status, staged, unstaged) = tokio::try_join!(
            self.run(&["status", "--porcelain=v1", "-z", "-uall"]),
            self.run(&["diff", "--cached", "--numstat", "-z"]),
            self.run(&["diff", "--numstat", "-z"]),
        )?;
        let (staged_stats, unstaged_stats) = (parse_numstat_z(&staged), parse_numstat_z(&unstaged));
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
        let (ns_args, stat_args) = (["diff", "--name-status", "-z", "-M", range], ["diff", "--numstat", "-z", "-M", range]);
        let (ns, stats) = tokio::try_join!(self.run(&ns_args), self.run(&stat_args))?;
        let stats = parse_numstat_z(&stats);
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

    /// Diff of one file. `range` None = working tree vs HEAD. `full` keeps the whole file as context.
    pub async fn file_diff(&self, path: &str, range: Option<&str>, full: bool) -> Result<Vec<Hunk>> {
        let ctx = context_flag(full);
        let out = match range {
            Some(r) => self.run(&["diff", ctx, "-M", r, "--", path]).await?,
            None => {
                let tracked = self.try_run(&["ls-files", "--error-unmatch", "--", path]).await?.0;
                if tracked && self.ref_exists("HEAD").await? {
                    self.run(&["diff", ctx, "HEAD", "--", path]).await?
                } else {
                    // Untracked: diff against nothing. Exit code 1 = "differences".
                    self.try_run(&["diff", ctx, "--no-index", "--", "/dev/null", path]).await?.1
                }
            }
        };
        Ok(parse_unified(&out))
    }

    /// Diff of one side of a file's uncommitted work.
    pub async fn file_diff_side(&self, path: &str, staged: bool, full: bool) -> Result<Vec<Hunk>> {
        let ctx = context_flag(full);
        let out = if staged {
            self.run(&["diff", ctx, "--cached", "-M", "--", path]).await?
        } else if self.is_tracked(path).await? {
            self.run(&["diff", ctx, "--", path]).await?
        } else {
            self.try_run(&["diff", ctx, "--no-index", "--", "/dev/null", path]).await?.1
        };
        Ok(parse_unified(&out))
    }

    /// Raw bytes of one version of a file; None when it doesn't exist there.
    pub async fn blob(&self, side: Side<'_>, path: &str) -> Result<Option<Vec<u8>>> {
        let spec = match side {
            Side::Rev(r) => format!("{r}:{path}"),
            Side::Index => format!(":{path}"),
            Side::Worktree => return Ok(tokio::fs::read(self.cwd.join(path)).await.ok()),
        };
        let out = self.command(&["cat-file", "blob", &spec]).output().await?;
        Ok(out.status.success().then_some(out.stdout))
    }

    /// Both versions of a file, base64.
    pub async fn blobs(&self, old: Side<'_>, new: Side<'_>, path: &str) -> Result<Blobs> {
        use base64::Engine;
        let (o, n) = tokio::join!(self.blob(old, path), self.blob(new, path));
        let enc = |b: Option<Vec<u8>>| b.map(|b| base64::engine::general_purpose::STANDARD.encode(b));
        Ok(Blobs { old: enc(o?), new: enc(n?) })
    }

    /// Both versions of a file across a diff range (`a..b`, or `a...b` from their merge base).
    pub async fn range_blobs(&self, range: &str, path: &str) -> Result<Blobs> {
        let (old, new) = match range.split_once("...") {
            Some((a, b)) => (self.merge_base(a, b).await?, b.to_string()),
            None => {
                let (a, b) = range.split_once("..").unwrap_or((range, "HEAD"));
                (a.to_string(), b.to_string())
            }
        };
        self.blobs(Side::Rev(&old), Side::Rev(&new), path).await
    }

    /// Whether tracked files have uncommitted changes in this checkout.
    pub async fn has_uncommitted(&self) -> Result<bool> {
        Ok(!self.run(&["status", "--porcelain", "--untracked-files=no"]).await?.trim().is_empty())
    }

    /// Whether `path` has uncommitted changes in this checkout.
    pub async fn is_dirty(&self, path: &str) -> Result<bool> {
        Ok(!self.run(&["status", "--porcelain", "--", path]).await?.trim().is_empty())
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
        if paths.is_empty() {
            return Ok(());
        }
        // shortcut: every path goes on the command line, so tens of thousands of files can hit the
        // OS argument limit; pass `.` for "discard all" if that shows up.
        // One git call for all paths. Only paths git names as untracked get deleted.
        let mut args = vec!["ls-files", "-z", "--others", "--exclude-standard", "--"];
        args.extend(paths.iter().map(String::as_str));
        let listed = self.run(&args).await?;
        let others: HashSet<&str> = listed.split('\0').collect();
        let (untracked, tracked): (Vec<&str>, Vec<&str>) = paths.iter().map(String::as_str).partition(|p| others.contains(p));
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
        if targets.is_empty() {
            return Ok(());
        }
        // One git call for all paths, not one per path.
        let listed = if has_head {
            let mut args = vec!["ls-tree", "-r", "-z", "--name-only", "HEAD", "--"];
            args.extend(targets.iter().map(String::as_str));
            self.run(&args).await?
        } else {
            String::new()
        };
        let in_head: HashSet<&str> = listed.split('\0').collect();
        let (restore, remove): (Vec<&str>, Vec<&str>) = targets.iter().map(String::as_str).partition(|p| in_head.contains(p));
        if !restore.is_empty() {
            let mut args = vec!["checkout", "HEAD", "--"];
            args.extend(&restore);
            self.run(&args).await?;
        }
        if !remove.is_empty() {
            let mut args = vec!["rm", "-f", "-q", "--ignore-unmatch", "--"];
            args.extend(&remove);
            self.run(&args).await?;
            for p in remove {
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

    /// The untracked files by name (a quarter of the budget at most), then every uncommitted change
    /// against HEAD; before the first commit, the staged ones.
    pub async fn wip_diff(&self, max_bytes: usize) -> Result<String> {
        let diff: &[&str] = if self.ref_exists("HEAD").await? { &["diff", "HEAD", "--stat", "-p"] } else { &["diff", "--cached", "--stat", "-p"] };
        let (d, mut untracked) = tokio::try_join!(self.run(diff), self.run(&["ls-files", "--others", "--exclude-standard"]))?;
        let mut out = String::new();
        if !untracked.trim().is_empty() {
            truncate_utf8(&mut untracked, max_bytes / 4);
            out = format!("New files:\n{untracked}\n");
        }
        out.push_str(&d);
        truncate_utf8(&mut out, max_bytes);
        Ok(out)
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

    /// Commit only `paths` as they are in the working tree; anything else staged stays staged.
    pub async fn commit_paths(&self, paths: &[&str], message: &str) -> Result<()> {
        let mut args = vec!["commit", "-m", message, "--only", "--"];
        args.extend(paths);
        self.run(&args).await?;
        Ok(())
    }

    /// Contents of `path` at `rev`, None when it doesn't exist there.
    pub async fn show_file(&self, rev: &str, path: &str) -> Result<Option<String>> {
        let (ok, out, _) = self.try_run(&["show", &format!("{rev}:{path}")]).await?;
        Ok(ok.then_some(out))
    }

    /// Commit `content` as the top-level file `name` on `branch` without touching any checkout.
    pub async fn commit_root_file(&self, branch: &str, name: &str, content: &str, message: &str) -> Result<String> {
        let r = format!("refs/heads/{branch}");
        let old = self.rev_parse(&r).await?;
        let blob = self.run_stdin(&["hash-object", "-w", "--stdin"], content).await?.trim().to_string();
        let listing = self.run(&["ls-tree", "-z", &old]).await?;
        let mut entries: Vec<String> = listing
            .split('\0')
            .filter(|e| !e.is_empty() && e.split_once('\t').map(|(_, n)| n) != Some(name))
            .map(String::from)
            .collect();
        entries.push(format!("100644 blob {blob}\t{name}"));
        let tree = self.run_stdin(&["mktree", "-z"], &(entries.join("\0") + "\0")).await?.trim().to_string();
        let sha = self.commit_tree(&tree, &[&old], message).await?;
        self.update_ref_from(&r, &sha, &old).await?;
        Ok(sha)
    }

    async fn run_stdin(&self, args: &[&str], input: &str) -> Result<String> {
        use std::process::Stdio;
        use tokio::io::AsyncWriteExt;
        let mut child = self.command(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        stdin.write_all(input.as_bytes()).await?;
        drop(stdin);
        Self::stdout_or_err(args, child.wait_with_output().await?)
    }

    pub async fn push(&self, branch: &str, set_upstream: bool) -> Result<String> {
        let mut args = vec!["push"];
        if set_upstream {
            args.push("-u");
        }
        args.extend(["origin", branch]);
        self.push_with(&args).await
    }

    /// Replace `upstream` (`remote/branch`) with local `branch`, e.g. after a rebase.
    /// Refused when origin has commits that were never on the local branch
    /// (`--force-if-includes`), even if a background fetch already saw them.
    pub async fn force_push(&self, branch: &str, upstream: &str) -> Result<String> {
        let (remote, dest) = upstream.split_once('/').unwrap_or(("origin", upstream));
        self.push_with(&["push", "--force-with-lease", "--force-if-includes", remote, &format!("{branch}:refs/heads/{dest}")]).await
    }

    /// Push several refs to origin: all of them land, or none do.
    pub async fn push_atomic(&self, refs: &[&str]) -> Result<String> {
        let mut args = vec!["push", "--atomic", "origin"];
        args.extend(refs);
        self.push_with(&args).await
    }

    async fn push_with(&self, args: &[&str]) -> Result<String> {
        let (ok, out, err) = self.try_run(args).await?;
        if !ok {
            return Err(Error::Git { cmd: "push".into(), stderr: err.trim().into() });
        }
        Ok(format!("{out}{err}").trim().to_string())
    }

    /// Delete `tag` on origin; false when origin didn't have it.
    pub async fn delete_remote_tag(&self, tag: &str) -> Result<bool> {
        let r = format!("refs/tags/{tag}");
        let (ok, _, err) = self.try_run(&["push", "origin", "--delete", &r]).await?;
        if ok {
            Ok(true)
        } else if err.contains("remote ref does not exist") {
            Ok(false)
        } else {
            Err(Error::Git { cmd: "push".into(), stderr: err.trim().into() })
        }
    }

    /// Push `tag`; `force` replaces the one on origin if it points elsewhere.
    pub async fn push_tag(&self, tag: &str, force: bool) -> Result<()> {
        let r = format!("refs/tags/{tag}");
        let mut args = vec!["push"];
        if force {
            args.push("--force");
        }
        args.extend(["origin", &r]);
        self.run(&args).await.map(|_| ())
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
        // --force: a tag moved on origin (a re-merged release) replaces the local one instead of failing the fetch.
        self.run(&["fetch", "--prune", "--tags", "--force", "origin"]).await.map(|_| ())
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

    /// Stable patch id of each non-merge commit in `revs` (rev-list syntax), with its commit.
    pub async fn patch_ids(&self, revs: &[&str]) -> Result<Vec<(String, String)>> {
        let mut args = vec!["log", "-p", "--no-merges", "--no-color", "--no-ext-diff", "--format=commit %H"];
        args.extend_from_slice(revs);
        args.push("--");
        let log = self.run(&args).await?;
        if log.trim().is_empty() {
            return Ok(vec![]);
        }
        let out = self.run_stdin(&["patch-id", "--stable"], &log).await?;
        Ok(out.lines().filter_map(|l| l.split_once(' ')).map(|(id, c)| (id.to_string(), c.to_string())).collect())
    }

    /// Stable patch id of the whole change from `from` to `to`; None when nothing changed.
    pub async fn diff_patch_id(&self, from: &str, to: &str) -> Result<Option<String>> {
        let diff = self.run(&["diff", "--no-color", "--no-ext-diff", from, to, "--"]).await?;
        if diff.trim().is_empty() {
            return Ok(None);
        }
        let out = self.run_stdin(&["patch-id", "--stable"], &diff).await?;
        Ok(out.split_whitespace().next().map(str::to_string))
    }

    pub async fn merge_base(&self, a: &str, b: &str) -> Result<String> {
        Ok(self.run(&["merge-base", a, b]).await?.trim().to_string())
    }

    /// Subjects of the non-merge commits in `range`, oldest first.
    pub async fn subjects(&self, range: &str) -> Result<Vec<String>> {
        let out = self.run(&["log", "--no-merges", "--reverse", "--format=%s", range]).await?;
        Ok(out.lines().filter(|l| !l.is_empty()).map(String::from).collect())
    }

    /// Move `r` to `new` only if it still points at `old`.
    pub async fn update_ref_from(&self, r: &str, new: &str, old: &str) -> Result<()> {
        self.run(&["update-ref", r, new, old]).await.map(|_| ())
    }

    // ---------- history ----------

    /// `range` like "v2.3.0..release/2.4.0", or "--all", or a branch.
    pub async fn log(&self, range: &str, limit: Option<u32>) -> Result<Vec<Commit>> {
        self.log_revs(&[range], limit).await
    }

    /// Commits reachable from any of `revs` (`^rev` excludes), newest first.
    pub async fn log_revs(&self, revs: &[&str], limit: Option<u32>) -> Result<Vec<Commit>> {
        // %D limited to tags reads "tag: v1.0, tag: latest".
        let mut args = vec!["log".to_string(), "--decorate-refs=refs/tags/".to_string(), "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%b%x1e".to_string()];
        if let Some(n) = limit {
            args.push(format!("-n{n}"));
        }
        args.extend(revs.iter().map(|r| r.to_string()));
        args.push("--".to_string());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = self.run(&refs).await?;
        Ok(out
            .split('\x1e')
            .filter_map(|rec| {
                let rec = rec.trim_start_matches('\n');
                let f: Vec<&str> = rec.splitn(7, '\x1f').collect();
                (f.len() == 7).then(|| Commit {
                    sha: f[0].into(),
                    author: f[1].into(),
                    email: f[2].into(),
                    date: f[3].into(),
                    subject: f[5].into(),
                    body: f[6].trim().into(),
                    tags: f[4].split(", ").filter_map(|d| d.strip_prefix("tag: ")).map(Into::into).collect(),
                    local: false,
                    origin: false,
                    unpulled: false,
                })
            })
            .collect())
    }
}

// ---------- parsers (pure, unit-tested) ----------

/// Branch and message of a stash subject: "On <branch>: <message>" when given a message,
/// "WIP on <branch>: <sha> <subject>" otherwise; the branch reads "(no branch)" when detached.
pub fn parse_stash_subject(s: &str) -> (Option<String>, String) {
    let (wip, rest) = match s.strip_prefix("WIP on ") {
        Some(r) => (true, r),
        None => (false, s.strip_prefix("On ").unwrap_or(s)),
    };
    let Some((branch, msg)) = rest.split_once(": ") else {
        return (None, s.to_string());
    };
    // Without a message git describes HEAD: drop its abbreviated SHA.
    let msg = if wip { msg.split_once(' ').map_or(msg, |(_, subject)| subject) } else { msg };
    ((branch != "(no branch)").then(|| branch.to_string()), msg.to_string())
}

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

/// Context flag for a file diff: enough lines to cover any file, or git's default
/// (`--inter-hunk-context=0` is a no-op, so the arg list keeps one shape).
fn context_flag(full: bool) -> &'static str {
    if full { "-U1000000" } else { "--inter-hunk-context=0" }
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
    fn reads_ticket_keys() {
        assert_eq!(ticket_keys("feature/MNC-7187-integrer-nouveau-parcours", true), ["MNC-7187"]);
        assert_eq!(ticket_keys("MNC-7187_&_MNC-7185-integration nouveau parcours", false), ["MNC-7187", "MNC-7185"]);
        assert_eq!(ticket_keys("fix/mnc-7315-7318-adjust", true), ["MNC-7315"]);
        assert_eq!(ticket_keys("bugfix/MNC-6771-android-crash-expo-54", false), ["MNC-6771"]);
        assert!(ticket_keys("Feature/MNC 7322 button transition", true).is_empty());
        assert!(ticket_keys("release/8.17.0", true).is_empty());
        assert!(ticket_keys("feat/x-12abc", true).is_empty());
    }

    #[test]
    fn stash_subjects() {
        assert_eq!(parse_stash_subject("On feat/x: 2 files: a.rs, b.rs"), (Some("feat/x".into()), "2 files: a.rs, b.rs".into()));
        assert_eq!(parse_stash_subject("WIP on main: 1a2b3c4 fix: the thing"), (Some("main".into()), "fix: the thing".into()));
        assert_eq!(parse_stash_subject("On (no branch): saved"), (None, "saved".into()));
        assert_eq!(parse_stash_subject("odd"), (None, "odd".into()));
    }

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
