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

/// Uncommitted files get their lines counted up to this many (per side in `wip_split`). Past it (an
/// unignored node_modules) none are: `diff --numstat` takes half a minute on 60k changed files, and
/// reading every untracked one on each WIP poll stalls the app. The UI says so (`UNCOUNTED_PAST`).
const MAX_COUNTED: usize = 2000;

/// Bytes of untracked files read per listing to count their lines. A file past what is left of it (a dump, a video,
/// a folder of images) shows no count: each WIP poll read it whole (400 MB: 170 ms and 400 MB allocated every 4 s).
const COUNT_BUDGET: u64 = 8 << 20;

/// `git log -E` filter for pull request squashes named after their branch.
const PR_GREP: &str = "--grep=^Merged PR [0-9]+: [^ ]+$";

/// `git log -E` filter for every pull request squash.
pub(crate) const PR_ANY_GREP: &str = "--grep=^Merged PR [0-9]+: ";

/// Branch a pull request squash came from: `Merged PR 12: feature/x` → `feature/x`.
/// An edited title (spaces in it) names no branch.
pub(crate) fn pr_source(subject: &str) -> Option<&str> {
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

/// Told (done, total) files as a long stage or discard goes.
pub type Progress<'a> = &'a (dyn Fn(usize, usize) + Sync);

#[derive(Debug, Clone)]
pub struct Git {
    cwd: PathBuf,
    /// Extra `-c key=value` pairs (author identity, signing).
    config: Vec<(String, String)>,
    /// Another index file than the checkout's own (`GIT_INDEX_FILE`), see [`Git::with_index`].
    index: Option<PathBuf>,
    /// Extra environment, see [`Git::unattended`].
    env: Vec<(&'static str, &'static str)>,
    /// The app's GitHub token may sign in to github.com, see [`Git::with_github`].
    github: bool,
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

/// A changed line picked in a diff: a removal (`-`) by its old line number, an addition (`+`) by its
/// new one. `text` is the line as it was shown, so a pick the file changed under is refused.
#[derive(Debug, Clone, Deserialize)]
pub struct LinePick {
    pub kind: char,
    pub n: u32,
    pub text: String,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// On the local branch but on no origin branch: a hard reset past it loses it.
    #[serde(default)]
    pub unpushed: bool,
    /// Where the branch left its base, listed last below the branch's own commits: a reset there drops them all
    /// (set for one branch's commit list only).
    #[serde(default)]
    pub base: bool,
}

/// Who last changed each line of a file (`git blame`).
#[derive(Debug, Clone, Default, Serialize)]
pub struct Blame {
    pub lines: Vec<String>,
    /// Runs of lines last changed in one commit, in file order: its SHA and how many lines.
    pub runs: Vec<(String, u32)>,
    /// Those commits. The all-zero SHA is uncommitted work.
    pub commits: Vec<Commit>,
}

/// A commit that changed one file, in that file's history.
#[derive(Debug, Clone, Serialize)]
pub struct FileCommit {
    #[serde(flatten)]
    pub commit: Commit,
    /// The file's path in that commit: older commits may know it by another name.
    pub path: String,
    /// Its path before, when this commit renamed it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// A added, M modified, D deleted, R renamed.
    pub status: char,
    pub additions: u32,
    pub deletions: u32,
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

/// State files of an operation in progress, kept in each checkout's own git dir.
const OP_FILES: [&str; 6] = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_START"];

/// Taken for the default branch, in this order, when origin/HEAD isn't set.
const DEFAULT_NAMES: [&str; 4] = ["main", "master", "trunk", "develop"];

/// Commands that may sign in to a host: they get the app's HTTPS logins ([`Git::logins`]).
const SIGNS_IN: [&str; 7] = ["fetch", "pull", "push", "ls-remote", "clone", "submodule", "credential"];

/// Keychain key of the HTTPS logins the user typed when git asked for one, by host.
pub const LOGINS_KEY: &str = "git-logins";

/// What git answers an HTTPS host's sign-in with: a username and a password or access token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Login {
    pub username: String,
    pub token: String,
}

pub fn saved_logins() -> std::collections::BTreeMap<String, Login> {
    crate::secrets::get(LOGINS_KEY).ok().flatten().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Keep `login` for `host`, replacing the one it had. Checked here: the host goes into git config keys, and both
/// values into git's credential protocol, where a line break would start another field.
pub fn save_login(host: &str, login: Login) -> Result<()> {
    let bad = |s: &str| s.is_empty() || s.chars().any(char::is_control);
    if !valid_host(host) || bad(&login.username) || bad(&login.token) {
        return Err(Error::Invalid("a host, a username and a token, each on one line".into()));
    }
    let mut all = saved_logins();
    all.insert(host.into(), login);
    crate::secrets::set(LOGINS_KEY, &serde_json::to_string(&all)?)
}

fn valid_host(h: &str) -> bool {
    !h.is_empty() && h.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c))
}

/// `-c` values and environment letting git answer each host's sign-in from `logins`. Only the environment holds
/// the secrets: arguments show in `ps` and in the log.
fn helpers(logins: &[(String, Login)]) -> impl Iterator<Item = (String, [(String, &str); 2])> + '_ {
    logins.iter().enumerate().map(|(i, (host, l))| {
        let helper = format!("!f() {{ if [ \"$1\" = get ]; then printf 'username=%s\\npassword=%s\\n' \"$GNX_GIT_USER_{i}\" \"$GNX_GIT_TOKEN_{i}\"; fi; }}; f");
        (format!("credential.https://{host}.helper={helper}"), [(format!("GNX_GIT_USER_{i}"), l.username.as_str()), (format!("GNX_GIT_TOKEN_{i}"), l.token.as_str())])
    })
}

/// The HTTPS host git couldn't sign in to: no credential helper knew it, or it refused what one gave.
pub fn login_host(stderr: &str) -> Option<String> {
    let at = ["could not read Username for '", "could not read Password for '", "Authentication failed for '"].iter().find_map(|m| stderr.find(m).map(|i| i + m.len()))?;
    let auth = stderr[at..].strip_prefix("https://")?.split(['/', '\'']).next()?;
    let host = auth.rsplit('@').next()?;
    valid_host(host).then(|| host.to_string())
}

/// Host of an ssh remote URL, with the URL's start before its path: `git@host:` or `ssh://git@host[:port]/`.
fn ssh_prefix(url: &str) -> Option<(&str, &str)> {
    let (host, end) = if let Some(rest) = url.strip_prefix("ssh://") {
        let auth = rest.split('/').next()?;
        (auth.rsplit('@').next()?.split(':').next()?, "ssh://".len() + auth.len() + 1)
    } else {
        // The scp form. A user is required, so a Windows path (`C:/repo`) isn't taken for host `C`.
        let (auth, _) = url.split_once(':')?;
        (auth.split_once('@').filter(|_| !auth.contains('/'))?.1, auth.len() + 1)
    };
    (valid_host(host) && end <= url.len()).then(|| (host, &url[..end]))
}

/// The host a login for `url` is saved under: an http(s) URL's `host[:port]`, an ssh one's host (git may retry it
/// over HTTPS).
fn url_host(url: &str) -> Option<&str> {
    match url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) {
        Some(rest) => rest.split('/').next()?.rsplit('@').next().filter(|h| valid_host(h)),
        None => ssh_prefix(url).map(|(h, _)| h),
    }
}

/// Where the command in `args` starts, past any leading `-c key=value`.
fn verb_at(args: &[&str]) -> usize {
    let mut i = 0;
    while args.get(i) == Some(&"-c") {
        i += 2;
    }
    i
}

/// One `for-each-ref` line per ref with all [`RefList`] needs.
const REF_FORMAT: &str = "--format=%(refname)%1f%(objectname)%1f%(upstream)%1f%(upstream:short)%1f%(committerdate:iso-strict)%1f%(authorname)%1f%(authoremail)%1f%(symref)%1f%(HEAD)%1f%(refname:short)%1f%(creatordate:iso-strict)%1f%(creatordate:unix)%1f%(*objectname)";

/// Refs as one [`REF_FORMAT`] listing gives them.
#[derive(Debug, Default)]
pub struct RefList {
    pub branches: Vec<BranchInfo>,
    /// Origin's, named without `origin/`, its HEAD left out.
    pub remote_branches: Vec<BranchInfo>,
    /// Newest first.
    pub tags: Vec<TagInfo>,
    /// The branch HEAD is on; none when detached or not born yet (see [`Git::current_branch`]).
    pub current: Option<String>,
    /// The branch origin/HEAD points to.
    pub origin_head: Option<String>,
    /// [`Git::ref_fingerprint`], when the listing covered heads, remotes and tags.
    pub fingerprint: String,
}

impl RefList {
    /// [`Git::default_branch`] from this listing; `current` as [`Git::current_branch`] gives it.
    pub fn default_branch(&self, current: Option<&str>) -> String {
        let local = DEFAULT_NAMES.into_iter().find(|n| self.branches.iter().any(|b| b.name == *n));
        self.origin_head.as_deref().or(local).or(current).unwrap_or("main").to_string()
    }
}

/// Whether a ref name read from git can go back to it as an argument. Git's own commands never create a name
/// starting with `-` (`git branch` refuses it), so only a crafted remote can: dropped, no later command
/// (a log, a range, a push) reads it as an option. `origin/-x` counts too: the app strips `origin/` in places.
fn plain_ref(name: &str) -> bool {
    !name.strip_prefix("origin/").unwrap_or(name).starts_with('-')
}

fn parse_refs(out: &str) -> RefList {
    let mut r = RefList::default();
    let mut tags = Vec::new();
    for l in out.lines() {
        let f: Vec<&str> = l.split('\x1f').collect();
        let [refname, sha, upstream, upstream_short, date, author, email, symref, head, short, created, created_unix, peeled] = f[..] else { continue };
        r.fingerprint.push_str(&format!("{refname} {sha} {upstream}\n"));
        let name = ["refs/heads/", "refs/remotes/origin/", "refs/tags/"].iter().find_map(|p| refname.strip_prefix(p)).unwrap_or(refname);
        if !plain_ref(name) {
            continue;
        }
        let info = |name: &str, upstream: Option<String>| BranchInfo { name: name.into(), sha: sha.into(), upstream, date: date.into(), author: author.into(), email: email.trim_matches(['<', '>']).into() };
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            if head == "*" {
                r.current = Some(name.into());
            }
            r.branches.push(info(name, (!upstream_short.is_empty()).then(|| upstream_short.to_string())));
        } else if let Some(name) = refname.strip_prefix("refs/remotes/origin/") {
            if name == "HEAD" {
                r.origin_head = symref.strip_prefix("refs/remotes/origin/").filter(|n| plain_ref(n)).map(String::from);
            } else if symref.is_empty() {
                r.remote_branches.push(info(name, None));
            }
        } else if refname.starts_with("refs/tags/") {
            // Annotated tags point at a tag object; prefer the commit.
            let sha = if peeled.is_empty() { sha } else { peeled };
            tags.push((created_unix.parse::<i64>().unwrap_or(0), TagInfo { name: short.into(), date: created.into(), sha: sha.into() }));
        }
    }
    // Newest first, as `--sort=-creatordate` gives them: a stable sort keeps ties in name order.
    tags.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    r.tags = tags.into_iter().map(|(_, t)| t).collect();
    r
}

impl Git {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Git { cwd: cwd.into(), config: Vec::new(), index: None, env: Vec::new(), github: false }
    }

    /// Lets git sign in to github.com with the app's GitHub token (the user connected github.com, not an Enterprise host).
    pub fn with_github(mut self) -> Self {
        self.github = true;
        self
    }

    /// The HTTPS logins git may answer a host with: the saved ones, then the GitHub token for github.com. Read when a
    /// command may sign in, not before: the keychain may ask the user to unlock it.
    fn logins(&self) -> Vec<(String, Login)> {
        let mut all: Vec<(String, Login)> = saved_logins().into_iter().collect();
        if self.github && !all.iter().any(|(h, _)| h == "github.com") {
            if let Some(token) = crate::secrets::get("github").ok().flatten().filter(|t| !t.is_empty()) {
                all.push(("github.com".into(), Login { username: "x-access-token".into(), token }));
            }
        }
        all
    }

    /// Hosts a sign-in command may go to: those of the URLs in `args`, of the repository's remotes and of its
    /// submodules, configured or listed in `.gitmodules`.
    // shortcut: URLs as written, before the user's `url.*.insteadOf` rewrites, and no nested submodules; resolve them if a login goes missing there.
    fn reached_hosts(&self, args: &[&str]) -> Vec<String> {
        let mut cmd = std::process::Command::new(read_git());
        crate::shell::without_appimage(&mut cmd);
        let config = cmd.current_dir(&self.cwd).args(["config", "--get-regexp", r"^(remote|submodule)\..*\.(push)?url$"]).output();
        let config = config.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        let modules = std::fs::read_to_string(self.cwd.join(".gitmodules")).unwrap_or_default();
        let listed = config.lines().chain(modules.lines()).filter_map(|l| l.split_whitespace().last());
        args.iter().copied().chain(listed).filter_map(url_host).map(String::from).collect()
    }

    /// The same checkout staging into `index` instead of its own index file, which stays as the user left it.
    pub fn with_index(mut self, index: impl Into<PathBuf>) -> Self {
        self.index = Some(index.into());
        self
    }

    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    /// For calls nobody asked for (the background fetch): ssh, git and the credential manager fail instead of asking
    /// for a passphrase, about an unknown host or for a sign-in. An empty `GIT_ASKPASS` keeps git from the desktop's
    /// `SSH_ASKPASS` (`GIT_TERMINAL_PROMPT=0` only stops its terminal prompt). BatchMode only when the user has no ssh
    /// command of their own ([`Git::own_ssh`]): `GIT_SSH_COMMAND` would replace it.
    pub fn unattended(mut self, own_ssh: bool) -> Self {
        self.env.extend([("SSH_ASKPASS_REQUIRE", "never"), ("GCM_INTERACTIVE", "never"), ("GIT_ASKPASS", "")]);
        if !own_ssh {
            self.env.push(("GIT_SSH_COMMAND", "ssh -o BatchMode=yes"));
        }
        self
    }

    /// The user set the ssh git runs: `GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand` (a second account's key).
    pub async fn own_ssh(&self) -> bool {
        std::env::var_os("GIT_SSH_COMMAND").is_some()
            || std::env::var_os("GIT_SSH").is_some()
            || self.try_run(&["config", "--get", "core.sshCommand"]).await.is_ok_and(|(ok, _, _)| ok)
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
        let _ = STARTED.try_with(|n| n.set(n.get() + 1));
        let writes = changes_repo(args);
        if writes {
            let copy = if self.index.is_some() { ", into a copy of its index" } else { "" };
            crate::log::info(format!("Will attempt git {} (in {}{copy})", args.join(" "), self.cwd.display()));
        }
        // Writes can run hooks: they keep the git the user's PATH gives, with its environment.
        let mut cmd = Command::new(if writes { Path::new("git") } else { read_git() });
        crate::shell::without_appimage(cmd.as_std_mut());
        cmd.current_dir(&self.cwd);
        for (k, v) in &self.config {
            cmd.arg("-c").arg(format!("{k}={v}"));
        }
        // After the user's own credential helpers, which git asks first. Only for the hosts this call reaches: hooks
        // and the other programs git starts inherit the environment.
        if args.get(verb_at(args)).is_some_and(|v| SIGNS_IN.contains(v)) {
            let logins = self.logins();
            let reached = if logins.is_empty() { Vec::new() } else { self.reached_hosts(args) };
            let logins: Vec<_> = logins.into_iter().filter(|(h, _)| reached.contains(h)).collect();
            for (conf, env) in helpers(&logins) {
                cmd.arg("-c").arg(conf).envs(env);
            }
        }
        cmd.args(args);
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.env("LC_ALL", "C");
        // A read leaves the index as it is (git status would refresh it): the watcher takes an index write for a change.
        if !writes {
            cmd.env("GIT_OPTIONAL_LOCKS", "0");
        }
        // Never let git open an editor inside the app.
        cmd.env("GIT_EDITOR", "true");
        if let Some(index) = &self.index {
            cmd.env("GIT_INDEX_FILE", index);
        }
        cmd.envs(self.env.iter().copied());
        cmd.kill_on_drop(true);
        cmd
    }

    /// Run git and return stdout; non-zero exit becomes `Error::Git`.
    pub async fn run(&self, args: &[&str]) -> Result<String> {
        let out = self.output(args).await?;
        Self::stdout_or_err(args, out)
    }

    /// Run git. A fetch, pull, push or ls-remote whose ssh failed goes again over HTTPS, for users without a working
    /// key or behind a firewall closing ssh. That answer stands when it worked or the host asks for a sign-in (the app
    /// can ask the user for it); else the ssh error, which says more.
    // shortcut: every call tries ssh first (a closed port waits for ssh's timeout each time); remember the host if that bites.
    async fn output(&self, args: &[&str]) -> std::io::Result<std::process::Output> {
        let out = self.command(args).output().await?;
        let i = verb_at(args);
        let falls_back = matches!(args.get(i), Some(&("fetch" | "pull" | "push" | "ls-remote")));
        if out.status.success() || !falls_back || !String::from_utf8_lossy(&out.stderr).contains("Could not read from remote repository") {
            return Ok(out);
        }
        // Boxed: inline, the retry made every git call's future big enough to overflow a 2 MB stack in debug tests.
        Box::pin(self.over_https(args, i, out)).await
    }

    /// `args` again over HTTPS after its ssh failed with `out`; `out` stands unless HTTPS worked or asks for a sign-in.
    async fn over_https(&self, args: &[&str], i: usize, out: std::process::Output) -> std::io::Result<std::process::Output> {
        // The remote named in `args` (pull names none: the branch's), its URL as git rewrites it.
        let mut get_url = vec!["ls-remote", "--get-url"];
        get_url.extend(args[i + 1..].iter().find(|a| !a.starts_with('-')));
        let url = self.command(&get_url).output().await?;
        let url = String::from_utf8_lossy(&url.stdout);
        let Some((host, prefix)) = ssh_prefix(url.trim()) else { return Ok(out) };
        let mut https = self.clone();
        https.config.push((format!("url.https://{host}/.insteadOf"), prefix.into()));
        let again = https.command(args).output().await?;
        if again.status.success() || login_host(&String::from_utf8_lossy(&again.stderr)).is_some() {
            crate::log::info(format!("ssh to {host} failed, so git {} went over HTTPS", args[i]));
            return Ok(again);
        }
        Ok(out)
    }

    fn stdout_or_err(args: &[&str], out: std::process::Output) -> Result<String> {
        if !out.status.success() {
            crate::log::error(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
            return Err(Error::Git {
                cmd: args.first().copied().unwrap_or("").to_string(),
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Run git and return (exit success, stdout, stderr) without failing.
    pub async fn try_run(&self, args: &[&str]) -> Result<(bool, String, String)> {
        let out = self.output(args).await?;
        if !out.status.success() && changes_repo(args) {
            crate::log::error(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
        }
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
        Ok(if ok { Some(out.trim().to_string()).filter(|b| plain_ref(b)) } else { None })
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
            if let Some(name) = out.trim().strip_prefix("origin/").filter(|n| plain_ref(n)) {
                return Ok(name.to_string());
            }
        }
        for name in DEFAULT_NAMES {
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
        // An operation's state files sit in the checkout's own git dir, which its `.git` names: no git process,
        // each one ~40 ms on Windows. Other names may live in the common dir or be redirected.
        if names.iter().all(|n| OP_FILES.contains(&n.split('/').next().unwrap_or(""))) {
            if let Some(dir) = self.own_git_dir() {
                return Ok(names.iter().map(|n| dir.join(n)).collect());
            }
        }
        let args: Vec<&str> = ["rev-parse"].into_iter().chain(names.iter().flat_map(|n| ["--git-path", n])).collect();
        let out = self.run(&args).await?;
        Ok(out.lines().map(|l| self.cwd.join(l.trim())).collect())
    }

    /// The git dir `.git` is or names (`gitdir: …` in a worktree or submodule); None when `cwd` isn't a checkout's top.
    fn own_git_dir(&self) -> Option<PathBuf> {
        let dot = self.cwd.join(".git");
        if dot.is_dir() {
            return Some(dot);
        }
        let s = std::fs::read_to_string(&dot).ok()?;
        Some(self.cwd.join(s.strip_prefix("gitdir:")?.trim()))
    }

    pub async fn is_rebasing(&self) -> Result<bool> {
        Ok(self.git_paths(&["rebase-merge", "rebase-apply"]).await?.iter().any(|p| p.exists()))
    }

    /// The rebase, merge, cherry-pick or revert this checkout is stopped in the middle of, if any.
    pub async fn in_progress(&self) -> Result<Option<&'static str>> {
        let paths = self.git_paths(&["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]).await?;
        let ops = ["rebase", "rebase", "merge", "cherry-pick", "revert"];
        Ok(paths.iter().zip(ops).find(|(p, _)| p.exists()).map(|(_, op)| op))
    }

    /// The branch this checkout is rebasing or bisecting, its HEAD detached meanwhile.
    pub async fn detached_from(&self) -> Result<Option<String>> {
        let paths = self.git_paths(&["rebase-merge/head-name", "rebase-apply/head-name", "BISECT_START"]).await?;
        Ok(paths.iter().find_map(|p| std::fs::read_to_string(p).ok()).map(|s| s.trim().trim_start_matches("refs/heads/").to_string()))
    }

    /// The branch this checkout is rebasing (not bisecting), its HEAD detached meanwhile.
    pub async fn rebasing_branch(&self) -> Result<Option<String>> {
        let paths = self.git_paths(&["rebase-merge/head-name", "rebase-apply/head-name"]).await?;
        Ok(paths.iter().find_map(|p| std::fs::read_to_string(p).ok()).and_then(|s| s.trim().strip_prefix("refs/heads/").map(String::from)))
    }

    /// Commit the paused rebase is on, from 1, and how many it replays.
    pub async fn rebase_step(&self) -> Result<Option<(u32, u32)>> {
        let paths = self.git_paths(&["rebase-merge/msgnum", "rebase-merge/end", "rebase-apply/next", "rebase-apply/last"]).await?;
        let read = |i: usize| std::fs::read_to_string(&paths[i]).ok().and_then(|s| s.trim().parse::<u32>().ok());
        Ok(read(0).zip(read(1)).or_else(|| read(2).zip(read(3))))
    }

    /// Subject of the commit the paused rebase stopped on.
    pub async fn rebase_subject(&self) -> Result<String> {
        let (_, out, _) = self.try_run(&["log", "-1", "--format=%s", "REBASE_HEAD"]).await?;
        Ok(out.trim().to_string())
    }

    /// Settle conflicted `path` on one side: stage 2 (the checkout's version) or 3 (the one brought in).
    pub async fn take_stage(&self, path: &str, stage: u8) -> Result<()> {
        self.run(&["checkout", if stage == 2 { "--ours" } else { "--theirs" }, "--", path]).await?;
        self.add(path).await
    }

    /// Commit the paused rebase replays onto.
    pub async fn rebase_onto(&self) -> Result<Option<String>> {
        let paths = self.git_paths(&["rebase-merge/onto", "rebase-apply/onto"]).await?;
        Ok(paths.iter().find_map(|p| std::fs::read_to_string(p).ok()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
    }

    /// Branches whose tip is `sha`: local ones first, then origin's (without `origin/`).
    pub async fn branches_at(&self, sha: &str) -> Result<Vec<String>> {
        let out = self.run(&["for-each-ref", "--points-at", sha, "--format=%(refname)", "refs/heads", "refs/remotes/origin"]).await?;
        Ok(out
            .lines()
            .filter_map(|l| l.strip_prefix("refs/heads/").or_else(|| l.strip_prefix("refs/remotes/origin/")))
            .filter(|n| *n != "HEAD" && plain_ref(n))
            .map(String::from)
            .collect())
    }

    // ---------- refs ----------

    /// Every ref the overview reads, in one git process: heads, remotes and tags.
    pub async fn read_refs(&self) -> Result<RefList> {
        self.list_refs(&["refs/heads", "refs/remotes", "refs/tags"]).await
    }

    async fn list_refs(&self, patterns: &[&str]) -> Result<RefList> {
        let args: Vec<&str> = ["for-each-ref", REF_FORMAT].into_iter().chain(patterns.iter().copied()).collect();
        Ok(parse_refs(&self.run(&args).await?))
    }

    pub async fn branches(&self) -> Result<Vec<BranchInfo>> {
        Ok(self.list_refs(&["refs/heads"]).await?.branches)
    }

    /// Branches on origin (names without the `origin/` prefix, `HEAD` left out).
    pub async fn remote_branches(&self) -> Result<Vec<BranchInfo>> {
        Ok(self.list_refs(&["refs/remotes/origin"]).await?.remote_branches)
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
        Ok(out.lines().filter(|n| plain_ref(n)).map(str::to_string).collect())
    }

    /// Whether `base` holds a pull request of branch `name` (tip `rev`) squashed in after its last commit.
    pub async fn pr_merged_into(&self, name: &str, rev: &str, base: &str) -> Result<bool> {
        let tip: i64 = self.run(&["log", "-1", "--format=%ct", rev]).await?.trim().parse().unwrap_or(i64::MAX);
        let not_rev = format!("^{rev}");
        let out = self.run(&["log", "--no-merges", "-E", PR_GREP, "--format=%ct%x1f%s", base, &not_rev, "--"]).await?;
        Ok(out.lines().filter_map(|l| l.split_once('\x1f')).any(|(t, s)| pr_source(s) == Some(name) && t.parse::<i64>().is_ok_and(|t| t >= tip)))
    }

    pub async fn tags(&self) -> Result<Vec<TagInfo>> {
        Ok(self.list_refs(&["refs/tags"]).await?.tags)
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
        Ok(ok.then(|| out.trim().to_string()).filter(|u| !u.is_empty() && plain_ref(u)))
    }

    /// `sha` was the tip of local `branch` at some point (its reflog): the
    /// branch has had it, so replacing it upstream loses nothing unseen.
    pub async fn in_reflog(&self, branch: &str, sha: &str) -> Result<bool> {
        let (ok, out, _) = self.try_run(&["reflog", "show", "--format=%H", &format!("refs/heads/{branch}")]).await?;
        Ok(ok && out.lines().any(|l| l == sha))
    }

    pub async fn is_ancestor(&self, a: &str, b: &str) -> Result<bool> {
        Ok(self.ancestry(a, b).await? == Some(true))
    }

    /// [`Git::is_ancestor`], None when git can't tell (a commit it doesn't have yet).
    pub async fn ancestry(&self, a: &str, b: &str) -> Result<Option<bool>> {
        let out = self.command(&["merge-base", "--is-ancestor", a, b]).output().await?;
        Ok(match out.status.code() {
            Some(0) => Some(true),
            Some(1) => Some(false),
            _ => None,
        })
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
        Ok((true, self.merged_by_commit(tip, base_tip).await?))
    }

    /// A merge commit in `base_tip` has `tip` (already in it) as a merged-in parent.
    pub async fn merged_by_commit(&self, tip: &str, base_tip: &str) -> Result<bool> {
        let merges = self.run(&["rev-list", "--merges", "--parents", "--ancestry-path", &format!("{tip}..{base_tip}")]).await?;
        Ok(merges.lines().any(|l| l.split_whitespace().skip(2).any(|p| p == tip)))
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
        Ok(self.squash_check(branch, base, None).await?.0)
    }

    /// [`Git::is_squash_merged`], with the commit the squash looked for was made on when it got that far.
    /// `fork`: their merge base, when the caller already knows it.
    pub async fn squash_check(&self, branch: &str, base: &str, fork: Option<&str>) -> Result<(bool, Option<String>)> {
        let fork = match fork {
            Some(f) => f.to_string(),
            None => self.run(&["merge-base", base, branch]).await?.trim().to_string(),
        };
        // The branch's commits (oldest first, like `git cherry`) and its squash from the fork, each marked `=`
        // when the base has its patch: one walk of the base's patches answers both.
        let squash = self.squash_commit(branch, &fork).await?;
        let (mine, theirs) = (format!("{base}...{branch}"), squash.as_ref().map(|s| format!("{base}...{s}")));
        let mut args = vec!["rev-list", "--reverse", "--cherry", mine.as_str()];
        args.extend(theirs.as_deref());
        let marks = self.run(&args).await?;
        let mut own: Vec<(bool, &str)> = Vec::new();
        let mut squashed = false;
        for l in marks.lines() {
            let (same, sha) = (l.starts_with('='), l.get(1..).unwrap_or_default().trim());
            match squash.as_deref() == Some(sha) {
                true => squashed = same,
                false => own.push((same, sha)),
            }
        }
        if !own.is_empty() && own.iter().all(|(same, _)| *same) {
            return Ok((true, None));
        }
        // Oldest commits already upstream (other work the branch pulled in) were not part of its
        // squash: squash from the last of them. Otherwise from where the branch forked.
        let upstream = own.iter().take_while(|(same, _)| *same).count();
        if upstream > 0 && own[upstream..].iter().all(|(same, _)| !same) {
            let parent = own[upstream - 1].1.to_string();
            let Some(squash) = self.squash_commit(branch, &parent).await? else { return Ok((false, None)) };
            let cherry = self.run(&["cherry", base, &squash]).await?;
            return Ok((!cherry.trim().is_empty() && cherry.lines().all(|l| l.starts_with('-')), Some(parent)));
        }
        Ok(match squash {
            Some(_) => (squashed, Some(fork)),
            None => (false, None),
        })
    }

    /// A throwaway commit on `parent` holding `branch`'s tree: the whole branch as one change. None when git can't make it.
    async fn squash_commit(&self, branch: &str, parent: &str) -> Result<Option<String>> {
        let tree = format!("{branch}^{{tree}}");
        let out = self
            .command(&["commit-tree", &tree, "-p", parent, "-m", "squash"])
            .env("GIT_AUTHOR_NAME", "gitnetix")
            .env("GIT_AUTHOR_EMAIL", "gitnetix@localhost")
            .env("GIT_COMMITTER_NAME", "gitnetix")
            .env("GIT_COMMITTER_EMAIL", "gitnetix@localhost")
            .output()
            .await?;
        Ok(out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()))
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

    /// Rename a local branch: its reflog, config and checkouts follow.
    pub async fn rename_branch(&self, from: &str, to: &str) -> Result<()> {
        self.run(&["branch", "-m", from, to]).await.map(|_| ())
    }

    pub async fn set_upstream(&self, branch: &str, upstream: &str) -> Result<()> {
        self.run(&["branch", "--set-upstream-to", upstream, branch]).await.map(|_| ())
    }

    /// Rename `from` to `to` on origin in one push: both land or neither does. Leases: `from` must
    /// still be at `sha` (nothing pushed since is lost) and `to` must not exist there yet.
    pub async fn push_rename(&self, from: &str, to: &str, sha: &str) -> Result<String> {
        let (from, to) = (format!("refs/heads/{from}"), format!("refs/heads/{to}"));
        self.push_atomic(&[&format!("--force-with-lease={from}:{sha}"), &format!("--force-with-lease={to}:"), &format!("{sha}:{to}"), &format!(":{from}")]).await
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
                    w.branch = Some(b.trim_start_matches("refs/heads/").to_string()).filter(|b| plain_ref(b));
                }
            }
        }
        if let Some(w) = cur {
            list.push(w);
        }
        // Rebasing detaches HEAD: the checkout still belongs to the branch being rebased.
        // A folder deleted outside git (still listed, prunable) is skipped.
        for w in list.iter_mut().filter(|w| w.branch.is_none() && Path::new(&w.path).exists()) {
            w.branch = Git::new(&w.path).rebasing_branch().await.ok().flatten().filter(|b| plain_ref(b));
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
        let res = if force { self.run(&["worktree", "remove", "--force", &p]).await } else { self.run(&["worktree", "remove", &p]).await };
        let Err(e) = res else { return Ok(()) };
        // Refused (locked, dirty): git still lists it, and its folder stays as it is.
        let real = std::fs::canonicalize(path)?;
        if self.worktrees().await?.iter().any(|w| std::fs::canonicalize(&w.path).is_ok_and(|w| w == real)) {
            return Err(e);
        }
        // Git dropped its record but a process just killed in there (its shell's or agent's build) kept writing:
        // "Directory not empty". Finish the folder once that process is gone.
        // shortcut: a writer alive past 5s (a dev server the agent left running) still fails; kill agents' whole process group if that shows up.
        for _ in 0..25 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            match tokio::fs::remove_dir_all(path).await {
                Err(x) if x.kind() != std::io::ErrorKind::NotFound => {}
                _ => return Ok(()),
            }
        }
        Err(e)
    }

    // ---------- working tree ----------

    /// Uncommitted changes (staged + unstaged + untracked) against HEAD.
    pub async fn wip_changes(&self) -> Result<Vec<FileChange>> {
        let (status, has_head) = tokio::try_join!(self.run(&["status", "--porcelain=v1", "-z", "-uall"]), self.ref_exists("HEAD"))?;
        let mut entries = parse_status_z(&status);
        let count = entries.len() <= MAX_COUNTED;
        let stats = self.numstat(count && has_head, &["diff", "--numstat", "-z", "HEAD"]).await?;
        let mut budget = COUNT_BUDGET;
        for e in entries.iter_mut() {
            if let Some((a, d)) = stats.get(&e.path) {
                e.additions = *a;
                e.deletions = *d;
            } else if count && e.status == 'A' {
                e.additions = count_lines(&self.cwd.join(&e.path), &mut budget);
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

    /// Set aside every uncommitted change, untracked files included; returns the new stash's sha.
    pub async fn stash(&self, message: &str) -> Result<String> {
        self.run(&["stash", "push", "--include-untracked", "-m", message]).await?;
        self.rev_parse("refs/stash").await
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
        let status = self.run(&["status", "--porcelain=v1", "-z", "-uall"]).await?;
        let mut out = parse_status_split_z(&status);
        let count = |staged: bool| out.iter().filter(|e| e.staged == Some(staged)).count() <= MAX_COUNTED;
        let (count_staged, count_unstaged) = (count(true), count(false));
        let (staged_stats, unstaged_stats) = tokio::try_join!(
            self.numstat(count_staged, &["diff", "--cached", "--numstat", "-z"]),
            self.numstat(count_unstaged, &["diff", "--numstat", "-z"]),
        )?;
        let mut budget = COUNT_BUDGET;
        for e in out.iter_mut() {
            let stats = if e.staged == Some(true) { &staged_stats } else { &unstaged_stats };
            if let Some((a, d)) = stats.get(&e.path) {
                e.additions = *a;
                e.deletions = *d;
            } else if count_unstaged && e.status == 'A' && e.staged == Some(false) {
                e.additions = count_lines(&self.cwd.join(&e.path), &mut budget);
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// Lines added and deleted per file by the `diff --numstat` in `args`; none when not `on`.
    async fn numstat(&self, on: bool, args: &[&str]) -> Result<HashMap<String, (u32, u32)>> {
        Ok(if on { parse_numstat_z(&self.run(args).await?) } else { HashMap::new() })
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

    /// Index stages conflicted `path` has, in order: 1 the common base, 2 the checkout's side, 3 the side
    /// brought in. Base and one side only: changed on that side, deleted on the other.
    pub async fn conflict_stages(&self, path: &str) -> Result<Vec<u8>> {
        let out = self.run(&["ls-files", "-u", "-z", "--", path]).await?;
        // "<mode> <sha> <stage>\t<path>"
        Ok(out.split('\0').filter_map(|e| e.split_once('\t').filter(|(_, p)| *p == path)?.0.rsplit(' ').next()?.parse().ok()).collect())
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

    /// Diff of a file `range` renamed from `from`: with both names git pairs them and shows only what changed.
    pub async fn rename_diff(&self, from: &str, path: &str, range: &str, full: bool) -> Result<Vec<Hunk>> {
        Ok(parse_unified(&self.run(&["diff", context_flag(full), "-M", range, "--", from, path]).await?))
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

    // Picked paths go through stdin to plumbing that looks each one up. On the command line tens of
    // thousands pass the OS argument limit (os error 7), and porcelain pathspecs (`add`, `reset`,
    // `checkout`) match every index entry against every path: ~30 s more at 60k files.

    /// Every file on one side of the uncommitted work, as `wip_split` has them. Status alone: the
    /// line counts can take a minute on tens of thousands of changed files.
    pub async fn wip_side(&self, staged: bool) -> Result<Vec<String>> {
        let status = self.run(&["status", "--porcelain=v1", "-z", "-uall"]).await?;
        Ok(parse_status_split_z(&status).into_iter().filter(|f| f.staged == Some(staged)).map(|f| f.path).collect())
    }

    /// Stage `paths`, including deletions.
    pub async fn stage(&self, paths: &[String], tell: Progress<'_>) -> Result<()> {
        // A nested repository is listed as `dir/`; update-index ignores it unless the slash goes.
        let list: Vec<&str> = paths.iter().map(|p| p.trim_end_matches('/')).collect();
        self.run_paths(&["update-index", "--add", "--remove", "-z", "--stdin"], &list, &|n| tell(n, list.len())).await
    }

    /// Move `paths` back out of the index; the working tree is untouched.
    pub async fn unstage(&self, paths: &[String]) -> Result<()> {
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        self.index_to_head(&paths).await.map(|_| ())
    }

    /// Put the index entries of `paths` back to HEAD, dropping those HEAD lacks; the working tree is
    /// untouched. Returns the paths split into (in HEAD, not in HEAD).
    async fn index_to_head<'a>(&self, paths: &[&'a str]) -> Result<(Vec<&'a str>, Vec<&'a str>)> {
        if paths.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        let tree =if self.ref_exists("HEAD").await? { self.run(&["ls-tree", "-r", "-z", "HEAD"]).await? } else { String::new() };
        // `<mode> <type> <object>\t<path>`, the line `update-index --index-info` takes back.
        let entries: HashMap<&str, &str> = tree.split('\0').filter_map(|e| Some((e.split_once('\t')?.1, e))).collect();
        let (in_head, gone): (Vec<&str>, Vec<&str>) = paths.iter().copied().partition(|p| entries.contains_key(p));
        if !in_head.is_empty() {
            let info: String = in_head.iter().map(|p| format!("{}\0", entries[p])).collect();
            self.run_stdin(&["update-index", "-z", "--index-info"], info).await?;
        }
        if !gone.is_empty() {
            self.run_stdin(&["update-index", "--force-remove", "-z", "--stdin"], gone.join("\0")).await?;
        }
        Ok((in_head, gone))
    }

    /// Stage only the `picked` lines of `path`'s unstaged changes or, with `unstage`, take them back
    /// out of its staged ones. Every other line stays on its side; the working tree is untouched.
    pub async fn stage_lines(&self, path: &str, picked: &[LinePick], unstage: bool) -> Result<()> {
        let patch = pick_patch(&self.raw_side_diff(path, unstage).await?, path, picked, unstage)?;
        let args: &[&str] = if unstage { &["apply", "--cached", "-R", "--whitespace=nowarn", "-"] } else { &["apply", "--cached", "--whitespace=nowarn", "-"] };
        self.run_stdin(args, &patch).await.map(|_| ())
    }

    /// Throw away only the `picked` lines of `path`'s unstaged changes: the working tree takes them back
    /// to their staged version (an untracked file left with none of its lines is deleted). The index is untouched.
    pub async fn discard_lines(&self, path: &str, picked: &[LinePick]) -> Result<()> {
        let patch = pick_patch(&self.raw_side_diff(path, false).await?, path, picked, true)?;
        self.run_stdin(&["apply", "-R", "--whitespace=nowarn", "-"], &patch).await.map(|_| ())
    }

    /// Git's diff of one side of `path`'s uncommitted work, byte for byte. Three lines of context
    /// whatever diff.context says: `git apply` wants some.
    async fn raw_side_diff(&self, path: &str, staged: bool) -> Result<Vec<u8>> {
        if staged {
            self.run_raw(&["diff", "--cached", "--no-color", "--no-ext-diff", "-U3", "--", path], false).await
        } else if self.is_tracked(path).await? {
            self.run_raw(&["diff", "--no-color", "--no-ext-diff", "-U3", "--", path], false).await
        } else {
            self.run_raw(&["diff", "--no-color", "--no-ext-diff", "-U3", "--no-index", "--", "/dev/null", path], true).await
        }
    }

    /// Throw away working-tree changes to `paths`: tracked files go back to
    /// their staged state, untracked ones are deleted. Conflicts left with no
    /// operation paused (a stash apply) go back to HEAD.
    pub async fn discard_unstaged(&self, paths: &[String], tell: Progress<'_>) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        // Only paths git names as untracked get deleted.
        let (listed, unmerged) = tokio::try_join!(
            self.run(&["ls-files", "-z", "--others", "--exclude-standard"]),
            self.run(&["diff", "--name-only", "--diff-filter=U", "-z"]),
        )?;
        let others: HashSet<&str> = listed.split('\0').collect();
        let (mut untracked, mut tracked): (Vec<&str>, Vec<&str>) = paths.iter().map(String::as_str).partition(|p| others.contains(p));
        let conflicted: Vec<&str> = tracked.iter().copied().filter(|p| unmerged.split('\0').any(|u| u == *p)).collect();
        if let Some(p) = conflicted.first() {
            // A paused rebase, merge, cherry-pick or revert settles its conflicts by resolving or aborting it. Refuse up
            // front: checkout-index would restore the other files and only then fail on the conflict.
            if self.in_progress().await?.is_some() {
                return Err(Error::Invalid(format!("{p} has conflicts: resolve them first")));
            }
            // Nothing to resolve or abort (a stash apply keeps its stash): back to HEAD, as before the apply.
            let (_, gone) = self.index_to_head(&conflicted).await?;
            tracked.retain(|p| !gone.contains(p));
            untracked.extend(gone);
        }
        self.run_paths(&["checkout-index", "-f", "-u", "-z", "--stdin"], &tracked, &|n| tell(n, paths.len())).await?;
        // What `git clean -f` does to these files, which it only takes as arguments: emptied folders
        // stay, and so does a nested repository (listed as `dir/`).
        for (i, p) in untracked.iter().enumerate() {
            if !p.ends_with('/') {
                match std::fs::remove_file(self.cwd.join(p)) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                    _ => {}
                }
            }
            tell(tracked.len() + i + 1, paths.len());
        }
        Ok(())
    }

    /// Throw away staged changes to `paths` entirely: index and working tree
    /// go back to HEAD (files added since HEAD are deleted, rename sources restored).
    pub async fn discard_staged(&self, paths: &[String], tell: Progress<'_>) -> Result<()> {
        let has_head = self.ref_exists("HEAD").await?;
        let mut targets: Vec<String> = paths.to_vec();
        if has_head {
            // A staged rename only lists its new path; bring the old one back too.
            let ns = self.run(&["diff", "--cached", "--name-status", "-z", "-M"]).await?;
            let picked: HashSet<&str> = paths.iter().map(String::as_str).collect();
            let mut parts = ns.split('\0').filter(|p| !p.is_empty());
            while let Some(code) = parts.next() {
                if code.starts_with('R') || code.starts_with('C') {
                    let (old, new) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                    if code.starts_with('R') && picked.contains(new) {
                        targets.push(old.to_string());
                    }
                } else {
                    parts.next();
                }
            }
        }
        let targets: Vec<&str> = targets.iter().map(String::as_str).collect();
        let (restore, remove) = self.index_to_head(&targets).await?;
        self.run_paths(&["checkout-index", "-f", "-u", "-z", "--stdin"], &restore, &|n| tell(n, targets.len())).await?;
        for (i, p) in remove.iter().enumerate() {
            let _ = std::fs::remove_file(self.cwd.join(p));
            tell(restore.len() + i + 1, targets.len());
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

    /// Run git with `paths` NUL-separated on its stdin, a thousand at a time; `tell` gets how many it
    /// has taken so far. git handles each path as it reads it, so that is how far it got, give or take
    /// a pipe's worth. Nothing to run without paths.
    async fn run_paths(&self, args: &[&str], paths: &[&str], tell: &(dyn Fn(usize) + Sync)) -> Result<()> {
        use std::process::Stdio;
        use tokio::io::AsyncWriteExt;
        if paths.is_empty() {
            return Ok(());
        }
        let mut child = self.command(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let mut sent = 0;
        for batch in paths.chunks(1000) {
            let buf: Vec<u8> = batch.iter().flat_map(|p| p.bytes().chain([0])).collect();
            // git stopped reading: its exit status and stderr say why.
            if stdin.write_all(&buf).await.is_err() {
                break;
            }
            sent += batch.len();
            tell(sent);
        }
        drop(stdin);
        Self::stdout_or_err(args, child.wait_with_output().await?).map(|_| ())
    }

    pub(crate) async fn run_stdin(&self, args: &[&str], input: impl AsRef<[u8]>) -> Result<String> {
        use std::process::Stdio;
        use tokio::io::AsyncWriteExt;
        let mut child = self.command(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        stdin.write_all(input.as_ref()).await?;
        drop(stdin);
        Self::stdout_or_err(args, child.wait_with_output().await?)
    }

    /// Run git and return its stdout byte for byte (a diff, whatever the files' encoding).
    /// `differ_ok` takes exit code 1 as success: `diff --no-index` exits with it when files differ.
    async fn run_raw(&self, args: &[&str], differ_ok: bool) -> Result<Vec<u8>> {
        let out = self.command(args).output().await?;
        if out.status.success() || (differ_ok && out.status.code() == Some(1)) {
            return Ok(out.stdout);
        }
        Self::stdout_or_err(args, out).map(String::into_bytes)
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
            // --no-rebase: with pull.rebase set, git refuses any uncommitted change, even ones the fast-forward leaves alone.
            self.try_run(&["pull", "--ff-only", "--no-rebase"]).await?
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

    /// Origin's branch and tag tips, as `ls-remote` lists them: one round trip that writes nothing here
    /// (a fetch with nothing new still rewrites FETCH_HEAD). Same refs as [`Git::fetch`] takes.
    pub async fn remote_tips(&self) -> Result<String> {
        self.run(&["ls-remote", "--heads", "--tags", "origin"]).await
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
        self.continue_op("rebase").await
    }

    /// `git <op> --continue` once its conflicts are staged (rebase, merge, cherry-pick, revert),
    /// keeping the prepared message. Returns false when it stopped on conflicts again (a rebase's next commit).
    pub async fn continue_op(&self, op: &str) -> Result<bool> {
        if op == "rebase" {
            self.commit_commented_pick().await?;
        }
        let (ok, _, err) = self.try_run(&["-c", "core.editor=true", op, "--continue"]).await?;
        if ok {
            return Ok(true);
        }
        if !self.conflicted_files().await?.is_empty() {
            return Ok(false);
        }
        Err(Error::Git { cmd: op.into(), stderr: err.trim().into() })
    }

    /// A paused rebase pick whose message is all `#` lines (`#42 fix login`): `--continue` takes them for
    /// comments, finds the message empty and refuses. Commit it here instead, message and author as they were.
    async fn commit_commented_pick(&self) -> Result<()> {
        let paths = self.git_paths(&["rebase-merge/done", "rebase-merge/message"]).await?;
        let (Ok(done), Ok(message)) = (std::fs::read_to_string(&paths[0]), std::fs::read_to_string(&paths[1])) else {
            return Ok(());
        };
        // Squash, fixup and edit steps make their commit differently: git's own path for those.
        let pick = done.lines().rev().find(|l| !l.trim().is_empty()).is_some_and(|l| l.starts_with("pick ") || l.starts_with("p "));
        let commented = message.lines().all(|l| l.trim().is_empty() || l.starts_with('#'));
        if pick && commented && self.conflicted_files().await?.is_empty() && self.has_staged().await? {
            // No hooks, as git's own continue commits it.
            self.run(&["commit", "--no-verify", "-C", "REBASE_HEAD"]).await?;
        }
        Ok(())
    }

    pub async fn abort_op(&self, op: &str) -> Result<()> {
        self.run(&[op, "--abort"]).await.map(|_| ())
    }

    /// Staged files whose changes add conflict markers (`<<<<<<<` / `>>>>>>>` lines).
    pub async fn staged_with_conflict_markers(&self) -> Result<Vec<String>> {
        let out = self.run(&["diff", "--cached", "-U0", "--no-color", "--no-ext-diff"]).await?;
        let mut files: Vec<String> = Vec::new();
        let mut file = "";
        for l in out.lines() {
            if let Some(f) = l.strip_prefix("+++ b/") {
                file = f;
            } else if (l.starts_with("+<<<<<<< ") || l.starts_with("+>>>>>>> ")) && files.last().map(String::as_str) != Some(file) {
                files.push(file.to_string());
            }
        }
        Ok(files)
    }

    /// Undo a commit with a new one. Returns false when it stopped on conflicts.
    pub async fn revert(&self, sha: &str) -> Result<bool> {
        self.apply_commit("revert", sha).await
    }

    /// Copy a commit onto the checked-out branch. Returns false when it stopped on conflicts.
    pub async fn cherry_pick(&self, sha: &str) -> Result<bool> {
        self.apply_commit("cherry-pick", sha).await
    }

    /// `revert` / `cherry-pick` one commit; a merge commit is taken against its first parent.
    /// Stopped on conflicts, it stays in progress; any other failure is aborted.
    async fn apply_commit(&self, cmd: &str, sha: &str) -> Result<bool> {
        let merge = self.try_run(&["rev-parse", "--verify", "-q", &format!("{sha}^2")]).await?.0;
        let mut args = vec![cmd, "--no-edit"];
        if merge {
            args.extend(["-m", "1"]);
        }
        args.push(sha);
        let (ok, _, err) = self.try_run(&args).await?;
        if ok {
            return Ok(true);
        }
        if !self.conflicted_files().await?.is_empty() {
            return Ok(false);
        }
        let _ = self.try_run(&[cmd, "--abort"]).await;
        Err(Error::Git { cmd: cmd.into(), stderr: err.trim().into() })
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

    /// Merge commit in the current checkout. Returns false when it stopped on conflicts,
    /// left in progress; any other failure is aborted.
    pub async fn merge_start(&self, from: &str, message: &str) -> Result<bool> {
        let (ok, _, err) = self.try_run(&["merge", "--no-ff", "-m", message, from]).await?;
        if ok {
            return Ok(true);
        }
        if !self.conflicted_files().await?.is_empty() {
            return Ok(false);
        }
        let _ = self.try_run(&["merge", "--abort"]).await;
        Err(Error::Git { cmd: "merge".into(), stderr: err.trim().into() })
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
                (f.len() == 7).then(|| commit_of(&f))
            })
            .collect())
    }

    /// Commits reachable from `rev` that changed `path`, newest first, following its renames.
    pub async fn file_log(&self, rev: &str, path: &str, limit: u32) -> Result<Vec<FileCommit>> {
        let n = format!("-n{limit}");
        let format = "--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%b%x1f";
        Ok(parse_file_log(&self.run(&["log", "--follow", "--decorate-refs=refs/tags/", format, "--raw", "--numstat", "-z", &n, rev, "--", path]).await?))
    }

    /// Who last changed each line of `path` on one side: at a revision, or in this checkout's index or working tree
    /// (uncommitted lines too, against HEAD).
    pub async fn blame(&self, side: Side<'_>, path: &str) -> Result<Blame> {
        let out = match side {
            Side::Rev(rev) => self.run(&["blame", "--porcelain", rev, "--", path]).await,
            Side::Worktree => self.run(&["blame", "--porcelain", "--", path]).await,
            Side::Index => match self.blob(Side::Index, path).await? {
                Some(bytes) => self.run_stdin(&["blame", "--porcelain", "--contents", "-", "--", path], bytes).await,
                None => return Err(Error::Invalid(format!("{path} is not in the index"))),
            },
        };
        match out {
            Ok(out) => Ok(parse_blame(&out)),
            // git refuses a file HEAD doesn't have yet (untracked, or only staged): all of it is uncommitted.
            Err(e) if !matches!(side, Side::Rev(_)) && !self.try_run(&["cat-file", "-e", &format!("HEAD:{path}")]).await?.0 => match self.blob(side, path).await? {
                Some(bytes) => Ok(uncommitted_blame(&String::from_utf8_lossy(&bytes))),
                None => Err(e),
            },
            Err(e) => Err(e),
        }
    }
}

/// One `log_revs` record's fields: SHA, author, email, date, tag decorations, subject, body.
fn commit_of(f: &[&str]) -> Commit {
    Commit {
        sha: f[0].into(),
        author: f[1].into(),
        email: f[2].into(),
        date: f[3].into(),
        subject: f[5].into(),
        body: f[6].trim().into(),
        tags: f[4].split(", ").filter_map(|d| d.strip_prefix("tag: ")).map(Into::into).collect(),
        ..Commit::default()
    }
}

/// SHA git blame gives lines that are not committed yet.
const UNCOMMITTED: &str = "0000000000000000000000000000000000000000";

/// Blame of a file git has no history of: every line uncommitted.
fn uncommitted_blame(text: &str) -> Blame {
    let lines: Vec<String> = text.lines().map(String::from).collect();
    let runs = if lines.is_empty() { vec![] } else { vec![(UNCOMMITTED.to_string(), lines.len() as u32)] };
    Blame { lines, runs, commits: vec![Commit { sha: UNCOMMITTED.into(), author: "Not Committed Yet".into(), ..Commit::default() }] }
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

/// `git blame --porcelain`: a "<sha> <old line> <new line> [<count>]" header before each line, the commit's
/// "key value" lines the first time it comes, then the line itself after a tab.
pub fn parse_blame(s: &str) -> Blame {
    let mut b = Blame::default();
    let mut at: HashMap<String, usize> = HashMap::new();
    let mut sha = String::new();
    for line in s.lines() {
        if let Some(text) = line.strip_prefix('\t') {
            b.lines.push(text.to_string());
            match b.runs.last_mut() {
                Some((s, n)) if *s == sha => *n += 1,
                _ => b.runs.push((sha.clone(), 1)),
            }
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        if (40..=64).contains(&key.len()) && key.bytes().all(|c| c.is_ascii_hexdigit()) {
            sha = key.to_string();
            at.entry(sha.clone()).or_insert_with(|| {
                b.commits.push(Commit { sha: sha.clone(), ..Commit::default() });
                b.commits.len() - 1
            });
            continue;
        }
        let Some(c) = at.get(&sha).map(|&i| &mut b.commits[i]) else { continue };
        match key {
            "author" => c.author = value.into(),
            "author-mail" => c.email = value.trim_start_matches('<').trim_end_matches('>').into(),
            "author-time" => c.date = value.parse().ok().and_then(|t| chrono::DateTime::from_timestamp(t, 0)).map(|d| d.to_rfc3339()).unwrap_or_default(),
            "summary" => c.subject = value.into(),
            _ => {}
        }
    }
    b
}

/// `git log --raw --numstat -z` of one file, formatted as [`Git::file_log`] asks: each record is the commit's
/// fields, then a NUL, a newline, the raw line ending in the status, the path (old and new for a rename), and
/// "<added>\t<deleted>\t<path>" (a rename: "<added>\t<deleted>\t", old, new).
pub fn parse_file_log(s: &str) -> Vec<FileCommit> {
    s.split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.splitn(8, '\x1f').collect();
            let mut parts = f.get(7)?.trim_start_matches(['\0', '\n']).split('\0');
            let status = parts.next()?.rsplit(' ').next()?.chars().next()?;
            let first = parts.next()?.to_string();
            let (from, path) = if matches!(status, 'R' | 'C') { (Some(first), parts.next()?.to_string()) } else { (None, first) };
            let nums: Vec<&str> = parts.next().unwrap_or_default().splitn(3, '\t').collect();
            // Binary files count "-".
            let count = |i: usize| nums.get(i).and_then(|n| n.parse().ok()).unwrap_or(0);
            let status = match status {
                'A' | 'C' => 'A',
                'D' | 'R' => status,
                _ => 'M',
            };
            Some(FileCommit { commit: commit_of(&f), path, from, status, additions: count(0), deletions: count(1) })
        })
        .collect()
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

/// A patch of only the `picked` changes of `diff` (git's raw diff of `path`) for `git apply --cached`,
/// built to be applied with `-R` when `reverse`. Unpicked changes stay as they are: a line the patch's
/// base has (the old side, or the new one in reverse) turns to context, any other is left out.
fn pick_patch(diff: &[u8], path: &str, picked: &[LinePick], reverse: bool) -> Result<Vec<u8>> {
    let stale = || Error::Invalid(format!("{path} changed since its diff was shown: pick the lines again"));
    let unreadable = || Error::Invalid(format!("Could not read the diff of {path}"));
    let mut want: HashMap<(u8, u32), &str> = HashMap::new();
    for p in picked {
        if p.kind != '+' && p.kind != '-' {
            return Err(Error::Invalid(format!("Not a changed line: {:?}", p.kind)));
        }
        want.insert((p.kind as u8, p.n), &p.text);
    }
    if want.is_empty() {
        return Err(Error::Invalid("No lines picked".into()));
    }
    let lines: Vec<&[u8]> = diff.split(|&b| b == b'\n').collect();
    let (mut created, mut deleted, mut mode) = (false, false, String::from("100644"));
    let mut i = 0;
    while i < lines.len() && !lines[i].starts_with(b"@@ ") {
        let l = lines[i];
        if l.starts_with(b"diff --cc ") {
            return Err(Error::Invalid(format!("{path} has conflicts: resolve them first")));
        }
        if (l.starts_with(b"index ") && l.ends_with(b" 160000")) || l.ends_with(b"mode 160000") {
            return Err(Error::Invalid(format!("{path} is a submodule: stage it whole")));
        }
        if let Some(m) = l.strip_prefix(b"new file mode ") {
            (created, mode) = (true, String::from_utf8_lossy(m).into());
        }
        if let Some(m) = l.strip_prefix(b"deleted file mode ") {
            (deleted, mode) = (true, String::from_utf8_lossy(m).into());
        }
        i += 1;
    }
    let mut body = Vec::new();
    // What the hunks written so far add to the line count, and each side's total.
    let (mut delta, mut old_total, mut new_total) = (0i64, 0u32, 0u32);
    while i < lines.len() {
        let Some(range) = lines[i].strip_prefix(b"@@ ") else {
            if lines[i].starts_with(b"diff ") {
                return Err(Error::Invalid("Pick lines of one file at a time".into()));
            }
            i += 1;
            continue;
        };
        let (os, oc, ns, nc) = hunk_range(range).ok_or_else(unreadable)?;
        i += 1;
        // Kind, text, "\ No newline at end of file" after it, number on its side.
        let mut hunk: Vec<(u8, &[u8], bool, u32)> = Vec::new();
        let (mut o, mut n, mut left_o, mut left_n) = (os, ns, oc, nc);
        while i < lines.len() {
            let l = lines[i];
            if l.first() == Some(&b'\\') {
                if let Some(last) = hunk.last_mut() {
                    last.2 = true;
                }
                i += 1;
                continue;
            }
            if left_o == 0 && left_n == 0 {
                break;
            }
            let (kind, text) = match l.first() {
                // An empty context line (diff.suppressBlankEmpty).
                None => (b' ', l),
                Some(&k) if matches!(k, b' ' | b'-' | b'+') => (k, &l[1..]),
                _ => return Err(unreadable()),
            };
            hunk.push((kind, text, false, if kind == b'-' { o } else { n }));
            if kind != b'+' {
                (o, left_o) = (o + 1, left_o.checked_sub(1).ok_or_else(unreadable)?);
            }
            if kind != b'-' {
                (n, left_n) = (n + 1, left_n.checked_sub(1).ok_or_else(unreadable)?);
            }
            i += 1;
        }
        if left_o > 0 || left_n > 0 {
            return Err(unreadable());
        }
        let mut out: Vec<(u8, &[u8], bool)> = Vec::new();
        let mut any = false;
        for (kind, text, no_eol, num) in hunk {
            let pick = kind != b' ' && match want.remove(&(kind, num)) {
                Some(shown) if same_text(text, shown) => true,
                Some(_) => return Err(stale()),
                None => false,
            };
            any |= pick;
            // The patch's base has context lines, removals going forward and additions in reverse.
            let in_base = kind == b' ' || (kind == b'-') != reverse;
            if pick || in_base {
                out.push((if pick { kind } else { b' ' }, text, no_eol));
            }
        }
        if !any {
            continue;
        }
        let old_count = out.iter().filter(|l| l.0 != b'+').count() as u32;
        let new_count = out.iter().filter(|l| l.0 != b'-').count() as u32;
        // The base side keeps its numbers; the other moves by what the hunks before changed.
        // A side with no lines is numbered from the line before it.
        let first = |start: u32, count: u32| i64::from(start) + i64::from(count == 0);
        let (old_first, new_first) = if reverse {
            let f = first(ns, nc);
            (f - delta, f)
        } else {
            let f = first(os, oc);
            (f, f + delta)
        };
        let start = |first: i64, count: u32| first - i64::from(count == 0);
        body.extend_from_slice(format!("@@ -{},{old_count} +{},{new_count} @@\n", start(old_first, old_count), start(new_first, new_count)).as_bytes());
        for (kind, text, no_eol) in out {
            body.push(kind);
            body.extend_from_slice(text);
            body.push(b'\n');
            if no_eol {
                body.extend_from_slice(b"\\ No newline at end of file\n");
            }
        }
        delta += i64::from(new_count) - i64::from(old_count);
        old_total += old_count;
        new_total += new_count;
    }
    if !want.is_empty() {
        return Err(stale());
    }
    // Still a new file when the patch's base has none of it, still a deletion when nothing is left.
    let (created, deleted) = (created && old_total == 0, deleted && new_total == 0);
    let (a, b) = (quoted("a/", path), quoted("b/", path));
    let mut patch = format!("diff --git {a} {b}\n");
    if created {
        patch.push_str(&format!("new file mode {mode}\n"));
    }
    if deleted {
        patch.push_str(&format!("deleted file mode {mode}\n"));
    }
    patch.push_str(&format!("--- {}\n+++ {}\n", if created { "/dev/null" } else { &a }, if deleted { "/dev/null" } else { &b }));
    let mut patch = patch.into_bytes();
    patch.extend_from_slice(&body);
    Ok(patch)
}

/// `-a,b +c,d @@…` after a hunk's `@@ ` (a count left out is 1) → (a, b, c, d).
fn hunk_range(s: &[u8]) -> Option<(u32, u32, u32, u32)> {
    let end = s.windows(3).position(|w| w == b" @@")?;
    let mut sides = std::str::from_utf8(&s[..end]).ok()?.split_whitespace();
    let side = |t: &str, sign: char| -> Option<(u32, u32)> {
        let t = t.strip_prefix(sign)?;
        Some(match t.split_once(',') {
            Some((start, count)) => (start.parse().ok()?, count.parse().ok()?),
            None => (t.parse().ok()?, 1),
        })
    };
    let (a, b) = side(sides.next()?, '-')?;
    let (c, d) = side(sides.next()?, '+')?;
    Some((a, b, c, d))
}

/// Whether a diff line's raw text is the `shown` one: shown lines went through lossy UTF-8 and lost a CR.
fn same_text(raw: &[u8], shown: &str) -> bool {
    String::from_utf8_lossy(raw.strip_suffix(b"\r").unwrap_or(raw)) == shown
}

/// `prefix` + `path` as a quoted patch file name, which `git apply` reads whatever the path holds.
fn quoted(prefix: &str, path: &str) -> String {
    let mut s = format!("\"{prefix}");
    for c in path.chars() {
        match c {
            '"' | '\\' => {
                s.push('\\');
                s.push(c);
            }
            '\n' => s.push_str("\\n"),
            '\t' => s.push_str("\\t"),
            c if c.is_ascii_control() => s.push_str(&format!("\\{:03o}", c as u32)),
            c => s.push(c),
        }
    }
    s.push('"');
    s
}

/// Lines of an untracked file, read only while `budget` (bytes, see [`COUNT_BUDGET`]) lasts: a bigger one counts none.
fn count_lines(p: &Path, budget: &mut u64) -> u32 {
    let Ok(len) = std::fs::metadata(p).map(|m| m.len()) else { return 0 };
    if len > *budget {
        return 0;
    }
    *budget -= len;
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
    fn blame_porcelain_reads_lines_runs_and_commits() {
        let (a, z) = ("a".repeat(40), UNCOMMITTED.to_string());
        let out = format!(
            "{a} 1 1 2\nauthor Ann\nauthor-mail <ann@x.io>\nauthor-time 1700000000\nauthor-tz +0000\nsummary first\nfilename f.txt\n\tone\n{a} 2 2\n\ttwo\n\
             {z} 3 3 1\nauthor Not Committed Yet\nauthor-mail <not.committed.yet>\nauthor-time 1700000100\nsummary Version of f.txt from f.txt\nprevious {a} f.txt\nfilename f.txt\n\t\tindented\n\
             {a} 3 4 1\n\tfour\n"
        );
        let b = parse_blame(&out);
        assert_eq!(b.lines, ["one", "two", "\tindented", "four"]);
        assert_eq!(b.runs, [(a.clone(), 2), (z.clone(), 1), (a.clone(), 1)]);
        assert_eq!(b.commits.len(), 2, "each commit once");
        let c = &b.commits[0];
        assert_eq!((c.author.as_str(), c.email.as_str(), c.subject.as_str(), c.date.as_str()), ("Ann", "ann@x.io", "first", "2023-11-14T22:13:20+00:00"));
        assert_eq!(uncommitted_blame("x\ny\n").runs, [(z, 2)]);
    }

    #[test]
    fn file_log_reads_status_paths_and_counts() {
        let rec = |sha: &str, stat: &str| format!("\x1e{sha}\x1fAnn\x1fann@x.io\x1f2026-11-08T10:00:00-05:00\x1ftag: v1\x1fsubject {sha}\x1fbody\n\x1f\x00\n{stat}");
        let out = [
            rec("c3", ":100644 100644 aaa bbb M\x00b.txt\x003\t1\tb.txt\x00"),
            rec("c2", ":100644 100644 aaa aaa R100\x00a.txt\x00b.txt\x000\t0\t\x00a.txt\x00b.txt\x00"),
            rec("c1", ":000000 100644 000 aaa A\x00a.txt\x00-\t-\ta.txt\x00"),
            // A merge shows no diff: left out.
            rec("c0", ""),
        ]
        .concat();
        let log = parse_file_log(&out);
        let got: Vec<_> = log.iter().map(|c| (c.commit.sha.as_str(), c.path.as_str(), c.from.as_deref(), c.status, c.additions, c.deletions)).collect();
        assert_eq!(got, [("c3", "b.txt", None, 'M', 3, 1), ("c2", "b.txt", Some("a.txt"), 'R', 0, 0), ("c1", "a.txt", None, 'A', 0, 0)]);
        assert_eq!((log[0].commit.subject.as_str(), log[0].commit.body.as_str(), log[0].commit.tags.as_slice()), ("subject c3", "body", ["v1".to_string()].as_slice()));
    }

    #[test]
    fn ref_names_starting_with_a_dash_are_dropped() {
        let line = |refname: &str, short: &str| [refname, "abc", "", "", "2026-11-07", "T", "<t@t>", "", "", short, "2026-11-07", "1", ""].join("\x1f");
        let out = [("refs/heads/main", "main"), ("refs/heads/-x", "-x"), ("refs/heads/feat/-ok", "feat/-ok"), ("refs/remotes/origin/-y", "origin/-y"), ("refs/tags/-v1", "-v1"), ("refs/tags/v1", "v1")]
            .map(|(r, s)| line(r, s))
            .join("\n");
        let r = parse_refs(&out);
        assert_eq!(r.branches.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), ["main", "feat/-ok"]);
        assert!(r.remote_branches.is_empty());
        assert_eq!(r.tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["v1"]);
    }

    #[test]
    fn counts_untracked_lines_within_budget() {
        let dir = tempfile::tempdir().unwrap();
        let (small, big) = (dir.path().join("a.txt"), dir.path().join("b.bin"));
        std::fs::write(&small, "1\n2\n3").unwrap();
        std::fs::write(&big, [b'\n'; 100]).unwrap();
        let mut budget = 50;
        assert_eq!(count_lines(&small, &mut budget), 3);
        assert_eq!(budget, 45);
        assert_eq!(count_lines(&big, &mut budget), 0, "past the budget: not read");
        assert_eq!(budget, 45);
        assert_eq!(count_lines(&dir.path().join("gone"), &mut budget), 0);
    }

    #[tokio::test]
    async fn one_ref_listing_reads_what_the_separate_calls_did() {
        let tmp = tempfile::tempdir().unwrap();
        let git_in = |dir: &Path, args: &[&str], date: &str| {
            let out = std::process::Command::new("git")
                .current_dir(dir)
                .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"])
                .args(args)
                .env("GIT_COMMITTER_DATE", date)
                .env("GIT_AUTHOR_DATE", date)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let (origin, clone) = (tmp.path().join("origin"), tmp.path().join("clone"));
        std::fs::create_dir_all(&origin).unwrap();
        let o = |args: &[&str], date: &str| git_in(&origin, args, date);
        o(&["init", "-q", "-b", "main"], "2020-01-01T00:00:00Z");
        o(&["config", "core.autocrlf", "false"], "2020-01-01T00:00:00Z");
        o(&["config", "core.longpaths", "true"], "2020-01-01T00:00:00Z");
        o(&["commit", "-q", "--allow-empty", "-m", "a"], "2020-01-01T00:00:00Z");
        o(&["tag", "v1"], "2020-01-01T00:00:00Z");
        o(&["switch", "-qc", "feat/x"], "2020-01-02T00:00:00Z");
        o(&["commit", "-q", "--allow-empty", "-m", "x"], "2020-01-02T00:00:00Z");
        o(&["tag", "-a", "v2", "-m", "two"], "2021-06-01T12:00:00+02:00");
        o(&["tag", "v0"], "2019-01-01T00:00:00Z");
        o(&["switch", "-q", "main"], "2020-01-03T00:00:00Z");
        git_in(tmp.path(), &["clone", "-q", "-c", "core.autocrlf=false", "-c", "core.longpaths=true", origin.to_str().unwrap(), clone.to_str().unwrap()], "2020-01-03T00:00:00Z");
        let c = |args: &[&str]| git_in(&clone, args, "2020-01-04T00:00:00Z");
        c(&["branch", "feat/y"]);
        // A branch named like a tag: `refname:short` spells the tag `tags/v1`.
        c(&["branch", "v1"]);

        let g = Git::new(&clone);
        let r = g.read_refs().await.unwrap();
        assert_eq!(r.fingerprint, g.ref_fingerprint().await.unwrap());
        assert_eq!(r.current, g.current_branch().await.unwrap());
        assert_eq!(r.default_branch(r.current.as_deref()), g.default_branch().await.unwrap());
        let tags: Vec<&str> = r.tags.iter().map(|t| t.name.as_str()).collect();
        let want = c(&["for-each-ref", "refs/tags", "--sort=-creatordate", "--format=%(refname:short)"]);
        assert_eq!(tags, want.lines().collect::<Vec<_>>());
        let peeled = c(&["rev-parse", "v2^{commit}"]);
        assert_eq!(r.tags.iter().find(|t| t.name == "v2").unwrap().sha, peeled.trim());
        let heads: Vec<String> = r.branches.iter().map(|b| format!("{} {} {}", b.name, b.sha, b.upstream.as_deref().unwrap_or(""))).collect();
        let want = c(&["for-each-ref", "refs/heads", "--format=%(refname:lstrip=2) %(objectname) %(upstream:short)"]);
        assert_eq!(heads, want.lines().collect::<Vec<_>>());
        let remote: Vec<&str> = r.remote_branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(remote, ["feat/x", "main"]);
        assert_eq!(r.origin_head.as_deref(), Some("main"));

        c(&["switch", "-q", "--detach"]);
        assert_eq!(g.read_refs().await.unwrap().current, None);
        assert_eq!(g.current_branch().await.unwrap(), None);
    }

    #[tokio::test]
    async fn operation_paths_match_git_in_a_checkout_and_a_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, wt) = (tmp.path().join("r"), tmp.path().join("wt"));
        std::fs::create_dir_all(&repo).unwrap();
        let run = |dir: &Path, args: &[&str]| {
            let out = std::process::Command::new("git").current_dir(dir).args(["-c", "user.name=T", "-c", "user.email=t@x", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}");
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["config", "core.autocrlf", "false"]);
        run(&repo, &["config", "core.longpaths", "true"]);
        run(&repo, &["commit", "-q", "--allow-empty", "-m", "a"]);
        run(&repo, &["worktree", "add", "-q", "-b", "w", wt.to_str().unwrap()]);
        let names = ["rebase-merge/head-name", "MERGE_HEAD", "BISECT_START"];
        for dir in [&repo, &wt] {
            let ours = Git::new(dir).git_paths(&names).await.unwrap();
            let args: Vec<&str> = ["rev-parse"].into_iter().chain(names.iter().flat_map(|n| ["--git-path", *n])).collect();
            let theirs: Vec<PathBuf> = run(dir, &args).lines().map(|l| dir.join(l.trim())).collect();
            // Compared through the git dir, which exists: the files don't.
            let real = |p: &Path| {
                let dir = p.ancestors().find(|a| a.is_dir()).unwrap();
                std::fs::canonicalize(dir).unwrap().join(p.strip_prefix(dir).unwrap())
            };
            for (a, b) in ours.iter().zip(&theirs) {
                assert_eq!(real(a), real(b), "{}", dir.display());
            }
        }
    }

    #[test]
    fn reads_the_host_a_sign_in_failed_for() {
        let host = |e: &str| login_host(e);
        assert_eq!(host("fatal: could not read Username for 'https://github.com': terminal prompts disabled").as_deref(), Some("github.com"));
        assert_eq!(host("fatal: could not read Password for 'https://me@gitlab.example.com:8443': terminal prompts disabled").as_deref(), Some("gitlab.example.com:8443"));
        assert_eq!(host("remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/t1gu1/Gitnetix.git/'").as_deref(), Some("github.com"));
        assert_eq!(host("fatal: Could not read from remote repository."), None);
        assert_eq!(host("fatal: could not read Username for 'http://plain.example.com': terminal prompts disabled"), None, "no token over plain http");
    }

    #[test]
    fn splits_ssh_remotes_into_host_and_prefix() {
        assert_eq!(ssh_prefix("git@github.com:t1gu1/Gitnetix.git"), Some(("github.com", "git@github.com:")));
        assert_eq!(ssh_prefix("ssh://git@gitlab.example.com:2222/team/app.git"), Some(("gitlab.example.com", "ssh://git@gitlab.example.com:2222/")));
        assert_eq!(ssh_prefix("ssh://host.example.com/app.git"), Some(("host.example.com", "ssh://host.example.com/")));
        for not_ssh in ["https://github.com/t1gu1/Gitnetix.git", "https://me@github.com/a.git", "C:/repos/app", "/srv/app.git", "../app", "ssh://git@host"] {
            assert_eq!(ssh_prefix(not_ssh), None, "{not_ssh}");
        }
    }

    #[test]
    fn helpers_answer_only_their_host_from_the_environment() {
        let tmp = tempfile::tempdir().unwrap();
        let global = tmp.path().join("gitconfig");
        std::fs::write(&global, "").unwrap();
        let logins = [("git.example.com".to_string(), Login { username: "me".into(), token: "s3cr$t 'x' \"y\" `z`".into() })];
        let fill = |host: &str| {
            use std::io::Write;
            let mut cmd = std::process::Command::new("git");
            for (conf, env) in helpers(&logins) {
                assert!(!conf.contains("s3cr"), "the token stays out of the arguments");
                cmd.arg("-c").arg(conf).envs(env);
            }
            let mut child = cmd
                .args(["credential", "fill"])
                .env("GIT_CONFIG_GLOBAL", &global)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GIT_ASKPASS", "")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(format!("protocol=https\nhost={host}\n\n").as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned())
        };
        let (ok, out) = fill("git.example.com");
        assert!(ok && out.contains("username=me\npassword=s3cr$t 'x' \"y\" `z`\n"), "{out}");
        assert!(!fill("other.example.com").0, "another host gets nothing");
        assert!(save_login("bad host", Login { username: "me".into(), token: "t".into() }).is_err());
        assert!(save_login("git.example.com", Login { username: "me".into(), token: "t\nhost=evil".into() }).is_err());
    }

    /// A call gets the logins of the hosts it may reach, not every saved one: hooks see git's environment.
    #[test]
    fn logins_go_only_to_the_hosts_a_call_reaches() {
        let tmp = tempfile::tempdir().unwrap();
        let sh = |a: &[&str]| assert!(std::process::Command::new("git").current_dir(tmp.path()).args(a).status().unwrap().success());
        sh(&["init", "-q"]);
        sh(&["remote", "add", "origin", "https://me@git.example.com:8443/o/r.git"]);
        sh(&["remote", "add", "up", "git@ssh.example.org:o/r.git"]);
        std::fs::write(tmp.path().join(".gitmodules"), "[submodule \"lib\"]\n\tpath = lib\n\turl = https://sub.example.net/o/lib.git\n").unwrap();
        let git = Git::new(tmp.path());
        assert_eq!(git.reached_hosts(&["push", "origin", "main"]), ["git.example.com:8443", "ssh.example.org", "sub.example.net"]);
        let clone = git.reached_hosts(&["clone", "--", "https://clone.example.com/o/r", "/tmp/r"]);
        assert_eq!(clone[0], "clone.example.com");
        assert_eq!(url_host("C:/repo"), None, "a Windows path names no host");
    }

    /// An ssh remote that fails once over HTTPS too: the ssh error, which tells what to fix, is the one shown.
    #[tokio::test]
    async fn keeps_the_ssh_error_when_https_fails_too() {
        let tmp = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").current_dir(tmp.path()).args(args).status().unwrap().success());
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", "git@nohost.invalid:team/app.git"]);
        let mut g = Git::new(tmp.path()).unattended(true);
        g.env.push(("GIT_SSH_COMMAND", "false"));
        let err = g.remote_tips().await.unwrap_err().to_string();
        assert!(err.contains("Could not read from remote repository"), "{err}");
    }

    /// Needs github.com. `cargo test -p gitnetix-core falls_back -- --ignored`
    #[tokio::test]
    #[ignore = "reaches github.com"]
    async fn falls_back_to_https_when_ssh_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").current_dir(tmp.path()).args(args).status().unwrap().success());
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", "git@github.com:t1gu1/Gitnetix.git"]);
        let mut g = Git::new(tmp.path()).unattended(true);
        g.env.push(("GIT_SSH_COMMAND", "false"));
        assert!(g.remote_tips().await.unwrap().contains("refs/heads/main"));
        // A push asks the host for a sign-in: the error names it, for the app to ask the user.
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "probe"]);
        let err = g.try_run(&["push", "--dry-run", "origin", "HEAD:refs/heads/gnx-probe"]).await.unwrap().2;
        assert_eq!(login_host(&err).as_deref(), Some("github.com"), "{err}");
    }

    #[tokio::test]
    async fn background_calls_keep_the_users_own_ssh() {
        let tmp = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").current_dir(tmp.path()).args(args).status().unwrap().success());
        git(&["init", "-q"]);
        let batch = |own| Git::new(tmp.path()).unattended(own).env.iter().any(|(k, _)| *k == "GIT_SSH_COMMAND");
        assert!(batch(false) && !batch(true), "BatchMode only replaces git's plain ssh");
        assert!(Git::new(tmp.path()).unattended(true).env.contains(&("GIT_ASKPASS", "")), "the desktop's askpass never pops up");
        // A second account's key, set for this repository.
        git(&["config", "core.sshCommand", "ssh -i ~/.ssh/work"]);
        assert!(Git::new(tmp.path()).own_ssh().await);
    }

    #[tokio::test]
    async fn squash_check_tells_squashed_rebased_and_open_branches() {
        let dir = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git").current_dir(dir.path()).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let commit = |f: &str| {
            std::fs::write(dir.path().join(f), f).unwrap();
            run(&["add", f]);
            run(&["commit", "-qm", f]);
        };
        for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "T"], &["config", "commit.gpgsign", "false"]] {
            run(args);
        }
        commit("base");
        let base = run(&["rev-parse", "HEAD"]);
        for (branch, files) in [("squashed", &["s1", "s2"][..]), ("rebased", &["r1"]), ("open", &["o1"]), ("carries", &["fix", "c1", "c2"])] {
            run(&["switch", "-qc", branch, "main"]);
            files.iter().for_each(|f| commit(f));
        }
        run(&["switch", "-q", "main"]);
        commit("other");
        run(&["cherry-pick", "rebased"]);
        run(&["merge", "-q", "--squash", "squashed"]);
        run(&["commit", "-qm", "squashed"]);
        // The fix reached main on its own, then the rest of the branch as one squash.
        run(&["cherry-pick", "carries~2"]);
        run(&["merge", "-q", "--squash", "carries"]);
        run(&["commit", "-qm", "carries"]);

        let git = Git::new(dir.path());
        assert_eq!(git.squash_check("squashed", "main", None).await.unwrap(), (true, Some(base.clone())));
        assert_eq!(git.squash_check("squashed", "main", Some(&base)).await.unwrap(), (true, Some(base.clone())));
        assert_eq!(git.squash_check("rebased", "main", None).await.unwrap(), (true, None));
        assert_eq!(git.squash_check("open", "main", None).await.unwrap(), (false, Some(base.clone())));
        assert_eq!(git.squash_check("carries", "main", None).await.unwrap(), (true, Some(run(&["rev-parse", "carries~2"]))));
    }

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

    fn pick(kind: char, n: u32, text: &str) -> LinePick {
        LinePick { kind, n, text: text.into() }
    }

    fn patch(diff: &str, path: &str, picked: &[LinePick], reverse: bool) -> String {
        String::from_utf8(pick_patch(diff.as_bytes(), path, picked, reverse).unwrap()).unwrap()
    }

    const MODIFIED: &str = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";

    #[test]
    fn picks_lines_of_a_hunk() {
        let head = "diff --git \"a/f\" \"b/f\"\n--- \"a/f\"\n+++ \"b/f\"\n";
        // Staging the addition only: the removal it replaces stays, as context.
        assert_eq!(patch(MODIFIED, "f", &[pick('+', 2, "B")], false), format!("{head}@@ -1,3 +1,4 @@\n a\n b\n+B\n c\n"));
        // Unstaging the removal only: the staged addition stays, as context.
        assert_eq!(patch(MODIFIED, "f", &[pick('-', 2, "b")], true), format!("{head}@@ -1,4 +1,3 @@\n a\n-b\n B\n c\n"));
    }

    #[test]
    fn later_hunks_move_by_what_earlier_ones_change() {
        let diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,5 @@\n a\n+x\n b\n c\n d\n@@ -10,3 +11,3 @@\n j\n-k\n+K\n l\n";
        let hunks = |p: &str| p.lines().filter(|l| l.starts_with("@@")).map(String::from).collect::<Vec<_>>();
        assert_eq!(hunks(&patch(diff, "f", &[pick('+', 12, "K")], false)), ["@@ -10,3 +10,4 @@"]);
        assert_eq!(hunks(&patch(diff, "f", &[pick('+', 2, "x"), pick('+', 12, "K")], false)), ["@@ -1,4 +1,5 @@", "@@ -10,3 +11,4 @@"]);
        assert_eq!(hunks(&patch(diff, "f", &[pick('-', 11, "k")], true)), ["@@ -11,4 +11,3 @@"]);
        assert_eq!(hunks(&patch(diff, "f", &[pick('+', 2, "x"), pick('-', 11, "k")], true)), ["@@ -1,4 +1,5 @@", "@@ -10,4 +11,3 @@"]);
    }

    #[test]
    fn keeps_missing_newline_markers_with_their_line() {
        let diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n";
        let p = patch(diff, "f", &[pick('-', 2, "b")], false);
        assert!(p.ends_with("@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n"), "{p}");
        let p = patch(diff, "f", &[pick('-', 2, "b"), pick('+', 2, "B")], false);
        assert!(p.ends_with("@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n"), "{p}");
    }

    #[test]
    fn new_and_deleted_files_stay_so_only_when_whole() {
        let new = "diff --git a/n b/n\nnew file mode 100755\nindex 0000000..1\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n";
        // Staging part of an untracked file creates it with those lines.
        let p = patch(new, "n", &[pick('+', 1, "one"), pick('+', 3, "three")], false);
        assert_eq!(p, "diff --git \"a/n\" \"b/n\"\nnew file mode 100755\n--- /dev/null\n+++ \"b/n\"\n@@ -0,0 +1,2 @@\n+one\n+three\n");
        // Unstaging part of a staged new file edits it; unstaging all of it removes it.
        let p = patch(new, "n", &[pick('+', 2, "two")], true);
        assert_eq!(p, "diff --git \"a/n\" \"b/n\"\n--- \"a/n\"\n+++ \"b/n\"\n@@ -1,2 +1,3 @@\n one\n+two\n three\n");
        let all = [pick('+', 1, "one"), pick('+', 2, "two"), pick('+', 3, "three")];
        assert!(patch(new, "n", &all, true).contains("new file mode 100755\n--- /dev/null\n+++ \"b/n\"\n@@ -0,0 +1,3 @@\n"));

        let gone = "diff --git a/d b/d\ndeleted file mode 100644\nindex 1..0000000\n--- a/d\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n";
        let p = patch(gone, "d", &[pick('-', 1, "x")], false);
        assert_eq!(p, "diff --git \"a/d\" \"b/d\"\n--- \"a/d\"\n+++ \"b/d\"\n@@ -1,2 +1,1 @@\n-x\n y\n");
        let p = patch(gone, "d", &[pick('-', 1, "x"), pick('-', 2, "y")], false);
        assert!(p.contains("deleted file mode 100644\n--- \"a/d\"\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n"), "{p}");
    }

    #[test]
    fn keeps_bytes_and_refuses_stale_picks() {
        let diff = b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,1 +1,2 @@\n a\r\n+caf\xe9\r\n";
        let p = pick_patch(diff, "f", &[pick('+', 2, "caf\u{fffd}")], false).unwrap();
        assert!(p.ends_with(b" a\r\n+caf\xe9\r\n"));
        assert!(pick_patch(MODIFIED.as_bytes(), "f", &[pick('+', 2, "changed")], false).is_err());
        assert!(pick_patch(MODIFIED.as_bytes(), "f", &[pick('+', 9, "B")], false).is_err());
        assert!(pick_patch(MODIFIED.as_bytes(), "f", &[], false).is_err());
    }

    #[test]
    fn quotes_patch_names() {
        assert_eq!(quoted("a/", "dir/a \"b\"\\c\td.txt"), "\"a/dir/a \\\"b\\\"\\\\c\\td.txt\"");
        assert_eq!(quoted("b/", "é\u{1}"), "\"b/é\\001\"");
    }
}

tokio::task_local! {
    /// Git processes started by the work [`counting`] runs.
    static STARTED: std::cell::Cell<u32>;
}

/// Run `f` and count the git processes it starts: what a slow refresh spent its time on.
pub async fn counting<T>(f: impl std::future::Future<Output = T>) -> (T, u32) {
    STARTED.scope(std::cell::Cell::new(0), async move { (f.await, STARTED.with(std::cell::Cell::get)) }).await
}

/// The git binary reads run. On macOS `/usr/bin/git` is a stub that asks `xcrun` for Xcode's git
/// on every call: a second process each time, slow where starting one is (an overview runs hundreds).
/// Asked once here instead.
fn read_git() -> &'static Path {
    static GIT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    GIT.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            let on_path = std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("git")).find(|g| g.is_file()));
            if on_path.as_deref() == Some(Path::new("/usr/bin/git")) {
                if let Ok(out) = std::process::Command::new("/usr/bin/xcrun").args(["--find", "git"]).output() {
                    let found = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
                    if out.status.success() && found.is_file() {
                        return found;
                    }
                }
            }
        }
        PathBuf::from("git")
    })
}

/// A git command that changes the repository (worth a line in the log), as opposed to a read.
fn changes_repo(args: &[&str]) -> bool {
    let i = verb_at(args);
    let Some(&verb) = args.get(i) else { return false };
    let sub = args.get(i + 1).copied().unwrap_or("");
    match verb {
        "stash" | "worktree" => !matches!(sub, "list" | "show"),
        _ => ["clone", "merge", "rebase", "cherry-pick", "revert", "commit", "push", "pull", "reset", "checkout", "switch", "update-ref", "add", "rm", "restore", "clean", "apply"].contains(&verb),
    }
}

#[cfg(test)]
mod changes_repo_tests {
    use super::changes_repo;

    #[test]
    fn tells_writes_from_reads() {
        assert!(changes_repo(&["-c", "core.editor=true", "merge", "--continue"]));
        assert!(changes_repo(&["stash", "push"]));
        assert!(!changes_repo(&["stash", "list"]));
        assert!(!changes_repo(&["rev-parse", "HEAD"]));
        assert!(!changes_repo(&[]));
    }
}
