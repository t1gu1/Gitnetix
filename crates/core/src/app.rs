//! `Gitnetix`: the one service every front end talks to (Tauri window,
//! companion HTTP API for mobile, MCP bridge). All behaviour lives here;
//! `rpc` only maps method names onto these calls.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use futures_util::{future::join_all, stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, OnceCell};

use crate::agents::{AgentManager, AgentSession, AgentStatus, LogLine, StartArgs, StudyCheckout, TicketStudy};
use crate::ai::{self, Resolved};
use crate::auto_resolve;
use crate::cache::{key_of, CommitCache, LastCache, ViewCache};
use crate::dictation::Audio;
use crate::error::{Error, Result};
use crate::events::Event;
use crate::hooks;
use crate::git::{ticket_keys, Blame, Blobs, BranchInfo, Commit, FileChange, FileCommit, Git, Hunk, LinePick, PrSquash, Side, Identity, StashInfo, TagInfo, WorktreeInfo};
use crate::project_commands::{self, Scripts};
use crate::providers::azure::{self, MergedPr};
use crate::providers::{self, azure_auth, github::{GitHub, UserRepo}, parse_remote, PrHost, RepoRef};
use crate::secrets;
use crate::store::{new_id, now, BranchMeta, Config, Connection, ConnectMethod, GitProfile, Project, Release, ReleaseKind, Route, Store, UserProfile};
use crate::submodules::{self, FetchReport, Submodule};
use crate::templates::{self, Template};
use crate::tickets::{self, Ticket};

pub struct Gitnetix {
    pub store: Store,
    pub agents: AgentManager,
    pub shells: crate::shell::Shells,
    pub events: broadcast::Sender<Event>,
    pub dir: PathBuf,
    pub dictation: crate::dictation::Dictation,
    /// Branches the git host protects, per project, with when they were looked up.
    protected: std::sync::Mutex<HashMap<String, (Instant, Vec<String>)>>,
    /// Watches the projects' git dirs for changes made outside Gitnetix.
    watcher: std::sync::Mutex<Option<crate::watch::Watch>>,
    /// Merge checks already answered, by commit.
    commits: CommitCache,
    /// Every project's branch views as last built, with the refs they were built from.
    views: ViewCache<BuiltViews>,
    /// Each project's history walks as last read ([`Gitnetix::history`]); one read at a time per project.
    history: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<Option<History>>>>>,
    /// Held while a project's branch views build: a refresh asked meanwhile waits, then reuses them.
    building: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Projects with a branch cleanup running, once per cleanup: their views wait for it to end to rebuild.
    cleaning: std::sync::Mutex<Vec<String>>,
    /// Each project's [`shipped_patches`], with the key of the tips it was read at.
    shipped: std::sync::Mutex<HashMap<String, (u64, Arc<ShippedIndex>)>>,
    /// What the git host said about each project's branch tips.
    hosted: std::sync::Mutex<HashMap<String, HostedPrs>>,
    /// What [`Gitnetix::auto_fetch`] knows of each project's origin; one check at a time per project.
    auto_fetch: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<AutoFetch>>>>,
    /// The worktree list as last built, without agents: shown while the next one builds.
    worktrees: LastCache,
    /// Commit messages written ahead ([`Gitnetix::prepare_commit_message`]), per checkout, with the key of the prompt they answer.
    drafts: std::sync::Mutex<HashMap<PathBuf, (u64, Draft)>>,
    /// What each Jira connection answered for the sprint charts, with when: picking other people counts them again
    /// without asking Jira.
    sprint_fetches: std::sync::Mutex<HashMap<String, SprintFetched>>,
    /// Projects with a publish running: a second one is refused, its rollback could undo the first.
    publishing: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Rebases AI is carrying through, by checkout.
    runs: Runs,
}

/// [`tickets::jira_sprints`]'s answer.
type SprintFetch = (Vec<tickets::Sprint>, Vec<tickets::SprintIssue>, HashMap<u64, String>);
/// A [`SprintFetch`] with when it came, as an instant and as the time shown.
type SprintFetched = (Instant, String, Arc<SprintFetch>);

/// How long a Jira answer for the sprint charts is used again, as long as the screen keeps them before asking again.
const SPRINT_TTL: std::time::Duration = std::time::Duration::from_secs(300);

/// A commit message being written ahead, shared with whoever waits for it; `None` once writing it failed.
type Draft = Arc<OnceCell<Option<String>>>;

/// Completed pull requests the git host says took in a project's branch tips.
#[derive(Default)]
struct HostedPrs {
    /// By commit. A commit a pull request took stays taken: only the others are asked about again.
    merged: HashMap<String, Vec<MergedPr>>,
    /// When each commit was last asked about.
    asked: HashMap<String, Instant>,
}

/// How long the git host's "no pull request took it" is trusted before asking again.
const HOSTED_TTL: std::time::Duration = std::time::Duration::from_secs(300);

/// Least time between two looks at a project's origin, however many windows and phone pages ask.
pub const AUTO_FETCH_GAP: std::time::Duration = std::time::Duration::from_secs(4);

/// Time before looking at origin again once it stayed unchanged for `quiet`: a fifth of it, from [`AUTO_FETCH_GAP`]
/// up to a minute (5 minutes quiet). An idle repo open all day was asked every few seconds.
fn ask_gap(quiet: std::time::Duration) -> std::time::Duration {
    (quiet / 5).clamp(AUTO_FETCH_GAP, std::time::Duration::from_secs(60))
}

/// Longest the background check waits on origin's tips, then on the fetch, before giving up (git is killed with it). A
/// connection left hanging (the laptop slept, the network changed) otherwise holds the project's check until TCP gives
/// up, hours later. The fetch gets longer: a big one can take minutes.
const TIPS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(if cfg!(test) { 2 } else { 60 });
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// [`Gitnetix::auto_fetch`]'s state for one project.
#[derive(Default)]
struct AutoFetch {
    /// When origin was last asked for its tips.
    asked: Option<Instant>,
    /// Origin's tips ([`Git::remote_tips`]) at the last fetch.
    tips: Option<String>,
    /// When those tips last moved (the first look counts): the longer ago, the less often origin is asked.
    moved: Option<Instant>,
    /// When the git host was last asked again about pull requests.
    hosted: Option<Instant>,
    /// [`Git::own_ssh`]; none until read, and again after a failed check (the ssh setting may be why).
    own_ssh: Option<bool>,
}

/// How long the git host's protected branches are trusted before asking again.
const PROTECTED_TTL: std::time::Duration = std::time::Duration::from_secs(300);

/// Which changes the workspace file list and diff show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewMode {
    /// Uncommitted work in the branch's checkout.
    Wip,
    /// Committed changes since the branch's base.
    Branch,
    /// Every file on the branch, with its changes.
    Project,
}

impl std::str::FromStr for ViewMode {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "wip" => Ok(ViewMode::Wip),
            "branch" => Ok(ViewMode::Branch),
            "project" => Ok(ViewMode::Project),
            other => Err(Error::Invalid(format!("unknown mode {other:?}"))),
        }
    }
}

// ---------- views returned to the UI ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub next_release: Option<String>,
    pub running_agents: usize,
    pub hidden: bool,
    /// Release tags start with "v": the project's choice, else what its tags do (read only for a project
    /// with a next release, the one place it shows), else true.
    pub tag_v: bool,
}

/// A project saved in another profile, which this one can add back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub name: String,
    pub path: String,
    /// Name of the profile it comes from.
    pub profile: String,
}

/// How likely a repo file is the project's own icon, lower first: (name, format, depth). None: not an icon.
fn icon_rank(path: &str) -> Option<(u8, u8, usize)> {
    let lower = path.to_lowercase();
    let (dir, file) = lower.rsplit_once('/').unwrap_or(("", &lower));
    if dir.split('/').any(|d| matches!(d, "node_modules" | "vendor" | "third_party" | "test" | "tests" | "fixtures")) {
        return None;
    }
    let (stem, ext) = file.rsplit_once('.')?;
    let format = match ext {
        "svg" => 0,
        "png" | "webp" => 1,
        "ico" => 2,
        "jpg" | "jpeg" | "gif" | "avif" => 3,
        _ => return None,
    };
    // `icon-512`, `logo192`, `favicon@2x` count; `iconography` does not.
    let named = |p: &str| stem.strip_prefix(p).is_some_and(|rest| !rest.starts_with(|c: char| c.is_ascii_alphabetic()));
    let name = if named("favicon") {
        0
    } else if named("apple-touch-icon") {
        1
    } else if ["icon", "app-icon", "pwa", "android-chrome"].into_iter().any(named) {
        2
    } else if named("logo") {
        3
    } else {
        return None;
    };
    Some((name, format, lower.matches('/').count()))
}

/// .gitignore line matching exactly `path` from the repo root; glob characters are escaped.
fn ignore_line(path: &str, dir: bool) -> String {
    let mut out = String::from("/");
    for c in path.chars() {
        if matches!(c, '*' | '?' | '[' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out + if dir { "/\n" } else { "\n" }
}

/// `paths`, or when empty every file on that side of the checkout's uncommitted work.
async fn or_whole_side(git: &Git, staged: bool, paths: &[String]) -> Result<Vec<String>> {
    if paths.is_empty() {
        git.wip_side(staged).await
    } else {
        Ok(paths.to_vec())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchView {
    pub name: String,
    pub kind: String,
    pub short: String,
    pub worktree: Option<String>,
    pub checked_out: bool,
    pub running: bool,
    /// An agent on it stopped and waits for the user.
    pub waiting: bool,
    /// Its checkout is stopped in a rebase, merge, cherry-pick or revert with conflicts left.
    pub conflict: bool,
    /// The rebase, merge, cherry-pick or revert its checkout is stopped in the middle of.
    pub in_progress: Option<String>,
    /// Files with uncommitted changes in its checkout (0 when not checked out).
    pub wip: u32,
    /// Stashes made on it.
    pub stashes: u32,
    /// Commits not yet in the base (release, or default branch).
    pub ahead: u32,
    /// Commits in the base the branch does not have.
    pub behind: u32,
    /// The default branch, which has no base: its commits since its latest tag, what the next release ships. With no
    /// tag, all its commits, counted up to [`UNRELEASED_MAX`].
    #[serde(default)]
    pub unreleased: u32,
    /// The default branch: the latest tag in its history, which `unreleased` counts from.
    #[serde(default)]
    pub last_tag: Option<String>,
    /// Of the commits its list shows (`ahead`, else `unreleased`, and `upstream_behind`), those a merge commit brought in:
    /// listed under their merge, not on rows of their own.
    #[serde(default)]
    pub folded: u32,
    pub upstream: Option<String>,
    pub upstream_ahead: u32,
    pub upstream_behind: u32,
    /// Behind or diverged from its upstream only because it was rewritten (rebased, amended, reset):
    /// origin's tip was once on the local branch, so a force push loses nothing unseen.
    pub rewritten: bool,
    /// Diverged only because origin was rewritten (force pushed) after the branch's tip was on it:
    /// the branch holds nothing origin never had, so resetting it to origin loses nothing.
    #[serde(default)]
    pub upstream_rewritten: bool,
    pub ticket: Option<String>,
    /// Exists locally or on origin (false: an open release whose branch is not made yet).
    pub exists: bool,
    /// Its commits are all in the base (merged, nothing new since).
    pub merged: bool,
    /// `merged` by the look of it, not by proof: a pull request squash carrying its ticket
    /// key came after its last commit. Never deleted as merged.
    pub likely_merged: bool,
    /// Branch it merges into; None for the default branch.
    pub parent: Option<String>,
    /// trunk (default or dev branch) | release (open release branch) | branch
    pub role: String,
    /// Open release it ships in (a release branch: its own version).
    pub release: Option<String>,
    /// Version this release branch shipped as (role "branch" once shipped).
    pub shipped: Option<String>,
    /// Reset or made on a shipped release's commit (see [`BranchMeta::from_shipped`]) and still based there: where it
    /// left its base. The map draws its line out of that release on the trunk.
    #[serde(default)]
    pub fork: Option<ShippedFork>,
    pub local: bool,
    /// Exists on origin.
    pub remote: bool,
    /// The git host protects it (branch protection or a ruleset): it can't be deleted.
    pub protected: bool,
    /// Most likely renamed on origin by someone else: following it renames it here too (see [`renamed_to`]).
    #[serde(default)]
    pub renamed_to: Option<String>,
    /// Date of its last commit (ISO 8601).
    pub date: String,
    /// Author of its last commit.
    pub author: String,
    pub email: String,
}

/// Where a branch left its base, in a shipped release's history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShippedFork {
    /// The first release tag holding that commit: the release that shipped it.
    pub tag: String,
    pub sha: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseView {
    pub version: String,
    /// next | hotfix | released
    pub tag: String,
    pub branch: String,
    pub base: String,
    pub open: bool,
    pub note: String,
    /// Git tag it shipped as (shipped releases only).
    pub tag_name: Option<String>,
    /// HEAD is detached on its tag.
    pub checked_out: bool,
}

/// A commit as the branch map's search reads it: what it matches against.
#[derive(Debug, Clone, Serialize)]
pub struct FoundCommit {
    pub sha: String,
    pub subject: String,
    pub tags: Vec<String>,
}

/// A tile the map's search reads the commits of: its branch, and the base they are counted from (none for the default branch).
#[derive(Debug, Clone, Deserialize)]
pub struct MapList {
    pub name: String,
    pub base: Option<String>,
}

/// The commits the branch map lists, by tile and by shipped tag: see [`Gitnetix::map_commits`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct MapCommits {
    pub branches: HashMap<String, Vec<FoundCommit>>,
    pub tags: HashMap<String, Vec<FoundCommit>>,
}

/// What a shipped tag holds: see [`Gitnetix::release_counts`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCount {
    /// The latest tag before it in its history; none for the first.
    pub since: Option<String>,
    /// Commits past `since`, its own included (up to [`UNRELEASED_MAX`] for the first).
    pub commits: u32,
}

/// What the overview's readers use of the project; the rest of it (every branch's settings, prefs) comes with `config.get`
/// and made every reply as big again in the projects that use them most.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub releases: Vec<Release>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub project: OverviewProject,
    pub current_branch: Option<String>,
    pub default_branch: String,
    pub releases: Vec<ReleaseView>,
    /// Every branch (local, origin-only and open releases' not made yet), each with its parent: the only copy of each view, a release's
    /// branches being those whose `release` is its version (thousands of branches, each sent twice, doubled every reply).
    pub branches: Vec<BranchView>,
    pub rebasing: bool,
    /// Branch the main checkout's paused rebase replays onto (the commit when no branch is there).
    pub rebase_onto: Option<String>,
    /// The rebase, merge, cherry-pick or revert the main checkout is stopped in the middle of.
    pub in_progress: Option<&'static str>,
    pub conflicts: Vec<String>,
    pub remote: Option<String>,
    /// Every stash, newest first (shared by all worktrees).
    pub stashes: Vec<StashInfo>,
    /// The checkout has a CHANGELOG.md at its root.
    pub has_changelog: bool,
    /// Latest version heading of that CHANGELOG.md (see `latest_changelog_version`).
    pub changelog_version: Option<String>,
    /// The project's tags start with "v" (see `tags_use_v`), whatever its own choice (`branch_types.tag_v`).
    pub tags_use_v: bool,
    /// HEAD's branch has no commit yet (a new repository): the app offers to name it and make the first commit.
    pub unborn: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashApplied {
    /// Files left conflicted; the stash is kept then.
    pub conflicts: Vec<String>,
    /// The stash was dropped (popped cleanly).
    pub dropped: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub sha: String,
    pub message: String,
    pub ai_written: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeView {
    pub project_id: String,
    pub project_name: String,
    pub path: String,
    pub branch: Option<String>,
    pub main: bool,
    pub base: Option<String>,
    pub ticket: Option<String>,
    pub additions: u32,
    pub deletions: u32,
    /// Commits not in `base` yet: with `wip`, what a merge would carry.
    pub ahead: u32,
    /// Commits in `base` not in the branch yet.
    pub behind: u32,
    /// Files with uncommitted changes.
    pub wip: u32,
    pub agent: Option<AgentSession>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketView {
    #[serde(flatten)]
    pub ticket: Ticket,
    pub release: String,
    pub branch: Option<String>,
    /// Project holding `branch` when it is not the one asked about.
    pub branch_project: Option<String>,
    /// [`tickets::priority_rank`] of its priority: 0 most urgent, 5 none.
    pub priority_rank: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub key: String,
    pub kind: String,
    pub release: String,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct NewItem {
    /// Open release to ship in; empty = branch off `from` instead.
    pub release: String,
    /// Branch to start from and merge back into when there is no release (default branch when empty).
    pub from: Option<String>,
    /// Commit to start at instead of the tip of `from` (or the release); the branch still merges into it.
    pub at: Option<String>,
    /// `at` is a shipped release's commit: the branch is marked so (see [`BranchMeta::from_shipped`]).
    pub shipped: bool,
    pub kind: String,
    pub description: String,
    pub branch_name: Option<String>,
    pub ticket: Option<String>,
    /// switch | worktree
    pub r#where: String,
    pub start_agent: bool,
    /// Provider, model and effort for the agent when `start_agent`.
    #[serde(flatten)]
    pub pick: Route,
    /// Files sent with the agent's first message when `start_agent`.
    pub files: Vec<Attachment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewItemResult {
    pub branch: String,
    pub worktree: Option<String>,
    pub agent_session: Option<String>,
}

/// What deleting a branch has left to do once its checks passed: its local branch, and origin's copy at the commit the
/// checks saw (the push's lease).
struct DeletePlan {
    /// The local branch's commit (none: no local branch).
    tip: Option<String>,
    theirs: Option<String>,
}

/// What deleting branches checks them against, read once for all of them: their commits, their checkouts, and per base
/// the refs in its history (one ref listing per base; each branch took about 10 git calls before).
struct DeleteRefs {
    default: String,
    /// Local branches and origin's, by full ref name.
    tips: HashMap<String, String>,
    /// The worktree each checked-out branch is in.
    checkouts: HashMap<String, PathBuf>,
    /// Base → the refs in its history, at their commit then; read on first use.
    merged: tokio::sync::Mutex<HashMap<String, Arc<HashMap<String, String>>>>,
}

impl DeleteRefs {
    async fn read(git: &Git) -> Result<DeleteRefs> {
        Ok(DeleteRefs {
            default: git.default_branch().await?,
            tips: git.ref_tips(&["refs/heads", "refs/remotes/origin"], None).await?,
            checkouts: git.worktrees().await?.into_iter().filter_map(|w| Some((w.branch?, PathBuf::from(w.path)))).collect(),
            merged: Default::default(),
        })
    }

    /// Commit of `rev` spelled like [`Refs::rev`] (`main`, `origin/main`), as read here.
    fn sha(&self, rev: &str) -> Option<&String> {
        self.tips.get(&format!("refs/heads/{rev}")).or_else(|| self.tips.get(&format!("refs/remotes/origin/{}", rev.strip_prefix("origin/")?)))
    }

    /// [`Git::is_squash_merged`] for full ref `r` at the commit read here: the answer the branch map saved for the pair of
    /// commits (its squash index answers for every branch it shows), else git's own check, saved for next time.
    async fn squashed(&self, git: &Git, cache: &CommitCache, r: &str, base: &str) -> bool {
        let (Some(tip), Some(base_tip)) = (self.tips.get(r), self.sha(base)) else {
            return git.is_squash_merged(r, base).await.unwrap_or(false);
        };
        if let Some(hit) = cache.get("squash2", tip, base_tip) {
            return hit;
        }
        let Ok(squashed) = git.is_squash_merged(r, base).await else { return false };
        cache.insert("squash2", tip, base_tip, squashed);
        squashed
    }

    /// [`Git::rev_of`] as read here: the local branch, else origin's copy, else `name` as given.
    fn rev_of(&self, name: &str) -> String {
        if self.tips.contains_key(&format!("refs/heads/{name}")) {
            name.into()
        } else if self.tips.contains_key(&format!("refs/remotes/origin/{name}")) {
            format!("origin/{name}")
        } else {
            name.into()
        }
    }

    /// [`Git::is_ancestor`] for full ref `r` at the commit read here: no when it moved since.
    async fn in_history(&self, git: &Git, r: &str, base: &str) -> bool {
        let merged = {
            let mut all = self.merged.lock().await;
            match all.get(base) {
                Some(m) => m.clone(),
                None => {
                    // A base git can't read holds nothing, as `is_ancestor` answers.
                    let m = Arc::new(git.ref_tips(&["refs/heads", "refs/remotes/origin"], Some(base)).await.unwrap_or_default());
                    all.insert(base.into(), m.clone());
                    m
                }
            }
        };
        merged.get(r).is_some_and(|sha| self.tips.get(r) == Some(sha))
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub deleted: Vec<String>,
    pub skipped: Vec<Skipped>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub branch: String,
    pub reason: String,
}

/// How [`Gitnetix::merge_branch`] lands a branch.
#[derive(Debug, Clone, Copy, Default)]
pub struct MergeOptions {
    /// Collapse the branch's commits into one first.
    pub squash: bool,
    /// AI writes the squashed commit's message (else "squash | <branch>").
    pub squash_ai: bool,
    /// Rebase the branch onto the target and fast-forward the target, instead of a merge commit.
    pub rebase: bool,
    /// Delete the branch afterwards, locally and on origin.
    pub delete_after: bool,
    /// Push the target to origin afterwards.
    pub push: bool,
    /// Keep the main checkout where it is instead of switching to the target (unless deleting the branch moves it).
    pub stay: bool,
}

/// Where AI resolving an operation's conflicts got to.
struct Resolution {
    /// The operation went all the way through.
    done: bool,
    /// Files still conflicted where it stopped.
    left: Vec<String>,
    /// "path: why" for each file AI could not resolve; empty when it was off.
    errors: Vec<String>,
}

impl Resolution {
    /// Why AI did not get it through, as a sentence; empty when it was off.
    fn why(&self) -> String {
        if self.errors.is_empty() {
            String::new()
        } else {
            format!(" AI could not resolve {}.", self.errors.join("; "))
        }
    }
}

/// What AI makes of one conflicted file.
enum Fix {
    /// Its resolved text.
    Text(String),
    /// The file stays (changed on one side and deleted on the other, or added on one side only), or goes.
    Keep,
    Delete,
    /// One side's version stays whole: index stage 2 (the checkout's) or 3 (the one brought in).
    Side(u8),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    /// The open release's CHANGELOG.md section was moved to its new version (committed, not pushed).
    pub changelog: bool,
    /// Why committing that section failed; the rename itself went through.
    pub changelog_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseResult {
    /// Conflicted files where the rebase stopped (empty = done).
    pub conflicts: Vec<String>,
    /// Upstream that now needs a force push: the branch was already pushed before the rebase.
    pub force_push_to: Option<String>,
    /// The rebase finished, but the uncommitted changes it set aside conflict with it: these files hold conflict
    /// markers, and the changes are also kept in the "autostash" stash entry.
    pub stash_conflicts: Vec<String>,
    /// "path: why" for each file AI could not resolve, where it stopped.
    pub errors: Vec<String>,
    /// Files AI resolved on the way.
    pub resolved: u32,
    /// Stopped by an abort: the branch is back where it was.
    pub aborted: bool,
}

/// A rebase AI carries through, as the UIs show it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseRun {
    pub project_id: String,
    pub branch: String,
    pub onto: String,
    /// The commit it is on, from 1, of the `steps` it replays; 0 when git doesn't say.
    pub step: u32,
    pub steps: u32,
    /// Subject of that commit.
    pub subject: String,
    /// That commit's conflicted files, and how many of them AI has answered for.
    pub files: Vec<String>,
    pub resolved: u32,
    /// Files AI resolved since the run started.
    pub resolved_total: u32,
    /// Files of this commit the first pass could not settle, AI going over them again.
    pub second_pass: Vec<String>,
    pub started_at: String,
    pub state: RunState,
    /// Why it stopped, once failed.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunState {
    Running,
    Done,
    Failed,
    Aborted,
}

/// [`Gitnetix::runs`]: one AI rebase at a time per checkout.
type Runs = Arc<std::sync::Mutex<HashMap<PathBuf, RunSlot>>>;

struct RunSlot {
    run: RebaseRun,
    /// The UIs have heard of it: AI started resolving, or it was asked for.
    told: bool,
    /// Set to stop it: the AI calls in flight are dropped, then the rebase is aborted.
    stop: tokio::sync::watch::Sender<bool>,
    /// Turns true once it is over.
    over: tokio::sync::watch::Receiver<bool>,
}

/// Held by the rebase it registers in [`Gitnetix::runs`]; dropping it ends the run there.
struct RunCtl {
    dir: PathBuf,
    runs: Runs,
    events: broadcast::Sender<Event>,
    stop: tokio::sync::watch::Receiver<bool>,
    over: tokio::sync::watch::Sender<bool>,
    /// AI resolves even when the project has it off: the user asked for it.
    forced: bool,
}

impl RunCtl {
    /// Changes what the run shows, and tells the UIs.
    fn report(&self, f: impl FnOnce(&mut RebaseRun)) {
        let run = {
            let mut runs = self.runs.lock().unwrap();
            let Some(s) = runs.get_mut(&self.dir) else { return };
            f(&mut s.run);
            s.told = true;
            s.run.clone()
        };
        let _ = self.events.send(Event::RebaseRun { run });
    }

    fn stopped(&self) -> bool {
        *self.stop.borrow()
    }

    /// Resolves once the run is asked to stop.
    async fn on_stop(&self) {
        let mut stop = self.stop.clone();
        if stop.wait_for(|s| *s).await.is_err() {
            std::future::pending::<()>().await;
        }
    }

    fn resolved_total(&self) -> u32 {
        self.runs.lock().unwrap().get(&self.dir).map_or(0, |s| s.run.resolved_total)
    }

    /// Ends the run as `state`; the UIs hear of it if they heard of the run.
    fn end(self, state: RunState, error: Option<String>) {
        if let Some(s) = self.runs.lock().unwrap().get_mut(&self.dir) {
            s.run.state = state;
            s.run.error = error;
        }
    }
}

impl Drop for RunCtl {
    fn drop(&mut self) {
        let slot = self.runs.lock().unwrap().remove(&self.dir);
        if let Some(mut s) = slot.filter(|s| s.told) {
            if s.run.state == RunState::Running {
                s.run.state = RunState::Failed;
                s.run.error = Some("The rebase stopped unexpectedly.".into());
            }
            let _ = self.events.send(Event::RebaseRun { run: s.run });
        }
        self.over.send_replace(true);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub into: String,
    /// Tip of `into` after the merge.
    pub sha: String,
    pub already_merged: bool,
    pub deleted: bool,
    /// Why deleting the branch failed (the merge itself went through).
    pub delete_error: Option<String>,
    /// The main checkout moved to `into`.
    pub switched: bool,
    /// Why the main checkout didn't move to `into` when it should have.
    pub stayed: Option<String>,
    /// `into` was pushed to origin after the merge.
    pub pushed: bool,
    /// Why pushing `into` failed (the merge itself went through).
    pub push_error: Option<String>,
    /// Tag recreated on `sha`: a release already shipped merged again into the default branch.
    pub retagged: Option<String>,
    /// Why moving or pushing the tag failed (the merge itself went through).
    pub tag_error: Option<String>,
}

/// What [`Gitnetix::publish_branch`] did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub tag: String,
    /// The branch and the tag reached origin (false without an origin remote).
    pub pushed: bool,
    /// A commit dated the CHANGELOG.md entry.
    pub changelog: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct NotesInclude {
    pub feat: bool,
    pub fix: bool,
    pub internal: bool,
    pub tickets: bool,
}

/// One change in a release-notes range: a merged branch with its commits, or a commit made on the
/// range's own line. The notes page lists these so one can be left out.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotesItem {
    /// Full sha of the merge, or of the commit.
    pub id: String,
    /// "feat", "fix" or "internal".
    pub kind: &'static str,
    pub title: String,
    /// The PR number ("#12"), when the message names one.
    pub pr: Option<String>,
    /// Commits the change brings, its merge commit included.
    pub commits: usize,
    pub tickets: Vec<String>,
}

pub fn slugify(s: &str, max_words: usize) -> String {
    let lower = s.to_lowercase();
    let words: Vec<String> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty() && !matches!(*w, "a" | "an" | "the" | "and" | "to" | "of" | "for" | "with" | "in" | "on" | "let" | "users"))
        .take(max_words.max(1))
        .map(String::from)
        .collect();
    if words.is_empty() {
        "change".into()
    } else {
        words.join("-")
    }
}

/// The GitHub token may only reach github.com or the Enterprise API the user set: an API URL derived
/// from origin would hand it to any host with "github" in its name.
/// A pull request's branches and the commits its host diffs, as its details give them.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrRefs {
    pub base: String,
    pub head: String,
    pub base_sha: String,
    pub head_sha: String,
}

/// Commit `sha` (full or abbreviated) as this clone has it, fetched from `from` (a remote or a URL) when missing: from
/// each of `refs` in turn, then by itself when full, which some hosts hand out.
async fn fetched_commit(git: &Git, from: &str, sha: &str, refs: &[String]) -> Result<Option<String>> {
    if sha.is_empty() {
        return Ok(None);
    }
    if let Some(c) = git.commit_of(sha).await? {
        return Ok(Some(c));
    }
    let full = sha.len() >= 40 && sha.bytes().all(|b| b.is_ascii_hexdigit());
    for what in refs.iter().map(String::as_str).chain(full.then_some(sha)) {
        if git.fetch_objects(from, what).await? {
            if let Some(c) = git.commit_of(sha).await? {
                return Ok(Some(c));
            }
        }
    }
    Ok(None)
}

/// The remote holding `branch`'s own copy, when `upstream` (`remote/name`) is one: `fork` for `fork/feat/x`.
fn own_remote<'a>(upstream: &'a str, branch: &str) -> Option<&'a str> {
    upstream.strip_suffix(branch)?.strip_suffix('/').filter(|r| !r.is_empty())
}

/// Git's words when the host turns a push down for lack of write access: GitHub's over SSH ("ERROR: Permission to o/r.git
/// denied to me.") and over HTTPS ("remote: Permission to o/r.git denied to me." then "returned error: 403").
fn push_refused(stderr: &str) -> bool {
    (stderr.contains("Permission to") && stderr.contains("denied")) || stderr.contains("returned error: 403")
}

/// `url` (origin's) naming repository `to` instead of `from`, on the same host and protocol so the same sign-in
/// reaches it.
fn swap_repo(url: &str, from: &RepoRef, to: &RepoRef) -> String {
    let path = format!("{}/{}", from.owner, from.repo);
    match url.rfind(&path) {
        Some(i) => format!("{}{}/{}{}", &url[..i], to.owner, to.repo, &url[i + path.len()..]),
        None => format!("https://{}/{}/{}.git", to.host, to.owner, to.repo),
    }
}

/// The remote here that already points at GitHub repository `full_name` (owner/repo), if any.
fn remote_of<'a>(remotes: &'a [(String, String)], full_name: &str) -> Option<&'a str> {
    remotes.iter().find(|(_, url)| parse_remote(url).is_some_and(|r| format!("{}/{}", r.owner, r.repo).eq_ignore_ascii_case(full_name))).map(|(n, _)| n.as_str())
}

/// A name for the user's fork's new remote: `fork`, as the GitHub CLI names it, else the fork's owner.
fn fork_remote_name(remotes: &[(String, String)], owner: &str) -> String {
    let taken = |n: &str| remotes.iter().any(|(r, _)| r == n);
    ["fork", owner].into_iter().find(|n| !taken(n)).map(String::from).unwrap_or_else(|| format!("{owner}-fork"))
}

fn github_host_ok(host: &str, api_set: bool) -> bool {
    host == "github.com" || (api_set && host.contains("github"))
}

fn valid_branch_name(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && !s.contains("..")
        && !s.ends_with('/')
        && !s.ends_with(".lock")
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
}

/// File in a checkout's git dir holding its agent's ticket, out of the working tree.
const TICKET_FILE: &str = "gitnetix-ticket.md";

/// A web link to lines of a file on origin's pages, the commit it points at (short) and the branch it took it from.
#[derive(Debug, Serialize)]
pub struct Permalink {
    pub url: String,
    pub sha: String,
    pub branch: String,
}

/// The lines a link into origin points at, read from the clone: from `start` (1-based) to `end`, `more` left out.
#[derive(Debug, Serialize)]
pub struct LinkedLines {
    pub path: String,
    pub sha: String,
    pub start: u32,
    pub end: u32,
    pub lines: Vec<String>,
    pub more: u32,
}

/// Folder in a checkout's git dir holding files sent to its agent, out of the working tree.
// shortcut: never pruned on the main checkout (a worktree's git dir goes with it), prune per session if it grows.
pub(crate) const ATTACH_DIR: &str = "gitnetix-attachments";

/// A file sent with an agent message: its contents in base64, or a path on this machine (dropped on the desktop app).
#[derive(Debug, Clone, Deserialize)]
pub struct Attachment {
    pub name: String,
    #[serde(default)]
    pub data: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

/// The checkout's folder for files sent to its agent and images it shows, in its git dir.
async fn attach_root(cwd: &Path) -> Result<PathBuf> {
    Git::new(cwd).git_paths(&[ATTACH_DIR]).await?.into_iter().next().ok_or_else(|| Error::Invalid("no git dir".into()))
}

/// Saves `files` in the checkout's git dir and lists their paths after `text`, for the agent to open.
async fn attach(cwd: &Path, text: &str, files: &[Attachment]) -> Result<String> {
    use base64::Engine as _;
    if files.is_empty() {
        return Ok(text.to_string());
    }
    let dir = attach_root(cwd).await?.join(new_id());
    std::fs::create_dir_all(&dir)?;
    let mut list = String::new();
    for f in files {
        // The bare file name: a name carrying a path must not write outside `dir`.
        let name = Path::new(&f.name).file_name().and_then(|n| n.to_str()).unwrap_or("file");
        let mut dest = dir.join(name);
        // Pasted screenshots all arrive as "image.png".
        let mut i = 1;
        while dest.exists() {
            i += 1;
            dest = dir.join(format!("{i}-{name}"));
        }
        let saved = match (&f.data, &f.path) {
            (Some(d), _) => base64::engine::general_purpose::STANDARD.decode(d).map_err(|e| e.to_string()).and_then(|b| std::fs::write(&dest, b).map_err(|e| e.to_string())),
            (None, Some(p)) => std::fs::copy(p, &dest).map(|_| ()).map_err(|e| e.to_string()),
            (None, None) => Err("no contents".into()),
        };
        saved.map_err(|e| Error::Invalid(format!("Could not attach {name}: {e}")))?;
        list.push_str(&format!("\n- {}", dest.display()));
    }
    Ok(format!("{text}\n\nAttached files:{list}").trim_start().to_string())
}

/// The files sent with a ticket comment: their bare names and contents, 25 MB together at most.
fn comment_files(files: &[Attachment]) -> Result<Vec<(String, Vec<u8>)>> {
    use base64::Engine as _;
    const CAP: u64 = 25 << 20;
    let mut total = 0;
    let mut out = Vec::new();
    for f in files {
        let name = Path::new(&f.name).file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
        let bytes = match (&f.data, &f.path) {
            (Some(d), _) => base64::engine::general_purpose::STANDARD.decode(d).map_err(|e| Error::Invalid(format!("Could not read {name}: {e}")))?,
            (None, Some(p)) => {
                // Its size first: a dropped file can be any size.
                total += std::fs::metadata(p)?.len();
                if total > CAP {
                    return Err(Error::Invalid("Files sent with a comment are limited to 25 MB together".into()));
                }
                std::fs::read(p).map_err(|e| Error::Invalid(format!("Could not read {name}: {e}")))?
            }
            (None, None) => return Err(Error::Invalid(format!("{name} has no contents"))),
        };
        if f.data.is_some() {
            total += bytes.len() as u64;
        }
        if total > CAP {
            return Err(Error::Invalid("Files sent with a comment are limited to 25 MB together".into()));
        }
        out.push((name, bytes));
    }
    Ok(out)
}

/// Where a file `attach` saved, or an image the agent shows, is for the checkout at `cwd`; any path outside its attachments folder is refused.
async fn attachment_path(cwd: &Path, path: &str) -> Result<PathBuf> {
    let dir = attach_root(cwd).await?;
    // Canonical on both sides: "..", symlinks and the git dir's spelling cannot step out.
    let file = Path::new(path).canonicalize()?;
    if !file.starts_with(dir.canonicalize()?) {
        return Err(Error::Invalid("Not a file sent to this agent".into()));
    }
    Ok(file)
}

/// The contents of `attachment_path`, base64.
async fn attachment(cwd: &Path, path: &str) -> Result<String> {
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(std::fs::read(attachment_path(cwd, path).await?)?))
}

/// How long an agent start waits for the branch's ticket.
const TICKET_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Longest ticket description given to an agent, in characters.
const TICKET_DESCRIPTION_MAX: usize = 20_000;

/// A ticket as an agent reads it.
fn ticket_context(t: &Ticket) -> String {
    let mut s = format!("# {} · {} · {}\n{}\nStatus: {}", t.key, t.kind, t.title, t.url, t.status_label);
    if !t.parent_key.is_empty() {
        s.push_str(&format!("\nParent: {} {}", t.parent_key, t.parent_title));
    }
    let desc = t.description.trim();
    if !desc.is_empty() {
        s.push_str("\n\n");
        s.extend(desc.chars().take(TICKET_DESCRIPTION_MAX));
        if desc.chars().count() > TICKET_DESCRIPTION_MAX {
            s.push_str("\n… (cut, see the ticket)");
        }
    }
    if !t.criteria.is_empty() {
        s.push_str("\n\nAcceptance criteria:");
        for c in &t.criteria {
            s.push_str(&format!("\n- [{}] {}", if c.done { "x" } else { " " }, c.text));
        }
    }
    s
}

/// The agent prompt's `{ticket}`: the ticket, then where to get it again.
fn ticket_section(project_id: &str, key: &str, body: &str, saved: Option<&Path>) -> String {
    let mut s = format!("Ticket linked to this branch:\n\n{body}\n\n");
    if let Some(f) = saved {
        s.push_str(&format!("A copy is in {}: read it again whenever you need the ticket. ", f.display()));
    }
    s.push_str(&format!("If the Gitnetix `tickets_get` tool is available, call it with projectId \"{project_id}\" and key \"{key}\" for its current version."));
    s
}

/// Fill an agent prompt's `{ticket}`, or add the section at the end of a template without it.
fn insert_ticket(prompt: &str, ticket: &str) -> String {
    if prompt.contains("{ticket}") {
        prompt.replace("{ticket}", ticket)
    } else if ticket.is_empty() {
        prompt.to_string()
    } else {
        format!("{prompt}\n\n{ticket}")
    }
}

/// The language a dictation is rewritten in, for `{language}`: AI hears it in the words, any of the speech model's 25.
const SAME_LANGUAGE: &str = "the language it was spoken in";

/// Where a dictation is spoken, for AI's rewrite.
struct Scene {
    project: String,
    branch: String,
    ticket: Option<String>,
    /// The last 10 commits, each as "- subject" and then the files it touched.
    commits: String,
    /// The uncommitted changes, as `git status --short` lists them.
    files: String,
}

/// Start the part after the prefix with the ticket key and an underscore (`feat/ATL-212_login`).
/// A key already there (`feat/atl-212-login`) is replaced rather than repeated. Characters a branch
/// can't hold are dropped from the key, so Trello's `#aB3dE9fG` becomes `aB3dE9fG`.
fn with_ticket(branch: &str, ticket: &str) -> String {
    let t: String = ticket.trim().replace(char::is_whitespace, "-").chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect();
    let t = t.trim_matches(|c| matches!(c, '-' | '_' | '.'));
    if t.is_empty() {
        return branch.to_string();
    }
    let (prefix, rest) = match branch.split_once('/') {
        Some((p, r)) => (format!("{p}/"), r),
        None => (String::new(), branch),
    };
    if rest.eq_ignore_ascii_case(t) {
        return format!("{prefix}{t}");
    }
    let rest = match rest.get(..t.len()) {
        Some(head) if head.eq_ignore_ascii_case(t) && matches!(rest.as_bytes().get(t.len()), Some(b'-' | b'_')) => &rest[t.len() + 1..],
        _ => rest,
    };
    format!("{prefix}{t}_{rest}")
}

/// `v2.4` / `2.4.1` → [2, 4, 0] / [2, 4, 1]; anything else (pre-releases included) is not a version.
/// Parts are capped at u32 so bumping one can't overflow.
fn parse_version(s: &str) -> Option<[u64; 3]> {
    let parts: Vec<&str> = s.trim_start_matches('v').split('.').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut v = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        v[i] = part.parse::<u32>().ok()?.into();
    }
    Some(v)
}

fn valid_version(v: &str) -> bool {
    !v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// A version Publish can tag: a digit first, then only letters, digits, dots and dashes, without "..",
/// nor a trailing "." or ".lock" (git refuses such tag names). The Publish dialog checks the same.
fn publishable_version(v: &str) -> bool {
    v.starts_with(|c: char| c.is_ascii_digit()) && valid_version(v) && !v.contains("..") && !v.ends_with('.') && !v.ends_with(".lock")
}

/// Whether `release` brought commits of its own into `into` through a merge: its tip is in `into`, off
/// `into`'s first-parent line. A release cut from `into` with nothing on it sits on that line, so it is not
/// merged; nor is one fast-forwarded in (Gitnetix merges with --no-ff).
async fn release_merged_in(git: &Git, release: &str, into: &str) -> bool {
    if !git.is_ancestor(release, into).await.unwrap_or(false) {
        return false;
    }
    let (Ok(tip), Ok(line)) = (git.rev_parse(release).await, git.run(&["rev-list", "--first-parent", "--reverse", &format!("{release}..{into}")]).await) else {
        return false;
    };
    // The oldest commit on the line past the release: its first parent is the release's tip when the
    // release sits on the line, else the commit the release started from.
    let Some(first) = line.lines().next() else { return false };
    git.rev_parse(&format!("{first}^1")).await.is_ok_and(|parent| parent != tip)
}

/// Whether a project's release tags start with "v", read from its tag names: at least half of the
/// ones [`parse_version`] reads do. True without any, git's most common habit.
fn tags_use_v<'a>(names: impl IntoIterator<Item = &'a str>) -> bool {
    let (mut with_v, mut all) = (0, 0);
    for n in names.into_iter().filter(|n| parse_version(n).is_some()) {
        all += 1;
        with_v += usize::from(n.starts_with('v'));
    }
    with_v * 2 >= all
}

/// The tag `version` ships as: `v2.4.0`, or `2.4.0` when the project's tags go without the "v".
fn release_tag(use_v: bool, version: &str) -> String {
    let version = version.trim_start_matches('v');
    if use_v { format!("v{version}") } else { version.to_string() }
}

/// Whether `p`'s release tags start with "v": its own choice, else what its tags do.
async fn use_v(p: &Project, git: &Git) -> Result<bool> {
    Ok(match p.branch_types.tag_v {
        Some(v) => v,
        None => tags_use_v(git.tags().await?.iter().map(|t| t.name.as_str())),
    })
}

/// Which part of the version [`Gitnetix::suggest_version`] bumps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bump {
    Major,
    Minor,
    Patch,
}

fn release_branch(version: &str) -> String {
    format!("release/{}", version.trim_start_matches('v'))
}

/// Keep a Changelog file that shipping dates (see `stamp_changelog`).
const CHANGELOG: &str = "CHANGELOG.md";

/// Refused while CHANGELOG.md has uncommitted changes in the checkout at `dir`.
/// Refuses a file the checkout holds as a symbolic link: a branch can point one anywhere on disk, and a write follows it.
fn not_a_link(file: &Path) -> Result<()> {
    if std::fs::symlink_metadata(file).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(Error::Invalid(format!("{} is a symbolic link: Gitnetix does not write through it", file.display())));
    }
    Ok(())
}

async fn clean_changelog(g: &Git, dir: &Path) -> Result<()> {
    if !g.run(&["status", "--porcelain", "--", CHANGELOG]).await?.trim().is_empty() {
        return Err(Error::Invalid(format!("{CHANGELOG} has uncommitted changes at {}", dir.display())));
    }
    Ok(())
}

/// Refused while `branch`'s checkout at `dir` is stopped in the middle of a rebase, merge, cherry-pick or
/// revert: a commit made there would land in that operation instead of on the branch.
/// A publish running in a project, until dropped (see `Gitnetix::publishing`).
struct Publishing<'a>(&'a std::sync::Mutex<std::collections::HashSet<String>>, String);

impl Drop for Publishing<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().remove(&self.1);
    }
}

/// The branch at `local` once publishing committed on it: `prev`, or one commit on top of `prev`. Anything
/// else means someone else committed meanwhile: refused, so nothing of theirs gets tagged, pushed or rolled back.
async fn own_commit(git: &Git, local: &str, prev: &str, branch: &str) -> Result<String> {
    let now = git.rev_parse(local).await?;
    if now == prev || git.rev_parse(&format!("{now}^")).await.ok().as_deref() == Some(prev) {
        return Ok(now);
    }
    Err(Error::Invalid(format!("{branch} got other commits while its tag was being created, so nothing was tagged or pushed. Its changelog commit may stay on it: check {branch} before trying again.")))
}

async fn refuse_in_progress(g: &Git, dir: &Path, branch: &str) -> Result<()> {
    match g.in_progress().await? {
        Some(op) => Err(Error::Invalid(format!("{branch} is in the middle of a {op} at {}. Finish or abort it first.", dir.display()))),
        None => Ok(()),
    }
}

/// Refused when `version` is tagged already, with or without the "v": the other spelling would ship it twice.
async fn refuse_tagged(git: &Git, version: &str) -> Result<()> {
    for t in [release_tag(true, version), release_tag(false, version)] {
        if git.ref_exists(&format!("refs/tags/{t}")).await? {
            return Err(Error::Invalid(format!("{version} is already tagged as {t}.")));
        }
    }
    Ok(())
}

/// The changelog with `old`'s version heading (`## [2.4.0] - date`) under `new` instead; None without one.
fn rename_changelog_version(text: &str, old: &str, new: &str) -> Option<String> {
    let heading = format!("## [{old}]");
    let mut found = false;
    let out: String = text
        .split_inclusive('\n')
        .map(|l| match l.trim_start().strip_prefix(&heading) {
            Some(rest) => {
                found = true;
                format!("## [{new}]{rest}")
            }
            None => l.to_string(),
        })
        .collect();
    found.then_some(out)
}

/// Stashes made on a branch before it was renamed show under its name now (git keeps the old one
/// in their message), unless the old name is `in_use` again.
fn relabel_stashes(p: &Project, stashes: &mut [StashInfo], in_use: impl Fn(&str) -> bool) {
    for s in stashes {
        // Renamed again later: follow the chain (renames never loop, see `renamed`).
        while let Some(to) = s.branch.as_deref().filter(|n| !in_use(n)).and_then(|n| p.renamed_branches.get(n)) {
            s.branch = Some(to.clone());
        }
    }
}

/// Rename the `## [Unreleased]` section to `## [version] - date` and open a fresh empty
/// `Unreleased` above it. When the version already has a section (entries added after an
/// earlier move), the Unreleased entries are merged into it instead (see `merge_sections`).
/// None when there is no Unreleased section or it has no entries.
fn stamp_changelog(text: &str, version: &str, date: &str) -> Option<String> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let section_end = |from: usize| lines.iter().skip(from + 1).position(|l| l.trim_start().starts_with("## ")).map_or(lines.len(), |i| from + 1 + i);
    let start = lines.iter().position(|l| l.trim().eq_ignore_ascii_case("## [unreleased]"))?;
    let end = section_end(start);
    if lines[start + 1..end].iter().all(|l| l.trim().is_empty()) {
        return None;
    }
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let heading = format!("## [{version}]");
    let Some(at) = lines.iter().position(|l| l.trim_start().starts_with(&heading)) else {
        let mut out = lines[..start].concat();
        out.push_str(&format!("## [Unreleased]{eol}{eol}## [{version}] - {date}{eol}"));
        out.push_str(&lines[start + 1..].concat());
        return Some(out);
    };
    if at < start {
        return None;
    }
    let at_end = section_end(at);
    let mut out = lines[..start].concat();
    out.push_str(&format!("## [Unreleased]{eol}{eol}"));
    out.push_str(&lines[end..=at].concat());
    out.push_str(eol);
    out.push_str(&merge_sections(&lines[at + 1..at_end], &lines[start + 1..end]).join(eol));
    out.push_str(eol);
    if at_end < lines.len() {
        out.push_str(eol);
        out.push_str(&lines[at_end..].concat());
    }
    Some(out)
}

/// Lines of `into` with the entries of `from` added under the matching `### Kind` heading,
/// new kinds placed in Keep a Changelog order and entries already listed skipped.
/// shortcut: blank lines inside a section are dropped, fine for one-line bullets; keep them if entries grow paragraphs.
fn merge_sections(into: &[&str], from: &[&str]) -> Vec<String> {
    const ORDER: &[&str] = &["added", "changed", "deprecated", "removed", "fixed", "security"];
    // "### Added (App)" ranks as Added: a project in parentheses splits a kind, not a new kind.
    let rank = |h: &Option<String>| h.as_ref().map_or(0, |h| 1 + ORDER.iter().position(|k| h[3..].trim().split(" (").next().unwrap_or_default().eq_ignore_ascii_case(k)).unwrap_or(ORDER.len()));
    let groups = |lines: &[&str]| {
        let mut out: Vec<(Option<String>, Vec<String>)> = Vec::new();
        for l in lines.iter().map(|l| l.trim_end()).filter(|l| !l.trim().is_empty()) {
            if l.starts_with("### ") {
                out.push((Some(l.to_string()), Vec::new()));
            } else if let Some(g) = out.last_mut() {
                g.1.push(l.to_string());
            } else {
                out.push((None, vec![l.to_string()]));
            }
        }
        out
    };
    let mut merged = groups(into);
    for (head, entries) in groups(from) {
        let same = |h: &Option<String>| h.as_deref().map(str::to_lowercase) == head.as_deref().map(str::to_lowercase);
        let i = match merged.iter().position(|(h, _)| same(h)) {
            Some(i) => i,
            None => {
                let i = merged.iter().position(|(h, _)| rank(h) > rank(&head)).unwrap_or(merged.len());
                merged.insert(i, (head, Vec::new()));
                i
            }
        };
        for e in entries {
            if !merged[i].1.iter().any(|x| x.trim() == e.trim()) {
                merged[i].1.push(e);
            }
        }
    }
    let mut out = Vec::new();
    for (i, (head, entries)) in merged.into_iter().enumerate() {
        if i > 0 {
            out.push(String::new());
        }
        out.extend(head);
        out.extend(entries);
    }
    out
}

/// `text` with the body of its `## [name]` section (`name` matched ignoring case, heading kept)
/// replaced by `body`. Without that section, one is opened above the first version heading (or at the end).
fn replace_section(text: &str, name: &str, body: &str) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let heading = format!("## [{}]", name.to_lowercase());
    let start = lines.iter().position(|l| l.trim().to_lowercase().starts_with(&heading));
    let after = start.map_or(0, |s| s + 1);
    let end = lines.iter().skip(after).position(|l| l.trim_start().starts_with("## ")).map_or(lines.len(), |i| after + i);
    let mut out: String = lines[..start.unwrap_or(end)].concat();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push_str(eol);
    }
    out.push_str(&start.map_or(format!("## [{name}]"), |s| lines[s].trim_end().to_string()));
    out.push_str(&format!("{eol}{eol}"));
    let body = body.trim();
    if !body.is_empty() {
        out.push_str(&body.lines().map(str::trim_end).collect::<Vec<_>>().join(eol));
        out.push_str(eol);
    }
    if end < lines.len() {
        out.push_str(eol);
        out.push_str(&lines[end..].concat());
    }
    out
}

/// The version of the first `## [x.y.z]` heading that is not Unreleased.
fn latest_changelog_version(text: &str) -> Option<String> {
    text.lines()
        .filter_map(|l| l.trim_start().strip_prefix("## [")?.split_once(']'))
        .map(|(v, _)| v.trim())
        .find(|v| !v.eq_ignore_ascii_case("unreleased"))
        .map(String::from)
}

/// An AI answer for a changelog section with only its headings, entries, their indented lines and single
/// blank lines: notes around them ("Skipped: …", code fences) never reach CHANGELOG.md.
fn section_lines(answer: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for l in answer.lines().map(str::trim_end) {
        let after_text = out.last().is_some_and(|p| !p.is_empty());
        let keep = l.starts_with('#') || l.starts_with("- ") || l.starts_with("* ") || (after_text && (l.is_empty() || l.starts_with([' ', '\t'])));
        if keep {
            out.push(l);
        }
    }
    out.join("\n").trim().to_string()
}

/// The body of the `## [name]` section, `name` matched ignoring case ("" when there is none).
fn section_body(text: &str, name: &str) -> String {
    let heading = format!("## [{}]", name.to_lowercase());
    let mut lines = text.lines().skip_while(|l| !l.trim().to_lowercase().starts_with(&heading)).skip(1);
    let body: Vec<&str> = lines.by_ref().take_while(|l| !l.trim_start().starts_with("## ")).collect();
    body.join("\n").trim().to_string()
}

/// Tag a hotfix for `version` starts from: the highest earlier patch of its line (v2.4.1 for 2.4.2),
/// else the highest version tag, else the newest tag.
fn hotfix_base(tags: &[TagInfo], version: &str) -> Option<String> {
    let versioned = || tags.iter().filter_map(|t| parse_version(&t.name).map(|v| (v, t)));
    let line = parse_version(version).and_then(|want| versioned().filter(|(v, _)| v[..2] == want[..2] && *v < want).max_by_key(|(v, _)| *v));
    line.or_else(|| versioned().max_by_key(|(v, _)| *v)).map(|(_, t)| t).or(tags.first()).map(|t| t.name.clone())
}

/// Register `release/x.y.z` branches Gitnetix does not know yet, local or only on origin
/// (a shipped release whose local branch is gone). Returns whether any were added.
fn import_release_branches(p: &mut Project, branches: &[BranchInfo], remote: &[BranchInfo], default: &str) -> bool {
    let mut added = false;
    for b in branches.iter().chain(remote) {
        let Some(v) = b.name.strip_prefix("release/") else { continue };
        if p.releases.iter().any(|r| r.version == v || r.branch == b.name) || p.forgotten_releases.iter().any(|f| f == v) {
            continue;
        }
        let hotfix = v.split('.').nth(2).is_some_and(|patch| patch != "0");
        p.releases.push(Release {
            version: v.into(),
            kind: if hotfix { ReleaseKind::Hotfix } else { ReleaseKind::Next },
            branch: b.name.clone(),
            base: default.into(),
            created_at: now(),
            ..Default::default()
        });
        added = true;
    }
    added
}

/// Carry what the project knows about branch `from` over to `to`. An open release's branch
/// takes its new version along, with its branches and planned tickets.
fn renamed(p: &mut Project, from: &str, to: &str) -> Result<()> {
    if let Some(r) = p.releases.iter().find(|r| r.branch == from) {
        if r.shipped_at.is_some() {
            return Err(Error::Invalid(format!("Release {} shipped: its branch keeps its name", r.version)));
        }
        let Some(v) = to.strip_prefix("release/").filter(|v| valid_version(v)) else {
            return Err(Error::Invalid("A release branch is named release/<version>, like release/2.5.0".into()));
        };
        // An open release already on `to` was imported from origin's copy (renamed by someone else): this one takes its place.
        if p.releases.iter().any(|x| x.version == v && x.branch != from && (x.shipped_at.is_some() || x.branch != to)) {
            return Err(Error::Invalid(format!("Release {v} already exists")));
        }
        let old = r.version.clone();
        p.releases.retain(|x| x.branch != to || x.shipped_at.is_some());
        for x in p.releases.iter_mut().filter(|x| x.branch == from) {
            x.version = v.into();
            x.branch = to.into();
        }
        for m in p.branches.values_mut().filter(|m| m.release.as_deref() == Some(old.as_str())) {
            m.release = Some(v.into());
        }
        for r in p.ticket_releases.values_mut().filter(|r| **r == old) {
            *r = v.into();
        }
        // Origin keeps the old branch when renamed here only: it must not come back as a release.
        p.forgotten_releases.retain(|f| f != v);
        if !p.forgotten_releases.contains(&old) {
            p.forgotten_releases.push(old);
        }
    }
    if let Some(m) = p.branches.remove(from) {
        p.branches.insert(to.into(), m);
    }
    // `to` names this branch now, not what it was renamed to before: no loop of renames.
    p.renamed_branches.remove(to);
    p.renamed_branches.insert(from.into(), to.into());
    for m in p.branches.values_mut().filter(|m| m.parent.as_deref() == Some(from)) {
        m.parent = Some(to.into());
    }
    for r in p.releases.iter_mut().filter(|r| r.base == from) {
        r.base = to.into();
    }
    Ok(())
}

/// Long-lived integration branches that sit under the default branch.
const DEV_TRUNKS: &[&str] = &["develop", "dev", "development"];

/// Long-lived environment branches: trunks too, but never merge targets (merged into `qa` is not done).
const ENV_TRUNKS: &[&str] = &["trunk", "prod", "production", "preprod", "pre-prod", "staging", "stage", "qa", "aq", "uat", "int", "integration", "test", "testing"];

/// Long-lived branches that are never work: dev and environment branches, and `main`/`master`
/// when the default branch is something else (gitflow).
fn is_trunk(name: &str) -> bool {
    DEV_TRUNKS.contains(&name) || ENV_TRUNKS.contains(&name) || matches!(name, "main" | "master")
}

/// Which trunk the map starts from when several are as far behind: production first (the one tagged), then pre-production,
/// staging, `main`/`master`, the others.
fn root_rank(name: &str) -> u8 {
    match name {
        "prod" | "production" => 0,
        "preprod" | "pre-prod" => 1,
        "staging" | "stage" => 2,
        "main" | "master" => 3,
        _ => 4,
    }
}

/// The map's root: the least advanced trunk, the one most commits behind the default branch (`prod` left of the `main`
/// it takes releases from), [`root_rank`] breaking ties; the default branch when none is behind it. Dev branches, ahead by
/// design, and trunks given a parent keep their place.
/// shortcut: a default branch named outside the trunk names (`stable`) stays the root, since `plain_view` would make it work
/// once under another branch; give `plain_view` the default branch if such a project needs it.
async fn root_of(p: &Project, git: &Git, refs: &Refs, default: &str) -> String {
    let Some(base) = refs.rev(default).filter(|_| is_trunk(default)) else {
        return default.to_string();
    };
    let mut best = (0, std::cmp::Reverse(root_rank(default)), default.to_string());
    for name in branch_names(p, refs) {
        let given = p.branches.get(&name).is_some_and(|m| m.parent.is_some());
        if name == default || !is_trunk(&name) || DEV_TRUNKS.contains(&name.as_str()) || given {
            continue;
        }
        let Some(rev) = refs.rev(&name) else { continue };
        let Ok((behind, _)) = refs.left_right(git, &base, &rev).await else { continue };
        let key = (behind, std::cmp::Reverse(root_rank(&name)));
        if key > (best.0, best.1) {
            best = (key.0, key.1, name);
        }
    }
    best.2
}

/// Make `ticket` the branch's ticket, planned into the branch's release when it has one.
fn link_ticket(p: &mut Project, branch: &str, ticket: &str) {
    let meta = p.branches.entry(branch.to_string()).or_insert_with(|| BranchMeta { created_at: now(), ..Default::default() });
    meta.ticket = Some(ticket.to_string());
    if let Some(r) = meta.release.clone() {
        p.ticket_releases.insert(ticket.to_string(), r);
    }
}

/// Moves the releases and branch links saved under Trello's old card keys to the keys that replaced
/// them; `moves` holds (old key, new key) per card, in list order. Cards of different boards could
/// share an old key: each of them stays planned and the branch stays on the first, as they showed.
/// Whether anything moved.
fn move_ticket_keys(p: &mut Project, moves: &[(String, String)]) -> bool {
    let mut moved = false;
    for (old, new) in moves {
        if let Some(r) = p.ticket_releases.get(old).cloned() {
            p.ticket_releases.entry(new.clone()).or_insert(r);
            moved = true;
        }
    }
    for (old, _) in moves {
        p.ticket_releases.remove(old);
    }
    for m in p.branches.values_mut() {
        if let Some((_, new)) = moves.iter().find(|(old, _)| m.ticket.as_ref() == Some(old)) {
            m.ticket = Some(new.clone());
            moved = true;
        }
    }
    moved
}

/// A pair of commit counts per branch.
type Counts = HashMap<String, (u32, u32)>;

/// Patch id of each commit only shipped releases hold, to the lowest version holding it (see [`shipped_patches`]).
type ShippedIndex = HashMap<String, ([u64; 3], String)>;

/// Local and origin branches, looked up by name, plus what recent merge commits say.
struct Refs {
    local: Vec<BranchInfo>,
    remote: Vec<BranchInfo>,
    /// Position of each branch in `local` and `remote`, by name.
    local_at: HashMap<String, usize>,
    remote_at: HashMap<String, usize>,
    /// Merge commit subject, keyed by the tip it merged in; read on first use (a long history walk) unless
    /// [`Refs::set_history`] gave it.
    merges: OnceCell<Arc<HashMap<String, String>>>,
    /// Set when most branches get compared: counts then come from one ref scan per base, and merge checks from the
    /// whole commit graph. Off, each branch asks git: cheaper for a few branches in a big repository.
    batch: std::sync::atomic::AtomicBool,
    /// `left_right` of every branch against a base, keyed by base, read on first use.
    counts: std::sync::Mutex<HashMap<String, Arc<OnceCell<Counts>>>>,
    /// (ahead, behind) of local branches against their upstream, read on first use.
    upstream: OnceCell<Counts>,
    /// Patch id of each commit only shipped releases hold (not the default branch), to the
    /// lowest version holding it; read on first use.
    shipped_patches: OnceCell<Arc<ShippedIndex>>,
    /// Pull request squashes ([`Git::pr_squashes`]), read on first use unless [`Refs::set_history`] gave them.
    squashes: OnceCell<Arc<Vec<PrSquash>>>,
    /// Branches holding a commit ([`Git::branches_containing`]), by commit, read on first use.
    containing: std::sync::Mutex<HashMap<String, Arc<OnceCell<Vec<String>>>>>,
    /// Every commit and its parents, read on first use; None when too big or unreadable.
    graph: OnceCell<Option<Graph>>,
    /// [`SquashIndex`] against each base, read on first use while batched.
    squash_indexes: std::sync::Mutex<HashMap<String, Arc<OnceCell<Option<Arc<SquashIndex>>>>>>,
    /// Completed pull requests that took in branch tips, by tip, as the git host said.
    hosted: HashMap<String, Vec<MergedPr>>,
    /// Branch names by tip, local and on origin, read on first use.
    by_tip: std::sync::OnceLock<HashMap<String, Vec<String>>>,
}

impl Refs {
    async fn load(git: &Git, local: Vec<BranchInfo>) -> Refs {
        Refs::new(local, git.remote_branches().await.unwrap_or_default())
    }

    fn new(local: Vec<BranchInfo>, remote: Vec<BranchInfo>) -> Refs {
        let at = |list: &[BranchInfo]| list.iter().enumerate().map(|(i, b)| (b.name.clone(), i)).collect();
        Refs {
            local_at: at(&local),
            remote_at: at(&remote),
            local,
            remote,
            merges: OnceCell::new(),
            batch: Default::default(),
            counts: Default::default(),
            upstream: OnceCell::new(),
            shipped_patches: OnceCell::new(),
            squashes: OnceCell::new(),
            containing: Default::default(),
            graph: OnceCell::new(),
            squash_indexes: Default::default(),
            hosted: HashMap::new(),
            by_tip: Default::default(),
        }
    }

    /// With what the git host said about the tips.
    fn with_hosted(self, hosted: HashMap<String, Vec<MergedPr>>) -> Refs {
        Refs { hosted, ..self }
    }

    /// Every distinct branch tip, local and on origin.
    fn tips(&self) -> Vec<String> {
        let mut tips: Vec<String> = self.local.iter().chain(&self.remote).map(|b| b.sha.clone()).collect();
        tips.sort();
        tips.dedup();
        tips
    }

    /// Answer `left_right` from batched ref scans and merge checks from the commit graph: for views comparing most branches.
    fn set_batch(&self, on: bool) {
        self.batch.store(on, std::sync::atomic::Ordering::Relaxed);
    }

    fn batch(&self) -> bool {
        self.batch.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The history walks' answers, read already (see [`Gitnetix::history`]).
    fn set_history(&self, merges: Arc<HashMap<String, String>>, squashes: Arc<Vec<PrSquash>>) {
        let _ = (self.merges.set(merges), self.squashes.set(squashes));
    }

    /// `git.left_right(base, rev)`, both revisions as [`Refs::rev`] spells them.
    async fn left_right(&self, git: &Git, base: &str, rev: &str) -> Result<(u32, u32)> {
        if self.batch() {
            if let Some(c) = self.counts_against(git, base).await.get().and_then(|all| all.get(rev)) {
                return Ok(*c);
            }
        }
        git.left_right(base, rev).await
    }

    /// Every branch's counts against `base`, scanned on first use.
    async fn counts_against(&self, git: &Git, base: &str) -> Arc<OnceCell<Counts>> {
        let cell = self.counts.lock().unwrap().entry(base.to_string()).or_default().clone();
        cell.get_or_init(|| async {
            if !NO_AHEAD_BEHIND.load(std::sync::atomic::Ordering::Relaxed) {
                match git.left_right_all(base).await {
                    Ok(counts) => return counts,
                    Err(Error::Git { stderr, .. }) if stderr.contains("ahead-behind") => {
                        NO_AHEAD_BEHIND.store(true, std::sync::atomic::Ordering::Relaxed);
                        crate::log::info("This git cannot count every branch in one call (that takes git 2.41): the counts come from the commit graph instead, or a git call per branch past 300,000 commits");
                    }
                    Err(_) => return Counts::default(),
                }
            }
            // Else each branch would ask git on its own: thousands of processes on a big repository.
            match (self.graph(git).await, self.sha(base)) {
                (Some(g), Some(tip)) => g.counts(tip, self.local.iter().map(|b| (b.name.clone(), &b.sha)).chain(self.remote.iter().map(|b| (format!("origin/{}", b.name), &b.sha)))),
                _ => Counts::default(),
            }
        })
        .await;
        cell
    }

    /// Scan several bases at once, ahead of the branches that all wait on them.
    async fn prefetch(&self, git: &Git, bases: &[String]) {
        stream::iter(bases)
            .for_each_concurrent(8, |b| async move {
                self.counts_against(git, b).await;
            })
            .await;
    }

    /// Commit a revision spelled like [`Refs::rev`] points at.
    fn sha(&self, rev: &str) -> Option<&str> {
        match self.local(rev) {
            Some(b) => Some(&b.sha),
            None => self.remote(rev.strip_prefix("origin/")?).map(|b| b.sha.as_str()),
        }
    }

    /// (ahead, behind) of local branch `name` against its upstream; zeros when it has none on a remote.
    async fn upstream_counts(&self, git: &Git, name: &str) -> (u32, u32) {
        if !self.batch() {
            let own = git.upstream_counts(&format!("refs/heads/{name}")).await.unwrap_or_default();
            return own.get(name).copied().unwrap_or((0, 0));
        }
        let all = self.upstream.get_or_init(|| async { git.upstream_counts("refs/heads").await.unwrap_or_default() }).await;
        all.get(name).copied().unwrap_or((0, 0))
    }

    /// Branch a merge commit of `name` says it went into (`Merge branch 'name' into y`);
    /// git leaves out "into" for the default branch. The subject must name this branch:
    /// another branch sitting on the same commit was not the one merged.
    async fn merged_into(&self, git: &Git, name: &str, default: &str) -> Option<String> {
        let sha = &self.local(name).or_else(|| self.remote(name))?.sha;
        let subject = self.merges(git).await.get(sha)?;
        let rest = subject.strip_prefix("Merge branch '").or_else(|| subject.strip_prefix("Merge remote-tracking branch '"))?;
        let (merged, tail) = rest.split_once('\'')?;
        if merged != name && merged.strip_prefix("origin/") != Some(name) {
            return None;
        }
        Some(tail.rsplit_once(" into ").map(|(_, t)| t.trim().to_string()).unwrap_or_else(|| default.to_string()))
    }

    /// Tip of `name` (the local branch, else origin's) and its commit time.
    fn tip(&self, name: &str) -> Option<(&str, Option<i64>)> {
        let b = self.local(name).or_else(|| self.remote(name))?;
        Some((&b.sha, chrono::DateTime::parse_from_rfc3339(&b.date).ok().map(|d| d.timestamp())))
    }

    async fn merges(&self, git: &Git) -> &HashMap<String, String> {
        self.merges.get_or_init(|| async { Arc::new(git.merge_subjects(5000).await.unwrap_or_default()) }).await
    }

    async fn squashes(&self, git: &Git) -> &[PrSquash] {
        self.squashes.get_or_init(|| async { Arc::new(git.pr_squashes(5000).await.unwrap_or_default()) }).await
    }

    /// The merges and pull request squashes seen, for view keys: a new one can move any branch.
    async fn history_digest(&self, git: &Git) -> String {
        let mut seen: Vec<String> = self.merges(git).await.iter().map(|(tip, subject)| format!("{tip} {subject}")).collect();
        seen.sort_unstable();
        let mut squashes: Vec<&str> = self.squashes(git).await.iter().map(|s| s.sha.as_str()).collect();
        squashes.sort_unstable();
        seen.extend(squashes.into_iter().map(String::from));
        seen.join("\n")
    }

    /// Commits pull requests of `name` landed as: the ones the git host says took its tip,
    /// and squashes titled with its name made after its last commit.
    async fn pr_merges(&self, git: &Git, name: &str) -> Vec<String> {
        let Some((sha, time)) = self.tip(name) else { return vec![] };
        let mut out: Vec<String> = self.hosted.get(sha).into_iter().flatten().map(|m| m.merge_commit.clone()).collect();
        if let Some(time) = time {
            out.extend(self.squashes(git).await.iter().filter(|s| s.source() == Some(name) && s.time >= time).map(|s| s.sha.clone()));
        }
        out
    }

    /// Branches the git host says pull requests took `name`'s tip into.
    fn hosted_targets(&self, name: &str) -> Vec<String> {
        self.tip(name).and_then(|(sha, _)| self.hosted.get(sha)).into_iter().flatten().map(|m| m.target.clone()).collect()
    }

    /// Pull request squashes carrying one of `keys` (the branch's ticket) in their title, made
    /// after `name`'s last commit and not already in it: likely where its work went, not proof.
    async fn ticket_squashes(&self, git: &Git, cache: &CommitCache, keys: &[String], name: &str) -> Vec<String> {
        let (Some((sha, Some(time))), false) = (self.tip(name), keys.is_empty()) else { return vec![] };
        let mut out = Vec::new();
        for s in self.squashes(git).await.iter().filter(|s| s.time >= time && ticket_keys(&s.title, false).iter().any(|k| keys.contains(k))) {
            if ancestor(git, cache, &s.sha, sha).await == Some(false) {
                out.push(s.sha.clone());
            }
        }
        out
    }

    /// Whether `base` holds a pull request squash of `name`.
    async fn pr_landed(&self, git: &Git, cache: &CommitCache, name: &str, base: &str) -> bool {
        self.holds_any(git, cache, &self.pr_merges(git, name).await, base).await
    }

    /// Whether `base` holds any of `commits`; each pair answered once while `base` is a branch here.
    async fn holds_any(&self, git: &Git, cache: &CommitCache, commits: &[String], base: &str) -> bool {
        for sha in commits {
            let held = match self.sha(base) {
                Some(tip) => ancestor(git, cache, sha, tip).await,
                None => git.is_ancestor(sha, base).await.ok(),
            };
            if held == Some(true) {
                return true;
            }
        }
        false
    }

    /// The commit graph, read on first use; none unless batched: every commit is a lot to read for a few branches.
    async fn graph(&self, git: &Git) -> Option<&Graph> {
        if !self.batch() {
            return None;
        }
        self.graph.get_or_init(|| Graph::read(git)).await.as_ref()
    }

    /// [`SquashIndex`] against `base` for the branches no saved answer covers: while batched, when at least 16 need
    /// one (fewer cost less with a `squash_check` each).
    async fn squash_index(&self, git: &Git, cache: &CommitCache, base: &str) -> Option<Arc<SquashIndex>> {
        if !self.batch() {
            return None;
        }
        let cell = self.squash_indexes.lock().unwrap().entry(base.to_string()).or_default().clone();
        cell.get_or_init(|| SquashIndex::read(self, git, cache, base, 16)).await.clone()
    }

    /// [`Git::merge_base`] of two revisions, from the graph when they have a single one.
    async fn merge_base(&self, git: &Git, a: &str, b: &str) -> Result<String> {
        let tips = self.sha(a).zip(self.sha(b));
        match self.graph(git).await.zip(tips).and_then(|(g, (a, b))| g.merge_base(a, b)) {
            Some(base) => Ok(base),
            None => git.merge_base(a, b).await,
        }
    }

    /// [`Git::merged_by_commit`], from the graph when it has both commits.
    async fn merged_by_commit(&self, git: &Git, tip: &str, base_tip: &str) -> Result<bool> {
        match self.graph(git).await.and_then(|g| g.merged_by_commit(tip, base_tip)) {
            Some(by_merge) => Ok(by_merge),
            None => git.merged_by_commit(tip, base_tip).await,
        }
    }

    /// [`Git::branches_containing`]: from the graph, else asked once per commit.
    async fn containing(&self, git: &Git, sha: &str) -> Vec<String> {
        if let Some(g) = self.graph(git).await {
            let Some(held) = g.descendants(sha) else { return Vec::new() };
            let holds = |b: &&BranchInfo| g.at.get(&b.sha).is_some_and(|&t| held[t as usize]);
            return self.local.iter().filter(holds).map(|b| b.name.clone()).chain(self.remote.iter().filter(holds).map(|b| format!("origin/{}", b.name))).collect();
        }
        let cell = self.containing.lock().unwrap().entry(sha.to_string()).or_default().clone();
        cell.get_or_init(|| async { git.branches_containing(sha).await.unwrap_or_default() }).await.clone()
    }

    fn local(&self, name: &str) -> Option<&BranchInfo> {
        self.local_at.get(name).map(|&i| &self.local[i])
    }

    /// Branches whose tip is `sha`, local or on origin, each name once.
    fn branches_at(&self, sha: &str) -> &[String] {
        let at = self.by_tip.get_or_init(|| {
            let mut at: HashMap<String, Vec<String>> = HashMap::new();
            for b in self.local.iter().chain(&self.remote) {
                let names = at.entry(b.sha.clone()).or_default();
                if !names.contains(&b.name) {
                    names.push(b.name.clone());
                }
            }
            at
        });
        at.get(sha).map_or(&[], Vec::as_slice)
    }

    fn remote(&self, name: &str) -> Option<&BranchInfo> {
        self.remote_at.get(name).map(|&i| &self.remote[i])
    }

    /// Revision to read the branch from: the local branch, else its origin copy.
    fn rev(&self, name: &str) -> Option<String> {
        if self.local(name).is_some() {
            Some(name.to_string())
        } else {
            self.remote(name).map(|_| format!("origin/{name}"))
        }
    }
}

/// Set once git refused `%(ahead-behind)` (before 2.41): not asked again, the counts come from the graph.
static NO_AHEAD_BEHIND: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Past this many commits the graph is not held: git is asked each question instead.
const GRAPH_MAX: usize = 300_000;

/// Every commit and its parents, read at once (`git rev-list --all --parents`): which branches
/// hold a commit, and merge checks, then take no git process each.
struct Graph {
    at: HashMap<String, u32>,
    sha: Vec<String>,
    /// In order, first parent first; `u32::MAX` for one git did not list (a shallow clone's edge).
    parents: Vec<Vec<u32>>,
    children: Vec<Vec<u32>>,
    /// The commits each one holds (itself included), worked out on first use.
    ancestors: std::sync::Mutex<HashMap<u32, Arc<Vec<bool>>>>,
}

impl Graph {
    async fn read(git: &Git) -> Option<Graph> {
        let out = git.run(&["rev-list", "--all", "--parents"]).await.ok()?;
        let lines: Vec<Vec<&str>> = out.lines().map(|l| l.split(' ').collect()).collect();
        if lines.len() > GRAPH_MAX {
            return None;
        }
        let at: HashMap<String, u32> = lines.iter().enumerate().map(|(i, l)| (l[0].to_string(), i as u32)).collect();
        let mut parents = vec![Vec::new(); lines.len()];
        let mut children = vec![Vec::new(); lines.len()];
        for (i, l) in lines.iter().enumerate() {
            for p in &l[1..] {
                let p = at.get(*p).copied().unwrap_or(u32::MAX);
                parents[i].push(p);
                if p != u32::MAX {
                    children[p as usize].push(i as u32);
                }
            }
        }
        let sha = lines.iter().map(|l| l[0].to_string()).collect();
        Some(Graph { at, sha, parents, children, ancestors: Default::default() })
    }

    /// Commits reachable from `from` through `next`, `from` included.
    fn reach(&self, from: u32, next: &[Vec<u32>]) -> Vec<bool> {
        let mut seen = vec![false; next.len()];
        let mut todo = vec![from];
        while let Some(c) = todo.pop() {
            if !std::mem::replace(&mut seen[c as usize], true) {
                todo.extend(next[c as usize].iter().filter(|&&n| n != u32::MAX));
            }
        }
        seen
    }

    fn ancestors(&self, of: u32) -> Arc<Vec<bool>> {
        if let Some(held) = self.ancestors.lock().unwrap().get(&of) {
            return held.clone();
        }
        let held = Arc::new(self.reach(of, &self.parents));
        self.ancestors.lock().unwrap().insert(of, held.clone());
        held
    }

    /// Commits `tip` holds that `base` does not, nearest first, at most `max`; None when the graph lacks either.
    fn own_commits(&self, tip: &str, base: &str, max: usize) -> Option<Vec<String>> {
        let (t, b) = (*self.at.get(tip)?, *self.at.get(base)?);
        let held = self.ancestors(b);
        let (mut seen, mut todo, mut out) = (std::collections::HashSet::new(), std::collections::VecDeque::from([t]), Vec::new());
        while let Some(c) = todo.pop_front() {
            if out.len() >= max {
                break;
            }
            if held[c as usize] || !seen.insert(c) {
                continue;
            }
            out.push(self.sha[c as usize].clone());
            todo.extend(self.parents[c as usize].iter().filter(|&&p| p != u32::MAX));
        }
        Some(out)
    }

    /// Commits holding `sha` (itself included); None when the graph lacks it.
    fn descendants(&self, sha: &str) -> Option<Vec<bool>> {
        Some(self.reach(*self.at.get(sha)?, &self.children))
    }

    /// Whether commit `a` is `b` or in its history; None when the graph lacks either.
    fn holds(&self, b: &str, a: &str) -> Option<bool> {
        let (a, b) = (*self.at.get(a)?, *self.at.get(b)?);
        Some(self.ancestors(b)[a as usize])
    }

    /// [`Git::merge_base`] when `a` and `b` have a single best common ancestor; None otherwise.
    fn merge_base(&self, a: &str, b: &str) -> Option<String> {
        let (a, b) = (*self.at.get(a)?, *self.at.get(b)?);
        let held = self.ancestors(a);
        // Down from `b`, the first commits `a` holds on each path: the best common ones are among them.
        let (mut seen, mut todo, mut found) = (vec![false; self.parents.len()], vec![b], Vec::new());
        while let Some(c) = todo.pop() {
            if std::mem::replace(&mut seen[c as usize], true) {
                continue;
            }
            if held[c as usize] {
                found.push(c);
            } else {
                todo.extend(self.parents[c as usize].iter().filter(|&&p| p != u32::MAX));
            }
        }
        // One found through a path can still be in another's history.
        let best: Vec<u32> = found.iter().copied().filter(|&c| !found.iter().any(|&d| d != c && self.ancestors(d)[c as usize])).collect();
        (best.len() == 1).then(|| self.sha[best[0] as usize].clone())
    }

    /// (behind, ahead) of each named tip against commit `base`, as [`Git::left_right_all`] gives them: the commits
    /// only `base` holds, and those only the tip holds. Tips the graph lacks are left out.
    fn counts<'a>(&self, base: &str, tips: impl Iterator<Item = (String, &'a String)>) -> Counts {
        let Some(&b) = self.at.get(base) else { return Counts::default() };
        let held = self.ancestors(b);
        let in_base = held.iter().filter(|h| **h).count();
        tips.filter_map(|(name, sha)| {
            let mine = self.reach(*self.at.get(sha)?, &self.parents);
            let (mut shared, mut ahead) = (0, 0);
            for (m, h) in mine.iter().zip(held.iter()) {
                match (m, h) {
                    (true, true) => shared += 1,
                    (true, false) => ahead += 1,
                    _ => {}
                }
            }
            Some((name, ((in_base - shared) as u32, ahead)))
        })
        .collect()
    }

    /// [`Git::merged_by_commit`]: a merge commit in `base_tip` has `tip` as a merged-in parent.
    fn merged_by_commit(&self, tip: &str, base_tip: &str) -> Option<bool> {
        let (t, b) = (*self.at.get(tip)?, *self.at.get(base_tip)?);
        let held = self.ancestors(b);
        Some(self.children[t as usize].iter().any(|&m| held[m as usize] && self.parents[m as usize].iter().skip(1).any(|&p| p == t)))
    }
}

/// [`Git::squash_check`]'s answer for one branch, from a [`SquashIndex`].
enum Squash {
    /// Squashed (or rebased) in or not, and the commit its squash was looked for from.
    Known(bool, Option<String>),
    /// Its oldest commits are in the base already: the squash of the rest, from this commit, is checked on demand.
    Partial(String),
}

/// What [`Git::squash_check`] compares, for many branches against one base at once: patch ids of the base's commits
/// past the oldest fork, and of each branch's own commits and whole change, in three git calls. `squash_check` walks
/// the base past each branch's fork on its own: branches times history.
struct SquashIndex {
    /// Base commits past the oldest fork covered, by patch id.
    base: HashMap<String, Vec<String>>,
    /// By branch tip.
    verdicts: HashMap<String, Squash>,
    /// Patch ids of a tip's own commits and of its whole change since its fork ([`patches_since`]), for the tips left
    /// unsquashed with their fork.
    patches: HashMap<String, (Vec<String>, Option<String>)>,
}

impl SquashIndex {
    /// The index of the branches ahead of and behind `base` (spelled like [`Refs::rev`]) that no saved answer covers;
    /// none when fewer than `min` are, or without the commit graph.
    async fn read(refs: &Refs, git: &Git, cache: &CommitCache, base: &str, min: usize) -> Option<Arc<SquashIndex>> {
        let g = refs.graph(git).await?;
        let base_tip = refs.sha(base)?.to_string();
        let b = *g.at.get(&base_tip)?;
        let in_base = g.ancestors(b);
        let counts = refs.counts_against(git, base).await;
        let saved = |rev: &str, tip: &str| cache.get::<bool>("squash2", tip, &base_tip).is_some() || cache.get::<serde_json::Value>("unsquashed", tip, &format!("{rev} {base}")).is_some();
        let mut tips: Vec<&str> = counts
            .get()?
            .iter()
            .filter(|(_, &(behind, ahead))| behind > 0 && ahead > 0)
            .filter_map(|(rev, _)| refs.sha(rev).filter(|tip| !saved(rev, tip)))
            .collect();
        tips.sort_unstable();
        tips.dedup();
        if tips.is_empty() || tips.len() < min {
            return None;
        }
        // Each tip's fork, and its own commits (not in the base, merges left out) oldest first, like `rev-list --reverse`.
        let mut found: Vec<(&str, u32, Vec<u32>)> = Vec::new();
        for tip in tips {
            let (Some(&t), Some(fork)) = (g.at.get(tip), g.merge_base(&base_tip, tip)) else { continue };
            let Some(&fork) = g.at.get(&fork) else { continue };
            let (mut own, mut seen, mut todo) = (Vec::new(), std::collections::HashSet::new(), vec![t]);
            while let Some(c) = todo.pop() {
                if in_base[c as usize] || !seen.insert(c) {
                    continue;
                }
                if g.parents[c as usize].len() <= 1 {
                    own.push(c);
                }
                todo.extend(g.parents[c as usize].iter().filter(|&&p| p != u32::MAX));
            }
            // The graph lists newest first.
            own.sort_unstable_by(|a, b| b.cmp(a));
            found.push((tip, fork, own));
        }
        // The base's commits past the oldest fork: past every other fork too, for those it holds (the rest are left out).
        let oldest = found.iter().map(|f| f.1).max()?;
        let after = g.reach(oldest, &g.children);
        found.retain(|f| after[f.1 as usize]);
        let before = g.ancestors(oldest);
        let (mut base_list, mut seen, mut todo) = (Vec::new(), std::collections::HashSet::new(), vec![b]);
        while let Some(c) = todo.pop() {
            if before[c as usize] || !seen.insert(c) {
                continue;
            }
            if g.parents[c as usize].len() <= 1 {
                base_list.push(g.sha[c as usize].clone());
            }
            todo.extend(g.parents[c as usize].iter().filter(|&&p| p != u32::MAX));
        }
        let own_list: Vec<String> = found.iter().flat_map(|f| f.2.iter().map(|&c| g.sha[c as usize].clone())).collect::<std::collections::HashSet<_>>().into_iter().collect();
        let whole_list: Vec<String> = found.iter().map(|f| format!("{} {}", f.0, g.sha[f.1 as usize])).collect();
        let (base_ids, own_ids, whole_ids) = tokio::join!(git.patch_ids_stdin(&base_list), git.patch_ids_stdin(&own_list), git.patch_ids_stdin(&whole_list));
        let mut by_id: HashMap<String, Vec<String>> = HashMap::new();
        for (id, c) in base_ids.ok()? {
            by_id.entry(id).or_default().push(c);
        }
        let own_id: HashMap<String, String> = own_ids.ok()?.into_iter().map(|(id, c)| (c, id)).collect();
        let whole: HashMap<String, String> = whole_ids.ok()?.into_iter().map(|(id, tip)| (tip, id)).collect();
        let (mut verdicts, mut patches) = (HashMap::new(), HashMap::new());
        for (tip, fork, own) in found {
            // A base commit with the patch, past the fork: the only ones `rev-list --cherry` compares with.
            let mut forked: Option<Vec<bool>> = None;
            let mut held = |id: &str| -> bool {
                let Some(commits) = by_id.get(id) else { return false };
                let mine = forked.get_or_insert_with(|| g.reach(fork, &g.parents));
                commits.iter().any(|c| g.at.get(c).is_some_and(|&c| !mine[c as usize]))
            };
            let ids: Vec<Option<&String>> = own.iter().map(|&c| own_id.get(&g.sha[c as usize])).collect();
            let marks: Vec<bool> = ids.iter().map(|id| id.is_some_and(|id| held(id))).collect();
            let upstream = marks.iter().take_while(|m| **m).count();
            let verdict = if !marks.is_empty() && upstream == marks.len() {
                Squash::Known(true, None)
            } else if upstream > 0 && marks[upstream..].iter().all(|m| !m) {
                Squash::Partial(g.sha[own[upstream - 1] as usize].clone())
            } else {
                let squashed = whole.get(tip).is_some_and(|id| held(id));
                if !squashed {
                    patches.insert(tip.to_string(), (ids.iter().flatten().map(|id| id.to_string()).collect(), whole.get(tip).cloned()));
                }
                Squash::Known(squashed, Some(g.sha[fork as usize].clone()))
            };
            verdicts.insert(tip.to_string(), verdict);
        }
        Some(Arc::new(SquashIndex { base: by_id, verdicts, patches }))
    }

    /// [`Git::squash_check`]'s answer for the branch at `tip`; None when the index leaves it out.
    async fn verdict(&self, git: &Git, cache: &CommitCache, tip: &str) -> Option<(bool, Option<String>)> {
        match self.verdicts.get(tip)? {
            Squash::Known(squashed, from) => Some((*squashed, from.clone())),
            Squash::Partial(parent) => {
                // The squash of the rest, from the last commit already in the base, past the fork too.
                let id = git.diff_patch_id(parent, tip).await.ok()?;
                let mut squashed = false;
                for c in id.and_then(|id| self.base.get(&id)).into_iter().flatten() {
                    if ancestor(git, cache, c, tip).await == Some(false) {
                        squashed = true;
                        break;
                    }
                }
                Some((squashed, Some(parent.clone())))
            }
        }
    }
}

/// Whether branch `rev` landed in `base`, given its (behind, ahead) counts against it.
async fn landed(git: &Git, refs: &Refs, cache: &CommitCache, rev: &str, base: &str, counts: (u32, u32), origin_only: bool) -> bool {
    let Some((tip, base_tip)) = refs.sha(rev).zip(refs.sha(base)) else { return proved_landed(git, refs, cache, rev, base, counts, origin_only).await };
    // Landed stays landed while the base only moves on: proven at an older tip of it is enough.
    // Per branch name too: a branch just made at the same commit has landed nothing.
    let pair = format!("{rev} {base}");
    if let Some(at) = cache.get::<String>("landed", tip, &pair) {
        if at == base_tip || ancestor(git, cache, &at, base_tip).await == Some(true) {
            return true;
        }
    }
    let landed = proved_landed(git, refs, cache, rev, base, counts, origin_only).await;
    if landed {
        cache.insert("landed", tip, &pair, base_tip);
    }
    landed
}

/// [`landed`], worked out from the branch and its base as they are now.
async fn proved_landed(git: &Git, refs: &Refs, cache: &CommitCache, rev: &str, base: &str, (behind, ahead): (u32, u32), origin_only: bool) -> bool {
    let shas = refs.sha(rev).zip(refs.sha(base));
    if ahead == 0 {
        let merged = match shas {
            Some((tip, base_tip)) => merged_in(git, refs, cache, rev, tip, base_tip).await,
            None => git.is_merged_into(rev, base).await.unwrap_or(false),
        };
        // Origin-only branches have no creation reflog: fully contained and left behind counts.
        merged || (origin_only && behind > 0)
    } else if behind > 0 {
        // Squashed or rebased in: the base gained commits carrying the branch's changes.
        // Slow (patch ids), and fixed for a pair of commits: answered once per pair.
        let pair = format!("{rev} {base}");
        if let Some((t, b)) = shas {
            if let Some(hit) = cache.get("squash2", t, b) {
                return hit;
            }
            if let Some((at, was_ahead, from)) = cache.get::<(String, u32, String)>("unsquashed", t, &pair) {
                if was_ahead == ahead && still_unsquashed(git, cache, t, &at, b, &from).await {
                    return false;
                }
            }
        }
        // Many branches at once: from one index of patch ids (see `SquashIndex`). Else, and for one it leaves out, git's own check.
        let index = match shas {
            Some(_) => refs.squash_index(git, cache, base).await,
            None => None,
        };
        let known = match (&index, shas) {
            (Some(index), Some((t, _))) => index.verdict(git, cache, t).await,
            _ => None,
        };
        let (squashed, from) = match known {
            Some(answer) => answer,
            None => {
                // The fork from the commit graph when it has it: one git call fewer per branch.
                let fork = refs.merge_base(git, base, rev).await.ok();
                let Ok(answer) = git.squash_check(rev, base, fork.as_deref()).await else { return false };
                answer
            }
        };
        if let Some((t, b)) = shas {
            cache.insert("squash2", t, b, squashed);
            if let (false, Some(from)) = (squashed, from) {
                // What `still_unsquashed` reads the next time the base moves, when the index read it already.
                if let Some(patches) = index.as_ref().and_then(|i| i.patches.get(t)) {
                    cache.insert("patch-ids", t, &from, patches);
                }
                cache.insert("unsquashed", t, &pair, (b, ahead, from));
            }
        }
        squashed
    } else {
        false
    }
}

/// [`Git::is_merged_into`] for known tips, `tip` already in `base_tip` (its counts say so),
/// answering the part fixed for the pair of commits once.
async fn merged_in(git: &Git, refs: &Refs, cache: &CommitCache, rev: &str, tip: &str, base_tip: &str) -> bool {
    if tip == base_tip {
        return false;
    }
    let by_merge = match cache.get("merge-commit", tip, base_tip) {
        Some(m) => m,
        None => match refs.merged_by_commit(git, tip, base_tip).await {
            Ok(m) => {
                cache.insert("merge-commit", tip, base_tip, m);
                m
            }
            Err(_) => return false,
        },
    };
    by_merge || moved_since_created(git, cache, rev, tip).await
}

/// Whether commit `a` is in commit `b`'s history, answered once for the pair; None when git can't tell.
async fn ancestor(git: &Git, cache: &CommitCache, a: &str, b: &str) -> Option<bool> {
    if let Some(known) = cache.get("ancestor", a, b) {
        return Some(known);
    }
    let known = git.ancestry(a, b).await.ok().flatten()?;
    cache.insert("ancestor", a, b, known);
    Some(known)
}

/// Not squashed into the base at its older tip `at` (its squash looked for from `from`), its commits
/// unchanged, and nothing the base gained since carries the patch of one of them past `from` nor of
/// the whole squash: `git cherry` would answer the same, so not squashed in now either. Only the
/// patches the base gained get read.
async fn still_unsquashed(git: &Git, cache: &CommitCache, tip: &str, at: &str, base_tip: &str, from: &str) -> bool {
    if ancestor(git, cache, at, base_tip).await != Some(true) {
        return false;
    }
    let added: Vec<String> = match cache.get("patch-ids-added", base_tip, at) {
        Some(ids) => ids,
        None => {
            let not_at = format!("^{at}");
            let Ok(list) = git.patch_ids(&[base_tip, &not_at]).await else { return false };
            let ids: Vec<String> = list.into_iter().map(|(id, _)| id).collect();
            cache.insert("patch-ids-added", base_tip, at, &ids);
            ids
        }
    };
    let Some((each, Some(whole))) = patches_since(git, cache, tip, from).await else { return false };
    !added.iter().any(|id| *id == whole || each.contains(id))
}

/// Patch ids of what `tip` adds to `fork`: each commit's, and the whole change's (None: no change).
/// Fixed for the pair: read once, not again each time a base moves on. None when git failed.
async fn patches_since(git: &Git, cache: &CommitCache, tip: &str, fork: &str) -> Option<(Vec<String>, Option<String>)> {
    if let Some(ids) = cache.get("patch-ids", tip, fork) {
        return Some(ids);
    }
    let not_fork = format!("^{fork}");
    let revs = [tip, not_fork.as_str()];
    let (each, whole) = tokio::join!(git.patch_ids(&revs), git.diff_patch_id(fork, tip));
    let ids = (each.ok()?.into_iter().map(|(id, _)| id).collect::<Vec<_>>(), whole.ok()?);
    cache.insert("patch-ids", tip, fork, &ids);
    Some(ids)
}

/// [`Git::moved_since_created`], answered once per tip: the reflog's first entry stays put.
async fn moved_since_created(git: &Git, cache: &CommitCache, rev: &str, tip: &str) -> bool {
    if let Some(moved) = cache.get("moved", tip, rev) {
        return moved;
    }
    match git.moved_since_created(rev, tip).await {
        Ok(moved) => {
            cache.insert("moved", tip, rev, moved);
            moved
        }
        Err(_) => false,
    }
}

/// The parent of `name` that needs no history: the default branch has none; release
/// branches, trunks and branches given a release or parent say where they go.
/// None when only history can tell (see `Gitnetix::parent_of`).
fn declared_parent(p: &Project, refs: &Refs, default: &str, name: &str) -> Option<Option<String>> {
    if name == default {
        return Some(None);
    }
    let exists = |x: &&String| *x != name && refs.rev(x).is_some();
    // Given a parent before Gitnetix knew it as a release (see `set_parent`).
    let given = p.branches.get(name).and_then(|m| m.parent.as_ref()).filter(exists);
    // Release branches, open or shipped, sit under the branch they were cut from (or were given).
    if let Some(r) = p.releases.iter().find(|r| r.branch == name) {
        return Some(Some(given.or(Some(&r.base).filter(exists)).cloned().unwrap_or_else(|| default.to_string())));
    }
    // Trunks sit under the default branch, unless given another parent.
    if name.starts_with("release/") || is_trunk(name) {
        return Some(Some(given.cloned().unwrap_or_else(|| default.to_string())));
    }
    let m = p.branches.get(name)?;
    // Its release, as long as the release branch is still around.
    if let Some(r) = m.release.as_ref().and_then(|v| p.releases.iter().find(|r| &r.version == v)) {
        if refs.rev(&r.branch).is_some() {
            return Some(Some(r.branch.clone()));
        }
    }
    given.map(|x| Some(x.clone()))
}

/// Forget deleted `branches` in `p`; true when it held any of them. An open release whose branch is gone everywhere goes
/// with it; its branches find a new base.
fn forget_branches(p: &mut Project, branches: &[String], on_origin: &HashSet<String>) -> bool {
    let mut changed = false;
    for branch in branches {
        changed |= p.branches.remove(branch).is_some();
        let gone = !on_origin.contains(branch);
        let Some(version) = p.releases.iter().find(|r| &r.branch == branch && r.shipped_at.is_none() && gone).map(|r| r.version.clone()) else {
            continue;
        };
        changed = true;
        p.releases.retain(|r| !(r.version == version && r.shipped_at.is_none()));
        if !p.forgotten_releases.contains(&version) {
            p.forgotten_releases.push(version.clone());
        }
        for m in p.branches.values_mut().filter(|m| m.release.as_deref() == Some(version.as_str())) {
            m.release = None;
        }
    }
    changed
}

/// Every branch once: local and origin-only, and open releases whose branch is not made yet. A branch git no longer
/// has shows nowhere, even while its settings stay (deleted from a terminal, or on origin from another computer).
/// An origin branch a local one tracks under another name is that local branch.
fn branch_names(p: &Project, refs: &Refs) -> Vec<String> {
    let tracked: Vec<&str> = refs.local.iter().filter_map(|b| b.upstream.as_deref()?.strip_prefix("origin/")).collect();
    let remote_only = refs.remote.iter().filter(|b| !tracked.contains(&b.name.as_str()));
    let mut names: Vec<String> = refs.local.iter().chain(remote_only).map(|b| b.name.clone()).collect();
    names.extend(p.releases.iter().filter(|r| r.shipped_at.is_none()).map(|r| r.branch.clone()));
    names.sort();
    names.dedup();
    names
}

/// Where origin renamed local `name` to, by the look of it: its upstream is gone, and exactly one
/// branch on origin that no local branch has or tracks sits at its tip.
fn renamed_to(refs: &Refs, name: &str) -> Option<String> {
    let info = refs.local(name)?;
    let up = info.upstream.as_deref()?.strip_prefix("origin/")?;
    if refs.remote(up).is_some() {
        return None;
    }
    let taken = |n: &str| refs.local(n).is_some() || refs.local.iter().any(|l| l.upstream.as_deref().and_then(|u| u.strip_prefix("origin/")) == Some(n));
    let mut at_tip = refs.remote.iter().filter(|r| r.sha == info.sha && !taken(&r.name));
    let first = at_tip.next()?;
    at_tip.next().is_none().then(|| first.name.clone())
}

/// What a branch view says without looking at history: no counts, not merged,
/// no checkout (see `Gitnetix::decorate`).
fn plain_view(p: &Project, refs: &Refs, name: &str, parent: Option<String>) -> BranchView {
    let info = refs.local(name);
    let tip = info.or_else(|| refs.remote(name));
    let own_release = p.releases.iter().find(|r| r.branch == name);
    let role = if own_release.is_some_and(|r| r.shipped_at.is_none()) {
        "release"
    } else if parent.is_none() || is_trunk(name) {
        "trunk"
    } else {
        "branch"
    };
    let meta = p.branches.get(name);
    let open_release = |v: &str| p.releases.iter().any(|r| r.version == v && r.shipped_at.is_none());
    let kind = match meta.map(|m| m.kind.as_str()).filter(|k| !k.is_empty()) {
        Some(k) => k.to_string(),
        None if role == "branch" => kind_of_branch(name).unwrap_or("").to_string(),
        None => String::new(),
    };
    BranchView {
        short: name.split_once('/').map(|(_, b)| b.to_string()).unwrap_or_else(|| name.to_string()),
        name: name.to_string(),
        kind,
        worktree: None,
        checked_out: false,
        running: false,
        waiting: false,
        conflict: false,
        in_progress: None,
        wip: 0,
        stashes: 0,
        ahead: 0,
        behind: 0,
        unreleased: 0,
        last_tag: None,
        folded: 0,
        upstream: info.and_then(|b| b.upstream.clone()),
        upstream_ahead: 0,
        upstream_behind: 0,
        rewritten: false,
        upstream_rewritten: false,
        likely_merged: false,
        // Branches not made from a ticket here still carry its key in their name (`feat/ATL-212_login`).
        ticket: meta.and_then(|m| m.ticket.clone()).or_else(|| ticket_keys(name, true).into_iter().next()),
        exists: refs.rev(name).is_some(),
        merged: false,
        parent,
        role: role.into(),
        release: own_release.filter(|r| r.shipped_at.is_none()).map(|r| r.version.clone()).or_else(|| meta.and_then(|m| m.release.clone()).filter(|v| open_release(v))),
        shipped: own_release.filter(|r| r.shipped_at.is_some()).map(|r| r.version.clone()),
        fork: None,
        local: info.is_some(),
        remote: refs.remote(name).is_some(),
        protected: false,
        renamed_to: None,
        date: tip.map(|b| b.date.clone()).unwrap_or_default(),
        author: tip.map(|b| b.author.clone()).unwrap_or_default(),
        email: tip.map(|b| b.email.clone()).unwrap_or_default(),
    }
}

/// Bump when branch views are built differently, so saved ones are not reused.
const VIEW_CACHE_VERSION: &str = "21";

/// Most commits of its own a branch is looked through for the branch it was built on (see [`Gitnetix::built_on`]).
const OWN_MAX: usize = 1000;

/// Commits counted past the start of a history with no tag behind it: the default branch's unreleased ones, a
/// first release's.
const UNRELEASED_MAX: u32 = 1000;

/// The latest tag behind `rev` and how many commits `rev` has past it. With no tag behind it: no tag, and all
/// the commits `rev` holds, up to [`UNRELEASED_MAX`] (0 when `rev` is missing).
/// Where `rev` left `base`, when a tag in `base`'s history holds that commit: the lowest version of them, the release that
/// shipped it. None once the branch sits past the latest tag (rebased or reset back onto its base).
async fn shipped_fork(git: &Git, rev: &str, base: &str) -> Option<ShippedFork> {
    let sha = git.merge_base(rev, base).await.ok()?;
    let (ok, out, _) = git.try_run(&["tag", "--contains", &sha, "--merged", base, "--sort=v:refname"]).await.ok()?;
    let tag = out.lines().next().filter(|_| ok)?.trim().to_string();
    Some(ShippedFork { tag, sha })
}

async fn since_last_tag(git: &Git, rev: &str) -> (Option<String>, u32) {
    match git.last_tag(rev).await {
        Ok(Some((tag, n))) => (Some(tag), n),
        _ => {
            let max = format!("--max-count={UNRELEASED_MAX}");
            // Quietly: a first commit's parent is missing, and that is no error.
            let n = match git.try_run(&["rev-list", "--count", &max, rev]).await {
                Ok((true, out, _)) => out.trim().parse().unwrap_or(0),
                _ => 0,
            };
            (None, n)
        }
    }
}

/// What a project's branch views are built from: its refs, its default branch,
/// what Gitnetix knows about its releases and branches, and what the git host said.
fn view_key(p: &Project, default: &str, fingerprint: &str, hosted: &str) -> u64 {
    let releases = serde_json::to_string(&p.releases).unwrap_or_default();
    // Only the settings views read: a branch's worktree, description or creation date moves none of them.
    let read: Vec<_> = p.branches.iter().map(|(name, m)| (name, &m.kind, &m.release, &m.parent, &m.ticket, m.from_shipped)).collect();
    let branches = serde_json::to_string(&read).unwrap_or_default();
    key_of(&[VIEW_CACHE_VERSION, env!("CARGO_PKG_VERSION"), default, fingerprint, &releases, &branches, hosted])
}

/// A project's merge subjects and pull request squashes, as walked at refs `fingerprint` (see [`Gitnetix::history`]).
struct History {
    fingerprint: String,
    merges: Arc<HashMap<String, String>>,
    squashes: Arc<Vec<PrSquash>>,
}

/// Whether the refs moved from fingerprint `before` to `after` only forward (none deleted or rewritten), and every
/// commit they brought is plain: no merge commit, no pull request squash. The history walks then answer as they did
/// at `before`. False when unsure.
async fn same_history(git: &Git, before: &str, after: &str) -> bool {
    let tips = |f: &str| -> HashMap<String, String> {
        f.lines()
            .filter_map(|l| {
                let mut w = l.split(' ');
                Some((w.next()?.to_string(), w.next()?.to_string()))
            })
            .collect()
    };
    let (old, new) = (tips(before), tips(after));
    if old.keys().any(|r| !new.contains_key(r)) {
        return false;
    }
    let moved: Vec<&String> = new.iter().filter(|(r, sha)| old.get(*r) != Some(*sha)).map(|(_, sha)| sha).collect();
    // shortcut: up to 16 moved refs are checked one by one; a fetch moving more walks the history again.
    if moved.len() > 16 {
        return false;
    }
    for (r, sha) in new.iter().filter(|(r, sha)| old.get(*r).is_some_and(|was| was != *sha)) {
        if git.ancestry(&old[r], sha).await.ok().flatten() != Some(true) {
            return false;
        }
    }
    if moved.is_empty() {
        return true;
    }
    // The commits no ref held before.
    let mut input: String = moved.iter().map(|sha| format!("{sha}\n")).collect();
    for sha in old.values().collect::<std::collections::HashSet<_>>() {
        input.push_str(&format!("^{sha}\n"));
    }
    let Ok(out) = git.run_stdin(&["log", "--stdin", "--format=%P%x1f%s"], input).await else { return false };
    out.lines().all(|l| l.split_once('\x1f').is_some_and(|(parents, subject)| !parents.contains(' ') && !crate::git::is_pr_squash(subject)))
}

/// Branch views as last built, with what they were built from, so a build after a commit or
/// a push redoes only the branches it moved (see [`unmoved_views`]).
#[derive(Serialize, Deserialize)]
struct BuiltViews {
    /// [`Git::ref_fingerprint`] they were built at.
    refs: String,
    /// [`view_key`] of the rest they hang on, with [`Refs::history_digest`] in place of the refs.
    shared: u64,
    views: Vec<BranchView>,
}

/// The views in `built` still right at refs `now`: branches whose refs did not move, nor their
/// parent's. None of them when a ref every branch is weighed against moved (a trunk, a release, a
/// tag): what moved, then.
fn unmoved_views(p: &Project, default: &str, built: &BuiltViews, now: &str) -> std::result::Result<HashMap<String, BranchView>, String> {
    let lines = |s: &str| s.lines().map(str::to_string).collect::<std::collections::HashSet<String>>();
    let (before, after) = (lines(&built.refs), lines(now));
    fn branch(r: &str) -> Option<&str> {
        r.strip_prefix("refs/heads/").or_else(|| r.strip_prefix("refs/remotes/origin/"))
    }
    let mut moved = std::collections::HashSet::new();
    for line in before.symmetric_difference(&after) {
        let r = line.split(' ').next().unwrap_or_default();
        match branch(r) {
            Some(name) => moved.insert(name.to_string()),
            None => return Err(format!("{} changed", r.strip_prefix("refs/").unwrap_or(r))),
        };
    }
    // A local branch tracking another name (`fix-login` on origin/feature/login) moves with it: its counts against its
    // upstream, and whether that was force pushed, come from there.
    let tracking: Vec<String> = after
        .iter()
        .filter_map(|l| {
            let mut w = l.split(' ');
            let (name, upstream) = (w.next()?.strip_prefix("refs/heads/")?, branch(w.nth(1)?)?);
            (moved.contains(upstream) && name != upstream).then(|| name.to_string())
        })
        .collect();
    moved.extend(tracking);
    let here: std::collections::HashSet<&str> = after.iter().filter_map(|l| branch(l.split(' ').next()?)).collect();
    // A shipped release branch deleted everywhere (the Shipped cleanup) only moves the branches filed under it.
    // shortcut: a branch it held only partly may now match a later unmerged release's patches; rebuilt on the next shared move.
    let kept = p.releases.iter().filter(|r| r.shipped_at.is_none() || here.contains(r.branch.as_str()));
    let mut shared = DEV_TRUNKS.iter().map(|t| t.to_string()).chain([default.to_string()]).chain(kept.map(|r| r.branch.clone()));
    if let Some(b) = shared.find(|b| moved.contains(b)) {
        return Err(format!("{b} moved"));
    }
    Ok(built
        .views
        .iter()
        .filter(|v| !moved.contains(&v.name) && v.parent.as_ref().is_none_or(|b| !moved.contains(b)))
        .map(|v| (v.name.clone(), v.clone()))
        .collect())
}

/// A project listed in [`Gitnetix::cleaning`] while alive, even if the cleanup is dropped halfway.
struct Cleaning<'a>(&'a std::sync::Mutex<Vec<String>>, String);

impl<'a> Cleaning<'a> {
    fn enter(all: &'a std::sync::Mutex<Vec<String>>, project_id: &str) -> Cleaning<'a> {
        all.lock().unwrap().push(project_id.to_string());
        Cleaning(all, project_id.to_string())
    }
}

impl Drop for Cleaning<'_> {
    fn drop(&mut self) {
        let mut all = self.0.lock().unwrap();
        if let Some(i) = all.iter().position(|p| *p == self.1) {
            all.swap_remove(i);
        }
    }
}

/// Mark open releases whose version is tagged as shipped: they went out without
/// Gitnetix (or before it knew them). Returns whether any were.
fn ship_tagged_releases(p: &mut Project, tags: &[TagInfo]) -> bool {
    let mut shipped = false;
    for r in p.releases.iter_mut().filter(|r| r.shipped_at.is_none()) {
        if let Some(t) = tags.iter().find(|t| t.name.strip_prefix('v').unwrap_or(&t.name) == r.version) {
            r.shipped_at = Some(t.date.clone());
            r.tag = Some(t.name.clone());
            shipped = true;
        } else if let Some(t) = later_patch(tags, &r.version) {
            // Never tagged itself, but its line moved on (8.17.1 for 8.17.0): it went out with that one.
            r.shipped_at = Some(t.date.clone());
            shipped = true;
        }
    }
    shipped
}

/// Shipped releases with neither their own tag nor a later patch of their line: their tag
/// was deleted, so they may not have gone out after all. The caller checks the branch.
fn untagged_shipped(p: &Project, tags: &[TagInfo]) -> Vec<(String, String)> {
    let open = |v: &str| p.releases.iter().any(|r| r.version == v && r.shipped_at.is_none());
    p.releases
        .iter()
        .filter(|r| r.shipped_at.is_some() && !open(&r.version))
        .filter(|r| !tags.iter().any(|t| t.name.strip_prefix('v').unwrap_or(&t.name) == r.version) && later_patch(tags, &r.version).is_none())
        .map(|r| (r.version.clone(), r.branch.clone()))
        .collect()
}

/// Reopen shipped releases listed in `versions`. Returns whether any were.
fn reopen_releases(p: &mut Project, versions: &[String]) -> bool {
    let mut reopened = false;
    for r in p.releases.iter_mut().filter(|r| r.shipped_at.is_some() && versions.contains(&r.version)) {
        r.shipped_at = None;
        r.tag = None;
        reopened = true;
    }
    reopened
}

/// The first tagged patch after `version` in its line: 8.17.1 (or 8.17.2) for 8.17.0.
fn later_patch<'a>(tags: &'a [TagInfo], version: &str) -> Option<&'a TagInfo> {
    let want = parse_version(version)?;
    tags.iter().filter_map(|t| parse_version(&t.name).map(|v| (v, t))).filter(|(v, _)| v[..2] == want[..2] && v[2] > want[2]).min_by_key(|(v, _)| *v).map(|(_, t)| t)
}

/// Branches work can merge into, most specific first: open releases, dev branches, the default branch.
/// Shipped release branches still around, with their version, lowest first.
fn shipped_branches(p: &Project, refs: &Refs) -> Vec<([u64; 3], String)> {
    let mut v: Vec<([u64; 3], String)> = p
        .releases
        .iter()
        .filter(|r| r.shipped_at.is_some() && refs.rev(&r.branch).is_some())
        .filter_map(|r| Some((parse_version(&r.version)?, r.branch.clone())))
        .collect();
    v.sort();
    v
}

/// [`Refs::shipped_patches`]: each shipped release branch still around, lowest version first.
async fn shipped_patches(p: &Project, git: &Git, refs: &Refs, default_rev: &str) -> ShippedIndex {
    let shipped = shipped_branches(p, refs);
    // Owned items: futures borrowing from the stream's items are not provably Send.
    let not_default = format!("^{default_rev}");
    // A release the default branch holds whole has no commit of its own: nothing to ask git.
    let (graph, default_tip) = (refs.graph(git).await, refs.sha(default_rev));
    let revs: Vec<(String, bool)> = shipped
        .iter()
        .map(|(_, b)| {
            let rev = refs.rev(b).unwrap_or_default();
            let held = graph.zip(default_tip).zip(refs.sha(&rev)).and_then(|((g, d), t)| g.holds(d, t)) == Some(true);
            (rev, held)
        })
        .collect();
    let lists: Vec<_> = stream::iter(revs)
        .map(|(rev, held)| {
            let not_default = not_default.clone();
            async move {
                match held {
                    true => Vec::new(),
                    false => git.patch_ids(&[&rev, &not_default]).await.unwrap_or_default(),
                }
            }
        })
        .buffered(8)
        .collect()
        .await;
    let mut index = HashMap::new();
    for (release, list) in shipped.iter().zip(lists) {
        for (id, _) in list {
            index.entry(id).or_insert_with(|| release.clone());
        }
    }
    index
}

/// Whether `base` holds any of `commits`.
async fn any_in(git: &Git, commits: &[String], base: &str) -> bool {
    for sha in commits {
        if git.is_ancestor(sha, base).await.unwrap_or(false) {
            return true;
        }
    }
    false
}

/// Ticket keys of a branch: the one it was created for, and any in its name.
fn branch_tickets(p: &Project, name: &str) -> Vec<String> {
    let mut keys = ticket_keys(name, true);
    keys.extend(p.branches.get(name).and_then(|m| m.ticket.as_deref()).map(str::to_ascii_uppercase));
    keys
}

/// Branch to file `name` under among the branches holding its work (`holders`, spelled as
/// [`Refs::rev`] does): the release that shipped it (the lowest version), else the trunk or default branch.
fn home_among(p: &Project, refs: &Refs, default: &str, name: &str, holders: &std::collections::HashSet<String>) -> Option<String> {
    let mut releases: Vec<([u64; 3], String)> =
        p.releases.iter().filter(|r| refs.rev(&r.branch).is_some()).filter_map(|r| Some((parse_version(&r.version)?, r.branch.clone()))).collect();
    releases.sort();
    let rest = merge_targets(p, refs, default).into_iter().filter(|t| !releases.iter().any(|(_, b)| b == t)).collect::<Vec<_>>();
    releases.into_iter().map(|(_, b)| b).chain(rest).find(|t| t != name && refs.rev(t).is_some_and(|r| holders.contains(&r)))
}

/// Keychain keys a profile's settings can point to.
fn secret_keys(c: &Config) -> Vec<String> {
    let i = &c.integrations;
    let mut keys = vec!["github".to_string(), azure_auth::KEY.into(), tickets::jira_auth::KEY.into(), crate::git::LOGINS_KEY.into(), "gitlab".into(), "bitbucket".into(), "gitea".into()];
    keys.extend(i.jira.iter().map(Connection::secret));
    keys.extend(i.trello.iter().map(Connection::secret));
    keys.extend(i.asana.iter().map(Connection::secret));
    keys.extend(i.linear.iter().map(Connection::secret));
    keys.extend(ai::catalog().into_iter().map(|p| secrets::ai_key(p.id)));
    keys
}

fn merge_targets(p: &Project, refs: &Refs, default: &str) -> Vec<String> {
    let mut t: Vec<String> = p.releases.iter().filter(|r| r.shipped_at.is_none() && refs.rev(&r.branch).is_some()).map(|r| r.branch.clone()).collect();
    t.extend(DEV_TRUNKS.iter().filter(|d| **d != default && refs.rev(d).is_some()).map(|d| d.to_string()));
    t.push(default.to_string());
    t
}

impl Gitnetix {
    pub fn open(dir: &Path) -> Result<Arc<Gitnetix>> {
        // Tokens reach the keychain from the app's own folder only: a test's never asks the user or sees theirs.
        if dir == crate::store::data_dir() {
            secrets::save_for_good();
        }
        let store = Store::open(dir)?;
        let (events, _) = broadcast::channel(1024);
        let agents = AgentManager::new(events.clone(), dir);
        let shells = crate::shell::Shells::new(events.clone());
        crate::log::attach(events.clone(), dir);
        crate::log::started();
        let k = Arc::new(Gitnetix { store, agents, shells, events, dir: dir.to_path_buf(), dictation: Default::default(), protected: Default::default(), watcher: Default::default(), commits: CommitCache::open(dir), views: ViewCache::open(dir.join("overview-cache")), history: Default::default(), building: Default::default(), cleaning: Default::default(), shipped: Default::default(), hosted: Default::default(), auto_fetch: Default::default(), worktrees: LastCache::open(dir.join("worktrees-cache.json")), drafts: Default::default(), sprint_fetches: Default::default(), runs: Default::default(), publishing: Default::default() });
        k.rewatch();
        Ok(k)
    }

    /// Watch the git dirs of the current projects, replacing the previous watch.
    fn rewatch(&self) {
        let projects = self.store.read(|c| c.projects.clone());
        let mut w = self.watcher.lock().unwrap();
        // Stop the old one first so a repo is never watched twice.
        *w = None;
        *w = crate::watch::watch(&projects, self.events.clone());
    }

    /// Follow a profile switch made by another instance on the same settings folder (see [`Store::follow`]).
    // shortcut: checked before each RPC only, so a write from a background task in between still goes to the old profile; also check from the watcher if that shows up.
    pub fn follow_profile(&self) {
        if let Some(profile) = self.store.follow() {
            self.rewatch();
            let _ = self.events.send(Event::ProfileSwitched { profile });
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    fn changed(&self, project_id: &str) {
        let _ = self.events.send(Event::ProjectChanged { project_id: project_id.into() });
    }

    fn config_changed(&self) {
        let _ = self.events.send(Event::ConfigChanged {});
    }

    // ---------- git helpers ----------

    /// The profile's Git identity, applied to every project; none leaves it to the Git config.
    fn identity(&self) -> Option<Identity> {
        let prof: GitProfile = self.store.read(|c| c.profiles.first().cloned())?;
        let key = if prof.sign {
            prof.signing_key.clone().or_else(|| {
                let home = dirs::home_dir()?;
                ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"]
                    .iter()
                    .map(|f| home.join(".ssh").join(f))
                    .find(|p| p.exists())
                    .map(|p| p.to_string_lossy().to_string())
            })
        } else {
            None
        };
        Some(Identity { name: prof.name, email: prof.email, ssh_signing_key: key })
    }

    fn git_at(&self, cwd: &Path) -> Git {
        let mut g = Git::new(cwd);
        // An Enterprise token must not reach github.com.
        if self.store.read(|c| c.integrations.github_connected && c.integrations.github_api.is_none()) {
            g = g.with_github();
        }
        let mut g = match self.identity() {
            Some(id) => g.with_identity(&id),
            None => g,
        };
        if let Some(rules) = self.policies_at(cwd) {
            if rules.protected_branches {
                g = g.protected_by(&rules.by);
            }
            if rules.signed_commits {
                g = g.signing();
            }
        }
        g
    }

    /// The enterprise policies on a project, from the account's last sync; none when it is on no enterprise's list.
    fn policies(&self, project_id: &str) -> Option<crate::account::Policies> {
        self.store.read(|c| c.account.policies.get(project_id).cloned())
    }

    /// The policies on the project checked out at `cwd`: its main checkout, or one of its worktrees.
    fn policies_at(&self, cwd: &Path) -> Option<crate::account::Policies> {
        self.store.read(|c| {
            if c.account.policies.is_empty() {
                return None;
            }
            let main = crate::account::main_checkout(cwd);
            let p = c.projects.iter().find(|p| Path::new(&p.path) == main)?;
            c.account.policies.get(&p.id).cloned()
        })
    }

    fn git(&self, p: &Project) -> Git {
        self.git_at(Path::new(&p.path))
    }

    /// Directory where `branch` is checked out, if any.
    async fn checkout_dir(&self, p: &Project, branch: &str) -> Result<Option<PathBuf>> {
        let wts = self.git(p).worktrees().await?;
        Ok(wts.into_iter().find(|w| w.branch.as_deref() == Some(branch)).map(|w| PathBuf::from(w.path)))
    }

    async fn require_checkout(&self, p: &Project, branch: &str) -> Result<Git> {
        let dir = self
            .checkout_dir(p, branch)
            .await?
            .ok_or_else(|| Error::Invalid(format!("{branch} is not checked out. Switch to it or open it in a worktree first.")))?;
        Self::refuse_mid_run(self.rebasing_in(&dir))?;
        self.refuse_locked(&p.id, branch)?;
        Ok(self.git_at(&dir))
    }

    /// Nothing else touches a checkout while AI rebases `rebasing` there: it would break the rebase.
    fn refuse_mid_run(rebasing: Option<String>) -> Result<()> {
        match rebasing {
            Some(b) => Err(Error::Invalid(format!("Rebase & conflict resolving is running: AI is rebasing {b} in that checkout. Wait for it to finish, or abort it."))),
            None => Ok(()),
        }
    }

    /// The rebase AI is carrying through that holds `branch` of project `project_id`: the branch it
    /// rebases, or the one it goes onto.
    fn run_locking(&self, project_id: &str, branch: &str) -> Option<RebaseRun> {
        self.runs.lock().unwrap().values().map(|s| &s.run).find(|r| r.project_id == project_id && (r.branch == branch || r.onto == branch)).cloned()
    }

    /// Nothing moves a branch a rebase AI is carrying through holds: its commits, or the ones it
    /// replays them onto, would change under it.
    fn refuse_locked(&self, project_id: &str, branch: &str) -> Result<()> {
        match self.run_locking(project_id, branch) {
            Some(r) => Err(Error::Invalid(format!(
                "Rebase & conflict resolving is running: AI is rebasing {} onto {}, and {branch} stays locked until it is done. Wait for it to finish, or abort it.",
                r.branch, r.onto
            ))),
            None => Ok(()),
        }
    }

    /// Branch `branch` merges into (rebases onto, diffs against); the default branch maps to itself, even when the map files
    /// it under a less advanced trunk (`main` under `prod`, see [`root_of`]): that is for the map only.
    async fn base_of(&self, p: &Project, branch: &str, default: &str) -> String {
        if branch == default {
            return default.to_string();
        }
        let git = self.git(p);
        let fingerprint = git.ref_fingerprint().await.ok();
        if let Some(parent) = fingerprint.as_deref().and_then(|f| self.cached_parent(p, f, branch, default)) {
            return parent.unwrap_or_else(|| default.to_string());
        }
        let refs = Refs::load(&git, git.branches().await.unwrap_or_default()).await;
        if let Some(parent) = declared_parent(p, &refs, default, branch) {
            return parent.unwrap_or_else(|| default.to_string());
        }
        // Asked by every tile of the map right after a ref moved: the history walks come once, not once a tile.
        if let Some(f) = &fingerprint {
            let (merges, squashes) = self.history(&p.id, &git, f).await;
            refs.set_history(merges, squashes);
        }
        self.base_in(p, &git, &refs, branch, default).await
    }

    /// Parent of `branch` as the last overview found it, as long as no ref moved since (`fingerprint` is now).
    fn cached_parent(&self, p: &Project, fingerprint: &str, branch: &str, default: &str) -> Option<Option<String>> {
        let key = view_key(p, default, fingerprint, &self.hosted_digest(&p.id));
        let saved = self.views.get(&p.id, key)?;
        saved.value().views.iter().find(|b| b.name == branch).map(|b| b.parent.clone())
    }

    /// The history walks' answers (merge subjects, pull request squashes) at refs `fingerprint`: those read last
    /// when the refs only moved forward since and brought no merge commit or squash; walked again otherwise.
    async fn history(&self, project_id: &str, git: &Git, fingerprint: &str) -> (Arc<HashMap<String, String>>, Arc<Vec<PrSquash>>) {
        let slot = self.history.lock().unwrap().entry(project_id.to_string()).or_default().clone();
        let mut last = slot.lock().await;
        if let Some(h) = last.as_mut() {
            if h.fingerprint == fingerprint || same_history(git, &h.fingerprint, fingerprint).await {
                h.fingerprint = fingerprint.to_string();
                return (h.merges.clone(), h.squashes.clone());
            }
        }
        let (merges, squashes) = match tokio::join!(git.merge_subjects(5000), git.pr_squashes(5000)) {
            (Ok(m), Ok(s)) => (Arc::new(m), Arc::new(s)),
            // Not kept: the next look walks again.
            (m, s) => return (Arc::new(m.unwrap_or_default()), Arc::new(s.unwrap_or_default())),
        };
        *last = Some(History { fingerprint: fingerprint.to_string(), merges: merges.clone(), squashes: squashes.clone() });
        (merges, squashes)
    }

    /// `base_of` with the refs already loaded.
    async fn base_in(&self, p: &Project, git: &Git, refs: &Refs, branch: &str, default: &str) -> String {
        self.parent_of(p, git, refs, default, branch).await.unwrap_or_else(|| default.to_string())
    }

    /// The branch `name` merges into: an open release branch's base, the release
    /// it is attached to, the parent it was given, else the closest target by
    /// history (fewest commits of its own, then fewest missing; with none of its own, the target it sits
    /// on, else the most upstream one). None for the default branch.
    async fn parent_of(&self, p: &Project, git: &Git, refs: &Refs, default: &str, name: &str) -> Option<String> {
        if let Some(parent) = declared_parent(p, refs, default, name) {
            return parent;
        }
        // Merged by hand: the merge commit names where it went.
        if let Some(t) = refs.merged_into(git, name, default).await.filter(|t| t != name && refs.rev(t).is_some()) {
            return Some(t);
        }
        // Taken in by a pull request (the git host says so, or the squash names it): under the
        // release that shipped it, else the trunk or default branch holding it.
        let mut holders = std::collections::HashSet::new();
        for sha in refs.pr_merges(git, name).await {
            holders.extend(refs.containing(git, &sha).await);
        }
        // Where the host says it went, even before its squash is fetched.
        holders.extend(refs.hosted_targets(name).iter().filter_map(|t| refs.rev(t)));
        if let Some(t) = home_among(p, refs, default, name, &holders) {
            return Some(t);
        }
        let (Some(rev), targets) = (refs.rev(name), merge_targets(p, refs, default)) else {
            return Some(default.to_string());
        };
        let mut best: Option<((u32, u32, usize), String)> = None;
        if targets.len() > 1 {
            for (i, t) in targets.into_iter().enumerate().filter(|(_, t)| t != name) {
                let Some(trev) = refs.rev(&t) else { continue };
                let Ok((behind, ahead)) = refs.left_right(git, &trev, &rev).await else { continue };
                // On a tie, work in progress belongs to the most specific target. A branch with no commits of its own
                // belongs to the target it sits on, else to the most upstream one (shipped to main): how far behind
                // it is says nothing, a hotfix cut from an older tag would take in every old branch.
                let key = if ahead == 0 { (0, u32::from(behind > 0), usize::MAX - i) } else { (ahead, behind, i) };
                if best.as_ref().is_none_or(|(k, _)| key < *k) {
                    best = Some((key, t));
                }
            }
        }
        let target = best.map(|(_, t)| t).unwrap_or_else(|| default.to_string());
        if let Some(on) = self.built_on(p, git, refs, default, name, &rev, &target).await {
            return Some(on);
        }
        Some(self.shipped_home(p, git, refs, default, name, &rev, &target).await.unwrap_or(target))
    }

    /// The nearest other work branch whose tip is among `name`'s own commits (those `target` lacks): the branch it was
    /// built on. The person who made it has it declared; this files it there on a teammate's map too, and when it was
    /// made with a plain `git switch -c`. Trunks and releases are left to [`merge_targets`].
    /// shortcut: once that branch moves on, its tip is no longer in `name`'s history and `name` goes back under
    /// `target` until rebased; reading where origin's copy was before (its reflog) would keep it there.
    #[allow(clippy::too_many_arguments)]
    async fn built_on(&self, p: &Project, git: &Git, refs: &Refs, default: &str, name: &str, rev: &str, target: &str) -> Option<String> {
        let (tip, trev) = (refs.sha(rev)?.to_string(), refs.rev(target)?);
        let own: Vec<String> = match refs.graph(git).await {
            Some(g) => g.own_commits(&tip, refs.sha(&trev)?, OWN_MAX)?,
            // Batched yet too big for the graph: a git call per branch is too many.
            None if refs.batch() => return None,
            None => git.run(&["rev-list", "--topo-order", &format!("--max-count={OWN_MAX}"), &format!("{trev}..{rev}")]).await.ok()?.lines().map(String::from).collect(),
        };
        let work = |b: &&String| b.as_str() != name && b.as_str() != default && !b.starts_with("release/") && !is_trunk(b) && !p.releases.iter().any(|r| &r.branch == *b);
        own.iter().filter(|c| **c != tip).find_map(|c| refs.branches_at(c).iter().find(work)).cloned()
    }

    /// Where `name` landed (squashed by a PR, say) while it has not landed in `target`: the default
    /// branch, else the lowest shipped release holding one of its changes, or its whole squash,
    /// else where a pull request carrying its ticket key went.
    async fn shipped_home(&self, p: &Project, git: &Git, refs: &Refs, default: &str, name: &str, rev: &str, target: &str) -> Option<String> {
        let trev = refs.rev(target)?;
        let counts = refs.left_right(git, &trev, rev).await.ok()?;
        if counts.1 == 0 || landed(git, refs, &self.commits, rev, &trev, counts, false).await {
            return None;
        }
        let drev = refs.rev(default)?;
        // Picked or squashed into the default branch, past the target (a dev trunk, say).
        if target != default {
            if let Ok(counts) = refs.left_right(git, &drev, rev).await {
                if landed(git, refs, &self.commits, rev, &drev, counts, false).await {
                    return Some(default.to_string());
                }
            }
        }
        let index = refs.shipped_patches.get_or_init(|| self.shipped_index(p, git, refs, &drev)).await;
        if !index.is_empty() {
            let ids: Vec<String> = match (refs.sha(rev), refs.merge_base(git, &drev, rev).await) {
                (Some(tip), Ok(fork)) => patches_since(git, &self.commits, tip, &fork).await.map(|(each, whole)| each.into_iter().chain(whole).collect()).unwrap_or_default(),
                _ => git.patch_ids(&[rev, &format!("^{drev}")]).await.unwrap_or_default().into_iter().map(|(id, _)| id).collect(),
            };
            let mut hits: Vec<&([u64; 3], String)> = ids.iter().filter_map(|id| index.get(id)).collect();
            hits.sort();
            hits.dedup();
            for (_, branch) in hits {
                if branch == name {
                    continue;
                }
                let Some(rrev) = refs.rev(branch) else { continue };
                let Ok(counts) = refs.left_right(git, &rrev, rev).await else { continue };
                if landed(git, refs, &self.commits, rev, &rrev, counts, false).await {
                    return Some(branch.clone());
                }
            }
        }
        // Last, a guess: a pull request squash carrying its ticket key (see `BranchView::likely_merged`).
        let mut holders = std::collections::HashSet::new();
        for sha in refs.ticket_squashes(git, &self.commits, &branch_tickets(p, name), name).await {
            holders.extend(refs.containing(git, &sha).await);
        }
        home_among(p, refs, default, name, &holders)
    }

    /// [`shipped_patches`], read again only once the default branch or a shipped release branch moved.
    async fn shipped_index(&self, p: &Project, git: &Git, refs: &Refs, drev: &str) -> Arc<ShippedIndex> {
        let tips: Vec<String> = shipped_branches(p, refs).into_iter().map(|(v, b)| format!("{v:?} {b} {}", refs.rev(&b).and_then(|r| refs.sha(&r).map(str::to_string)).unwrap_or_default())).collect();
        let key = key_of(&[refs.sha(drev).unwrap_or(drev), &tips.join("\n")]);
        if let Some((k, index)) = self.shipped.lock().unwrap().get(&p.id) {
            if *k == key {
                return index.clone();
            }
        }
        let index = Arc::new(shipped_patches(p, git, refs, drev).await);
        self.shipped.lock().unwrap().insert(p.id.clone(), (key, index.clone()));
        index
    }

    /// Template `id`, else the `kind` one for `project_id`, with the global skills on for
    /// `project_id` in front of its body.
    fn template(&self, kind: &str, id: Option<&str>, project_id: Option<&str>) -> Result<Template> {
        self.store.read(|c| {
            let ok_scope = |t: &&Template| t.scope == "all" || Some(t.scope.as_str()) == project_id;
            let found = match id {
                Some(id) => c.templates.iter().find(|t| t.id == id),
                None => c
                    .templates
                    .iter()
                    .filter(|t| t.kind == kind)
                    .filter(ok_scope)
                    .find(|t| t.is_default)
                    .or_else(|| c.templates.iter().filter(|t| t.kind == kind).find(ok_scope)),
            };
            found.cloned().map(|mut t| {
                templates::apply_globals(&mut t, &c.templates, project_id);
                t
            })
        })
        .ok_or_else(|| Error::NotFound(format!("{kind} template")))
    }

    /// `t`, a prompt built here rather than stored, with the global skills on for `project_id` in front.
    fn with_globals(&self, mut t: Template, project_id: &str) -> Template {
        self.store.read(|c| templates::apply_globals(&mut t, &c.templates, Some(project_id)));
        t
    }

    fn route(&self, task: &str, t: Option<&Template>) -> Result<Resolved> {
        self.store.read(|c| ai::resolve(&c.ai, task, t.and_then(|t| t.model.as_deref())))
    }

    /// `lang` to write in: "spoken" is the language of the last dictation, the app's language before any.
    fn gen_lang(&self, lang: &str) -> String {
        if lang != "spoken" {
            return lang.into();
        }
        self.store.read(|c| c.ui.spoken_language.clone().unwrap_or_else(|| c.ui.language.clone()))
    }

    /// `cwd` only when the AI must work in the repo. Without it the CLI starts lean (no tools, MCP, hooks or CLAUDE.md),
    /// ~2 s sooner and on a fraction of the tokens: the prompt already holds the diff, commits or conflicted file.
    /// Agents still read CLAUDE.md, in their worktree.
    async fn ask(&self, task: &str, t: &Template, vars: BTreeMap<String, String>, lang: &str, cwd: Option<&Path>) -> Result<String> {
        let r = self.route(task, Some(t))?;
        let prompt = templates::render(t, &vars, &self.gen_lang(lang));
        self.complete(task, &r, &prompt, cwd).await
    }

    /// `prompt` answered on `r`, logged as `task`.
    async fn complete(&self, task: &str, r: &Resolved, prompt: &str, cwd: Option<&Path>) -> Result<String> {
        let how = format!("{} {:?}{}", r.provider, r.method, if r.model.is_empty() { String::new() } else { format!(" ({})", r.model) });
        crate::log::info(format!("Will attempt to ask AI for {task} with {how}"));
        let start = Instant::now();
        let out = ai::complete(r, prompt, cwd).await;
        let secs = start.elapsed().as_secs_f32();
        match &out {
            Ok(_) => crate::log::info(format!("AI answered {task} in {secs:.1}s")),
            Err(e) => crate::log::error(format!("AI failed {task} after {secs:.1}s: {e}")),
        }
        out
    }

    // ---------- dictation ----------

    /// `audio` as text, on this computer.
    pub async fn dictate(&self, audio: Audio, progress: impl Fn(u64, u64) + Send + Sync) -> Result<String> {
        self.dictation.transcribe(&self.dir, &self.store, audio, progress).await
    }

    /// `text` as dictated after `typed` into `field` (what the box is: "one-line field “Branch name”"), rewritten
    /// by AI into clear text with the project's names, the branch's ticket, the changed files and recent commits.
    /// Unchanged when that is turned off or no AI provider is set up.
    pub async fn polish_dictation(&self, text: &str, project_id: Option<&str>, branch: Option<&str>, field: &str, typed: &str) -> Result<String> {
        let t = self.template("dictation", None, project_id)?;
        if text.trim().is_empty() || !self.store.read(|c| c.ui.dictation_polish) || self.route("dictation", Some(&t)).is_err() {
            return Ok(text.into());
        }
        let scene = match project_id {
            Some(id) => self.scene(id, branch).await.ok(),
            None => None,
        };
        let ticket = match (project_id, scene.as_ref().and_then(|s| s.ticket.as_deref())) {
            // A slow ticket service costs a few seconds at most: the key alone still helps.
            (Some(id), Some(key)) => match tokio::time::timeout(std::time::Duration::from_secs(4), self.ticket(id, key)).await {
                Ok(Ok(Some(t))) => ticket_context(&t).chars().take(4_000).collect(),
                _ => key.to_string(),
            },
            _ => "(none)".into(),
        };
        let or_none = |s: String| if s.trim().is_empty() { "(none)".to_string() } else { s };
        let mut vars = BTreeMap::new();
        vars.insert("text".into(), text.to_string());
        vars.insert("typed".into(), if typed.trim().is_empty() { "(empty)".into() } else { typed.to_string() });
        vars.insert("field".into(), if field.is_empty() { "text box".into() } else { field.to_string() });
        vars.insert("ticket".into(), ticket);
        let (project, branch, files, commits) = scene.map(|s| (s.project, s.branch, s.files, s.commits)).unwrap_or_default();
        vars.insert("project".into(), or_none(project));
        vars.insert("branch".into(), or_none(branch));
        vars.insert("files".into(), or_none(files.lines().take(100).collect::<Vec<_>>().join("\n")));
        vars.insert("commits".into(), or_none(commits));
        vars.insert("projects".into(), or_none(self.store.read(|c| c.projects.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", "))));
        // The words are already there: a stuck provider must not hold them for minutes.
        tokio::time::timeout(std::time::Duration::from_secs(30), self.ask("dictation", &t, vars, SAME_LANGUAGE, None))
            .await
            .map_err(|_| Error::Other("AI took more than 30 s to rewrite the dictation".into()))?
    }

    /// Where a dictation in `project_id` on `branch` (its checked-out one when none) is spoken.
    async fn scene(&self, project_id: &str, branch: Option<&str>) -> Result<Scene> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let branch = match branch {
            Some(b) => b.to_string(),
            None => git.current_branch().await?.unwrap_or_default(),
        };
        let rev = if branch.is_empty() { "HEAD" } else { &branch };
        let commits = git.run(&["log", "-10", "--name-only", "--format=- %s", rev, "--"]).await.unwrap_or_default();
        // A branch checked out nowhere has no uncommitted changes.
        let files = match self.checkout_dir(&p, &branch).await? {
            Some(dir) => self.git_at(&dir).run(&["status", "--short"]).await.unwrap_or_default(),
            None => String::new(),
        };
        let ticket = p.branches.get(&branch).and_then(|m| m.ticket.clone()).or_else(|| ticket_keys(&branch, true).into_iter().next());
        Ok(Scene { project: p.name, branch, ticket, commits, files })
    }

    // ---------- projects ----------

    pub async fn projects(&self) -> Vec<ProjectSummary> {
        let agents = self.agents.list();
        let mut list: Vec<(ProjectSummary, bool)> = self.store.read(|c| {
            c.projects
                .iter()
                .map(|p| {
                    let next_release = p.releases.iter().find(|r| r.shipped_at.is_none() && r.kind == ReleaseKind::Next).map(|r| r.version.clone());
                    let detect = p.branch_types.tag_v.is_none() && next_release.is_some();
                    let summary = ProjectSummary {
                        id: p.id.clone(),
                        name: p.name.clone(),
                        path: p.path.clone(),
                        exists: Path::new(&p.path).exists(),
                        next_release,
                        running_agents: agents.iter().filter(|a| a.project_id == p.id && a.status == AgentStatus::Running).count(),
                        hidden: p.hidden,
                        tag_v: p.branch_types.tag_v.unwrap_or(true),
                    };
                    (summary, detect)
                })
                .collect()
        });
        // Read from its tags outside the store lock: a git call per project.
        for (s, _) in list.iter_mut().filter(|(s, detect)| *detect && s.exists) {
            if let Ok(p) = self.store.project(&s.id) {
                s.tag_v = use_v(&p, &self.git(&p)).await.unwrap_or(true);
            }
        }
        list.into_iter().map(|(s, _)| s).collect()
    }

    /// Projects of the other profiles that this one lacks and are still on disk, newest added first, each path once.
    pub fn recent_projects(&self) -> Vec<RecentProject> {
        let active = self.store.active();
        let mine: Vec<String> = self.store.read(|c| c.projects.iter().map(|p| p.path.clone()).collect());
        let mut all: Vec<(String, RecentProject)> = Vec::new();
        for prof in self.store.profiles().list.into_iter().filter(|p| p.id != active) {
            // An unreadable profile only hides its projects here.
            let Ok(c) = self.store.profile_config(&prof.id) else { continue };
            for p in c.projects {
                all.push((p.added_at, RecentProject { name: p.name, path: p.path, profile: prof.name.clone() }));
            }
        }
        all.sort_by(|a, b| b.0.cmp(&a.0));
        let mut seen = std::collections::HashSet::new();
        all.into_iter()
            .map(|(_, r)| r)
            .filter(|r| !mine.contains(&r.path) && seen.insert(r.path.clone()) && Path::new(&r.path).exists())
            .collect()
    }

    /// A saved or recent project's own icon (favicon, app or PWA icon, logo) among its tracked files: (repo path, base64).
    pub async fn project_icon(&self, path: &str) -> Result<Option<(String, String)>> {
        let known = self.store.read(|c| c.projects.iter().any(|p| p.path == path)) || self.recent_projects().iter().any(|r| r.path == path);
        if !known {
            return Err(Error::Invalid(format!("{path} is not a saved project")));
        }
        let pathspecs = ["ls-files", "-z", "--", ":(icase)*icon*", ":(icase)*logo*", ":(icase)*pwa*", ":(icase)*android-chrome*"];
        let Ok((true, out, _)) = Git::new(path).try_run(&pathspecs).await else {
            return Ok(None);
        };
        let mut found: Vec<_> = out.split('\0').filter_map(|f| Some((icon_rank(f)?, f))).collect();
        found.sort();
        for (_, file) in found {
            // The list shows it at 32 px: a bigger file is a banner or artwork, not worth sending.
            if let Ok(b) = tokio::fs::read(Path::new(path).join(file)).await {
                if b.len() <= 256 * 1024 {
                    use base64::Engine;
                    return Ok(Some((file.to_string(), base64::engine::general_purpose::STANDARD.encode(b))));
                }
            }
        }
        Ok(None)
    }

    /// The agent last picked for `path` in another profile, so a project taken from there keeps it. Empty when none.
    fn agent_from_other_profiles(&self, path: &str) -> Route {
        let active = self.store.active();
        for prof in self.store.profiles().list.into_iter().filter(|p| p.id != active) {
            // An unreadable profile only loses its pick here.
            let Ok(c) = self.store.profile_config(&prof.id) else { continue };
            if let Some(p) = c.projects.iter().find(|p| p.path == path && p.agent != Route::default()) {
                return p.agent.clone();
            }
        }
        Route::default()
    }

    /// Add local repositories as projects. `init`: a folder holding none gets a new, empty one first (the user said so
    /// after `Error::NotRepo`); it opens with no commit, and the app offers to name its first branch.
    pub async fn add_projects(&self, paths: Vec<String>, init: bool) -> Result<Vec<Project>> {
        let mut added = Vec::new();
        for raw in paths {
            let expanded = expand_home(&raw);
            let top = match Git::new(&expanded).toplevel().await {
                Ok(top) => top,
                Err(_) if init && expanded.is_dir() => {
                    Git::new(&expanded).run(&["init", "-q"]).await?;
                    Git::new(&expanded).toplevel().await?
                }
                Err(_) if expanded.is_dir() => return Err(Error::NotRepo(expanded.display().to_string())),
                Err(_) => return Err(Error::Invalid(format!("{} is not a Git repository", expanded.display()))),
            };
            let path = top.to_string_lossy().to_string();
            if let Some(id) = self.store.read(|c| c.projects.iter().find(|p| p.path == path).map(|p| p.id.clone())) {
                // Re-adding a closed project brings its tab back.
                let existing = self.store.with_project(&id, |p| {
                    p.hidden = false;
                    Ok(p.clone())
                })?;
                added.push(existing);
                continue;
            }
            let name = top.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| path.clone());
            let agent = self.agent_from_other_profiles(&path);
            let mut project = Project { id: new_id(), name, path, added_at: now(), agent, ..Default::default() };
            self.import_release_branches(&mut project).await;
            self.store.write(|c| {
                c.projects.push(project.clone());
                Ok(())
            })?;
            added.push(project);
        }
        self.rewatch();
        self.config_changed();
        Ok(added)
    }

    /// Clone `url` into the new folder `path` and add it as a project. The user asked for it: ssh and the
    /// credential manager may ask for a passphrase or a sign-in, as on push.
    pub async fn clone_project(&self, url: &str, path: &str) -> Result<Vec<Project>> {
        let (url, dest) = (url.trim(), expand_home(path.trim()));
        if url.is_empty() || !dest.is_absolute() {
            return Err(Error::Invalid("Give the repository URL and the full path of the folder to clone into".into()));
        }
        // git makes the missing folders of `dest` itself; it only needs to start in one that exists.
        self.git_at(&std::env::temp_dir()).run(&["clone", "--", url, &dest.to_string_lossy()]).await?;
        self.add_projects(vec![dest.to_string_lossy().into_owned()], false).await
    }

    /// Pick up existing `release/x.y.z` branches on first open.
    async fn import_release_branches(&self, p: &mut Project) {
        let git = Git::new(&p.path);
        let default = git.default_branch().await.unwrap_or_else(|_| "main".into());
        let branches = git.branches().await.unwrap_or_default();
        let remote = git.remote_branches().await.unwrap_or_default();
        import_release_branches(p, &branches, &remote, &default);
        ship_tagged_releases(p, &git.tags().await.unwrap_or_default());
    }

    /// Close or reopen a project's tab; its data is kept either way.
    pub fn set_project_hidden(&self, id: &str, hidden: bool) -> Result<()> {
        self.store.with_project(id, |p| {
            p.hidden = hidden;
            Ok(())
        })?;
        self.config_changed();
        Ok(())
    }

    /// Reorder projects to match `ids`; projects not listed keep their order after them.
    pub fn reorder_projects(&self, ids: &[String]) -> Result<()> {
        self.store.write(|c| {
            c.projects.sort_by_key(|p| ids.iter().position(|id| *id == p.id).unwrap_or(usize::MAX));
            Ok(())
        })?;
        self.config_changed();
        Ok(())
    }

    pub fn remove_project(&self, id: &str) -> Result<()> {
        self.store.write(|c| {
            c.projects.retain(|p| p.id != id);
            Ok(())
        })?;
        self.rewatch();
        self.config_changed();
        Ok(())
    }

    // ---------- user profiles ----------

    /// Use profile `id`: its projects, connections, tokens, AI setup and settings.
    pub fn switch_profile(&self, id: &str) -> Result<()> {
        self.store.switch(id)?;
        self.rewatch();
        self.config_changed();
        Ok(())
    }

    /// A new profile: blank, or a copy of profile `from` with its saved tokens. `git`: its Git identity instead of the copied one.
    pub fn create_profile(&self, mut p: UserProfile, from: Option<&str>, git: Option<Vec<GitProfile>>) -> Result<UserProfile> {
        p.id = new_id();
        let mut data = match from {
            Some(f) => {
                let mut data = self.store.profile_config(f)?;
                // Their refresh token works once: the profile that renews first voids the other's, so the copy signs in itself.
                let single_use = |k: &str, v: &str| matches!(k, "github" | "gitlab" | "gitea") && serde_json::from_str::<providers::oauth::Tokens>(v).is_ok_and(|t| t.refresh_token.is_some());
                for key in secrets::copy(&secret_keys(&data), f, &p.id, |k, v| !single_use(k, v))? {
                    let i = &mut data.integrations;
                    match key.as_str() {
                        "github" => (i.github_connected, i.github_user) = (false, None),
                        other => {
                            if let Some(h) = i.host_mut(other) {
                                h.connected = false;
                            }
                        }
                    }
                }
                data
            }
            None => Config::default(),
        };
        // A blank profile opens on the setup; a copy has its source's settings, even mid-setup.
        data.ui.onboarding = from.is_none();
        if let Some(g) = git {
            data.profiles = g;
        }
        self.store.add_profile(p.clone(), data)?;
        Ok(p)
    }

    /// Delete profile `id` with its settings and saved tokens; the repositories stay on disk. The one in use hands over to another first.
    pub fn delete_profile(&self, id: &str) -> Result<()> {
        if self.store.active() == id {
            let next = self.store.profiles().list.into_iter().find(|p| p.id != id);
            self.switch_profile(&next.ok_or_else(|| Error::Invalid("The last profile can't be deleted".into()))?.id)?;
        }
        let gone = self.store.remove_profile(id)?;
        secrets::forget(&secret_keys(&gone), id)?;
        self.config_changed();
        Ok(())
    }

    // ---------- workspace ----------

    /// `quick`: when the branches changed since the last overview, answer at once with
    /// what needs no history (no counts, merge state or inferred parents) instead of building them.
    pub async fn overview(&self, project_id: &str, quick: bool) -> Result<Overview> {
        let started = Instant::now();
        // Boxed: built inline, this deep future made the frames above it outgrow a 2 MB thread stack in debug builds.
        let (read, calls) = crate::git::counting(Box::pin(self.read_overview(project_id, quick))).await;
        let (overview, built) = read?;
        let secs = started.elapsed().as_secs_f64();
        // In the Logs: what each refresh redid and what it cost, so a slow one tells why.
        match built {
            Some(what) => crate::log::info(format!("Branches of {}: {what} in {secs:.1}s, {calls} git calls", overview.project.name)),
            None if secs >= 1.0 => crate::log::info(format!("Branches of {}: none rebuilt, read in {secs:.1}s, {calls} git calls", overview.project.name)),
            None => {}
        }
        Ok(overview)
    }

    /// [`Gitnetix::overview`], with what it rebuilt when it had to.
    async fn read_overview(&self, project_id: &str, quick: bool) -> Result<(Overview, Option<String>)> {
        let mut p = self.store.project(project_id)?;
        let git = self.git(&p);
        // Every ref in one git process: on Windows each costs ~40 ms.
        let (listed, wts, in_progress, remote) = tokio::join!(git.read_refs(), git.worktrees(), git.in_progress(), git.remote_url("origin"));
        let (listed, wts) = (listed?, wts?);
        let current = match listed.current.clone() {
            Some(c) => Some(c),
            // Detached, or not born yet.
            None => git.current_branch().await?,
        };
        // A branch HEAD is on that the listing lacks has no commit yet.
        let unborn = listed.current.is_none() && current.is_some();
        let default = listed.default_branch(current.as_deref());
        let crate::git::RefList { branches, remote_branches, tags, fingerprint, .. } = listed;
        let in_progress = in_progress.ok().flatten();
        let rebasing = in_progress == Some("rebase");
        // Rebasing detaches HEAD: the checkout is still on the branch being rebased.
        let current = match current {
            None if rebasing => git.rebasing_branch().await.ok().flatten(),
            c => c,
        };
        // Release branches created outside Gitnetix (or after the project was added), and releases tagged without it.
        let mut probe = p.clone();
        let imported = import_release_branches(&mut probe, &branches, &remote_branches, &default);
        let shipped = ship_tagged_releases(&mut probe, &tags);
        // Shipped but untagged with commits main lacks: it never went out, back to open.
        let mut unshipped = Vec::new();
        for (v, branch) in untagged_shipped(&probe, &tags) {
            // As `branch_rev` resolves it, from the refs already listed.
            let rev = if branches.iter().any(|b| b.name == branch) {
                Some(branch.clone())
            } else {
                remote_branches.iter().any(|b| b.name == branch).then(|| format!("origin/{branch}"))
            };
            if let Some(rev) = rev {
                if !git.is_ancestor(&rev, &default).await.unwrap_or(true) {
                    unshipped.push(v);
                }
            }
        }
        if imported || shipped || !unshipped.is_empty() {
            p = self.store.with_project(project_id, |p| {
                import_release_branches(p, &branches, &remote_branches, &default);
                ship_tagged_releases(p, &tags);
                reopen_releases(p, &unshipped);
                Ok(p.clone())
            })?;
        }
        let agents = self.agents.list();
        let conflicts = if rebasing { git.conflicted_files().await.unwrap_or_default() } else { Vec::new() };

        let refs = Refs::new(branches, remote_branches);
        // Never wait on the git host for a first look.
        let hosted = self.hosted_prs(&p, &refs.tips(), !quick).await;
        let refs = refs.with_hosted(hosted);
        let fingerprint = Some(fingerprint);
        let digest = self.hosted_digest(&p.id);
        let key = fingerprint.as_deref().map(|f| view_key(&p, &default, f, &digest));
        let mut built = None;
        let cleaning = self.cleaning.lock().unwrap().iter().any(|c| c == project_id);
        let mut all = match key.and_then(|k| self.views.get(project_id, k)) {
            Some(saved) => saved.value().views.clone(),
            None if quick || cleaning => match self.views.last(project_id) {
                // The last build's views, a little behind but already filed under their parents.
                Some(saved) => saved.value().views.clone(),
                None => branch_names(&p, &refs)
                    .iter()
                    .map(|n| plain_view(&p, &refs, n, declared_parent(&p, &refs, &default, n).unwrap_or_else(|| Some(default.clone()))))
                    .collect(),
            },
            None => {
                // One build at a time: a refresh asked meanwhile (the action's, then the watcher's) waits for it, then reuses it.
                let lock = self.building.lock().unwrap().entry(project_id.to_string()).or_default().clone();
                let _building = lock.lock().await;
                match key.and_then(|k| self.views.get(project_id, k)) {
                    Some(saved) => saved.value().views.clone(),
                    None => {
                        if let Some(f) = &fingerprint {
                            let (merges, squashes) = self.history(&p.id, &git, f).await;
                            refs.set_history(merges, squashes);
                        }
                        let shared = view_key(&p, &default, &refs.history_digest(&git).await, &digest);
                        let (keep, why) = match (self.views.last(project_id), &fingerprint) {
                            (Some(saved), Some(f)) if saved.value().shared == shared => match unmoved_views(&p, &default, saved.value(), f) {
                                Ok(keep) => (keep, None),
                                Err(moved) => (HashMap::new(), Some(moved)),
                            },
                            (Some(_), Some(_)) => (HashMap::new(), Some("new merges, pull requests or branch settings".to_string())),
                            _ => (HashMap::new(), Some("first build".to_string())),
                        };
                        let views = self.branch_views(&p, &git, &refs, &default, &keep).await;
                        let reused = views.iter().filter(|v| keep.contains_key(&v.name)).count();
                        built = Some(match why {
                            Some(why) => format!("all {} rebuilt ({why})", views.len()),
                            None => format!("{} rebuilt, {reused} reused", views.len() - reused),
                        });
                        self.commits.save();
                        if let (Some(k), Some(refs)) = (key, fingerprint) {
                            self.views.insert(project_id, k, BuiltViews { refs, shared, views: views.clone() });
                        }
                        views
                    }
                }
            }
        };
        let protected = async {
            match quick {
                // Never wait on the git host for a first look.
                true => self.protected.lock().unwrap().get(project_id).map(|(_, l)| l.clone()).unwrap_or_default(),
                false => self.protected_branches(project_id, false).await,
            }
        };
        let (_, protected, stashes) = tokio::join!(self.decorate(&p, &mut all, &wts, &agents), protected, git.stashes());
        let mut stashes = stashes.unwrap_or_default();
        // Local only: renamed here alone, origin still has the old name, and its stashes follow the new one.
        relabel_stashes(&p, &mut stashes, |n| all.iter().any(|b| b.name == n && b.local));
        for b in &mut all {
            b.protected = protected.contains(&b.name);
            b.stashes = stashes.iter().filter(|s| s.branch.as_deref() == Some(b.name.as_str())).count() as u32;
            // A merged branch's upstream is gone because it was deleted, not renamed.
            b.renamed_to = if b.merged { None } else { renamed_to(&refs, &b.name) };
        }
        let mut open: Vec<&Release> = p.releases.iter().filter(|r| r.shipped_at.is_none()).collect();
        // Newest version first; stable sort keeps unparseable versions in registration order, last.
        open.sort_by_key(|r| std::cmp::Reverse(parse_version(&r.version)));

        let mut releases = Vec::new();
        for r in &open {
            releases.push(ReleaseView {
                version: r.version.clone(),
                tag: match r.kind {
                    ReleaseKind::Next => "next".into(),
                    ReleaseKind::Hotfix => "hotfix".into(),
                },
                branch: r.branch.clone(),
                base: r.branch.clone(),
                open: true,
                note: String::new(),
                tag_name: None,
                checked_out: false,
            });
        }
        // Last shipped releases, from tags, plus older ones whose release branch is still around
        // (so it files under Shipped instead of lingering in the tree). The map lists the latest few, the rest on "see all".
        // shortcut: the newest SHIPPED_TAGS only, so a repo with thousands of tags stays light; page them if someone needs older.
        const SHIPPED_TAGS: usize = 100;
        let detached = if current.is_none() { git.rev_parse("HEAD").await.ok() } else { None };
        let on_default = git.tags_merged(&default).await.unwrap_or_default();
        let branch_left = |v: &str| p.releases.iter().any(|r| r.version == v && r.shipped_at.is_some() && all.iter().any(|b| b.name == r.branch && b.exists));
        let tag_list = tags.clone();
        let tags_use_v = tags_use_v(tag_list.iter().map(|t| t.name.as_str()));
        for (i, t) in tags.into_iter().enumerate() {
            let v = t.name.trim_start_matches('v').to_string();
            if i >= SHIPPED_TAGS && !branch_left(&v) {
                continue;
            }
            let shipped = p.branches.values().filter(|m| m.release.as_deref() == Some(v.as_str())).count();
            let date = t.date.get(..10).unwrap_or("").to_string();
            let branch = p.releases.iter().find(|r| r.version == v).map(|r| r.branch.clone()).unwrap_or_default();
            // Any branch can be published: name the default branch only when the tag is on it.
            let on = if on_default.contains(&t.name) { default.clone() } else { branch.clone() };
            releases.push(ReleaseView {
                branch,
                version: v,
                tag: "released".into(),
                base: if on.is_empty() { format!("tagged {date}") } else { format!("{on} · tagged {date}") },
                open: false,
                note: if shipped > 0 { format!("{shipped} branches shipped") } else { String::new() },
                checked_out: detached.as_deref() == Some(t.sha.as_str()),
                tag_name: Some(t.name),
            });
        }
        // Releases that went out with a later patch of their line, while their branch is around.
        for r in p.releases.iter().filter(|r| r.shipped_at.is_some() && r.tag.is_none() && branch_left(&r.version)) {
            let Some(with) = later_patch(&tag_list, &r.version).map(|t| t.name.clone()) else { continue };
            if releases.iter().any(|x| !x.open && x.version == r.version) {
                continue;
            }
            releases.push(ReleaseView {
                branch: r.branch.clone(),
                version: r.version.clone(),
                tag: "released".into(),
                base: format!("{default} · went out as {with}"),
                open: false,
                note: String::new(),
                checked_out: false,
                tag_name: None,
            });
        }
        // Shipped ones newest version first, like the open ones.
        let first_shipped = releases.iter().position(|r| !r.open).unwrap_or(releases.len());
        releases[first_shipped..].sort_by_key(|r| std::cmp::Reverse(parse_version(&r.version)));
        let remote = remote.ok().flatten();
        let has_changelog = Path::new(&p.path).join(CHANGELOG).is_file();
        let changelog_version = std::fs::read_to_string(Path::new(&p.path).join(CHANGELOG)).ok().and_then(|t| latest_changelog_version(&t));
        let rebase_onto = match current.as_deref().filter(|_| rebasing) {
            Some(b) => Self::rebasing_onto(&git, b, all.iter().find(|v| v.name == b).and_then(|v| v.parent.as_deref()).unwrap_or(&default)).await,
            None => None,
        };
        let project = OverviewProject { id: p.id, name: p.name, path: p.path, releases: p.releases };
        Ok((Overview { project, current_branch: current, default_branch: default, releases, branches: all, rebasing, rebase_onto, in_progress, conflicts, remote, stashes, has_changelog, changelog_version, tags_use_v, unborn }, built))
    }

    /// Every branch's view with counts, merge state and parent: a few git calls per branch,
    /// except those in `keep`, still right from the last build.
    async fn branch_views(&self, p: &Project, git: &Git, refs: &Refs, default: &str, keep: &HashMap<String, BranchView>) -> Vec<BranchView> {
        let names = branch_names(p, refs);
        let total = names.iter().filter(|n| !keep.contains_key(*n)).count() as u32;
        // Every ref's counts and the whole commit graph pay off when most branches get weighed; for a few, a git call each costs less.
        let many = total > 32 || total as usize * 8 >= names.len();
        refs.set_batch(many);
        if many {
            // The bases every branch is weighed against, scanned up front and side by side.
            let bases: Vec<String> = merge_targets(p, refs, default).iter().filter_map(|t| refs.rev(t)).collect();
            refs.prefetch(git, &bases).await;
        }
        let root = root_of(p, git, refs, default).await;
        // The root has no parent and the default branch sits under it; a saved view placed otherwise is redone (another
        // trunk fell further behind).
        let placed = |n: &str| match n {
            n if n == root => Some(None),
            n if n == default => Some(Some(root.clone())),
            _ => None,
        };
        // A long rebuild tells the UI how far it is, every few branches.
        let done = std::sync::atomic::AtomicU32::new(0);
        let tell = |n: u32| {
            if total >= 20 && (n % 10 == 0 || n == total) {
                let _ = self.events.send(Event::OverviewProgress { project_id: p.id.clone(), done: n, total });
            }
        };
        // Several branches at once, keeping the order.
        stream::iter(names)
            .map(|n| {
                let (done, tell, placed) = (&done, &tell, &placed);
                async move {
                    if let Some(v) = keep.get(&n).filter(|v| placed(&n).is_none_or(|w| v.parent == w)) {
                        return v.clone();
                    }
                    let parent = match placed(&n) {
                        Some(w) => w,
                        None => self.parent_of(p, git, refs, default, &n).await,
                    };
                    let v = self.branch_view(p, git, refs, &n, parent).await;
                    tell(done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1);
                    v
                }
            })
            .buffered(8)
            .collect()
            .await
    }

    /// Fill in what comes from checkouts and agents rather than refs.
    async fn decorate(&self, p: &Project, views: &mut [BranchView], wts: &[WorktreeInfo], agents: &[AgentSession]) {
        let checkouts: Vec<Option<&WorktreeInfo>> = views.iter().map(|b| wts.iter().find(|w| w.branch.as_deref() == Some(b.name.as_str()))).collect();
        let dirs: Vec<Option<String>> = checkouts.iter().map(|w| w.map(|w| w.path.clone())).collect();
        let state: Vec<(Option<&'static str>, bool, u32)> = stream::iter(dirs)
            .map(|dir| async move {
                let Some(dir) = dir else { return (None, false, 0) };
                let g = Git::new(&dir);
                let op = g.in_progress().await.ok().flatten();
                let conflict = op.is_some() && !g.conflicted_files().await.unwrap_or_default().is_empty();
                (op, conflict, g.wip_count().await.unwrap_or(0))
            })
            .buffered(8)
            .collect()
            .await;
        for ((b, wt), (op, conflict, wip)) in views.iter_mut().zip(checkouts).zip(state) {
            b.worktree = wt.filter(|w| !w.main).map(|w| w.path.clone());
            b.checked_out = wt.is_some();
            let has = |st| agents.iter().any(|a| a.branch == b.name && a.project_id == p.id && a.status == st);
            b.running = has(AgentStatus::Running);
            b.waiting = has(AgentStatus::Waiting);
            b.conflict = conflict;
            b.in_progress = op.map(String::from);
            b.wip = wip;
        }
    }

    /// [`plain_view`] with its counts against the parent and upstream, and whether it landed.
    async fn branch_view(&self, p: &Project, git: &Git, refs: &Refs, name: &str, parent: Option<String>) -> BranchView {
        let mut v = plain_view(p, refs, name, parent);
        let info = refs.local(name);
        let rev = refs.rev(name);
        let base_rev = v.parent.as_deref().and_then(|b| refs.rev(b));
        (v.behind, v.ahead) = match (&rev, &base_rev) {
            (Some(r), Some(b)) => refs.left_right(git, b, r).await.unwrap_or((0, 0)),
            _ => (0, 0),
        };
        // The default branch has no base to be ahead of: what it holds past its latest release instead.
        if v.parent.is_none() {
            if let Some(tip) = info.or_else(|| refs.remote(name)) {
                (v.last_tag, v.unreleased) = since_last_tag(git, &tip.sha).await;
            }
        }
        if v.upstream.is_some() {
            (v.upstream_ahead, v.upstream_behind) = refs.upstream_counts(git, name).await;
        }
        // Its list has a row a commit on its own line (first parents), as `commits` lists it: the others fold under their merge.
        // A fold takes a merge and a commit it brought, so 2 listed at least.
        let listed = (if v.ahead > 0 { v.ahead } else { v.unreleased }) + v.upstream_behind;
        let not_in = match (&base_rev, &v.last_tag) {
            (Some(b), _) => Some(format!("^{b}")),
            (None, Some(t)) => Some(format!("^refs/tags/{t}")),
            (None, None) => None,
        };
        if listed >= 2 && (base_rev.is_some() || v.parent.is_none()) {
            let max = format!("--max-count={UNRELEASED_MAX}");
            let mut args = vec!["rev-list", "--first-parent", "--count", &max];
            let tips: Vec<&str> = [info, refs.remote(name)].into_iter().flatten().map(|b| b.sha.as_str()).collect();
            args.extend(tips);
            args.extend(not_in.as_deref());
            if let Ok((true, out, _)) = git.try_run(&args).await {
                v.folded = listed.saturating_sub(out.trim().parse().unwrap_or(listed));
            }
        }
        v.rewritten = match &v.upstream {
            Some(u) if v.upstream_behind > 0 => match git.rev_parse(u).await {
                Ok(sha) => git.in_reflog(&format!("refs/heads/{name}"), &sha).await.unwrap_or(false),
                Err(_) => false,
            },
            _ => false,
        };
        v.upstream_rewritten = match (&v.upstream, info) {
            (Some(u), Some(i)) if v.upstream_ahead > 0 && v.upstream_behind > 0 => git.in_reflog(&format!("refs/remotes/{u}"), &i.sha).await.unwrap_or(false),
            _ => false,
        };
        if let (true, Some(r), Some(b)) = (p.branches.get(name).is_some_and(|m| m.from_shipped), &rev, &base_rev) {
            v.fork = shipped_fork(git, r, b).await;
        }
        // Trunks and open releases live on; only work gets merged away.
        v.merged = match (&rev, &base_rev) {
            (Some(r), Some(b)) if v.role == "branch" => {
                landed(git, refs, &self.commits, r, b, (v.behind, v.ahead), info.is_none()).await || refs.pr_landed(git, &self.commits, name, b).await || {
                    // Merged on the host (a PR) while the local base lags behind origin's copy.
                    let base = v.parent.as_deref().unwrap_or_default();
                    match (refs.local(base), refs.remote(base)) {
                        (Some(l), Some(o)) if l.sha != o.sha => {
                            let ob = format!("origin/{base}");
                            match refs.left_right(git, &ob, r).await {
                                Ok(counts) => landed(git, refs, &self.commits, r, &ob, counts, info.is_none()).await || refs.pr_landed(git, &self.commits, name, &ob).await,
                                Err(_) => false,
                            }
                        }
                        _ => false,
                    }
                }
            }
            _ => false,
        };
        // Parked on a shipped commit to try that release: it holds nothing, so nothing of it landed.
        if v.fork.is_some() && v.ahead == 0 {
            v.merged = false;
        }
        // No proof, but a pull request carrying its ticket key went into the base after its last commit.
        if let (false, "branch", true, Some(b)) = (v.merged, v.role.as_str(), v.ahead > 0, &base_rev) {
            v.likely_merged = refs.holds_any(git, &self.commits, &refs.ticket_squashes(git, &self.commits, &branch_tickets(p, name), name).await, b).await;
            v.merged = v.likely_merged;
        }
        v
    }

    pub async fn files(&self, project_id: &str, branch: &str, mode: ViewMode) -> Result<Vec<FileChange>> {
        let p = self.store.project(project_id)?;
        if mode == ViewMode::Wip {
            return match self.checkout_dir(&p, branch).await? {
                Some(dir) => Git::new(dir).wip_split().await,
                None => Ok(Vec::new()),
            };
        }
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let base = self.base_of(&p, branch, &default).await;
        // Either may exist only on origin.
        let (base_rev, rev) = tokio::join!(git.rev_of(&base), git.rev_of(branch));
        match mode {
            ViewMode::Branch | ViewMode::Wip => {
                if base == branch {
                    return Ok(Vec::new());
                }
                git.branch_changes(&base_rev, &rev).await
            }
            ViewMode::Project => {
                let dir = self.checkout_dir(&p, branch).await?;
                let mut known: HashMap<String, FileChange> = HashMap::new();
                if base != branch {
                    for f in git.branch_changes(&base_rev, &rev).await? {
                        known.insert(f.path.clone(), f);
                    }
                }
                if let Some(d) = &dir {
                    for f in Git::new(d).wip_changes().await? {
                        known.insert(f.path.clone(), f);
                    }
                }
                let listing = match &dir {
                    Some(d) => Git::new(d).ls_files().await?,
                    None => {
                        let out = git.run(&["ls-tree", "-r", "--name-only", "-z", &rev]).await?;
                        out.split('\0').filter(|s| !s.is_empty()).map(String::from).collect()
                    }
                };
                let mut all: Vec<FileChange> = listing
                    .into_iter()
                    .map(|path| known.remove(&path).unwrap_or(FileChange { path, status: ' ', additions: 0, deletions: 0, staged: None, from: None }))
                    .collect();
                all.extend(known.into_values());
                all.sort_by(|a, b| a.path.cmp(&b.path));
                Ok(all)
            }
        }
    }

    /// `staged` picks the side of a WIP file (None = working tree vs HEAD).
    pub async fn diff(&self, project_id: &str, branch: &str, mode: ViewMode, path: &str, staged: Option<bool>, full: bool) -> Result<Vec<Hunk>> {
        let p = self.store.project(project_id)?;
        if let (ViewMode::Wip, Some(staged)) = (mode, staged) {
            return match self.checkout_dir(&p, branch).await? {
                Some(dir) => Git::new(dir).file_diff_side(path, staged, full).await,
                None => Ok(Vec::new()),
            };
        }
        if mode != ViewMode::Branch {
            match self.checkout_dir(&p, branch).await? {
                Some(dir) => {
                    let wip = Git::new(&dir).file_diff(path, None, full).await?;
                    if !wip.is_empty() || mode == ViewMode::Wip {
                        return Ok(wip);
                    }
                }
                // Not checked out: no uncommitted work, like `files`.
                None if mode == ViewMode::Wip => return Ok(Vec::new()),
                None => {}
            }
        }
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let base = self.base_of(&p, branch, &default).await;
        if base == branch {
            return Ok(Vec::new());
        }
        let (base_rev, rev) = tokio::join!(git.rev_of(&base), git.rev_of(branch));
        git.file_diff(path, Some(&format!("{base_rev}...{rev}")), full).await
    }

    /// Old and new contents of one file, picked like `diff` (for image previews).
    pub async fn blobs(&self, project_id: &str, branch: &str, mode: ViewMode, path: &str, staged: Option<bool>) -> Result<Blobs> {
        let p = self.store.project(project_id)?;
        if mode != ViewMode::Branch {
            if let Some(dir) = self.checkout_dir(&p, branch).await? {
                let git = Git::new(dir);
                match staged.filter(|_| mode == ViewMode::Wip) {
                    Some(true) => return git.blobs(Side::Rev("HEAD"), Side::Index, path).await,
                    Some(false) => return git.blobs(Side::Index, Side::Worktree, path).await,
                    None if mode == ViewMode::Wip || git.is_dirty(path).await? => {
                        return git.blobs(Side::Rev("HEAD"), Side::Worktree, path).await;
                    }
                    None => {}
                }
            } else if mode == ViewMode::Wip {
                return Ok(Blobs::default());
            }
        }
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let base = self.base_of(&p, branch, &default).await;
        if base == branch {
            // Project view still shows an unchanged file's contents on a trunk.
            if mode != ViewMode::Project {
                return Ok(Blobs::default());
            }
            let rev = git.rev_of(branch).await;
            return git.blobs(Side::Rev(&rev), Side::Rev(&rev), path).await;
        }
        let (base_rev, rev) = tokio::join!(git.rev_of(&base), git.rev_of(branch));
        git.range_blobs(&format!("{base_rev}...{rev}"), path).await
    }

    pub async fn commit_blobs(&self, project_id: &str, sha: &str, path: &str) -> Result<Blobs> {
        let git = self.git(&self.store.project(project_id)?);
        git.range_blobs(&git.commit_range(check_sha(sha)?).await?, path).await
    }

    pub async fn stash_blobs(&self, project_id: &str, sha: &str, path: &str) -> Result<Blobs> {
        let git = self.git(&self.store.project(project_id)?);
        let (tracked, untracked) = git.stash_ranges(check_sha(sha)?).await?;
        match untracked {
            Some(r) if git.run(&["diff", "--name-only", &tracked, "--", path]).await?.trim().is_empty() => git.range_blobs(&r, path).await,
            _ => git.range_blobs(&tracked, path).await,
        }
    }

    /// Commits a branch has that its base does not, newest first; a trunk lists its recent history.
    /// `limit` caps how many (200 for a trunk, 500 for a branch when not given): raised to load older ones.
    /// `unreleased`: the default branch lists only its commits since its latest tag, the tagged one as its base.
    pub async fn commits(&self, project_id: &str, branch: &str, limit: Option<u32>, unreleased: bool, base: Option<&str>) -> Result<Vec<Commit>> {
        // The map's tiles all ask at once after each change: a few lists at a time, else hundreds of git processes start
        // side by side and crawl (300 tiles after a ref moved: 27 s side by side, 12 s eight at a time).
        static LISTING: std::sync::LazyLock<tokio::sync::Semaphore> = std::sync::LazyLock::new(|| tokio::sync::Semaphore::new(8));
        let _turn = LISTING.acquire().await.map_err(|e| Error::Invalid(e.to_string()))?;
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        // The base the caller files it under (the map's parent) saves working it out again, once per tile.
        let base = match base.filter(|b| valid_branch_name(b)) {
            Some(b) => b.to_string(),
            None => self.base_of(&p, branch, &default).await,
        };
        let (local_ref, origin_ref) = (format!("refs/heads/{branch}"), format!("refs/remotes/origin/{branch}"));
        let (local, origin) = tokio::join!(git.rev_parse(&local_ref), git.rev_parse(&origin_ref));
        let (local, origin) = (local.ok(), origin.ok());
        // Both copies' commits, so origin's not-yet-pulled ones show above the local tip.
        let mut revs: Vec<String> = [&local, &origin].into_iter().flatten().cloned().collect();
        if revs.is_empty() {
            revs.push(git.rev_of(branch).await);
        }
        let trunk = base == branch;
        // The default branch's unreleased commits: since the latest tag behind its local copy (else origin's), as its view counts them.
        let since = match (unreleased && branch == default, local.as_ref().or(origin.as_ref())) {
            (true, Some(tip)) => match git.last_tag(tip).await? {
                Some((t, _)) => git.rev_parse(&format!("refs/tags/{t}^{{commit}}")).await.ok(),
                None => None,
            },
            _ => None,
        };
        let base_rev = match since {
            Some(s) => Some(s),
            None if trunk => None,
            None => Some(git.rev_of(&base).await),
        };
        if let Some(b) = &base_rev {
            revs.push(format!("^{b}"));
        }
        let limit = limit.unwrap_or(if trunk { 200 } else { 500 });
        // One row a commit on the branch's own line; what a merge brought in is listed under its merge commit.
        revs.insert(0, "--first-parent".into());
        let revs: Vec<&str> = revs.iter().map(String::as_str).collect();
        let mut list = git.log_revs(&revs, Some(limit)).await?;
        let merges: std::collections::HashSet<String> = {
            let mut args = vec!["rev-list", "--merges"];
            let n = format!("-n{limit}");
            args.push(&n);
            args.extend(&revs);
            git.run(&args).await?.lines().map(Into::into).collect()
        };
        let brought: Vec<Vec<Commit>> = stream::iter(list.iter().map(|c| c.sha.clone()).collect::<Vec<_>>())
            .map(|sha| {
                let (git, base_rev, merge) = (&git, &base_rev, merges.contains(&sha));
                async move {
                    if !merge {
                        return Ok(Vec::new());
                    }
                    // Past its first parent and the base: what it brought that the list has no row for. Itself first.
                    let not_first = format!("^{sha}^");
                    let mut args = vec![sha.as_str(), not_first.as_str()];
                    let not_base = base_rev.as_ref().map(|b| format!("^{b}"));
                    args.extend(not_base.as_deref());
                    // shortcut: a merge listing more than `limit` commits under it shows only the newest `limit`; count them apart if ever needed.
                    let mut under = git.log_revs(&args, Some(limit + 1)).await?;
                    under.retain(|c| c.sha != sha);
                    Ok::<_, Error>(under)
                }
            })
            .buffered(8)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect::<Result<_>>()?;
        for (c, under) in list.iter_mut().zip(brought) {
            c.merged = under;
        }
        // The whole list loaded: below it, where the local branch left its base, to reset back past all its commits.
        // None when the local branch has no commits of its own (it would reset to where it is).
        if let (Some(b), Some(l), true) = (&base_rev, &local, list.len() < limit as usize) {
            if let Some(fork) = git.merge_base(l, b).await.ok().filter(|f| f != l) {
                if let Some(mut c) = git.log_revs(&[&fork], Some(1)).await?.pop() {
                    c.base = true;
                    list.push(c);
                }
            }
        }
        let unpulled = match (&local, &origin) {
            (Some(l), Some(o)) if l != o => git.rev_list(&format!("{l}..{o}")).await.unwrap_or_default().into_iter().collect(),
            _ => std::collections::HashSet::new(),
        };
        // Local commits on no origin branch: a hard reset past them loses them. As many as listed, rows and those under merges.
        let listed: usize = list.iter().map(|c| 1 + c.merged.len()).sum();
        let unpushed: std::collections::HashSet<String> = match &local {
            Some(l) => git.run(&["rev-list", &format!("-n{listed}"), l, "--not", "--remotes=origin"]).await.map(|o| o.lines().map(Into::into).collect()).unwrap_or_default(),
            None => std::collections::HashSet::new(),
        };
        for c in &mut list {
            c.local = local.as_deref() == Some(c.sha.as_str());
            c.origin = origin.as_deref() == Some(c.sha.as_str());
            c.unpulled = unpulled.contains(&c.sha);
            // Still on the base after a reset there: nothing lost.
            c.unpushed = !c.base && unpushed.contains(&c.sha);
            for m in &mut c.merged {
                m.unpulled = unpulled.contains(&m.sha);
                m.unpushed = unpushed.contains(&m.sha);
            }
        }
        Ok(list)
    }

    /// Commits tag `tag` shipped, newest first: those past the latest tag before it (its whole history without one),
    /// up to `limit` (200 when not given).
    pub async fn release_commits(&self, project_id: &str, tag: &str, limit: Option<u32>) -> Result<Vec<Commit>> {
        let git = self.git(&self.store.project(project_id)?);
        let at = format!("refs/tags/{tag}");
        let mut revs = vec![at.clone()];
        if let Some((prev, _)) = git.last_tag(&format!("{at}^")).await? {
            revs.push(format!("^refs/tags/{prev}"));
        }
        git.log_revs(&revs.iter().map(String::as_str).collect::<Vec<_>>(), Some(limit.unwrap_or(200))).await
    }

    /// How many commits each of `tags` shipped (see [`Gitnetix::release_commits`]) and the tag before it, by tag.
    pub async fn release_counts(&self, project_id: &str, tags: &[String]) -> Result<HashMap<String, ReleaseCount>> {
        let git = self.git(&self.store.project(project_id)?);
        let counts: Vec<(String, ReleaseCount)> = stream::iter(tags.to_vec())
            .map(|t| {
                let git = &git;
                async move {
                    // Its own commit, and those its parent has past the tag before. A first commit has no parent: 0 past it.
                    let (since, n) = since_last_tag(git, &format!("refs/tags/{t}^")).await;
                    (t, ReleaseCount { since, commits: n + 1 })
                }
            })
            .buffered(8)
            .collect()
            .await;
        Ok(counts.into_iter().collect())
    }

    /// What the branch map lists, for its search: each tile's commits as [`Gitnetix::commits`] gives them (origin's
    /// not pulled yet included, the base row left out), since `base`, or since its latest tag for the default branch
    /// (`base` none); and the commits each of `tags` shipped. Newest first, up to what the map lists: 500 a branch,
    /// 200 for the default branch and a tag. One ref listing, then one log a tile and two a tag.
    pub async fn map_commits(&self, project_id: &str, lists: &[MapList], tags: &[String]) -> Result<MapCommits> {
        let git = self.git(&self.store.project(project_id)?);
        let refs = git.read_refs().await?;
        let (git, refs) = (&git, &refs);
        let local = |n: &str| refs.branches.iter().find(|b| b.name == n).map(|b| b.sha.clone());
        let origin = |n: &str| refs.remote_branches.iter().find(|b| b.name == n).map(|b| b.sha.clone());
        let found = |list: Vec<Commit>| list.into_iter().map(|c| FoundCommit { sha: c.sha, subject: c.subject, tags: c.tags }).collect::<Vec<_>>();
        let branches: Vec<(String, Vec<FoundCommit>)> = stream::iter(lists.to_vec())
            .map(|l| async move {
                let mut revs: Vec<String> = [local(&l.name), origin(&l.name)].into_iter().flatten().collect();
                revs.dedup();
                let Some(tip) = revs.first().cloned() else { return (l.name, Vec::new()) };
                let since = match &l.base {
                    Some(b) => local(b).or_else(|| origin(b)),
                    None => git.last_tag(&tip).await.ok().flatten().map(|(t, _)| format!("refs/tags/{t}")),
                };
                revs.extend(since.map(|s| format!("^{s}")));
                // Its rows, as listed: what a merge brought in is folded under it, not found apart.
                revs.insert(0, "--first-parent".into());
                let limit = if l.base.is_some() { 500 } else { 200 };
                let list = git.log_revs(&revs.iter().map(String::as_str).collect::<Vec<_>>(), Some(limit)).await.unwrap_or_default();
                (l.name, found(list))
            })
            .buffered(8)
            .collect()
            .await;
        let tags: Vec<(String, Vec<FoundCommit>)> = stream::iter(tags.to_vec())
            .map(|t| async move {
                let list = self.release_commits(project_id, &t, Some(200)).await.unwrap_or_default();
                (t, found(list))
            })
            .buffered(8)
            .collect()
            .await;
        Ok(MapCommits { branches: branches.into_iter().collect(), tags: tags.into_iter().collect() })
    }

    /// Files one commit changed, against its first parent.
    pub async fn commit_files(&self, project_id: &str, sha: &str) -> Result<Vec<FileChange>> {
        let git = self.git(&self.store.project(project_id)?);
        git.range_changes(&git.commit_range(check_sha(sha)?).await?).await
    }

    /// `from`: the file's path before, when this commit renamed it.
    pub async fn commit_diff(&self, project_id: &str, sha: &str, path: &str, full: bool, from: Option<&str>) -> Result<Vec<Hunk>> {
        let git = self.git(&self.store.project(project_id)?);
        let range = git.commit_range(check_sha(sha)?).await?;
        match from {
            Some(old) => git.rename_diff(old, path, &range, full).await,
            None => git.file_diff(path, Some(&range), full).await,
        }
    }

    /// Who last changed each line of `path` on the new side of the file's diff, or its old side with `old` (for removed
    /// lines), the sides picked like `blobs`: commit `sha` against its parent when given, else the checkout's uncommitted
    /// work in the wip and project views (one side of it with `staged`), else the branch against its base.
    pub async fn blame(&self, project_id: &str, branch: &str, mode: ViewMode, path: &str, sha: Option<&str>, staged: Option<bool>, old: bool) -> Result<Blame> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        if let Some(sha) = sha {
            let sha = check_sha(sha)?;
            let parent = format!("{sha}^");
            return match old {
                false => git.blame(Side::Rev(sha), path).await,
                true if git.ref_exists(&parent).await? => git.blame(Side::Rev(&parent), path).await,
                // A root commit: no old side.
                true => Ok(Blame::default()),
            };
        }
        if mode != ViewMode::Branch {
            if let Some(dir) = self.checkout_dir(&p, branch).await? {
                let co = Git::new(dir);
                let sides = match staged.filter(|_| mode == ViewMode::Wip) {
                    Some(true) => Some((Side::Rev("HEAD"), Side::Index)),
                    Some(false) => Some((Side::Index, Side::Worktree)),
                    None if mode == ViewMode::Wip || co.is_dirty(path).await? => Some((Side::Rev("HEAD"), Side::Worktree)),
                    None => None,
                };
                if let Some((before, after)) = sides {
                    return co.blame(if old { before } else { after }, path).await;
                }
            } else if mode == ViewMode::Wip {
                return Ok(Blame::default());
            }
        }
        let rev = check_rev(git.rev_of(branch).await)?;
        if old {
            let default = git.default_branch().await?;
            let base = self.base_of(&p, branch, &default).await;
            if base != branch {
                let base_rev = check_rev(git.rev_of(&base).await)?;
                return git.blame(Side::Rev(&git.merge_base(&base_rev, &rev).await?), path).await;
            }
        }
        git.blame(Side::Rev(&rev), path).await
    }

    /// Commits of `branch` that changed `path`, newest first, following its renames. `limit` (200 when not
    /// given) is raised to reach older ones.
    pub async fn file_history(&self, project_id: &str, branch: &str, path: &str, limit: Option<u32>) -> Result<Vec<FileCommit>> {
        let git = self.git(&self.store.project(project_id)?);
        git.file_log(&check_rev(git.rev_of(branch).await)?, path, limit.unwrap_or(200)).await
    }

    /// Revert one commit of `branch` with a new commit on it.
    pub async fn revert_commit(&self, project_id: &str, branch: &str, sha: &str) -> Result<String> {
        self.apply_commit(project_id, branch, sha, "revert").await
    }

    /// Copy one commit onto `onto`.
    pub async fn cherry_pick(&self, project_id: &str, onto: &str, sha: &str) -> Result<String> {
        self.apply_commit(project_id, onto, sha, "cherry-pick").await
    }

    /// Revert or cherry-pick (`op`) one commit on checked-out `branch`, AI resolving its conflicts.
    /// When they can't be, nothing changes. Returns the new commit.
    async fn apply_commit(&self, project_id: &str, branch: &str, sha: &str, op: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        let sha = check_sha(sha)?;
        let started = if op == "revert" { git.revert(sha).await } else { git.cherry_pick(sha).await };
        let short = &sha[..sha.len().min(7)];
        let out = match started {
            Ok(true) => Ok(()),
            Ok(false) => {
                let (verb, change) = if op == "revert" { ("Reverting", format!("the revert of commit {short}")) } else { ("Cherry-picking", format!("commit {short}")) };
                self.resolve_or_abort(&p, &git, op, &change, branch, |r| format!("{verb} {short} conflicts in {}.{}", r.left.join(", "), r.why())).await
            }
            Err(e) => Err(e),
        };
        self.changed(project_id);
        out?;
        git.rev_parse("HEAD").await
    }

    /// Move `branch` to one of its commits: soft keeps the changes staged, mixed unstaged, hard drops them.
    /// `shipped`: `sha` is a shipped release's commit, reset onto to try that release; the branch is marked so (see
    /// [`BranchMeta::from_shipped`]). The default branch is the trunk itself: never marked.
    pub async fn reset_branch(&self, project_id: &str, branch: &str, sha: &str, mode: &str, shipped: bool) -> Result<()> {
        // Keep only serves Gitnetix's own rollbacks (see `roll_back`).
        if !matches!(mode, "soft" | "mixed" | "hard") {
            return Err(Error::Invalid(format!("unknown reset mode {mode:?}")));
        }
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        // A paused rebase has HEAD detached: the reset would move HEAD, not the branch, and drop the rebase's work.
        refuse_in_progress(&git, git.cwd(), branch).await?;
        git.reset(check_sha(sha)?, mode).await?;
        if shipped && branch != git.default_branch().await? {
            self.store.with_project(project_id, |p| {
                let m = p.branches.entry(branch.to_string()).or_insert_with(|| BranchMeta { created_at: now(), ..Default::default() });
                m.from_shipped = true;
                Ok(())
            })?;
        }
        self.changed(project_id);
        Ok(())
    }

    /// Check out `branch` in the main checkout; `abort` first aborts the rebase, merge, cherry-pick
    /// or revert it's stopped in the middle of (git refuses to switch then).
    /// Uncommitted changes the checkout would overwrite refuse it (`WouldOverwrite`) unless `wip` says
    /// what to do with them: "stash" leaves them in a stash, "carry" stashes them, switches and puts
    /// them back. Returns the files left conflicted by carrying them (the stash is kept then).
    /// Switch the main checkout to `branch` ([`Self::switch_to`]), then run the project's branch switched hook.
    pub async fn switch_branch(&self, project_id: &str, branch: &str, abort: bool, wip: Option<&str>) -> Result<Vec<String>> {
        let p = self.store.project(project_id)?;
        // Read only for a hook: switching to the branch already checked out runs none.
        let hook = hooks::live(&p, "branchSwitched").is_some();
        let from = if hook { self.git(&p).current_branch().await.ok().flatten() } else { None };
        let out = self.switch_to(project_id, branch, abort, wip).await?;
        if hook && from.as_deref() != Some(branch) {
            let mut vars = hook_vars(&p, branch);
            vars.push(("FROM", from.unwrap_or_default()));
            hooks::spawn(&p, "branchSwitched", &top_path(&p), vec![vars]);
        }
        Ok(out)
    }

    async fn switch_to(&self, project_id: &str, branch: &str, abort: bool, wip: Option<&str>) -> Result<Vec<String>> {
        let p = self.store.project(project_id)?;
        if let Some(dir) = self.checkout_dir(&p, branch).await? {
            if dir != Path::new(&p.path) {
                return Err(Error::Invalid(format!("{branch} is open in a worktree at {}", dir.display())));
            }
            return Ok(Vec::new());
        }
        Self::refuse_mid_run(self.rebasing_in(Path::new(&p.path)))?;
        self.refuse_locked(project_id, branch)?;
        let git = self.git(&p);
        if abort {
            if let Some(op) = git.in_progress().await? {
                let out = git.abort_op(op).await;
                self.changed(project_id);
                out?;
            }
        }
        let Some(wip) = wip else {
            return match git.switch(branch).await {
                Err(Error::Git { stderr, .. }) if stderr.contains("would be overwritten by checkout") => {
                    Err(Error::WouldOverwrite(format!("Uncommitted changes would be overwritten by switching to {branch}.")))
                }
                out => {
                    out?;
                    self.changed(project_id);
                    Ok(Vec::new())
                }
            };
        };
        if !matches!(wip, "stash" | "carry") {
            return Err(Error::Invalid(format!("wip: {wip:?}")));
        }
        let files = git.wip_changes().await?;
        if files.is_empty() {
            git.switch(branch).await?;
            self.changed(project_id);
            return Ok(Vec::new());
        }
        let Some(sha) = git.stash(&stash_message(&files)).await? else {
            // Only a submodule changed: git sets nothing aside, and the switch takes it along.
            git.switch(branch).await?;
            self.changed(project_id);
            return Ok(Vec::new());
        };
        let out = git.switch(branch).await;
        self.changed(project_id);
        // A post-checkout hook failing (git-lfs missing from the app's PATH, say) errors after git switched: then the work
        // goes where it was asked to, and the hook's error is in the Logs.
        if let Err(e) = out {
            if git.current_branch().await.ok().flatten().as_deref() != Some(branch) {
                // Still on the branch the stash was made on: it goes back cleanly.
                if git.stash_apply(&sha).await.is_ok_and(|c| c.is_empty()) {
                    git.stash_drop(&sha).await?;
                }
                return Err(e);
            }
        }
        if wip == "stash" {
            return Ok(Vec::new());
        }
        Ok(self.apply_stash(project_id, branch, &sha, true).await?.conflicts)
    }

    /// The branch's checkout, with everything staged first when `all`;
    /// errors when nothing is staged.
    async fn staged_checkout(&self, p: &Project, branch: &str, all: bool) -> Result<Git> {
        let git = self.require_checkout(p, branch).await?;
        if all {
            git.add_all().await?;
        }
        if !git.has_staged().await? {
            return Err(Error::Invalid(if all { "Nothing to commit" } else { "Nothing staged — stage files first" }.into()));
        }
        Ok(git)
    }

    /// Stage `paths` (all when empty) in the branch's checkout.
    pub async fn stage(&self, project_id: &str, branch: &str, paths: &[String]) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        let paths = or_whole_side(&git, false, paths).await?;
        git.stage(&paths, &self.files_progress(&p.id)).await?;
        self.changed(project_id);
        Ok(())
    }

    /// Unstage `paths` (all when empty), keeping the working tree.
    pub async fn unstage(&self, project_id: &str, branch: &str, paths: &[String]) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        git.unstage(&or_whole_side(&git, true, paths).await?).await?;
        self.changed(project_id);
        Ok(())
    }

    /// Tells the UI how far a stage or discard of a thousand files or more is, every thousand.
    fn files_progress<'a>(&'a self, project_id: &'a str) -> impl Fn(usize, usize) + Sync + 'a {
        move |done, total| {
            if total >= 1000 && (done % 1000 == 0 || done == total) {
                let _ = self.events.send(Event::FilesProgress { project_id: project_id.to_string(), done: done as u32, total: total as u32 });
            }
        }
    }

    /// Stage only `lines` of `path`'s unstaged changes or, with `unstage`, take them out of its staged ones.
    pub async fn stage_lines(&self, project_id: &str, branch: &str, path: &str, lines: &[LinePick], unstage: bool) -> Result<()> {
        let p = self.store.project(project_id)?;
        self.require_checkout(&p, branch).await?.stage_lines(path, lines, unstage).await?;
        self.changed(project_id);
        Ok(())
    }

    /// Throw away only `lines` of `path`'s unstaged changes, from the working tree.
    pub async fn discard_lines(&self, project_id: &str, branch: &str, path: &str, lines: &[LinePick]) -> Result<()> {
        let p = self.store.project(project_id)?;
        self.require_checkout(&p, branch).await?.discard_lines(path, lines).await?;
        self.changed(project_id);
        Ok(())
    }

    /// Throw away one side of the uncommitted work for `paths` (every file on that side when empty).
    pub async fn discard(&self, project_id: &str, branch: &str, staged: bool, paths: &[String]) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        let paths = or_whole_side(&git, staged, paths).await?;
        let tell = self.files_progress(&p.id);
        if staged {
            git.discard_staged(&paths, &tell).await?;
        } else {
            git.discard_unstaged(&paths, &tell).await?;
        }
        self.changed(project_id);
        Ok(())
    }

    /// Add `path` (a folder when `dir`) to the root .gitignore of the branch's checkout.
    pub async fn ignore(&self, project_id: &str, branch: &str, path: &str, dir: bool) -> Result<()> {
        let path = path.trim_matches('/');
        if path.is_empty() || path.contains(['\n', '\r']) {
            return Err(Error::Invalid(format!("cannot ignore {path:?}")));
        }
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        let file = git.cwd().join(".gitignore");
        not_a_link(&file)?;
        let mut text = match tokio::fs::read_to_string(&file).await {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&ignore_line(path, dir));
        tokio::fs::write(&file, text).await?;
        // .gitignore only hides untracked files: stop tracking it too (kept on disk) so it leaves the WIP once committed.
        // Literal: `report[1].csv` would otherwise also untrack `report1.csv`.
        git.run(&["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", &format!(":(literal){path}")]).await?;
        self.changed(project_id);
        Ok(())
    }

    /// AI commit message for what is staged.
    pub async fn generate_commit_message(&self, project_id: &str, branch: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = self.staged_checkout(&p, branch, false).await?;
        self.commit_message_for(&p, &git, branch).await
    }

    /// AI commit message for what `git` has staged: the one [`Self::prepare_commit_message`] wrote ahead for this very prompt
    /// (waited for while it is still being written), else a new one.
    async fn commit_message_for(&self, p: &Project, git: &Git, branch: &str) -> Result<String> {
        let (r, prompt) = self.commit_prompt(p, git, branch).await?;
        let key = key_of(&[&format!("{r:?}"), &prompt]);
        let ahead = {
            let mut drafts = self.drafts.lock().unwrap();
            if drafts.get(git.cwd()).is_some_and(|(k, _)| *k == key) { drafts.remove(git.cwd()).map(|(_, cell)| cell) } else { None }
        };
        if let Some(cell) = ahead {
            if let Some(m) = cell.get_or_init(|| async { self.complete("commit", &r, &prompt, None).await.ok() }).await {
                crate::log::info("Took the commit message written ahead of time");
                return Ok(m.clone());
            }
        }
        self.complete("commit", &r, &prompt, None).await
    }

    /// What [`Self::commit_message_for`] asks: the route, and the prompt for what `git` has staged.
    async fn commit_prompt(&self, p: &Project, git: &Git, branch: &str) -> Result<(Resolved, String)> {
        let t = self.template("commit", None, Some(&p.id))?;
        let diff = git.staged_diff(60_000).await?;
        let files = git.run(&["diff", "--cached", "--name-status"]).await?;
        let ticket = p.branches.get(branch).and_then(|m| m.ticket.clone()).unwrap_or_default();
        let mut vars = BTreeMap::new();
        vars.insert("diff".into(), diff);
        vars.insert("files".into(), files);
        vars.insert("branch".into(), branch.to_string());
        vars.insert("ticket".into(), if ticket.is_empty() { "(none)".into() } else { ticket });
        Ok((self.route("commit", Some(&t))?, templates::render(&t, &vars, &self.gen_lang(&p.gen_lang.commit))))
    }

    /// Writes the AI commit message that staging everything and committing would ask for now, staging nothing: such a
    /// commit made before anything changes takes it at once, or waits for the rest of it. Asked when a worktree session ends.
    pub async fn prepare_commit_message(&self, project_id: &str, branch: &str) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        let cwd = git.cwd().to_path_buf();
        let Some(index) = git.git_paths(&["index"]).await?.pop() else { return Ok(()) };
        // Staged into a copy of the index, outside the git dir: the watcher would refresh the UI on each write there.
        let copy = std::env::temp_dir().join(format!("gitnetix-{}.index", new_id()));
        let staged = git.with_index(&copy);
        let built: Result<Option<(Resolved, String)>> = async {
            tokio::fs::copy(&index, &copy).await?;
            staged.add_all().await?;
            if !staged.has_staged().await? {
                return Ok(None);
            }
            self.commit_prompt(&p, &staged, branch).await.map(Some)
        }
        .await;
        let _ = tokio::fs::remove_file(&copy).await;
        let Some((r, prompt)) = built? else { return Ok(()) };
        let key = key_of(&[&format!("{r:?}"), &prompt]);
        let cell = {
            let mut drafts = self.drafts.lock().unwrap();
            match drafts.get(&cwd) {
                // Asked again for the same changes (another screen, another device): one answer for both.
                Some((k, cell)) if *k == key => cell.clone(),
                _ => {
                    let cell = Arc::new(OnceCell::new());
                    drafts.insert(cwd.clone(), (key, cell.clone()));
                    cell
                }
            }
        };
        cell.get_or_init(|| async { self.complete("commit, ahead of time", &r, &prompt, None).await.ok() }).await;
        Ok(())
    }

    /// Commit what is staged (`all` stages everything first). An empty message is written by AI.
    pub async fn commit(&self, project_id: &str, branch: &str, message: Option<String>, all: bool) -> Result<CommitResult> {
        let p = self.store.project(project_id)?;
        let git = self.staged_checkout(&p, branch, all).await?;
        let marked = git.staged_with_conflict_markers().await?;
        if !marked.is_empty() {
            return Err(Error::Invalid(format!("Conflict markers are still in {}: resolve them before committing.", marked.join(", "))));
        }
        let (message, ai_written) = match message.filter(|m| !m.trim().is_empty()) {
            Some(m) => (m, false),
            None => (self.commit_message_for(&p, &git, branch).await?, true),
        };
        let sha = git.commit(&message).await?;
        if ai_written {
            self.store.with_project(project_id, |p| {
                p.ai_commits.push(sha.clone());
                Ok(())
            })?;
        }
        self.changed(project_id);
        Ok(CommitResult { sha, message, ai_written })
    }

    /// The first branch of a repository with no commit yet: HEAD goes to `name`, then its first commit, with the folder's
    /// files when `files` (what .gitignore leaves out stays out), else empty. Git makes a branch with its first commit.
    pub async fn first_branch(&self, project_id: &str, name: &str, files: bool) -> Result<CommitResult> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        if git.ref_exists("HEAD").await? {
            return Err(Error::Invalid(format!("{} already has a commit", p.name)));
        }
        let name = name.trim();
        if name.starts_with('-') || !git.try_run(&["check-ref-format", "--branch", name]).await?.0 {
            return Err(Error::Invalid(format!("\"{name}\" can't be a branch name: no spaces, and none of ~ ^ : ? * [ \\ or \"..\"")));
        }
        git.run(&["symbolic-ref", "HEAD", &format!("refs/heads/{name}")]).await?;
        let message = "Initial commit";
        if files {
            git.add_all().await?;
            // Allowed empty: a folder with nothing to commit yet still gets its branch.
            git.run(&["commit", "--allow-empty", "-m", message]).await?;
        } else {
            // `--only` with no paths: an empty commit, even over files staged by hand.
            git.run(&["commit", "--allow-empty", "--only", "-m", message]).await?;
        }
        let sha = git.rev_parse("HEAD").await?;
        self.changed(project_id);
        Ok(CommitResult { sha, message: message.into(), ai_written: false })
    }

    /// Push a branch; `force` replaces its upstream (see [`Git::force_push_to`]), e.g. after a rebase.
    pub async fn push(&self, project_id: &str, branch: &str, force: bool) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = match self.checkout_dir(&p, branch).await? {
            Some(d) => self.git_at(&d),
            None => self.git(&p),
        };
        let upstream = git.upstream(branch).await?;
        // Its own copy on another remote (a fork's, to open a pull request from) is where it goes; origin otherwise.
        let own = match upstream.as_deref().and_then(|u| own_remote(u, branch)) {
            Some(r) if git.remote_url(r).await?.is_some() => Some(r),
            _ => None,
        };
        let out = if force {
            let upstream = upstream.as_deref().ok_or_else(|| Error::Invalid(format!("{branch} has no upstream to force push to.")))?;
            // Only its own copy: a branch made from origin/main tracks it, and would replace main.
            let Some(remote) = own else {
                return Err(Error::Invalid(format!(
                    "{branch} tracks {upstream}, not origin/{branch}: a force push would replace {upstream}. Push it without force to give it its own copy on origin."
                )));
            };
            git.force_push_to(remote, branch).await?
        } else {
            // Track it unless it already does: a branch pushed without -u (on origin, untracked), or one
            // tracking another name (e.g. renamed locally), gets `origin/<branch>` as its upstream now.
            match git.push_to(own.unwrap_or("origin"), branch, own.is_none()).await {
                // A GitHub origin the user can't write to (a clone of someone else's project): the app offers a fork.
                Err(Error::Git { stderr, .. }) if own.is_none_or(|r| r == "origin") && push_refused(&stderr) => {
                    let url = git.remote_url("origin").await?.unwrap_or_default();
                    let api = self.store.read(|c| c.integrations.github_api.clone()).is_some_and(|a| !a.is_empty());
                    return Err(match parse_remote(&url).filter(|r| github_host_ok(&r.host, api)) {
                        Some(r) => Error::NoPushAccess { repo: format!("{}/{}", r.owner, r.repo) },
                        None => Error::Git { cmd: "push".into(), stderr },
                    });
                }
                r => r?,
            }
        };
        self.changed(project_id);
        Ok(out)
    }

    /// Rebase a branch onto `onto`, else onto its release. Its target stays as it was. Not checked out anywhere, it is
    /// rebased in a throwaway worktree, and conflicts AI leaves there put it back as it was.
    /// `resolve`: AI resolves conflicts this time even when the project's merge option leaves them to the user.
    pub async fn rebase(&self, project_id: &str, branch: &str, onto: Option<&str>, resolve: bool) -> Result<RebaseResult> {
        let mut p = self.store.project(project_id)?;
        p.merge.resolve_conflicts |= resolve;
        if self.checkout_dir(&p, branch).await?.is_some() {
            let git = self.require_checkout(&p, branch).await?;
            return self.rebase_at(&p, &git, branch, onto).await;
        }
        self.refuse_locked(project_id, branch)?;
        let main = self.git(&p);
        let tmp = std::env::temp_dir().join(format!("gitnetix-rebase-{}", new_id()));
        main.worktree_add(&tmp, branch, None).await?;
        let git = self.git_at(&tmp);
        let out = self.rebase_at(&p, &git, branch, onto).await;
        // A rebase paused there would go with the folder. The branch only moves once a rebase finishes, so it is as it was.
        let paused = git.is_rebasing().await.unwrap_or(false);
        if paused {
            let _ = git.abort_op("rebase").await;
        }
        if let Err(e) = main.worktree_remove(&tmp, true).await {
            crate::log::error(format!("Could not remove the temporary checkout {}: {e}", tmp.display()));
        }
        match out {
            Ok(r) if paused => {
                let why = if r.errors.is_empty() { String::new() } else { format!(" {}.", r.errors.join("; ")) };
                Err(Error::Invalid(format!("Rebasing {branch} stopped on conflicts in {}.{why} It is back as it was: check it out to rebase it and resolve them.", r.conflicts.join(", "))))
            }
            out => out,
        }
    }

    async fn rebase_at(&self, p: &Project, git: &Git, branch: &str, onto: Option<&str>) -> Result<RebaseResult> {
        let default = git.default_branch().await?;
        let target = self.base_of(p, branch, &default).await;
        let base = match onto {
            Some(o) => {
                let shared = |b: &str| b == default || b.starts_with("release/") || is_trunk(b) || p.releases.iter().any(|r| r.branch == b);
                // A work branch's target follows its history unless given: pin it, or landing on `o` would move it there.
                let given = p.branches.get(branch).is_some_and(|m| m.parent.is_some() || m.release.is_some());
                if !shared(branch) && !shared(o) && matches!(git.branch_rev(o).await, Ok(Some(_))) {
                    // Onto another work branch: now built on it, it sits under it (its tip can be that branch's own).
                    self.set_parent(&p.id, branch, o)?;
                } else if o != target && !given && !shared(branch) {
                    self.set_parent(&p.id, branch, &target)?;
                }
                o.to_string()
            }
            None => target,
        };
        // A commit (from the commit menu) reads as its short SHA, like a paused rebase's onto.
        let label = if base.len() == 40 && base.bytes().all(|c| c.is_ascii_hexdigit()) { &base[..7] } else { base.as_str() };
        let ctl = self.start_run(p, git, branch, label, false)?;
        let out = match git.rebase(&git.rev_of(&base).await).await {
            Ok(true) => Ok(Resolution { done: true, left: Vec::new(), errors: Vec::new() }),
            Ok(false) => self.resolve_and_continue(p, git, Some("rebase"), branch, &base, Some(&ctl)).await,
            Err(e) => Err(e),
        };
        self.finish_rebase(p, git, branch, ctl, out).await
    }

    /// AI resolves the paused rebase's conflicts and carries it on through every commit left, even when
    /// the project has AI resolving off: asked for. With no conflicts left, it just carries on.
    pub async fn rebase_continue(&self, project_id: &str, branch: &str) -> Result<RebaseResult> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        if !git.is_rebasing().await? {
            return Err(Error::Invalid(format!("{branch} is not in the middle of a rebase")));
        }
        let base = self.conflict_base(&p, &git, branch).await?;
        let ctl = self.start_run(&p, &git, branch, &base, true)?;
        let out = self.resolve_and_continue(&p, &git, Some("rebase"), branch, &base, Some(&ctl)).await;
        self.finish_rebase(&p, &git, branch, ctl, out).await
    }

    /// Registers the rebase of `branch` onto `onto` in `git`'s checkout; refused while another runs there.
    fn start_run(&self, p: &Project, git: &Git, branch: &str, onto: &str, forced: bool) -> Result<RunCtl> {
        let dir = git.cwd().to_path_buf();
        let mut runs = self.runs.lock().unwrap();
        if let Some(s) = runs.get(&dir) {
            return Err(Error::Invalid(format!("AI is already rebasing {} there: wait for it to finish, or abort it.", s.run.branch)));
        }
        let (stop_tx, stop) = tokio::sync::watch::channel(false);
        let (over, over_rx) = tokio::sync::watch::channel(false);
        let run = RebaseRun {
            project_id: p.id.clone(),
            branch: branch.to_string(),
            onto: onto.to_string(),
            step: 0,
            steps: 0,
            subject: String::new(),
            files: Vec::new(),
            resolved: 0,
            resolved_total: 0,
            second_pass: Vec::new(),
            started_at: now(),
            state: RunState::Running,
            error: None,
        };
        runs.insert(dir.clone(), RunSlot { run, told: false, stop: stop_tx, over: over_rx });
        Ok(RunCtl { dir, runs: self.runs.clone(), events: self.events.clone(), stop, over, forced })
    }

    /// The rebases AI is carrying through that the UIs have heard of.
    pub fn rebase_runs(&self) -> Vec<RebaseRun> {
        self.runs.lock().unwrap().values().filter(|s| s.told).map(|s| s.run.clone()).collect()
    }

    /// The branch AI is rebasing in checkout `dir`, if any.
    fn rebasing_in(&self, dir: &Path) -> Option<String> {
        self.runs.lock().unwrap().get(dir).map(|s| s.run.branch.clone())
    }

    /// Ends `ctl`'s run with how `out` went. Asked to stop, the rebase is aborted, unless it was already done.
    async fn finish_rebase(&self, p: &Project, git: &Git, branch: &str, ctl: RunCtl, out: Result<Resolution>) -> Result<RebaseResult> {
        let aborted = ctl.stopped() && git.is_rebasing().await.unwrap_or(false) && git.abort_op("rebase").await.is_ok();
        let resolved = ctl.resolved_total();
        let (state, error) = match &out {
            _ if aborted => (RunState::Aborted, None),
            Ok(r) if r.done => (RunState::Done, None),
            Ok(r) if r.errors.is_empty() => (RunState::Failed, Some(format!("Stopped on conflicts in {}.", r.left.join(", ")))),
            Ok(r) => (RunState::Failed, Some(r.why().trim().to_string())),
            Err(e) => (RunState::Failed, Some(e.to_string())),
        };
        ctl.end(state, error);
        self.changed(&p.id);
        if aborted {
            return Ok(RebaseResult { conflicts: Vec::new(), force_push_to: None, stash_conflicts: Vec::new(), errors: Vec::new(), resolved, aborted: true });
        }
        let r = out?;
        let mut result = Self::rebase_result(git, branch, r.done).await?;
        result.errors = r.errors;
        result.resolved = resolved;
        Ok(result)
    }

    /// What a paused rebase of `branch` replays onto, as a branch: `target` when it is there, else another
    /// branch there (local first), else the commit. None when nothing is being rebased.
    async fn rebasing_onto(git: &Git, branch: &str, target: &str) -> Option<String> {
        let sha = git.rebase_onto().await.ok().flatten()?;
        let at: Vec<String> = git.branches_at(&sha).await.unwrap_or_default().into_iter().filter(|n| n != branch).collect();
        Some(match at.iter().find(|n| *n == target).or(at.first()) {
            Some(n) => n.clone(),
            None => sha.get(..7).unwrap_or(&sha).to_string(),
        })
    }

    /// The other side of `branch`'s conflicts: where its paused rebase goes, else its target.
    async fn conflict_base(&self, p: &Project, git: &Git, branch: &str) -> Result<String> {
        let target = self.base_of(p, branch, &git.default_branch().await?).await;
        Ok(Self::rebasing_onto(git, branch, &target).await.unwrap_or(target))
    }

    async fn rebase_result(git: &Git, branch: &str, done: bool) -> Result<RebaseResult> {
        let mut r = RebaseResult { conflicts: Vec::new(), force_push_to: None, stash_conflicts: Vec::new(), errors: Vec::new(), resolved: 0, aborted: false };
        if !done {
            r.conflicts = git.conflicted_files().await?;
            return Ok(r);
        }
        // A finished rebase exits 0 even when `--autostash` could not put the uncommitted changes back.
        r.stash_conflicts = git.conflicted_files().await?;
        // Its upstream no longer fits under it: the rewritten commits only go up forced.
        // Only to its own copy on origin, the one `Gitnetix::push` force pushes.
        r.force_push_to = match git.upstream(branch).await? {
            Some(u) if u == format!("origin/{branch}") && git.ref_exists(&format!("refs/remotes/{u}")).await? && !git.is_ancestor(&u, branch).await? => Some(u),
            _ => None,
        };
        Ok(r)
    }

    /// Abort the rebase, merge, cherry-pick or revert `branch`'s checkout is stopped in: the branch goes
    /// back to where it was before it started, with the uncommitted changes a rebase stashed. A rebase AI
    /// is carrying through stops first; returns once it is aborted.
    pub async fn abort_in_progress(&self, project_id: &str, branch: &str) -> Result<()> {
        let p = self.store.project(project_id)?;
        if let Some(dir) = self.checkout_dir(&p, branch).await? {
            let over = self.runs.lock().unwrap().get(&dir).map(|s| {
                s.stop.send_replace(true);
                s.over.clone()
            });
            if let Some(mut over) = over {
                let _ = over.wait_for(|o| *o).await;
                return Ok(());
            }
        }
        let git = self.require_checkout(&p, branch).await?;
        let Some(op) = git.in_progress().await? else {
            return Err(Error::Invalid(format!("{branch} is not in the middle of a rebase, merge, cherry-pick or revert")));
        };
        let out = git.abort_op(op).await;
        self.changed(project_id);
        out
    }

    /// Conflicted file `path` in `git`'s checkout with every conflict settled by [`auto_resolve`], in milliseconds:
    /// its index versions merged again, keeping what git leaves to the user when no choice is needed. None when a
    /// conflict needs AI, the file has no base version (both sides added it), or it is no longer what git wrote.
    async fn resolve_without_ai(git: &Git, path: &str) -> Option<String> {
        let content = std::fs::read_to_string(git.cwd().join(path)).ok()?;
        let lines: Vec<&str> = content.lines().collect();
        let conflicts = real_conflicts(&lines, &sides_of(git, path).await);
        let [head, base, incoming] = [2, 1, 3].map(|stage| format!(":{stage}:{path}"));
        let size = format!("--marker-size={}", auto_resolve::MARKER);
        // Histogram, as git's own merge: the same conflicts, so each side of the file can be checked against them.
        let args = ["merge-file", "-p", "-q", "--diff3", "--diff-algorithm=histogram", &size, "--object-id", &head, &base, &incoming];
        // Exits with the number of conflicts; a missing version or an older git says why on stderr.
        let (merged, err) = match git.try_run(&args).await {
            Ok((_, merged, err)) => (merged, err),
            Err(e) => (String::new(), e.to_string()),
        };
        if !err.trim().is_empty() {
            crate::log::info(format!("Left {path} to AI, git could not merge it again: {}", err.trim()));
            return None;
        }
        let out = auto_resolve::resolve(&lines, &conflicts, &merged)?;
        crate::log::info(format!("Resolved {path} without AI: none of its conflicts needed a choice"));
        // `lines()` drops the `\r`: a CRLF file keeps its line endings.
        Some(out.join(if content.contains("\r\n") { "\r\n" } else { "\n" }))
    }

    /// AI's take on conflicted file `path` in `git`'s checkout: the change from `ours` brought onto `theirs`.
    /// AI sees the whole file and answers with edits, not the file: a big file would take minutes to
    /// write back. Edits go anywhere, as resolving may take lines outside the conflicts (a name both
    /// sides declare, an import). An answer that can't be applied is asked again, AI told why.
    async fn propose_resolution(&self, p: &Project, git: &Git, path: &str, ours: &str, theirs: &str) -> Result<String> {
        const TRIES: usize = 3;
        let content = std::fs::read_to_string(git.cwd().join(path))?;
        let lines: Vec<&str> = content.lines().collect();
        let conflicts = real_conflicts(&lines, &sides_of(git, path).await);
        if conflicts.is_empty() {
            return Err(Error::Invalid(format!("{path} has no conflict markers to resolve")));
        }
        let mut t = self.template("conflict", None, Some(&p.id))?;
        t.body = format!("{}\n\n{}", t.body, templates::CONFLICT_EDITS);
        let text: Vec<String> = conflict_regions(&lines, 0).into_iter().filter(|r| !conflicts.contains(r)).map(|(s, e)| format!("{}-{}", s + 1, e)).collect();
        if !text.is_empty() {
            t.body.push_str(&format!("\n\nLines {} of the file show conflict markers as text, not conflicts: leave them exactly as they are.", text.join(", ")));
        }
        // A huge file would not fit some models: its conflicts then, with room around each.
        let (shown, about) = if content.len() <= 200_000 {
            (lines.join("\n"), path.to_string())
        } else {
            let parts: Vec<String> = conflict_regions(&lines, 30).iter().map(|&(s, e)| format!("Lines {}-{} of {}:\n{}", s + 1, e, lines.len(), lines[s..e].join("\n"))).collect();
            (parts.join("\n\n"), format!("{path} (only its conflicts and the lines around them are shown)"))
        };
        let mut why = String::new();
        for n in 1..=TRIES {
            let mut t = t.clone();
            if !why.is_empty() {
                t.body.push_str("\n\nYour last answer could not be applied: {why}. Answer again with every edit.");
            }
            let mut vars = BTreeMap::new();
            vars.insert("conflict".into(), shown.clone());
            vars.insert("path".into(), about.clone());
            vars.insert("ours".into(), ours.to_string());
            vars.insert("theirs".into(), theirs.to_string());
            vars.insert("why".into(), why.clone());
            let answer = self.ask("conflict", &t, vars, "en", None).await?;
            match resolve_answer(&lines, &conflicts, &answer) {
                // `lines()` drops the `\r`: a CRLF file keeps its line endings.
                Ok(out) => return Ok(out.join(if content.contains("\r\n") { "\r\n" } else { "\n" })),
                Err(e) => {
                    let mut said = answer;
                    crate::git::truncate_utf8(&mut said, 4_000);
                    crate::log::error(format!("AI answer for {path} could not be applied (try {n} of {TRIES}): {e}\n{said}"));
                    why = e;
                }
            }
        }
        Err(Error::Ai(format!("No answer in {TRIES} tries could be applied: {why}")))
    }

    /// Write a resolved file and stage it.
    async fn write_resolution(git: &Git, path: &str, content: &str) -> Result<()> {
        let mut body = content.to_string();
        if !body.ends_with('\n') {
            body.push_str(if body.contains("\r\n") { "\r\n" } else { "\n" });
        }
        not_a_link(&git.cwd().join(path))?;
        std::fs::write(git.cwd().join(path), body)?;
        git.add(path).await
    }

    /// AI resolves this project's conflicts on its own: turned on, with an AI set up to run the conflict
    /// template (a CLI one found on this computer), so that every conflict isn't a call bound to fail.
    fn resolves_conflicts(&self, p: &Project) -> bool {
        p.merge.resolve_conflicts
            && self
                .template("conflict", None, Some(&p.id))
                .and_then(|t| self.route("conflict", Some(&t)))
                .is_ok_and(|r| r.method != ConnectMethod::Cli || ai::cli_path(&r.provider).is_ok())
    }

    /// The conflict template's AI asked `body` until `valid` takes an answer, `tries` in all; `{why}` in
    /// the body asked again says why the last answer was turned down. An AI that fails to answer (a
    /// network hiccup, a busy model) is asked again a moment later.
    async fn ask_until<T>(&self, p: &Project, body: &str, vars: BTreeMap<String, String>, tries: usize, valid: impl Fn(&str) -> std::result::Result<T, String>) -> Result<T> {
        // The template's AI and rules, asked a question its text-resolving body doesn't fit.
        let mut t = self.template("conflict", None, Some(&p.id))?;
        let mut why = String::new();
        for n in 1..=tries {
            t.body = if why.is_empty() { body.to_string() } else { format!("{body}\n\nYour last answer could not be used: {{why}}. Answer again.") };
            let mut vars = vars.clone();
            vars.insert("why".into(), why.clone());
            match self.ask("conflict", &t, vars, "en", None).await {
                Ok(answer) => match valid(&answer) {
                    Ok(v) => return Ok(v),
                    Err(e) => {
                        let mut said = answer;
                        crate::git::truncate_utf8(&mut said, 4_000);
                        crate::log::error(format!("AI answer could not be used (try {n} of {tries}): {e}\n{said}"));
                        why = e;
                    }
                },
                Err(e) if n < tries => {
                    crate::log::error(format!("AI did not answer (try {n} of {tries}), asking again: {e}"));
                    tokio::time::sleep(std::time::Duration::from_secs(2 * n as u64)).await;
                }
                Err(e) => return Err(e),
            }
        }
        Err(Error::Ai(format!("No usable answer after {}: {why}", if tries == 1 { "1 try".to_string() } else { format!("{tries} tries") })))
    }

    /// `body`, a question to settle a conflict, as the second pass asks it when `first` (why the first
    /// pass failed) is set: told it has to come to an answer this time.
    fn second_pass_body(body: &str, first: Option<&str>) -> (String, usize) {
        match first {
            Some(_) => (format!("A first try to settle {{path}} failed: {{first}}. This is the second pass: it has to end with an answer.\n\n{body}"), 3),
            None => (body.to_string(), 1),
        }
    }

    /// AI's call on `path`, changed on one side and deleted on the other: keep the changed file, or
    /// delete it. `first`: the second pass, after the first answer could not be used.
    async fn keep_or_delete(&self, p: &Project, git: &Git, path: &str, ours: &str, theirs: &str, first: Option<&str>) -> Result<Fix> {
        // The index stage holding the change: 2 for `theirs`, 3 for `ours`.
        let changed = git.conflict_stages(path).await?.last().copied().unwrap_or(2);
        let (changed_by, deleted_by) = if changed == 3 { (ours, theirs) } else { (theirs, ours) };
        let mut diff = git.run(&["diff", &format!(":1:{path}"), &format!(":{changed}:{path}")]).await?;
        crate::git::truncate_utf8(&mut diff, 60_000);
        let (body, tries) = Self::second_pass_body("{path} was changed by {changed} and deleted by {deleted}. Decide whether the file stays, with that change, or goes.\n\n- keep: the file is still needed and the change still matters\n- delete: the deletion was deliberate and the change is no longer needed, or is already made where the code moved\n\nAnswer with one word: keep or delete.\n\nThe change from {changed}:\n{diff}", first);
        let mut vars = BTreeMap::new();
        vars.insert("path".into(), path.to_string());
        vars.insert("changed".into(), changed_by.to_string());
        vars.insert("deleted".into(), deleted_by.to_string());
        vars.insert("diff".into(), diff);
        vars.insert("first".into(), first.unwrap_or_default().to_string());
        let fix = match self.ask_until(p, &body, vars, tries, |a| pick_word(a, ["keep", "delete"])).await? {
            0 => Fix::Keep,
            _ => Fix::Delete,
        };
        crate::log::info(format!("AI chose to {} {path}, changed by {changed_by} and deleted by {deleted_by}", if matches!(fix, Fix::Keep) { "keep" } else { "delete" }));
        Ok(fix)
    }

    /// AI's call on `path`, changed on both sides where git can't merge it line by line (a binary file,
    /// a symlink, a submodule): which side's version stays whole. `first`: the second pass, after the
    /// first answer could not be used.
    async fn pick_side(&self, p: &Project, git: &Git, path: &str, ours: &str, theirs: &str, first: Option<&str>) -> Result<Fix> {
        let size = |stage: u8| async move { git.run(&["cat-file", "-s", &format!(":{stage}:{path}")]).await.map_or_else(|_| "?".to_string(), |s| s.trim().to_string()) };
        // The commit being brought in, when the operation has one (a stash pop has none).
        let mut other = None;
        for head in ["REBASE_HEAD", "CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD"] {
            if git.try_run(&["rev-parse", "--verify", "-q", head]).await?.0 {
                other = Some(head);
                break;
            }
        }
        let log = |range: String| async move {
            let (_, out, _) = git.try_run(&["log", "-5", "--format=- %s", &range, "--", path]).await.unwrap_or_default();
            if out.trim().is_empty() { "(nothing known)".to_string() } else { out.trim_end().to_string() }
        };
        let (incoming_log, current_log) = match other {
            Some(o) => (log(format!("HEAD..{o}")).await, log(format!("{o}..HEAD")).await),
            None => ("(nothing known)".to_string(), "(nothing known)".to_string()),
        };
        let (body, tries) = Self::second_pass_body("{path} can't be merged line by line (a binary file, a symlink or a submodule) and both sides changed it: one version stays whole.\n\n- incoming: the version from {incoming} ({incoming_size} bytes), changed by:\n{incoming_log}\n- current: the version on {current} ({current_size} bytes), changed by:\n{current_log}\n\nKeep incoming when its change is the one that matters (a new or updated asset), current when the incoming change is outdated or already redone there.\n\nAnswer with one word: incoming or current.", first);
        let mut vars = BTreeMap::new();
        vars.insert("path".into(), path.to_string());
        vars.insert("incoming".into(), ours.to_string());
        vars.insert("current".into(), theirs.to_string());
        vars.insert("incoming_size".into(), size(3).await);
        vars.insert("current_size".into(), size(2).await);
        vars.insert("incoming_log".into(), incoming_log);
        vars.insert("current_log".into(), current_log);
        vars.insert("first".into(), first.unwrap_or_default().to_string());
        let stage = if self.ask_until(p, &body, vars, tries, |a| pick_word(a, ["incoming", "current"])).await? == 0 { 3 } else { 2 };
        crate::log::info(format!("AI kept the {} version of {path} ({} onto {theirs})", if stage == 3 { "incoming" } else { "current" }, ours));
        Ok(Fix::Side(stage))
    }

    /// AI's fix for conflicted `path`, by what the index holds of it: text with conflict markers gets
    /// resolved, without AI when none of its conflicts needs a choice; changed on one side and deleted on
    /// the other, it stays or goes; changed on both sides with no markers to work from (binary, symlink),
    /// one side's version stays. What both sides deleted goes, what one side added stays (the halves of a
    /// file both sides renamed).
    async fn fix_for(&self, p: &Project, git: &Git, path: &str, ours: &str, theirs: &str) -> Result<Fix> {
        let stages = git.conflict_stages(path).await?;
        let marked = || std::fs::read_to_string(git.cwd().join(path)).is_ok_and(|c| c.contains("<<<<<<<"));
        match stages.as_slice() {
            [1] => Ok(Fix::Delete),
            [2] | [3] => Ok(Fix::Keep),
            [1, 2 | 3] => self.keep_or_delete(p, git, path, ours, theirs, None).await,
            _ if marked() => match Self::resolve_without_ai(git, path).await {
                Some(text) => Ok(Fix::Text(text)),
                None => self.propose_resolution(p, git, path, ours, theirs).await.map(Fix::Text),
            },
            [.., 2, 3] => self.pick_side(p, git, path, ours, theirs, None).await,
            _ => Err(Error::Invalid("no conflict markers to resolve".into())),
        }
    }

    /// The second pass on conflicted `path`, whose first answer could not be used (`first` says why): AI is
    /// asked again until it settles it, in a form that can't fail to apply, its answers turned down told why.
    async fn settle(&self, p: &Project, git: &Git, path: &str, ours: &str, theirs: &str, first: &str) -> Result<Fix> {
        let stages = git.conflict_stages(path).await?;
        let marked = || std::fs::read_to_string(git.cwd().join(path)).is_ok_and(|c| c.contains("<<<<<<<"));
        match stages.as_slice() {
            [1, 2 | 3] => self.keep_or_delete(p, git, path, ours, theirs, Some(first)).await,
            _ if marked() => self.resolve_by_conflict(p, git, path, ours, theirs, first).await.map(Fix::Text),
            [.., 2, 3] => self.pick_side(p, git, path, ours, theirs, Some(first)).await,
            _ => self.fix_for(p, git, path, ours, theirs).await,
        }
    }

    /// The second pass on text file `path`, whose edits could not be applied: AI answers for one conflict
    /// at a time with the lines that take its place, which always fit there.
    async fn resolve_by_conflict(&self, p: &Project, git: &Git, path: &str, ours: &str, theirs: &str, first: &str) -> Result<String> {
        const AROUND: usize = 30;
        let content = std::fs::read_to_string(git.cwd().join(path))?;
        let lines: Vec<&str> = content.lines().collect();
        let conflicts = real_conflicts(&lines, &sides_of(git, path).await);
        if conflicts.is_empty() {
            return Err(Error::Invalid(format!("{path} has no conflict markers to resolve")));
        }
        let body = "This is the second pass on the conflicts in {path}, between {ours} and {theirs}: resolving the whole file at once failed ({first}). It goes one conflict at a time, and has to end with a resolution.\n\nIn a conflict, the lines after <<<<<<< come from {theirs} and the lines after ======= from {ours}; a ||||||| section, when there is one, holds the text both started from.\n\nThe lines before it:\n{before}\n\nConflict {n} of {count}:\n{conflict}\n\nThe lines after it:\n{after}\n\nAnswer with only the lines that take this conflict's place, from its <<<<<<< line to its >>>>>>> line: what both sides meant, with no conflict markers, code fences or explanations. When no line should stay there, answer [[NOTHING]].";
        let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        // From the last conflict up: each one swapped leaves the lines above it where they were.
        for (i, &(s, e)) in conflicts.iter().enumerate().rev() {
            let mut vars = BTreeMap::new();
            vars.insert("path".into(), path.to_string());
            vars.insert("ours".into(), ours.to_string());
            vars.insert("theirs".into(), theirs.to_string());
            vars.insert("first".into(), first.to_string());
            vars.insert("before".into(), lines[s.saturating_sub(AROUND)..s].join("\n"));
            vars.insert("conflict".into(), lines[s..e].join("\n"));
            vars.insert("after".into(), lines[e..(e + AROUND).min(lines.len())].join("\n"));
            vars.insert("n".into(), (i + 1).to_string());
            vars.insert("count".into(), conflicts.len().to_string());
            let new = self.ask_until(p, body, vars, 3, conflict_answer).await?;
            out.splice(s..e, new);
        }
        crate::log::info(format!("AI resolved {path} one conflict at a time, in the second pass"));
        // `lines()` drops the `\r`: a CRLF file keeps its line endings.
        Ok(out.join(if content.contains("\r\n") { "\r\n" } else { "\n" }))
    }

    /// AI's fixes for conflicted `files` in `git`'s checkout, `AT_ONCE` asked at a time. `ctl`'s run counts each answer.
    async fn ask_fixes(&self, p: &Project, git: &Git, files: &[String], ours: &str, theirs: &str, ctl: Option<&RunCtl>) -> Vec<(String, Result<Fix>)> {
        // Each file is its own call on its own text, so none waits on another's answer: 6 files took two rounds at 3 (AI-19).
        const AT_ONCE: usize = 6;
        // A rebase run shows its own progress.
        if ctl.is_none() {
            let _ = self.events.send(Event::ConflictResolving { project_id: p.id.clone(), files: files.to_vec() });
        }
        crate::log::info(format!("Will attempt to resolve conflicts with AI in {} ({ours} onto {theirs}): {}", git.cwd().display(), files.join(", ")));
        let counted = |r: &Result<Fix>| {
            if let (Some(c), Ok(_)) = (ctl, r) {
                c.report(|run| {
                    run.resolved += 1;
                    run.resolved_total += 1;
                });
            }
        };
        // Unordered: a slow file holds up no other, the next one starts as soon as any answer is in. Back in `files`' order after.
        let in_order = |mut a: Vec<(String, Result<Fix>)>| {
            a.sort_by_key(|(f, _)| files.iter().position(|x| x == f));
            a
        };
        let answers: Vec<(String, Result<Fix>)> = in_order(
            stream::iter(files.to_vec())
                .map(|f| async move {
                    let r = self.fix_for(p, git, &f, ours, theirs).await;
                    counted(&r);
                    (f, r)
                })
                .buffer_unordered(AT_ONCE)
                .collect()
                .await,
        );
        // What the first pass could not settle gets a second one, which has to.
        let again: Vec<String> = answers.iter().filter(|(_, r)| r.is_err()).map(|(f, _)| f.clone()).collect();
        if again.is_empty() {
            return answers;
        }
        crate::log::info(format!("Second pass with AI on {}", again.join(", ")));
        if let Some(c) = ctl {
            c.report(|run| run.second_pass = again.clone());
        }
        let answers = in_order(
            stream::iter(answers)
                .map(|(f, r)| async move {
                    let r = match r {
                        Err(e) => {
                            let r = self.settle(p, git, &f, ours, theirs, &e.to_string()).await;
                            counted(&r);
                            r
                        }
                        done => done,
                    };
                    (f, r)
                })
                .buffer_unordered(AT_ONCE)
                .collect()
                .await,
        );
        if let Some(c) = ctl {
            c.report(|run| run.second_pass.clear());
        }
        answers
    }

    /// Writes and stages each of AI's fixes, one by one as `git add` takes the index lock. Returns "path: why"
    /// for each file it could not resolve, left as it was.
    async fn apply_fixes(&self, p: &Project, git: &Git, answers: Vec<(String, Result<Fix>)>) -> Vec<String> {
        let mut failed = Vec::new();
        for (f, r) in answers {
            if let Err(e) = match r {
                Ok(Fix::Text(body)) => Self::write_resolution(git, &f, &body).await,
                Ok(Fix::Keep) => git.add(&f).await,
                Ok(Fix::Delete) => git.run(&["rm", "-q", "--", &f]).await.map(|_| ()),
                Ok(Fix::Side(stage)) => git.take_stage(&f, stage).await,
                Err(e) => Err(e),
            } {
                crate::log::error(format!("Could not resolve {f}: {e}"));
                failed.push(format!("{f}: {e}"));
            } else {
                crate::log::info(format!("Resolved and staged {f}"));
            }
        }
        self.changed(&p.id);
        failed
    }

    /// AI resolves what `op` stopped on in `git`'s checkout, then `op` carries on, through every commit
    /// a rebase stops on, until it's done. `op` None has nothing to carry on (a stash). Stops, `op` left
    /// in progress, when AI is off for the project, could not resolve a file, or `ctl`'s run was asked to stop.
    async fn resolve_and_continue(&self, p: &Project, git: &Git, op: Option<&str>, ours: &str, theirs: &str, ctl: Option<&RunCtl>) -> Result<Resolution> {
        let on = ctl.is_some_and(|c| c.forced) || self.resolves_conflicts(p);
        loop {
            let files = git.conflicted_files().await?;
            if ctl.is_some_and(RunCtl::stopped) {
                return Ok(Resolution { done: false, left: files, errors: Vec::new() });
            }
            if !files.is_empty() {
                if !on {
                    return Ok(Resolution { done: false, left: files, errors: Vec::new() });
                }
                if let Some(c) = ctl {
                    let step = if op == Some("rebase") { git.rebase_step().await.ok().flatten() } else { None };
                    let subject = git.rebase_subject().await.unwrap_or_default();
                    c.report(|run| {
                        (run.step, run.steps) = step.unwrap_or((0, 0));
                        run.subject = subject;
                        run.files = files.clone();
                        run.resolved = 0;
                    });
                }
                let asking = self.ask_fixes(p, git, &files, ours, theirs, ctl);
                // A stop drops the AI calls in flight (their processes with them); nothing is written yet.
                let answers = match ctl {
                    Some(c) => tokio::select! {
                        a = asking => a,
                        () = c.on_stop() => return Ok(Resolution { done: false, left: files, errors: Vec::new() }),
                    },
                    None => asking.await,
                };
                let errors = self.apply_fixes(p, git, answers).await;
                if !errors.is_empty() {
                    return Ok(Resolution { done: false, left: git.conflicted_files().await?, errors });
                }
            }
            let done = match op {
                Some(op) => git.continue_op(op).await?,
                None => true,
            };
            if done {
                return Ok(Resolution { done, left: Vec::new(), errors: Vec::new() });
            }
        }
    }

    /// Like [`Self::resolve_and_continue`], except `op` is aborted unless it goes through, the checkout
    /// back as it was before it; `refusal` words the error then.
    async fn resolve_or_abort(&self, p: &Project, git: &Git, op: &str, ours: &str, theirs: &str, refusal: impl FnOnce(&Resolution) -> String) -> Result<()> {
        match self.resolve_and_continue(p, git, Some(op), ours, theirs, None).await {
            Ok(r) if r.done => Ok(()),
            r => {
                let _ = git.abort_op(op).await;
                Err(match r {
                    Ok(r) => Error::Invalid(refusal(&r)),
                    Err(e) => e,
                })
            }
        }
    }

    // ---------- releases ----------

    /// Version for a new release, from the highest one around (tags, release branches here or on origin,
    /// releases Gitnetix knows): major and minor bump that one, patch bumps the patch of the highest version tag.
    pub async fn suggest_version(&self, project_id: &str, bump: Bump) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let (tags, local, remote) = tokio::try_join!(git.tags(), git.branches(), git.remote_branches())?;
        let mut taken: Vec<[u64; 3]> = tags.iter().filter_map(|t| parse_version(&t.name)).collect();
        let latest_tag = taken.iter().max().copied();
        taken.extend(p.releases.iter().filter_map(|r| parse_version(&r.version)));
        let names = local.into_iter().chain(remote).map(|b| b.name);
        taken.extend(names.filter_map(|n| n.strip_prefix("release/").and_then(parse_version)));
        let v = match bump {
            Bump::Major => [taken.iter().map(|v| v[0]).max().unwrap_or(0) + 1, 0, 0],
            Bump::Minor => taken.iter().max().map(|v| [v[0], v[1] + 1, 0]).unwrap_or([0, 1, 0]),
            // Hotfixes patch what shipped; skip past patches already taken by another hotfix.
            Bump::Patch => {
                let mut v = latest_tag.unwrap_or([0, 0, 0]);
                v[2] += 1;
                while taken.contains(&v) {
                    v[2] += 1;
                }
                v
            }
        };
        Ok(format!("{}.{}.{}", v[0], v[1], v[2]))
    }

    pub async fn create_release(&self, project_id: &str, version: &str, kind: ReleaseKind, from: Option<String>) -> Result<Release> {
        let version = version.trim().trim_start_matches('v').to_string();
        if !valid_version(&version) {
            return Err(Error::Invalid("Version like 2.4.0".into()));
        }
        let p = self.store.project(project_id)?;
        if p.releases.iter().any(|r| r.version == version && r.shipped_at.is_none()) {
            return Err(Error::Invalid(format!("Release {version} already exists")));
        }
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let from = match from.filter(|s| !s.is_empty()) {
            Some(f) => f,
            None if kind == ReleaseKind::Hotfix => hotfix_base(&git.tags().await?, &version).unwrap_or(default.clone()),
            None => default.clone(),
        };
        let branch = release_branch(&version);
        if !git.ref_exists(&format!("refs/heads/{branch}")).await? {
            git.create_branch(&branch, &from).await?;
        }
        let r = Release { version, kind, branch, base: default, created_at: now(), shipped_at: None, tag: None };
        self.store.with_project(project_id, |p| {
            p.forgotten_releases.retain(|f| *f != r.version);
            p.releases.push(r.clone());
            Ok(())
        })?;
        let mut vars = hook_vars(&p, &r.branch);
        vars.push(("VERSION", r.version.clone()));
        hooks::spawn(&p, "releaseCreated", &top_path(&p), vec![vars]);
        self.changed(project_id);
        Ok(r)
    }

    /// Ship: date the release's CHANGELOG.md entry, move the default branch to the
    /// release (fast-forward only), tag it, optionally push both.
    pub async fn ship_release(&self, project_id: &str, version: &str, push: bool) -> Result<String> {
        let p = self.store.project(project_id)?;
        let r = p
            .releases
            .iter()
            .find(|r| r.version == version && r.shipped_at.is_none())
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("open release {version}")))?;
        self.refuse_locked(project_id, &r.branch)?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        if !git.is_ancestor(&default, &r.branch).await? {
            return Err(Error::Invalid(format!(
                "{default} has commits that are not in {}. Merge {default} into the release first.",
                r.branch
            )));
        }
        // Checked before anything moves: a refused push would leave main moved and tagged here only.
        if push {
            git.fetch().await?;
            let theirs = format!("refs/remotes/origin/{default}");
            if git.ref_exists(&theirs).await? && !git.is_ancestor(&theirs, &r.branch).await? {
                return Err(Error::Invalid(format!(
                    "origin/{default} has commits that are not in {}. Merge origin/{default} into the release first.",
                    r.branch
                )));
            }
        }
        refuse_tagged(&git, version).await?;
        let tag = release_tag(use_v(&p, &git).await?, version);
        let default_dir = self.checkout_dir(&p, &default).await?;
        if let Some(dir) = &default_dir {
            self.check_wip_clear(dir, &r.branch, &default).await?;
            // The stamp below changes it on the release after this check.
            clean_changelog(&self.git_at(dir), dir).await?;
        }
        self.stamp_release_changelog(&p, &git, &r.branch, version, &format!("docs(changelog): release {tag}")).await?;
        let sha = git.rev_parse(&r.branch).await?;
        git.tag(&tag, &sha, &format!("Release {tag}")).await?;
        // Origin before this repo: when the push is refused, main and the tag stay as they were here, so the release
        // stays open and Ship can run again (a local tag alone would mark it shipped).
        if push {
            if let Err(e) = git.push_atomic(&[&format!("{sha}:refs/heads/{default}"), &format!("refs/tags/{tag}")]).await {
                let _ = git.delete_tag(&tag).await;
                return Err(e);
            }
        }
        match default_dir {
            Some(dir) => Git::new(&dir).merge_ff_only(&r.branch).await?,
            None => {
                git.update_ref(&format!("refs/heads/{default}"), &sha).await?;
                // Same commit, so the switch keeps any local changes.
                if let Some(dir) = self.checkout_dir(&p, &r.branch).await? {
                    Git::new(&dir).switch(&default).await?;
                }
            }
        }
        self.store.with_project(project_id, |p| {
            if let Some(x) = p.releases.iter_mut().find(|x| x.version == version && x.shipped_at.is_none()) {
                x.shipped_at = Some(now());
                x.tag = Some(tag.clone());
            }
            Ok(())
        })?;
        let mut vars = hook_vars(&p, &r.branch);
        vars.extend([("VERSION", version.to_string()), ("TAG", tag.clone())]);
        hooks::spawn(&p, "releasePublished", &top_path(&p), vec![vars]);
        self.changed(project_id);
        Ok(tag)
    }

    /// Publish `branch` as `version`, any branch (a release one too): date its CHANGELOG.md entry in a
    /// commit on it, tag its tip, and push the branch (to its own name on origin, which it tracks from then
    /// on) and the tag together. No other branch moves. `v`: the tag starts with "v"; None follows the
    /// project's choice. `ai_changelog`: AI first adds the branch's changes to the Unreleased section of its
    /// CHANGELOG.md, once every check passed, following `ai_request` when it is not empty. Refused before
    /// anything changes while its checkout is in the middle of a rebase, merge, cherry-pick or revert. A step
    /// failing later, a refused push too, puts the branch back where it was, untagged, its release still open.
    /// `custom`: the tag's full name, taken as written instead of `version` and `v`; the changelog then dates
    /// it without a "v" before a digit.
    pub async fn publish_branch(&self, project_id: &str, branch: &str, version: &str, v: Option<bool>, custom: Option<&str>, ai_changelog: bool, ai_request: &str) -> Result<Published> {
        self.refuse_locked(project_id, branch)?;
        if !self.publishing.lock().unwrap().insert(project_id.to_string()) {
            return Err(Error::Invalid("A tag is already being created in this project. Wait for it to finish.".into()));
        }
        let _publishing = Publishing(&self.publishing, project_id.to_string());
        let custom = custom.map(str::trim).filter(|t| !t.is_empty());
        let version = match custom {
            // Same characters as a branch name (no leading "-", read as an option); git also refuses a leading or trailing ".".
            Some(t) if !valid_branch_name(t) || t.starts_with('.') || t.ends_with('.') => {
                return Err(Error::Invalid("Not a tag name git takes: letters, digits, dots, dashes, underscores or slashes, not starting with a dash or a dot.".into()));
            }
            Some(t) => t.strip_prefix('v').filter(|r| r.starts_with(|c: char| c.is_ascii_digit())).unwrap_or(t),
            None => {
                let version = version.trim();
                let version = version.strip_prefix('v').unwrap_or(version);
                if !publishable_version(version) {
                    return Err(Error::Invalid("Not a version git can tag: a digit first, then letters, digits, dots or dashes, like 2.4.0.".into()));
                }
                version
            }
        };
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let local = format!("refs/heads/{branch}");
        if !git.ref_exists(&local).await? {
            return Err(Error::NotFound(format!("local branch {branch}")));
        }
        if let Some(r) = p.releases.iter().find(|r| r.version == version && r.shipped_at.is_none() && r.branch != branch) {
            // Already merged into this branch (a release merged into main, main published): publishing here
            // releases it, and it is marked shipped below.
            // Imported releases may only be on origin.
            if !release_merged_in(&git, &git.rev_of(&r.branch).await, &local).await {
                return Err(Error::Invalid(format!("{version} is the open release of {}. Create its tag from that branch, merge it into {branch} first (a squash merge does not count), or pick another version.", r.branch)));
            }
        }
        if let Some(dir) = self.checkout_dir(&p, branch).await? {
            refuse_in_progress(&self.git_at(&dir), &dir, branch).await?;
        }
        // Checked before anything is committed or tagged, so a refusal leaves the branch as it was.
        let origin = git.remote_url("origin").await?.is_some();
        if origin {
            // Origin's tags too: one it has already is refused below.
            git.fetch().await?;
            // Its own name there, whatever it tracks: a branch started from origin/main must not move main.
            let theirs = format!("refs/remotes/origin/{branch}");
            if git.ref_exists(&theirs).await? && !git.is_ancestor(&theirs, &local).await? {
                return Err(Error::Invalid(format!("origin/{branch} has commits that are not in {branch}. Pull first.")));
            }
        }
        refuse_tagged(&git, version).await?;
        let tag = match (custom, v) {
            (Some(t), _) => t.to_string(),
            (None, Some(v)) => release_tag(v, version),
            (None, None) => release_tag(use_v(&p, &git).await?, version),
        };
        let before = git.rev_parse(&local).await?;
        // The last commit publishing made, each on the one before: where a failure takes the branch back from.
        let mut tip = before.clone();
        // The tag is this publish's own once created: only then does a failure delete it.
        let mut tagged = false;
        let done: Result<bool> = async {
            if ai_changelog && git.show_file(branch, CHANGELOG).await?.is_some() {
                match self.update_changelog(project_id, branch, ai_request).await {
                    // Nothing new since its base or latest tag: the entries already listed get dated.
                    Err(Error::Invalid(m)) if m.starts_with(&format!("{branch} has no commits since ")) => {}
                    r => {
                        r?;
                    }
                }
                tip = own_commit(&git, &local, &tip, branch).await?;
            }
            let changelog = self.stamp_release_changelog(&p, &git, branch, version, &format!("docs(changelog): release {tag}")).await?;
            tip = own_commit(&git, &local, &tip, branch).await?;
            git.tag(&tag, &tip, &format!("Release {tag}")).await?;
            tagged = true;
            if origin {
                // All or nothing: a tag on origin without its changelog commit, or the reverse, never happens.
                // An origin without `--atomic` gets the commit first: only the tag can be missing.
                git.push_atomic(&[&format!("{tip}:refs/heads/{branch}"), &format!("refs/tags/{tag}")]).await?;
            }
            Ok(changelog)
        }
        .await;
        let changelog = match done {
            Ok(c) => c,
            Err(e) => {
                self.undo_publish(&p, branch, version, &tag, tagged, &before, &tip).await;
                self.changed(project_id);
                return Err(e);
            }
        };
        if origin {
            let own = format!("origin/{branch}");
            if git.upstream(branch).await.ok().flatten().as_deref() != Some(own.as_str()) {
                if let Err(e) = git.set_upstream(branch, &own).await {
                    crate::log::error(format!("Created {tag}, but {branch} could not track {own}: {e}"));
                }
            }
        }
        // This branch's own release, or one merged into it (any other open one of this version was refused above).
        self.store.with_project(project_id, |p| {
            if let Some(r) = p.releases.iter_mut().find(|r| r.version == version && r.shipped_at.is_none()) {
                r.shipped_at = Some(now());
                r.tag = Some(tag.clone());
            }
            Ok(())
        })?;
        let mut vars = hook_vars(&p, branch);
        vars.extend([("VERSION", version.to_string()), ("TAG", tag.clone())]);
        hooks::spawn(&p, "releasePublished", &top_path(&p), vec![vars]);
        self.changed(project_id);
        Ok(Published { tag, pushed: origin, changelog })
    }

    /// Take back what a failed [`Self::publish_branch`] did: its tag (any `tag` there is its own: it was
    /// refused when tagged already), its commits (the branch goes from `tip`, the last one it made, back to
    /// `before`) and the shipped mark an overview may have put on the branch's open release meanwhile.
    /// What can't be undone is logged: the publish error matters more.
    async fn undo_publish(&self, p: &Project, branch: &str, version: &str, tag: &str, tagged: bool, before: &str, tip: &str) {
        let git = self.git(p);
        if tagged {
            if let Err(e) = git.delete_tag(tag).await {
                crate::log::error(format!("Creating {tag} failed, and its tag could not be deleted: {e}"));
            }
        }
        if tip != before {
            if let Err(e) = self.roll_back(p, &git, branch, before, tip).await {
                crate::log::error(format!("Creating {tag} failed, and {branch} could not go back to {before}: {e}"));
            }
        }
        // Its own release or one merged into it; the tag tells the overview's mark from an older one.
        if p.releases.iter().any(|r| r.version == version && r.shipped_at.is_none()) {
            let reopened = self.store.with_project(&p.id, |p| {
                for r in p.releases.iter_mut().filter(|r| r.version == version && r.tag.as_deref() == Some(tag)) {
                    r.shipped_at = None;
                    r.tag = None;
                }
                Ok(())
            });
            if let Err(e) = reopened {
                crate::log::error(format!("Creating {tag} failed, and release {version} could not be reopened: {e}"));
            }
        }
    }

    /// Move `branch` from `tip` back to `before`, only while it is still on `tip`. In its checkout only
    /// CHANGELOG.md goes back with it (the only file publishing commits), the rest of the index and the
    /// working tree stay; refused while an operation is in progress there or CHANGELOG.md was edited since.
    async fn roll_back(&self, p: &Project, git: &Git, branch: &str, before: &str, tip: &str) -> Result<()> {
        match self.checkout_dir(p, branch).await? {
            Some(dir) => {
                let g = self.git_at(&dir);
                // Nothing the user started there since, and CHANGELOG.md as publishing left it: publishing's
                // commits only touch that file, so it alone goes back; the rest of the index stays as staged.
                refuse_in_progress(&g, &dir, branch).await?;
                clean_changelog(&g, &dir).await?;
                git.update_ref_from(&format!("refs/heads/{branch}"), before, tip).await?;
                g.run(&["restore", "--source", before, "--staged", "--worktree", "--", CHANGELOG]).await.map(|_| ())
            }
            None => git.update_ref_from(&format!("refs/heads/{branch}"), before, tip).await,
        }
    }

    /// Move the `Unreleased` entries of an open release's CHANGELOG.md into its version's
    /// section, committed on the release branch, ahead of shipping it.
    pub async fn release_changelog(&self, project_id: &str, version: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let r = p
            .releases
            .iter()
            .find(|r| r.version == version && r.shipped_at.is_none())
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("open release {version}")))?;
        let git = self.git(&p);
        let text = git.show_file(&r.branch, CHANGELOG).await?.ok_or_else(|| Error::Invalid(format!("{} has no {CHANGELOG}", r.branch)))?;
        let merging = text.lines().any(|l| l.trim_start().starts_with(&format!("## [{version}]")));
        let tag = release_tag(use_v(&p, &git).await?, version);
        if !self.stamp_release_changelog(&p, &git, &r.branch, version, &format!("docs(changelog): release {tag}")).await? {
            return Ok(format!("Nothing under Unreleased to move into {version}"));
        }
        self.changed(project_id);
        let verb = if merging { "merged" } else { "moved" };
        Ok(format!("Unreleased changes {verb} into {version} on {}", r.branch))
    }

    /// Merge the `Unreleased` entries of `branch`'s CHANGELOG.md into its latest version's
    /// section, committed on the branch (see `stamp_release_changelog`).
    pub async fn changelog_into_latest(&self, project_id: &str, branch: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let text = git.show_file(branch, CHANGELOG).await?.ok_or_else(|| Error::Invalid(format!("{branch} has no {CHANGELOG}")))?;
        let version = latest_changelog_version(&text).ok_or_else(|| Error::Invalid(format!("{CHANGELOG} on {branch} lists no version yet")))?;
        let tag = release_tag(use_v(&p, &git).await?, &version);
        if !self.stamp_release_changelog(&p, &git, branch, &version, &format!("docs(changelog): add unreleased changes to {tag}")).await? {
            return Ok(format!("Nothing under Unreleased to add to {version}"));
        }
        self.changed(project_id);
        Ok(format!("Unreleased changes merged into {version} on {branch}"))
    }

    /// Turn the `Unreleased` section of `branch`'s CHANGELOG.md into `version`'s (dated today when
    /// new), and commit that on the branch. When the version already lists entries, AI merges both
    /// (each change once, highlights first); without AI, or when it fails, `merge_sections` does.
    /// False (no-op) without a changelog or entries.
    async fn stamp_release_changelog(&self, p: &Project, git: &Git, branch: &str, version: &str, message: &str) -> Result<bool> {
        let Some(text) = git.show_file(branch, CHANGELOG).await? else { return Ok(false) };
        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let Some(mut stamped) = stamp_changelog(&text, version, &date) else { return Ok(false) };
        let released = section_body(&text, version);
        if !released.is_empty() {
            if let Some(body) = self.merge_changelog_ai(p, version, &released, &section_body(&text, "unreleased")).await {
                stamped = replace_section(&stamped, version, &body);
            }
        }
        self.commit_changelog(p, git, branch, &stamped, message).await?;
        Ok(true)
    }

    /// `released` and `unreleased` entries merged by AI into one body for `version`'s section.
    /// None without AI, when it fails, or when the answer is not a section body.
    async fn merge_changelog_ai(&self, p: &Project, version: &str, released: &str, unreleased: &str) -> Option<String> {
        let mut t = self.template("changelogMerge", None, Some(&p.id)).ok()?;
        if [released, unreleased].iter().any(|s| s.lines().any(|l| l.starts_with("### ") && l.trim_end().ends_with(')'))) {
            t.body.push_str("\n\nThe headings name a project in parentheses, like \"### Added (App)\". Keep them: combine entries only under headings of the same project, and keep each project's headings apart, in the order the existing headings follow.");
        }
        let mut vars = BTreeMap::new();
        vars.insert("version".into(), version.into());
        vars.insert("released".into(), released.into());
        vars.insert("unreleased".into(), unreleased.into());
        let out = self.ask("release", &t, vars, &p.gen_lang.release, None).await.ok()?;
        let out = section_lines(&out);
        // Some models repeat the heading they were told to leave out.
        let body = if out.starts_with("## [") { out.split_once('\n').map_or("", |(_, b)| b).trim() } else { &out };
        if body.is_empty() || body.lines().any(|l| l.trim_start().starts_with("## ")) {
            crate::log::error(format!("AI changelog merge for {version} was not a section body; merged without AI"));
            return None;
        }
        Some(body.to_string())
    }

    /// Commit `text` as `branch`'s CHANGELOG.md: in its checkout when it has one, else straight onto the branch.
    async fn commit_changelog(&self, p: &Project, git: &Git, branch: &str, text: &str, message: &str) -> Result<()> {
        match self.checkout_dir(p, branch).await? {
            Some(dir) => {
                let g = self.git_at(&dir);
                refuse_in_progress(&g, &dir, branch).await?;
                clean_changelog(&g, &dir).await?;
                not_a_link(&dir.join(CHANGELOG))?;
                tokio::fs::write(dir.join(CHANGELOG), text).await?;
                if let Err(e) = g.commit_paths(&[CHANGELOG], message).await {
                    // Clean before the write, so HEAD's copy is the user's: a refused commit (a hook) leaves nothing half done.
                    if let Err(r) = g.run(&["checkout", "HEAD", "--", CHANGELOG]).await {
                        crate::log::error(format!("{CHANGELOG} could not be put back at {} after a failed commit: {r}", dir.display()));
                    }
                    return Err(e);
                }
                Ok(())
            }
            None => git.commit_root_file(branch, CHANGELOG, text, message).await.map(|_| ()),
        }
    }

    pub fn delete_release(&self, project_id: &str, version: &str) -> Result<()> {
        self.store.with_project(project_id, |p| {
            p.releases.retain(|r| !(r.version == version && r.shipped_at.is_none()));
            if !p.forgotten_releases.iter().any(|f| f == version) {
                p.forgotten_releases.push(version.into());
            }
            Ok(())
        })?;
        self.changed(project_id);
        Ok(())
    }

    /// `kind`: the type the user picked, which the name keeps. None: AI picks the type among the project's branch types.
    pub async fn suggest_branch_name(&self, project_id: &str, kind: Option<&str>, description: &str, ticket: Option<&str>) -> Result<(String, bool)> {
        let p = self.store.project(project_id)?;
        let t = self.template("branch", None, Some(&p.id))?;
        let max_words = templates::rule_num(&t, "maxWords").unwrap_or(4) as usize;
        let kind = kind.and_then(type_of);
        let types: Vec<String> = match &kind {
            Some(k) => vec![k.clone()],
            None => p.branch_types.list.iter().map(|t| t.id.clone()).filter(|id| id != "release").collect(),
        };
        let kind = kind.unwrap_or_else(|| p.branch_types.first());
        // The ticket key is added by with_ticket when the branch is created.
        let fallback = || format!("{kind}/{}", slugify(description, max_words));
        let mut vars = BTreeMap::new();
        vars.insert("description".into(), description.to_string());
        vars.insert("type".into(), kind.clone());
        vars.insert("types".into(), types.join(", "));
        vars.insert("ticket".into(), ticket.unwrap_or("").to_string());
        match self.ask("branch", &t, vars, "en", None).await {
            Ok(name) => {
                let name = offered_type(name.lines().next().unwrap_or("").trim().trim_matches('`'), &types, &kind);
                if valid_branch_name(&name) && name.contains('/') {
                    Ok((name, true))
                } else {
                    Ok((fallback(), false))
                }
            }
            Err(_) => Ok((fallback(), false)),
        }
    }

    pub async fn create_item(&self, project_id: &str, req: NewItem) -> Result<NewItemResult> {
        let p = self.store.project(project_id)?;
        if let Some(rules) = self.policies(&p.id) {
            crate::account::check_branch_type(&rules, &req.kind)?;
        }
        let git = self.git(&p);
        let release = match req.release.trim() {
            "" => None,
            v => Some(
                p.releases
                    .iter()
                    .find(|r| r.version == v && r.shipped_at.is_none())
                    .cloned()
                    .ok_or_else(|| Error::NotFound(format!("open release {v}")))?,
            ),
        };
        // Without a release, the branch starts from (and later merges into) `from`.
        // A tag can't take merges: a branch started from one merges into the default branch.
        let (start, merge_into) = match &release {
            Some(r) => (r.branch.clone(), None),
            None => match req.from.clone().filter(|f| !f.trim().is_empty()) {
                Some(f) => match git.branch_rev(&f).await? {
                    Some(rev) => (rev.clone(), Some(rev.trim_start_matches("origin/").to_string())),
                    None if git.ref_exists(&format!("refs/tags/{f}")).await? => (format!("refs/tags/{f}"), Some(git.default_branch().await?)),
                    None => return Err(Error::NotFound(format!("branch or tag {f}"))),
                },
                None => {
                    let d = git.default_branch().await?;
                    (d.clone(), Some(d))
                }
            },
        };
        let from_shipped = start.starts_with("refs/tags/") || (req.shipped && req.at.is_some());
        // A commit picked in a commit list: the branch starts there and still merges where `from` said.
        let start = match req.at.as_deref() {
            Some(sha) => check_sha(sha)?.to_string(),
            None => start,
        };
        // No kind sent: when AI names the branch, it picks the type too.
        let picked = type_of(&req.kind);
        let kind = picked.clone().unwrap_or_else(|| p.branch_types.first());
        let branch = match req.branch_name.clone().filter(|s| !s.trim().is_empty()) {
            Some(b) if b.contains('/') => b.trim().to_string(),
            Some(b) => format!("{kind}/{}", b.trim()),
            // Nothing typed: switching carries the uncommitted changes along, so they say what the work is.
            None => {
                // Only on an explicit switch: API callers that omit `where` keep the plain slug fallback.
                let wip = if req.description.trim().is_empty() && req.r#where == "switch" { git.wip_diff(20_000).await? } else { String::new() };
                if wip.trim().is_empty() {
                    self.suggest_branch_name(project_id, picked.as_deref(), &req.description, req.ticket.as_deref()).await?.0
                } else {
                    let wip = format!("Name it after these uncommitted changes:\n{wip}");
                    match self.suggest_branch_name(project_id, picked.as_deref(), &wip, req.ticket.as_deref()).await? {
                        (name, true) => name,
                        _ => return Err(Error::Invalid("AI couldn't name the branch from your changes. Type a name.".into())),
                    }
                }
            }
        };
        let branch = with_ticket(&branch, req.ticket.as_deref().unwrap_or(""));
        // The name's own prefix is its type: `wip/x` is a wip even when asked for as a feature.
        let kind = branch.split_once('/').and_then(|(pre, _)| type_of(pre)).unwrap_or(kind);
        if !valid_branch_name(&branch) {
            return Err(Error::Invalid(format!("“{branch}” is not a valid branch name")));
        }
        if git.ref_exists(&format!("refs/heads/{branch}")).await? {
            return Err(Error::Invalid(format!("{branch} already exists")));
        }
        // The release's branch may only be on origin yet; the new branch merges into it, so it comes down first.
        if let Some(r) = &release {
            git.ensure_local_branch(&r.branch).await?;
        }
        // An agent always gets its own worktree, so it keeps working while the main checkout moves on.
        let wt_path = (req.r#where == "worktree" || req.start_agent).then(|| worktree_path(&p, &branch));
        let parent = release.as_ref().map(|r| r.branch.clone()).or_else(|| merge_into.clone()).unwrap_or_default();
        let worktree = wt_path.as_ref().map(|path| path.to_string_lossy().to_string());
        let meta = BranchMeta {
            kind: kind.clone(),
            release: release.as_ref().map(|r| r.version.clone()),
            parent: merge_into,
            ticket: req.ticket.clone().filter(|t| !t.is_empty()),
            worktree: worktree.clone(),
            description: Some(req.description.clone()),
            created_at: now(),
            from_shipped,
        };
        // Saved before git makes the branch: a refresh while git works (a worktree checking out files) files it under its parent
        // at once, instead of under a guess that moves once the parent is saved.
        let before = self.store.with_project(project_id, |p| Ok(p.branches.insert(branch.clone(), meta)))?;
        let made = match &wt_path {
            Some(path) => git.worktree_add(path, &branch, Some(&start)).await,
            None => git.switch_create(&branch, &start).await,
        };
        if let Err(e) = made {
            // A failing hook fails git after it made the branch: that branch keeps its parent.
            if !git.ref_exists(&format!("refs/heads/{branch}")).await.unwrap_or(true) {
                self.store.with_project(project_id, |p| {
                    match before {
                        Some(m) => p.branches.insert(branch.clone(), m),
                        None => p.branches.remove(&branch),
                    };
                    Ok(())
                })?;
            }
            return Err(e);
        }
        let cwd = match wt_path {
            Some(path) => {
                init_submodules(&path).await;
                copy_worktree_files(&self.store, &p, &path).await;
                path
            }
            None => top_path(&p),
        };
        self.store.with_project(project_id, |p| {
            // A prefix used for the first time joins the dialogs' types.
            p.branch_types.add(&kind);
            if let (Some(t), Some(r)) = (req.ticket.as_ref().filter(|t| !t.is_empty()), &release) {
                p.ticket_releases.insert(t.clone(), r.version.clone());
            }
            Ok(())
        })?;
        let mut vars = hook_vars(&p, &branch);
        vars.push(("PARENT", parent));
        if let Some(w) = &worktree {
            vars.push(("WORKTREE", w.clone()));
            hooks::spawn(&p, "worktreeCreated", &cwd, vec![vars.clone()]);
        }
        hooks::spawn(&p, "branchCreated", &cwd, vec![vars]);
        let mut agent_session = None;
        if req.start_agent {
            let mut request = req.description.clone();
            if let Some(t) = req.ticket.as_ref().filter(|t| !t.is_empty()) {
                request = format!("{request} (ticket {t})");
            }
            let request = attach(&cwd, &request, &req.files).await?;
            let s = self.start_agent(project_id, Some(&branch), &cwd, worktree.is_some(), &request, req.pick.clone()).await?;
            agent_session = Some(s.id);
        }
        self.changed(project_id);
        Ok(NewItemResult { branch, worktree, agent_session })
    }

    pub fn attach_branch(&self, project_id: &str, branch: &str, release: Option<String>, kind: &str) -> Result<()> {
        self.store.with_project(project_id, |p| {
            let m = p.branches.entry(branch.to_string()).or_insert_with(|| BranchMeta { created_at: now(), ..Default::default() });
            m.kind = normalize_kind(kind).unwrap_or("feat").into();
            m.release = release.filter(|s| !s.is_empty());
            Ok(())
        })?;
        self.changed(project_id);
        Ok(())
    }

    /// Choose what `branch` merges into: an open release branch attaches it to
    /// that release, any other branch becomes its parent.
    pub fn set_parent(&self, project_id: &str, branch: &str, parent: &str) -> Result<()> {
        if branch == parent {
            return Err(Error::Invalid(format!("{branch} cannot merge into itself")));
        }
        self.store.with_project(project_id, |p| {
            // A release branch keeps its version: what changes is where it was cut from.
            if let Some(r) = p.releases.iter_mut().find(|r| r.branch == branch) {
                r.base = parent.to_string();
                if let Some(m) = p.branches.get_mut(branch) {
                    m.parent = None;
                }
                return Ok(());
            }
            // Trunks only take a parent; work branches targeting an open release join it.
            let trunk = branch.starts_with("release/") || is_trunk(branch);
            let release = p.releases.iter().find(|r| !trunk && r.branch == parent && r.shipped_at.is_none()).map(|r| r.version.clone());
            let m = p.branches.entry(branch.to_string()).or_insert_with(|| BranchMeta { created_at: now(), ..Default::default() });
            if m.kind.is_empty() && !trunk {
                m.kind = kind_of_branch(branch).unwrap_or("feat").into();
            }
            m.parent = release.is_none().then(|| parent.to_string());
            m.release = release;
            Ok(())
        })?;
        self.changed(project_id);
        Ok(())
    }

    pub async fn remove_item(&self, project_id: &str, branch: &str, delete_branch: bool) -> Result<()> {
        if delete_branch {
            return self.delete_branch(project_id, branch, true, false).await;
        }
        self.store.with_project(project_id, |p| {
            p.branches.remove(branch);
            Ok(())
        })?;
        self.changed(project_id);
        Ok(())
    }

    // ---------- branches ----------

    /// Delete a branch and forget it: the local one (its worktree goes too) and, with `remote`,
    /// the one on origin. Without `force`, refuses when it has commits not in its base.
    /// The default branch and branches the git host protects are never deleted.
    pub async fn delete_branch(&self, project_id: &str, branch: &str, force: bool, remote: bool) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let plan = self.plan_delete(project_id, &DeleteRefs::read(&git).await?, branch, None, force, remote).await?;
        // Origin first: if the host refuses, the local branch is still there.
        if let Some(theirs) = &plan.theirs {
            git.delete_remote_branch(branch, theirs).await?;
        }
        if plan.tip.is_some() {
            git.delete_branch(branch, true).await?;
        }
        self.forget_branches(project_id, &git, &[branch.to_string()]).await?;
        hooks::spawn(&p, "branchDeleted", &top_path(&p), vec![hook_vars(&p, branch)]);
        self.changed(project_id);
        Ok(())
    }

    /// The checks before deleting `branch` (merged into `base`, `None`: work it out; origin's copy seen), then its
    /// worktree removed; what is left to delete, nothing deleted yet.
    async fn plan_delete(&self, project_id: &str, known: &DeleteRefs, branch: &str, base: Option<String>, force: bool, remote: bool) -> Result<DeletePlan> {
        self.refuse_locked(project_id, branch)?;
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        if branch == known.default {
            return Err(Error::Invalid(format!("{branch} is the default branch")));
        }
        if self.protected_branches(project_id, false).await.iter().any(|b| b == branch) {
            return Err(Error::Invalid(format!("{branch} is protected on the git host")));
        }
        // Full refs: a bare name resolves to a tag of the same name first.
        let (mine, origins) = (format!("refs/heads/{branch}"), format!("refs/remotes/origin/{branch}"));
        let tip = known.tips.get(&mine).cloned();
        let local = tip.is_some();
        let on_origin = remote && known.tips.contains_key(&origins);
        if !local && !on_origin {
            let only_origin = !remote && known.tips.contains_key(&origins);
            let tracked = p.branches.contains_key(branch) || p.releases.iter().any(|r| r.branch == branch);
            if only_origin || !tracked {
                return Err(Error::Invalid(if only_origin { format!("{branch} is only on origin") } else { format!("{branch} not found") }));
            }
        }
        // Origin's copy as the checks below see it, and the only one the delete may remove (its lease).
        let theirs = on_origin.then(|| known.tips[&origins].clone());
        // Gone everywhere: nothing to check or delete, only forget it below. Forced: nothing to check.
        if !force && (local || on_origin) {
            let rev = if local { &mine } else { &origins };
            let base = match base {
                Some(b) => b,
                None => self.base_of(&p, branch, &known.default).await,
            };
            let local_base = known.rev_of(&base);
            // Merged on the host while the local base lags behind: origin's copy has it.
            let origin_base = format!("origin/{base}");
            let (base_rev, landed) = if known.in_history(&git, rev, &local_base).await {
                (local_base, true)
            } else if known.tips.contains_key(&format!("refs/remotes/{origin_base}")) && self.landed(project_id, &git, known, branch, rev, &origin_base).await {
                (origin_base, true)
            } else {
                let landed = self.landed(project_id, &git, known, branch, rev, &local_base).await;
                (local_base, landed)
            };
            if !landed {
                let n = git.count(&format!("{base_rev}..{rev}")).await?;
                return Err(Error::Invalid(format!(
                    "{branch} has {n} commit{} not merged into {base}. Merge it first or force the delete.",
                    if n == 1 { "" } else { "s" }
                )));
            }
            // The local branch is merged; origin's copy may still hold commits pushed from elsewhere.
            // It goes when those are in the base too, or the local branch had them (then rewrote them, e.g. a squash).
            if let (true, Some(theirs)) = (local, &theirs) {
                // The local branch's own commit: nothing more on origin.
                let seen = tip.as_ref() == Some(theirs)
                    || known.in_history(&git, &origins, &base_rev).await
                    || git.in_reflog(&mine, theirs).await?
                    || known.squashed(&git, &self.commits, &origins, &base_rev).await;
                if !seen {
                    return Err(Error::Invalid(format!("origin/{branch} has commits that are neither in {base} nor in {branch}. Pull them first or force the delete.")));
                }
            }
        }
        let dir = if local { known.checkouts.get(branch).cloned() } else { None };
        if dir.as_deref() == Some(Path::new(&p.path)) {
            return Err(Error::Invalid(format!("{branch} is checked out. Switch away first.")));
        }
        // Its worktree first: refused while it holds work, and then nothing is gone yet (deleting origin's copy closes its
        // pull request on the host).
        if let Some(dir) = dir {
            self.remove_worktree(project_id, &dir.to_string_lossy(), false).await?;
        }
        Ok(DeletePlan { tip, theirs })
    }

    /// Whether `rev`, branch `branch`'s full ref, landed in `base`: in its history, rebased or squashed in, or its pull
    /// request merged (as git or the git host tells).
    async fn landed(&self, project_id: &str, git: &Git, known: &DeleteRefs, branch: &str, rev: &str, base: &str) -> bool {
        known.in_history(git, rev, base).await
            || known.squashed(git, &self.commits, rev, base).await
            || git.pr_merged_into(branch, rev, base).await.unwrap_or(false)
            || self.hosted_landed(project_id, git, &known.tips[rev], base).await
    }

    /// Forget deleted `branches` in the project's settings, in one write, and in the other profiles' copies of it: the
    /// repository is the same whichever profile deleted them.
    async fn forget_branches(&self, project_id: &str, git: &Git, branches: &[String]) -> Result<()> {
        let on_origin: HashSet<String> = git.remote_branches().await?.into_iter().map(|b| b.name).collect();
        self.store.with_project(project_id, |p| {
            forget_branches(p, branches, &on_origin);
            Ok(())
        })?;
        self.store.update_others(|c| c.projects.iter_mut().find(|p| p.id == project_id).is_some_and(|p| forget_branches(p, branches, &on_origin)))
    }

    /// Rename a branch and, with `remote`, its copy on origin for everyone. An open release's
    /// branch (`release/<version>`) takes its new version along. A local branch whose origin
    /// copy was renamed by someone else follows it (`renamed_to`): it tracks the new name after.
    pub async fn rename_branch(&self, project_id: &str, branch: &str, to: &str, remote: bool) -> Result<RenameResult> {
        self.refuse_locked(project_id, branch)?;
        let to = to.trim();
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        if !valid_branch_name(to) || to == branch {
            return Err(Error::Invalid(format!("{to:?} is not a new branch name")));
        }
        if branch == git.default_branch().await? {
            return Err(Error::Invalid(format!("{branch} is the default branch")));
        }
        // Refused release renames are refused before anything moves.
        renamed(&mut p.clone(), branch, to)?;
        if git.ref_exists(&format!("refs/heads/{to}")).await? {
            return Err(Error::Invalid(format!("{to} already exists")));
        }
        let dir = self.checkout_dir(&p, branch).await?;
        if let Some(dir) = &dir {
            if let Some(op) = Git::new(dir).in_progress().await? {
                return Err(Error::Invalid(format!("{branch} is in the middle of a {op}. Finish or abort it first.")));
            }
        }
        // Bisecting detaches HEAD, so no checkout has `branch` then (a rebase's is found above); git would refuse the local rename after origin's.
        // A folder deleted outside git (still listed, prunable) is skipped: it can't be rebasing anything.
        for w in git.worktrees().await?.iter().filter(|w| w.branch.is_none() && Path::new(&w.path).exists()) {
            if Git::new(&w.path).detached_from().await?.as_deref() == Some(branch) {
                return Err(Error::Invalid(format!("{branch} is being rebased or bisected at {}. Finish or abort it first.", w.path)));
            }
        }
        let local = git.ref_exists(&format!("refs/heads/{branch}")).await?;
        let on_origin = remote && git.ref_exists(&format!("refs/remotes/origin/{branch}")).await?;
        if !local && !on_origin {
            return Err(Error::Invalid(format!("{branch} is only on origin")));
        }
        // An open release's CHANGELOG.md section follows its new version (checked by `renamed` above).
        let versions = p.releases.iter().find(|r| r.branch == branch && r.shipped_at.is_none()).map(|r| (r.version.clone(), to.trim_start_matches("release/")));
        let changelog = match (&versions, local) {
            (Some((old, new)), true) => git.show_file(branch, CHANGELOG).await?.and_then(|t| rename_changelog_version(&t, old, new)),
            _ => None,
        };
        if let (Some(_), Some(dir)) = (&changelog, &dir) {
            clean_changelog(&self.git_at(dir), dir).await?;
        }
        // As configured: `@{upstream}` fails once origin dropped it.
        let upstream = git.run(&["for-each-ref", "--format=%(upstream:short)", &format!("refs/heads/{branch}")]).await?;
        // Origin first: if the host refuses, nothing changed here.
        if on_origin {
            git.fetch().await?;
            let theirs = format!("refs/remotes/origin/{branch}");
            if !git.ref_exists(&theirs).await? {
                return Err(Error::Invalid(format!("{branch} is no longer on origin")));
            }
            if git.ref_exists(&format!("refs/remotes/origin/{to}")).await? {
                return Err(Error::Invalid(format!("origin already has {to}")));
            }
            let sha = git.rev_parse(&theirs).await?;
            self.rename_on_origin(&p, &git, branch, to, &sha).await?;
        }
        if local {
            git.rename_branch(branch, to).await?;
            // Renamed on origin, here or by someone else (its upstream is gone and origin has `to`): track the new name.
            let gone = upstream.trim() == format!("origin/{branch}") && !git.ref_exists(&format!("refs/remotes/origin/{branch}")).await?;
            if on_origin || (gone && git.ref_exists(&format!("refs/remotes/origin/{to}")).await?) {
                git.set_upstream(to, &format!("origin/{to}")).await?;
            } else if upstream.trim() == format!("origin/{branch}") {
                // Renamed here only: origin keeps the old name, which `to` must not track. Its next push tracks `origin/{to}`.
                git.run(&["branch", "--unset-upstream", to]).await?;
            }
        }
        self.store.with_project(project_id, |p| renamed(p, branch, to))?;
        self.agents.rename_branch(project_id, branch, to);
        // Renamed by now: a failed commit (a hook, say) is reported along, not as the rename failing.
        let mut out = RenameResult { changelog: false, changelog_error: None };
        if let (Some(text), Some((old, new))) = (&changelog, &versions) {
            match self.commit_changelog(&p, &git, to, text, &format!("docs(changelog): v{old} is now v{new}")).await {
                Ok(()) => out.changelog = true,
                Err(e) => {
                    // In a checkout the file is written before the commit: it stays there for the user to commit.
                    let left = dir.as_ref().map(|d| format!(". {CHANGELOG} is left uncommitted at {}", d.display())).unwrap_or_default();
                    crate::log::error(format!("Could not commit {CHANGELOG} on {to}: {e}{left}"));
                    out.changelog_error = Some(format!("{e}{left}"));
                }
            }
        }
        self.changed(project_id);
        Ok(out)
    }

    /// Rename `from` (at `sha` on origin) to `to` on origin. GitHub renames it itself, so its open
    /// pull requests and protection rules follow; elsewhere one atomic push creates `to` and deletes `from`.
    async fn rename_on_origin(&self, p: &Project, git: &Git, from: &str, to: &str, sha: &str) -> Result<()> {
        let url = git.remote_url("origin").await?.unwrap_or_default();
        if let Some(repo) = azure::parse_remote(&url) {
            // Deleting the old name would cut off its pull requests: Azure DevOps can't move them to another branch.
            let prs = azure::Azure::new(repo, azure_auth::authorization().await?).open_prs(from).await?;
            if let Some(n) = prs.first() {
                return Err(Error::Invalid(format!("Pull request #{n} is open from or into {from}. Complete or abandon it first.")));
            }
        } else {
            // Boxed: the host lookup and listing are big futures, and every RPC future grows with them (see `Git::output`).
            match Box::pin(self.pr_host(&p.id)).await {
                Ok(PrHost::GitHub(gh)) => {
                    gh.rename_branch(from, to).await?;
                    // GitHub renames in the background: the tracking refs move now, the next fetch confirms.
                    git.update_ref(&format!("refs/remotes/origin/{to}"), sha).await?;
                    git.run(&["update-ref", "-d", &format!("refs/remotes/origin/{from}")]).await?;
                    return Ok(());
                }
                // GitLab, Bitbucket, Gitea: deleting the old name would close or orphan its pull requests.
                // shortcut: `list` holds each host's latest pull requests (60 on GitLab); query by branch if an older open one gets cut off.
                Ok(host) => {
                    let open = Box::pin(host.list()).await?.into_iter().find(|pr| matches!(pr.state.as_str(), "open" | "draft") && (pr.head == from || pr.base == from));
                    if let Some(pr) = open {
                        return Err(Error::Invalid(format!("Pull request #{} is open from or into {from}. Merge or close it first.", pr.number)));
                    }
                }
                // Not a pull request host: plain git below.
                Err(Error::Unsupported(_)) => {}
                // A known host without sign-in: deleting the old name would close its pull requests.
                Err(e) => return Err(e),
            }
        }
        git.push_rename(from, to, sha).await.map(|_| ())
    }

    /// Delete several branches (merged ones only unless `force`), a few at a time, carrying on past the ones that can't go.
    pub async fn cleanup_branches(&self, project_id: &str, branches: &[String], force: bool, remote: bool) -> Result<CleanupResult> {
        // Bases first, while the refs still match the last overview: once a delete moves them,
        // `base_of` misses its cache and works the whole tree out again, for every branch left.
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let known = DeleteRefs::read(&git).await?;
        let default = &known.default;
        // One ref listing for every saved parent, not one a branch.
        let fingerprint = git.ref_fingerprint().await.ok();
        let mut bases = Vec::with_capacity(branches.len());
        for b in branches {
            let base = match fingerprint.as_deref().and_then(|f| self.cached_parent(&p, f, b, default)) {
                Some(parent) => parent.unwrap_or_else(|| default.clone()),
                None => self.base_of(&p, b, default).await,
            };
            bases.push((b.clone(), base));
        }
        // Each refresh meanwhile shows the views as last built: one rebuild once all are gone, not one per delete.
        let cleaning = Cleaning::enter(&self.cleaning, project_id);
        // Each one checked (and its worktree removed) a few at a time; the deletes themselves together after.
        let known = &known;
        let checked = stream::iter(bases)
            .map(|(b, base)| async move {
                let r = self.plan_delete(project_id, known, &b, Some(base), force, remote).await;
                // Progress counts it once checked: the deletes after are a push or two for all of them.
                let _ = self.events.send(Event::CleanupStep { project_id: project_id.into(), branch: b.clone() });
                (b, r)
            })
            .buffered(4)
            .collect::<Vec<_>>()
            .await;
        let mut out = CleanupResult::default();
        let mut plans = Vec::new();
        // A branch that moved since its check (an agent committed meanwhile) is kept, on origin too: `branch -D` would
        // take the new commit with it.
        let tips = git.ref_tips(&["refs/heads"], None).await?;
        for (b, r) in checked {
            match r {
                Ok(plan) if plan.tip.as_ref().is_some_and(|t| tips.get(&format!("refs/heads/{b}")) != Some(t)) => {
                    out.skipped.push(Skipped { reason: format!("{b} got new commits while it was checked"), branch: b })
                }
                Ok(plan) => plans.push((b, plan)),
                Err(e) => out.skipped.push(Skipped { branch: b, reason: e.to_string() }),
            }
        }
        // Origin's copies in one push (a connection each was minutes for a big cleanup), then the local ones of those it took.
        let on_origin: Vec<(String, String)> = plans.iter().filter_map(|(b, plan)| Some((b.clone(), plan.theirs.clone()?))).collect();
        let refused = git.delete_remote_branches(&on_origin).await.map_err(|e| e.to_string());
        let refusal = |b: &String, plan: &DeletePlan| match (&refused, &plan.theirs) {
            (_, None) => None,
            (Err(e), Some(_)) => Some(e.clone()),
            (Ok(r), Some(_)) => r.get(b).cloned(),
        };
        let local: Vec<&str> = plans.iter().filter(|(b, plan)| plan.tip.is_some() && refusal(b, plan).is_none()).map(|(b, _)| b.as_str()).collect();
        let kept = git.delete_branches(&local).await.map_err(|e| e.to_string());
        let mut deleted = Vec::new();
        for (b, plan) in &plans {
            let why = refusal(b, plan).or_else(|| match &kept {
                _ if plan.tip.is_none() => None,
                Ok(kept) => kept.get(b).cloned(),
                Err(e) => Some(e.clone()),
            });
            match why {
                Some(reason) => out.skipped.push(Skipped { branch: b.clone(), reason }),
                None => deleted.push(b.clone()),
            }
        }
        self.forget_branches(project_id, &git, &deleted).await?;
        // One after the other, not a shell per branch at once.
        hooks::spawn(&p, "branchDeleted", &top_path(&p), deleted.iter().map(|b| hook_vars(&p, b)).collect());
        out.deleted = deleted;
        drop(cleaning);
        self.changed(project_id);
        Ok(out)
    }

    /// Completed pull requests that took in any of `tips`, as the git host says (Azure DevOps
    /// for now; nothing without sign-in). `ask`: look up the tips not asked about lately first.
    async fn hosted_prs(&self, p: &Project, tips: &[String], ask: bool) -> HashMap<String, Vec<MergedPr>> {
        if ask {
            let due: Vec<String> = {
                let all = self.hosted.lock().unwrap();
                let h = all.get(&p.id);
                let due = |t: &&String| h.is_none_or(|h| !h.merged.contains_key(*t) && h.asked.get(*t).is_none_or(|at| at.elapsed() >= HOSTED_TTL));
                tips.iter().filter(due).cloned().collect()
            };
            if !due.is_empty() {
                let lookup = async {
                    match self.pr_host(&p.id).await? {
                        PrHost::Azure(a) => a.merged_prs(&due).await,
                        _ => Ok(HashMap::new()),
                    }
                };
                let found = tokio::time::timeout(std::time::Duration::from_secs(10), lookup).await.ok().and_then(|r| r.ok());
                let mut all = self.hosted.lock().unwrap();
                let h = all.entry(p.id.clone()).or_default();
                let now = Instant::now();
                h.asked.extend(due.into_iter().map(|t| (t, now)));
                h.merged.extend(found.unwrap_or_default());
            }
        }
        let all = self.hosted.lock().unwrap();
        let Some(h) = all.get(&p.id) else { return HashMap::new() };
        tips.iter().filter_map(|t| Some((t.clone(), h.merged.get(t)?.clone()))).collect()
    }

    /// What the git host said so far about a project, for view keys.
    fn hosted_digest(&self, project_id: &str) -> String {
        let all = self.hosted.lock().unwrap();
        let Some(h) = all.get(project_id) else { return String::new() };
        let mut v: Vec<String> = h.merged.iter().map(|(tip, prs)| format!("{tip}>{}", prs.iter().map(|m| m.merge_commit.as_str()).collect::<Vec<_>>().join(","))).collect();
        v.sort();
        v.join(";")
    }

    /// Whether the git host says a pull request took commit `tip` into `base`.
    async fn hosted_landed(&self, project_id: &str, git: &Git, tip: &str, base: &str) -> bool {
        let commits: Vec<String> = {
            let all = self.hosted.lock().unwrap();
            all.get(project_id).and_then(|h| h.merged.get(tip)).into_iter().flatten().map(|m| m.merge_commit.clone()).collect()
        };
        any_in(git, &commits, base).await
    }

    /// Branches the git host protects, looked up again after a few minutes or on `refresh`.
    /// Empty without a connected git host, or when it can't be reached.
    async fn protected_branches(&self, project_id: &str, refresh: bool) -> Vec<String> {
        if !refresh {
            if let Some((at, list)) = self.protected.lock().unwrap().get(project_id) {
                if at.elapsed() < PROTECTED_TTL {
                    return list.clone();
                }
            }
        }
        let lookup = async {
            // Azure DevOps branch policies are not looked up: no keychain read or token refresh for them.
            let p = self.store.project(project_id)?;
            if self.git(&p).remote_url("origin").await?.is_some_and(|u| azure::parse_remote(&u).is_some()) {
                return Ok(vec![]);
            }
            self.pr_host(project_id).await?.protected_branches().await
        };
        let list = match tokio::time::timeout(std::time::Duration::from_secs(5), lookup).await {
            Ok(Ok(list)) => list,
            _ => Vec::new(),
        };
        self.protected.lock().unwrap().insert(project_id.into(), (Instant::now(), list.clone()));
        list
    }

    /// Stash a checked-out branch's uncommitted changes (untracked files included).
    pub async fn stash_branch(&self, project_id: &str, branch: &str) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        let files = git.wip_changes().await?;
        if files.is_empty() {
            return Err(Error::Invalid(format!("{branch} has no uncommitted changes to stash.")));
        }
        if git.stash(&stash_message(&files)).await?.is_none() {
            return Err(Error::Invalid(format!("Nothing to stash: git does not set aside changes made inside a submodule of {branch}.")));
        }
        self.changed(project_id);
        Ok(())
    }

    /// Every stash of the project, newest first.
    pub async fn stashes(&self, project_id: &str) -> Result<Vec<StashInfo>> {
        self.git(&self.store.project(project_id)?).stashes().await
    }

    /// Files a stash holds: its tracked changes, and its untracked files.
    pub async fn stash_files(&self, project_id: &str, sha: &str) -> Result<Vec<FileChange>> {
        let git = self.git(&self.store.project(project_id)?);
        let (tracked, untracked) = git.stash_ranges(check_sha(sha)?).await?;
        let mut files = git.range_changes(&tracked).await?;
        if let Some(r) = untracked {
            files.extend(git.range_changes(&r).await?);
            files.sort_by(|a, b| a.path.cmp(&b.path));
        }
        Ok(files)
    }

    pub async fn stash_diff(&self, project_id: &str, sha: &str, path: &str, full: bool) -> Result<Vec<Hunk>> {
        let git = self.git(&self.store.project(project_id)?);
        let (tracked, untracked) = git.stash_ranges(check_sha(sha)?).await?;
        let hunks = git.file_diff(path, Some(&tracked), full).await?;
        match untracked {
            Some(r) if hunks.is_empty() => git.file_diff(path, Some(&r), full).await,
            _ => Ok(hunks),
        }
    }

    /// Put a stash's changes back on a checked-out branch. `pop` drops the stash once it
    /// applied cleanly; on conflicts it stays, and the conflicted files are returned.
    pub async fn apply_stash(&self, project_id: &str, branch: &str, sha: &str, pop: bool) -> Result<StashApplied> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        let sha = check_sha(sha)?;
        let out = git.stash_apply(sha).await;
        // Even a refused apply may have touched files.
        self.changed(project_id);
        let mut conflicts = out?;
        // Kept after AI resolves its conflicts: the stash is the only copy if AI got them wrong.
        let clean = conflicts.is_empty();
        if !clean {
            conflicts = self.resolve_and_continue(&p, &git, None, "the stashed changes", branch, None).await?.left;
        }
        let dropped = pop && clean;
        if dropped {
            git.stash_drop(sha).await?;
            self.changed(project_id);
        }
        Ok(StashApplied { conflicts, dropped })
    }

    pub async fn drop_stash(&self, project_id: &str, sha: &str) -> Result<()> {
        self.git(&self.store.project(project_id)?).stash_drop(check_sha(sha)?).await?;
        self.changed(project_id);
        Ok(())
    }

    /// Tag a branch's tip (annotated; the message defaults to the name) and push the tag to origin.
    pub async fn tag_branch(&self, project_id: &str, branch: &str, name: &str, message: Option<&str>) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let rev = git.branch_rev(branch).await?.ok_or_else(|| Error::NotFound(format!("branch {branch}")))?;
        self.tag_commit(project_id, &git.rev_parse(&rev).await?, name, message).await
    }

    /// Tag a commit (annotated; the message defaults to the name) and push the tag to origin.
    pub async fn tag_commit(&self, project_id: &str, sha: &str, name: &str, message: Option<&str>) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::Invalid("Name the tag.".into()));
        }
        let rev = check_sha(sha)?;
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        if git.ref_exists(&format!("refs/tags/{name}")).await? {
            return Err(Error::Invalid(format!("Tag {name} already exists.")));
        }
        let message = message.map(str::trim).filter(|m| !m.is_empty()).unwrap_or(name);
        git.tag(name, rev, message).await?;
        self.changed(project_id);
        git.push_tag(name, false).await?;
        Ok(())
    }

    /// Check out a tag's commit in the main checkout (detached HEAD).
    pub async fn checkout_tag(&self, project_id: &str, name: &str) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        if !git.ref_exists(&format!("refs/tags/{name}")).await? {
            return Err(Error::NotFound(format!("tag {name}")));
        }
        git.switch_detach(&format!("refs/tags/{name}^{{commit}}")).await?;
        self.changed(project_id);
        Ok(())
    }

    /// Delete a tag locally and on origin (a fetch would bring it back otherwise).
    pub async fn delete_tag(&self, project_id: &str, name: &str) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let local = git.ref_exists(&format!("refs/tags/{name}")).await?;
        let remote = git.remote_url("origin").await?.is_some() && git.delete_remote_tag(name).await?;
        if local {
            git.delete_tag(name).await?;
        } else if !remote {
            return Err(Error::NotFound(format!("tag {name}")));
        }
        self.store.with_project(project_id, |p| {
            // Its release never went out after all: back to open.
            for r in p.releases.iter_mut().filter(|r| r.tag.as_deref() == Some(name)) {
                r.tag = None;
                r.shipped_at = None;
            }
            Ok(())
        })?;
        self.changed(project_id);
        Ok(())
    }

    /// Bring a branch up to its upstream, checked out or not: a fast-forward or, when both moved,
    /// its local commits replayed on top, or the upstream merged in when they hold merges (AI resolving
    /// conflicts either way, aborted when it can't).
    /// Uncommitted changes in its checkout that the pull would overwrite refuse it (`WouldOverwrite`) unless
    /// `wip` says what to do with them: "stash" leaves them in a stash, "carry" stashes them, pulls and puts
    /// them back. Returns git's output and the files left conflicted by carrying them (the stash is kept then).
    pub async fn pull_branch(&self, project_id: &str, branch: &str, wip: Option<&str>) -> Result<(String, Vec<String>)> {
        self.refuse_locked(project_id, branch)?;
        if wip.is_some_and(|w| !matches!(w, "stash" | "carry")) {
            return Err(Error::Invalid(format!("wip: {wip:?}")));
        }
        let p = self.store.project(project_id)?;
        let upstream = self
            .git(&p)
            .branches()
            .await?
            .into_iter()
            .find(|b| b.name == branch)
            .ok_or_else(|| Error::NotFound(format!("branch {branch}")))?
            .upstream
            .ok_or_else(|| Error::Invalid(format!("{branch} has no upstream. Push it first.")))?;
        let dir = self.checkout_dir(&p, branch).await?;
        let stashed = match (wip, &dir) {
            (Some(_), Some(dir)) => {
                let g = self.git_at(dir);
                let files = g.wip_changes().await?;
                if files.is_empty() {
                    None
                } else {
                    // None: only a submodule changed, so there is nothing to put back after the pull.
                    g.stash(&stash_message(&files)).await?.map(|sha| (g, sha))
                }
            }
            _ => None,
        };
        let pulled = self.pull_upstream(&p, branch, &upstream, dir.as_deref()).await;
        self.changed(project_id);
        let Some((g, sha)) = stashed else {
            return Ok((pulled?, Vec::new()));
        };
        let out = match pulled {
            Ok(out) => out,
            Err(e) => {
                // The failed pull left the branch where it was: the stash goes back cleanly.
                if g.stash_apply(&sha).await.is_ok_and(|c| c.is_empty()) {
                    g.stash_drop(&sha).await?;
                }
                return Err(e);
            }
        };
        if wip == Some("stash") {
            return Ok((out, Vec::new()));
        }
        Ok((out, self.apply_stash(project_id, branch, &sha, true).await?.conflicts))
    }

    /// `pull_branch` once its uncommitted changes are dealt with; `dir` is the branch's checkout.
    async fn pull_upstream(&self, p: &Project, branch: &str, upstream: &str, dir: Option<&Path>) -> Result<String> {
        let git = self.git(p);
        let pulled = match dir {
            Some(dir) => self.git_at(dir).pull_ff(branch, upstream, true).await,
            None => git.pull_ff(branch, upstream, false).await,
        };
        Ok(match pulled {
            Err(Error::Git { stderr, .. }) if stderr.contains("would be overwritten by merge") => {
                return Err(Error::WouldOverwrite(format!("Uncommitted changes on {branch} would be overwritten by pulling {upstream}.")));
            }
            // Diverged; the pull above fetched origin's side. Only commits origin never had get rewritten, and
            // not merges: rebasing those would rewrite the branches they took in, so they'd look unmerged.
            Err(Error::Git { stderr, .. }) if stderr.contains("non-fast-forward") || stderr.contains("Not possible to fast-forward") || stderr.contains("rejected") => {
                if git.run(&["rev-list", "--merges", "--count", &format!("{upstream}..{branch}")]).await?.trim() != "0" {
                    self.merge_refs(p, upstream, branch).await?;
                    format!("{branch} and {upstream} had diverged: merged {upstream} into {branch}")
                } else {
                    if let Some(dir) = dir {
                        self.check_wip_clear(dir, upstream, branch).await?;
                    }
                    let cut = self.own_commits_start(p, &git, branch, upstream).await;
                    self.rebase_branch(p, branch, upstream, cut.as_deref()).await?;
                    format!("{branch} and {upstream} had diverged: rebased {branch} onto {upstream}")
                }
            }
            out => out?,
        })
    }

    /// Where `branch`'s own commits start, when it holds commits of its parent that `upstream` lacks: rebased onto its
    /// parent here while a teammate pushed to origin's copy. Replaying the branch onto `upstream` from there leaves the
    /// parent's commits out; replayed too, they would land on top as copies, the rebase undone. None otherwise: the
    /// whole branch is replayed, git dropping what `upstream` already holds.
    async fn own_commits_start(&self, p: &Project, git: &Git, branch: &str, upstream: &str) -> Option<String> {
        let default = git.default_branch().await.ok()?;
        let parent = self.base_of(p, branch, &default).await;
        if parent == branch {
            return None;
        }
        let fork = git.merge_base(branch, &git.rev_of(&parent).await).await.ok()?;
        (!git.is_ancestor(&fork, upstream).await.ok()?).then_some(fork)
    }

    /// Move a branch to exactly where its upstream is, dropping local commits. In its
    /// checkout this is a hard reset (uncommitted changes are lost too); elsewhere the ref just moves.
    /// `safe`: loses nothing. Refused when the branch has a commit origin never had, checked now rather than
    /// trusting a view that may be stale; uncommitted changes are stashed and put back on top. Returns the files
    /// left conflicted by putting them back (the stash is kept then).
    pub async fn reset_to_upstream(&self, project_id: &str, branch: &str, safe: bool) -> Result<Vec<String>> {
        self.refuse_locked(project_id, branch)?;
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let upstream = git
            .branches()
            .await?
            .into_iter()
            .find(|b| b.name == branch)
            .ok_or_else(|| Error::NotFound(format!("branch {branch}")))?
            .upstream
            .ok_or_else(|| Error::Invalid(format!("{branch} has no upstream to reset to.")))?;
        let sha = git.rev_parse(&upstream).await?;
        let dir = self.checkout_dir(&p, branch).await?;
        if let Some(d) = &dir {
            Self::refuse_mid_run(self.rebasing_in(d))?;
            refuse_in_progress(&self.git_at(d), d, branch).await?;
        }
        let mut stashed = None;
        if safe {
            let local = format!("refs/heads/{branch}");
            // Commits origin lacks are fine only when origin had them before a force push.
            let own = git.run(&["rev-list", "--count", &format!("{upstream}..{local}")]).await?.trim() != "0"
                && !git.in_reflog(&format!("refs/remotes/{upstream}"), &git.rev_parse(&local).await?).await?;
            if own {
                return Err(Error::Invalid(format!("{branch} now has commits origin never had: not reset. Look at it again before resetting.")));
            }
            if let Some(d) = &dir {
                let g = self.git_at(d);
                let files = g.wip_changes().await?;
                if !files.is_empty() {
                    // None: only a submodule changed, so there is nothing to put back.
                    stashed = g.stash(&stash_message(&files)).await?;
                }
            }
        }
        let reset = match &dir {
            Some(dir) => self.git_at(dir).reset(&sha, "hard").await,
            None => git.update_ref(&format!("refs/heads/{branch}"), &sha).await,
        };
        self.changed(project_id);
        let (Some(stash), Some(dir)) = (stashed, &dir) else {
            return reset.map(|_| Vec::new());
        };
        if let Err(e) = reset {
            // The failed reset left the branch where it was: the stash goes back cleanly.
            let g = self.git_at(dir);
            if g.stash_apply(&stash).await.is_ok_and(|c| c.is_empty()) {
                g.stash_drop(&stash).await?;
            }
            return Err(e);
        }
        Ok(self.apply_stash(project_id, branch, &stash, true).await?.conflicts)
    }

    /// Merge a branch into its base (its release, else its parent). Works whether or not
    /// the base is checked out; stops before touching anything when the merge would conflict.
    /// `into` overrides the target (any other local branch); by default it is the branch's base.
    /// See [`MergeOptions`] for squashing first, rebasing instead of a merge commit, and pushing.
    pub async fn merge_branch(&self, project_id: &str, branch: &str, into: Option<&str>, opts: MergeOptions) -> Result<MergeResult> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let into = match into.filter(|i| !i.trim().is_empty()) {
            Some(i) => i.to_string(),
            None => self.base_of(&p, branch, &default).await,
        };
        if into == branch {
            return Err(Error::Invalid(format!("{branch} has no other branch to merge into")));
        }
        self.refuse_locked(project_id, branch)?;
        self.refuse_locked(project_id, &into)?;
        // Caught up with origin first, so the merge lands on top of origin's commits and the push goes through.
        // shortcut: when `branch` was started from commits of `into` never pushed, rebasing them here duplicates them in the history.
        if git.upstream(&into).await.ok().flatten().is_some() {
            if let Err(e) = self.pull_branch(project_id, &into, None).await {
                crate::log::info(format!("Merging into {into} as it is: updating it from origin failed: {e}"));
            }
        }
        // Deleting the branch the main checkout is on means moving that checkout to `into`:
        // make sure that can happen before merging anything.
        let must_switch = opts.delete_after && self.checkout_dir(&p, branch).await?.is_some_and(|d| d == Path::new(&p.path));
        let into_dir = self.checkout_dir(&p, &into).await?;
        if must_switch {
            if let Some(dir) = &into_dir {
                return Err(Error::Invalid(format!(
                    "{into} is open in a worktree at {}, so this checkout can't switch to it. Merge without deleting, or close that worktree first.",
                    dir.display()
                )));
            }
        }
        // A shipped release merged into the default branch again: note its own tip, where its tag moves,
        // so the tag never takes in later work that only `into` has.
        let shipped = if into == default { p.releases.iter().find(|r| r.branch == branch && r.shipped_at.is_some()) } else { None };
        let release_tip = match shipped {
            Some(_) => git.rev_parse(branch).await.ok(),
            None => None,
        };
        // Its tag, and whether it stays: when it still tags that tip, the release went out as it is (published,
        // not shipped through main), whatever commits a squash or rebase lands; when it tags a commit off the
        // release's line (main published with the release merged in), moving it would drop what went out.
        let (release_tag_name, went_out_as_is) = match shipped {
            Some(r) => {
                let tag = match &r.tag {
                    Some(t) => t.clone(),
                    // Its own tag unknown (it went out with a later patch): named like the project's, skipped when missing.
                    None => release_tag(use_v(&p, &git).await.unwrap_or(true), &r.version),
                };
                let tagged = git.rev_parse(&format!("refs/tags/{tag}^{{commit}}")).await.ok();
                let keep = match (&tagged, &release_tip) {
                    (Some(t), Some(tip)) => t == tip || !git.is_ancestor(t, tip).await.unwrap_or(false),
                    _ => false,
                };
                (Some(tag), keep)
            }
            None => (None, false),
        };
        let mut squashed = None;
        if opts.squash && !git.is_ancestor(branch, &into).await.unwrap_or(false) {
            // Squashing rewrites the branch: check everything that could stop the merge first,
            // so a refusal never leaves it squashed but not merged.
            self.check_mergeable(&p, branch, &into, opts.rebase).await?;
            squashed = self.squash_branch(&p, branch, &into, opts.squash_ai).await?;
        }
        let merged = if opts.rebase { self.rebase_ff(&p, branch, &into).await } else { self.merge_refs(&p, branch, &into).await };
        let (sha, already_merged) = match merged {
            Ok(m) => m,
            Err(e) => {
                // Conflicts AI could not resolve: the branch goes back to before the squash, unless it moved since.
                if let Some((old, new)) = squashed {
                    let _ = git.update_ref_from(&format!("refs/heads/{branch}"), &old, &new).await;
                }
                return Err(e);
            }
        };
        self.changed(project_id);
        // Land the main checkout on the branch that got the changes, unless it's already there
        // or `into` is open in another worktree (a branch can't be checked out twice).
        let mut stayed = None;
        let switched = match &into_dir {
            Some(dir) if dir == Path::new(&p.path) => false,
            Some(dir) => {
                stayed = Some(format!("{into} is open in a worktree at {}", dir.display()));
                false
            }
            None if opts.stay && !must_switch => false,
            None => match git.switch(&into).await {
                Ok(()) => true,
                Err(e) if must_switch => return Err(Error::Invalid(format!("Merged into {into}, but switching to it failed, so {branch} was kept: {e}"))),
                Err(e) => {
                    stayed = Some(format!("switching to {into} failed: {e}"));
                    false
                }
            },
        };
        if switched {
            self.changed(project_id);
        }
        // The merge stands even when the push doesn't: report it rather than fail.
        let push_error = if opts.push {
            let tracked = git.upstream(&into).await.ok().flatten().is_some();
            let res = git.push(&into, !tracked).await.err().map(|e| e.to_string());
            self.changed(project_id);
            res
        } else {
            None
        };
        let pushed = opts.push && push_error.is_none();
        // New release commits now on origin's default branch: the release tag moves to cover them.
        // Only once pushed, so the tag never differs between here and origin. Reported, never fatal.
        let (mut retagged, mut tag_error) = (None, None);
        if let (Some(tag), true, false, false) = (release_tag_name, pushed, already_merged, went_out_as_is) {
            // Squash and rebase land rewritten commits, not the release's own: tag what landed.
            let target = if opts.squash || opts.rebase { Some(sha.clone()) } else { release_tip };
            if let Some(target) = target {
                match Self::move_tag(&git, &tag, &target).await {
                    Ok(true) => {
                        self.changed(project_id);
                        retagged = Some(tag);
                    }
                    Ok(false) => {}
                    Err(e) => tag_error = Some(e.to_string()),
                }
            }
        }
        // Last, once everything else landed, so a branch that can't go never holds up the push or the tag.
        let delete_error = if opts.delete_after { self.delete_branch(project_id, branch, false, true).await.err().map(|e| e.to_string()) } else { None };
        let deleted = opts.delete_after && delete_error.is_none();
        if !already_merged {
            let mut vars = hook_vars(&p, branch);
            vars.push(("INTO", into.clone()));
            hooks::spawn(&p, "branchMerged", &top_path(&p), vec![vars]);
        }
        Ok(MergeResult { into, sha, already_merged, deleted, delete_error, switched, stayed, pushed, push_error, retagged, tag_error })
    }

    /// Move release tag `tag` to `target` on origin too. A failed push puts the
    /// old tag back, so the two never disagree. Ok(false): already there, or no such tag.
    async fn move_tag(git: &Git, tag: &str, target: &str) -> Result<bool> {
        let r = format!("refs/tags/{tag}");
        if !git.ref_exists(&r).await? || git.rev_parse(&format!("{r}^{{commit}}")).await.ok().as_deref() == Some(target) {
            return Ok(false);
        }
        let old = git.retag(tag, target, &format!("Release {tag}")).await?;
        if let Err(e) = git.push_tag(tag, true).await {
            let _ = git.update_ref(&format!("refs/tags/{tag}"), &old).await;
            return Err(e);
        }
        Ok(true)
    }

    /// Refuse up front what would stop a squash or rebase merge halfway: conflicts,
    /// and uncommitted changes where the rebase or the fast-forward has to run.
    async fn check_mergeable(&self, p: &Project, from: &str, into: &str, rebase: bool) -> Result<()> {
        let git = self.git(p);
        for b in [from, into] {
            if !git.ref_exists(&format!("refs/heads/{b}")).await? {
                return Err(Error::NotFound(format!("local branch {b}")));
            }
        }
        if let Err(files) = git.merge_tree(into, from).await? {
            if !self.resolves_conflicts(p) {
                return Err(Error::Invalid(format!("Merging {from} into {into} conflicts in {}. Rebase onto the base and resolve first.", files.join(", "))));
            }
        }
        if let Some(dir) = self.checkout_dir(p, into).await? {
            self.check_wip_clear(&dir, from, into).await?;
        }
        // Rebased where it's checked out: its uncommitted work would be left out of the merge.
        if let (true, Some(dir)) = (rebase, self.checkout_dir(p, from).await?) {
            let g = self.git_at(&dir);
            if g.is_rebasing().await? || !g.wip_changes().await?.is_empty() {
                return Err(Error::Invalid(format!("{from} has uncommitted changes at {}", dir.display())));
            }
        }
        Ok(())
    }

    /// Uncommitted work in `into`'s checkout at `dir` stays there while `from` comes in, as long as
    /// `from` leaves those files alone (git won't overwrite them) and no rebase is in progress there.
    async fn check_wip_clear(&self, dir: &Path, from: &str, into: &str) -> Result<()> {
        let g = self.git_at(dir);
        if g.is_rebasing().await? {
            return Err(Error::Invalid(format!("{into} is in the middle of a rebase at {}", dir.display())));
        }
        let wip = g.wip_changes().await?;
        if wip.is_empty() {
            return Ok(());
        }
        let touched = g.run(&["diff", "--name-only", "--no-renames", "-z", &format!("{into}...{from}")]).await?;
        let hit: Vec<&str> = wip.iter().map(|f| f.path.as_str()).filter(|w| touched.split('\0').any(|t| t == *w)).collect();
        if hit.is_empty() {
            return Ok(());
        }
        Err(Error::WouldOverwrite(format!("{into} has uncommitted changes at {} to files {from} changes: {}. Commit or stash them first.", dir.display(), hit.join(", "))))
    }

    /// Collapse `branch`'s commits since it left `onto` into one, its files unchanged.
    /// Only the ref moves, so a checkout of it stays as it was. The message is
    /// "squash | <branch>" with the squashed subjects, or written by AI (`ai`).
    /// Returns the old tip and the squashed commit, None when there was nothing to squash.
    async fn squash_branch(&self, p: &Project, branch: &str, onto: &str, ai: bool) -> Result<Option<(String, String)>> {
        let git = self.git(p);
        let base = git.merge_base(onto, branch).await?;
        let range = format!("{base}..{branch}");
        if git.count(&range).await? < 2 {
            return Ok(None);
        }
        // Written before anything moves: if AI fails, the branch is untouched.
        let message = if ai {
            let t = self.template("commit", None, Some(&p.id))?;
            let ticket = p.branches.get(branch).and_then(|m| m.ticket.clone()).unwrap_or_else(|| "(none)".into());
            let mut vars = BTreeMap::new();
            vars.insert("diff".into(), git.range_diff(&range, 60_000).await?);
            vars.insert("files".into(), git.run(&["diff", "--name-status", &range]).await?);
            vars.insert("branch".into(), branch.to_string());
            vars.insert("ticket".into(), ticket);
            self.ask("commit", &t, vars, &p.gen_lang.commit, None).await?
        } else {
            let list: Vec<String> = git.subjects(&range).await?.iter().map(|s| format!("* {s}")).collect();
            format!("{}\n\n{}", squash_title(branch), list.join("\n"))
        };
        let old = git.rev_parse(branch).await?;
        let tree = git.rev_parse(&format!("{branch}^{{tree}}")).await?;
        let commit = git.commit_tree(&tree, &[&base], &message).await?;
        git.update_ref_from(&format!("refs/heads/{branch}"), &commit, &old).await?;
        if ai {
            self.store.with_project(&p.id, |p| {
                p.ai_commits.push(commit.clone());
                Ok(())
            })?;
        }
        Ok(Some((old, commit)))
    }

    /// Rebase `from` onto `into`, then fast-forward `into` to it. Returns (new tip, already merged).
    async fn rebase_ff(&self, p: &Project, from: &str, into: &str) -> Result<(String, bool)> {
        let git = self.git(p);
        self.check_mergeable(p, from, into, true).await?;
        if git.is_ancestor(from, into).await? {
            return Ok((git.rev_parse(into).await?, true));
        }
        // Read before the rebase, which can take minutes when conflicts get resolved: a merge landing in `into`
        // meanwhile then stops this one instead of being rewound by it.
        let before = git.rev_parse(into).await?;
        if !git.is_ancestor(&before, from).await? {
            self.rebase_branch(p, from, into, None).await?;
        }
        let tip = git.rev_parse(from).await?;
        match self.checkout_dir(p, into).await? {
            Some(dir) => self.git_at(&dir).merge_ff_only(from).await?,
            None => {
                if git.update_ref_from(&format!("refs/heads/{into}"), &tip, &before).await.is_err() {
                    return Err(Error::Invalid(format!("{into} moved while {from} was rebased onto it: nothing was merged. Merge again to take its new commits.")));
                }
            }
        }
        Ok((tip, false))
    }

    /// Rebase `from` onto `into` where it's checked out, else in a throwaway worktree. See [`Self::rebase_resolving`].
    async fn rebase_branch(&self, p: &Project, from: &str, into: &str, cut: Option<&str>) -> Result<()> {
        if let Some(dir) = self.checkout_dir(p, from).await? {
            return self.rebase_resolving(p, &self.git_at(&dir), from, into, cut).await;
        }
        let git = self.git(p);
        let tmp = std::env::temp_dir().join(format!("gitnetix-rebase-{}", new_id()));
        git.worktree_add(&tmp, from, None).await?;
        let done = self.rebase_resolving(p, &self.git_at(&tmp), from, into, cut).await;
        // The rebase stands either way: a folder that won't go (a tool still writing there) is only logged.
        if let Err(e) = git.worktree_remove(&tmp, true).await {
            crate::log::error(format!("Could not remove the temporary checkout {}: {e}", tmp.display()));
        }
        done
    }

    /// Rebase `g`'s checkout of `from` onto `into` (only its commits past `cut`, when given), AI resolving the
    /// conflicts on the way. When they can't be, the rebase is aborted.
    async fn rebase_resolving(&self, p: &Project, g: &Git, from: &str, into: &str, cut: Option<&str>) -> Result<()> {
        if g.rebase_from(into, cut).await? {
            return Ok(());
        }
        self.resolve_or_abort(p, g, "rebase", from, into, |r| format!("Rebasing {from} onto {into} stopped on conflicts.{} Rebase it by hand and resolve first.", r.why())).await
    }

    /// Merge commit of `from` in `g`'s checkout of `into`, AI resolving the conflicts.
    /// When they can't be, the merge is aborted. Returns the merge commit.
    async fn merge_resolving(&self, p: &Project, g: &Git, from: &str, into: &str, message: &str) -> Result<String> {
        if !g.merge_start(from, message).await? {
            self.resolve_or_abort(p, g, "merge", from, into, |r| format!("Merging {from} into {into} conflicts in {}.{} Rebase onto the base and resolve first.", r.left.join(", "), r.why())).await?;
        }
        g.rev_parse("HEAD").await
    }

    /// Bring a branch up to date with its base by merging the base into it
    /// (no history rewrite: right for shared release and dev branches).
    pub async fn sync_branch(&self, project_id: &str, branch: &str) -> Result<MergeResult> {
        self.refuse_locked(project_id, branch)?;
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let from = self.base_of(&p, branch, &default).await;
        if from == branch {
            return Err(Error::Invalid(format!("{branch} has no base to update from")));
        }
        let (sha, already_merged) = self.merge_refs(&p, &from, branch).await?;
        self.changed(project_id);
        Ok(MergeResult { into: branch.to_string(), sha, already_merged, deleted: false, delete_error: None, switched: false, stayed: None, pushed: false, push_error: None, retagged: None, tag_error: None })
    }

    /// Merge commit of `from` (a local branch, or a remote-tracking one) into local branch `into`. Returns (new tip, already merged).
    async fn merge_refs(&self, p: &Project, from: &str, into: &str) -> Result<(String, bool)> {
        let git = self.git(p);
        if !git.ref_exists(&format!("refs/heads/{from}")).await? && !git.ref_exists(&format!("refs/remotes/{from}")).await? {
            return Err(Error::NotFound(format!("branch {from}")));
        }
        if !git.ref_exists(&format!("refs/heads/{into}")).await? {
            return Err(Error::NotFound(format!("local branch {into}")));
        }
        if git.is_ancestor(from, into).await? {
            return Ok((git.rev_parse(into).await?, true));
        }
        // None: conflicts, for AI to resolve in a checkout.
        let tree = match git.merge_tree(into, from).await? {
            Ok(tree) => Some(tree),
            Err(_) if self.resolves_conflicts(p) => None,
            Err(files) => return Err(Error::Invalid(format!("Merging {from} into {into} conflicts in {}. Rebase onto the base and resolve first.", files.join(", ")))),
        };
        let message = format!("Merge branch '{from}' into {into}");
        let sha = match (self.checkout_dir(p, into).await?, tree) {
            (Some(dir), tree) => {
                self.check_wip_clear(&dir, from, into).await?;
                let g = self.git_at(&dir);
                // Git won't start a merge commit over staged changes.
                if g.has_staged().await? {
                    return Err(Error::Invalid(format!("{into} has staged changes at {}. Commit or unstage them first.", dir.display())));
                }
                match tree {
                    Some(_) => g.merge_no_ff(from, &message).await?,
                    None => self.merge_resolving(p, &g, from, into, &message).await?,
                }
            }
            // Not checked out anywhere: merge it in a throwaway worktree.
            (None, None) => {
                let tmp = std::env::temp_dir().join(format!("gitnetix-merge-{}", new_id()));
                git.worktree_add(&tmp, into, None).await?;
                let sha = self.merge_resolving(p, &self.git_at(&tmp), from, into, &message).await;
                // The merge stands either way: a folder that won't go (a tool still writing there) is only logged.
                if let Err(e) = git.worktree_remove(&tmp, true).await {
                    crate::log::error(format!("Could not remove the temporary checkout {}: {e}", tmp.display()));
                }
                sha?
            }
            (None, Some(tree)) => {
                let (old, tip) = (git.rev_parse(into).await?, git.rev_parse(from).await?);
                let commit = git.commit_tree(&tree, &[&old, &tip], &message).await?;
                git.update_ref_from(&format!("refs/heads/{into}"), &commit, &old).await?;
                commit
            }
        };
        Ok((sha, false))
    }

    /// Fetch origin (pruning branches deleted there).
    pub async fn fetch(&self, project_id: &str) -> Result<()> {
        let p = self.store.project(project_id)?;
        self.fetch_with(project_id, &self.git(&p)).await
    }

    async fn fetch_with(&self, project_id: &str, git: &Git) -> Result<()> {
        git.fetch().await?;
        let before = self.protected.lock().unwrap().get(project_id).map(|(_, l)| l.clone());
        let after = self.protected_branches(project_id, true).await;
        // The next overview asks the git host again. The watcher already refreshes for the refs the fetch moved:
        // one more refresh only for a new list of protected branches.
        if let Some(h) = self.hosted.lock().unwrap().get_mut(project_id) {
            h.asked.clear();
        }
        if before.as_ref() != Some(&after) {
            self.changed(project_id);
        }
        Ok(())
    }

    /// Rebuild the overview, asking the git host again about every tip still without a pull request.
    fn recheck_host(&self, project_id: &str) {
        if let Some(h) = self.hosted.lock().unwrap().get_mut(project_id) {
            h.asked.clear();
        }
        self.changed(project_id);
    }

    /// Fetch only when origin's tips moved since the last time this fetched (always the first time).
    /// Returns whether it fetched. Read before the fetch: a push landing in between shows as moved next time.
    /// Asks origin at most every [`AUTO_FETCH_GAP`], less often while it stays unchanged ([`ask_gap`]); a call meanwhile,
    /// or while a check runs, returns false. `back`: someone just came back to a window (focused it, or its looks had
    /// paused): the wait starts over, so origin is asked now.
    pub async fn auto_fetch(&self, project_id: &str, back: bool) -> Result<bool> {
        let p = self.store.project(project_id)?;
        let slot = self.auto_fetch.lock().unwrap().entry(project_id.into()).or_default().clone();
        // A second window asking while the first one's check runs waits for it, then shares it.
        let mut s = slot.lock().await;
        if back {
            s.moved = Some(Instant::now());
        }
        let gap = ask_gap(s.moved.map_or(std::time::Duration::ZERO, |t| t.elapsed()));
        if s.asked.is_some_and(|t| t.elapsed() < gap) {
            return Ok(false);
        }
        let git = self.git(&p);
        let own_ssh = match s.own_ssh {
            Some(own) => own,
            None => git.own_ssh().await,
        };
        let git = git.unattended(own_ssh);
        let tips = match tokio::time::timeout(TIPS_TIMEOUT, git.remote_tips()).await {
            Ok(tips) => tips,
            Err(_) => Err(Error::Invalid(format!("origin did not answer within {} s", TIPS_TIMEOUT.as_secs()))),
        };
        s.asked = Some(Instant::now());
        s.own_ssh = tips.is_ok().then_some(own_ssh);
        let tips = tips?;
        if s.tips.as_ref() != Some(&tips) {
            tokio::time::timeout(FETCH_TIMEOUT, self.fetch_with(project_id, &git))
                .await
                .map_err(|_| Error::Invalid(format!("the fetch from origin took over {} minutes", FETCH_TIMEOUT.as_secs() / 60)))??;
            s.tips = Some(tips);
            s.moved = Some(Instant::now());
            s.hosted = Some(Instant::now());
            return Ok(true);
        }
        // Nothing moved on origin, but its host may have opened or merged a pull request: ask it as often as the timed fetch did.
        // Only Azure DevOps answers that (see `hosted_prs`): for other hosts the refresh would show nothing new.
        if s.hosted.is_none_or(|t| t.elapsed() >= HOSTED_TTL) {
            s.hosted = Some(Instant::now());
            if self.pr_kind(&p).await.ok() == Some("azure") {
                self.recheck_host(project_id);
            }
        }
        Ok(false)
    }

    // ---------- worktrees & agents ----------

    pub async fn worktrees(&self) -> Result<Vec<WorktreeView>> {
        let projects = self.store.read(|c| c.projects.clone());
        let agents = self.agents.list();
        // What every worktree of a project needs, read once for all of them: its refs, and the key of its saved views.
        let mut each = Vec::new();
        for p in &projects {
            let git = self.git(p);
            let Ok(list) = git.worktrees().await else { continue };
            let default = git.default_branch().await.unwrap_or_else(|_| "main".into());
            let refs = Refs::load(&git, git.branches().await.unwrap_or_default()).await;
            let fingerprint = git.ref_fingerprint().await.ok();
            each.push((p, git, default, refs, fingerprint, list));
        }
        // Several worktrees at once, keeping the order: each reads its files (a `git status`), and with a few projects of
        // several worktrees one after another took longer than the list's poll.
        // Indices into `each`, not borrowed tuples: a closure taking references fails the Send check where this is spawned.
        let jobs: Vec<(usize, usize)> = each.iter().enumerate().flat_map(|(i, e)| (0..e.5.len()).map(move |j| (i, j))).collect();
        let (each, agents) = (&each, &agents);
        let out: Vec<WorktreeView> = stream::iter(jobs)
            .map(|(i, j)| {
                let (p, git, default, refs, fingerprint, list) = &each[i];
                let (p, w) = (*p, &list[j]);
                async move {
                    let (mut add, mut del) = (0, 0);
                    let changes = Git::new(&w.path).wip_changes().await.unwrap_or_default();
                    for f in &changes {
                        add += f.additions;
                        del += f.deletions;
                    }
                    let meta = w.branch.as_ref().and_then(|b| p.branches.get(b));
                    let base = match &w.branch {
                        // As the last overview filed it, while no ref moved: working it out takes many git calls.
                        Some(b) => {
                            let saved = fingerprint.as_deref().and_then(|f| self.cached_parent(p, f, b, default));
                            let base = match saved {
                                Some(parent) => parent.unwrap_or_else(|| default.clone()),
                                None => self.base_of(p, b, default).await,
                            };
                            Some(base).filter(|x| x != b)
                        }
                        None => None,
                    };
                    let (behind, ahead) = match (w.branch.as_deref().and_then(|b| refs.rev(b)), base.as_deref().and_then(|b| refs.rev(b))) {
                        (Some(r), Some(b)) => refs.left_right(git, &b, &r).await.unwrap_or((0, 0)),
                        _ => (0, 0),
                    };
                    WorktreeView {
                        project_id: p.id.clone(),
                        project_name: p.name.clone(),
                        base,
                        ticket: meta.and_then(|m| m.ticket.clone()),
                        // Without its log: agents.list carries it, and here it rode along on every poll (MBs with long sessions).
                        agent: agents.iter().find(|a| a.cwd == w.path).map(|a| AgentSession { lines: Vec::new(), ..a.clone() }),
                        path: w.path.clone(),
                        branch: w.branch.clone(),
                        main: w.main,
                        additions: add,
                        deletions: del,
                        ahead,
                        behind,
                        wip: changes.len() as u32,
                    }
                }
            })
            .buffered(8)
            .collect()
            .await;
        // Agents come from their own list, and their logs would make the file big.
        self.worktrees.set(&out.iter().map(|w| WorktreeView { agent: None, ..w.clone() }).collect::<Vec<_>>());
        Ok(out)
    }

    /// The list [`Self::worktrees`] last built (none before the first), at once: for the projects still open, under their current names.
    pub fn saved_worktrees(&self) -> Option<Vec<WorktreeView>> {
        let names: HashMap<String, String> = self.store.read(|c| c.projects.iter().map(|p| (p.id.clone(), p.name.clone())).collect());
        let list: Vec<WorktreeView> = self.worktrees.get()?;
        Some(list.into_iter().filter_map(|w| Some(WorktreeView { project_name: names.get(&w.project_id)?.clone(), ..w })).collect())
    }

    pub async fn create_worktree(&self, project_id: &str, branch: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        if branch == default {
            return Err(Error::Invalid(format!("{default} is reserved: create a new branch for the worktree.")));
        }
        let path = worktree_path(&p, branch);
        // A branch only on origin is checked out tracking it (git's DWIM).
        if git.branch_rev(branch).await?.is_some() {
            git.worktree_add(&path, branch, None).await?;
        } else {
            git.worktree_add(&path, branch, Some(&default)).await?;
        }
        init_submodules(&path).await;
        copy_worktree_files(&self.store, &p, &path).await;
        self.store.with_project(project_id, |p| {
            if let Some(m) = p.branches.get_mut(branch) {
                m.worktree = Some(path.to_string_lossy().to_string());
            }
            Ok(())
        })?;
        let mut vars = hook_vars(&p, branch);
        vars.push(("WORKTREE", path.to_string_lossy().to_string()));
        hooks::spawn(&p, "worktreeCreated", &path, vec![vars]);
        self.changed(project_id);
        Ok(path.to_string_lossy().to_string())
    }

    pub async fn remove_worktree(&self, project_id: &str, path: &str, force: bool) -> Result<()> {
        let p = self.store.project(project_id)?;
        if Path::new(path) == Path::new(&p.path) {
            return Err(Error::Invalid("That is the main checkout".into()));
        }
        // One of the project's worktrees, or a folder already gone: any other folder is neither stopped nor deleted.
        if Path::new(path).exists() {
            self.require_own_checkout(&p, path).await?;
        }
        // git refuses a dirty worktree; refuse before its shell and agents are stopped for nothing.
        if !force && Path::new(path).exists() && Git::new(path).wip_count().await? > 0 {
            return Err(Error::Invalid(format!("{path} has uncommitted or untracked files. Commit or discard them first.")));
        }
        // Removing also deletes the worktree's submodule clones: keep commits that exist nowhere else.
        if !force && Path::new(path).exists() {
            let (_, unpushed, _) = Git::new(path).try_run(&["submodule", "foreach", "--recursive", "--quiet", "git rev-list -n1 HEAD --branches --not --remotes"]).await?;
            if !unpushed.trim().is_empty() {
                return Err(Error::Invalid(format!("A submodule in {path} has commits that are not pushed. Push them first.")));
            }
        }
        // The one hook waited for: it runs in the worktree while its files are still there (to copy some out), and when
        // it fails and stops on failure, the worktree stays.
        if Path::new(path).exists() && hooks::live(&p, "worktreeRemoved").is_some() {
            let branch = match p.branches.iter().find(|(_, m)| m.worktree.as_deref() == Some(path)) {
                Some((b, _)) => b.clone(),
                None => Git::new(path).current_branch().await.ok().flatten().unwrap_or_default(),
            };
            let mut vars = hook_vars(&p, &branch);
            vars.push(("WORKTREE", path.to_string()));
            hooks::wait(&p, "worktreeRemoved", Path::new(path), vars).await?;
        }
        let agents: Vec<String> = self.agents.list().into_iter().filter(|a| a.cwd == path).map(|a| a.id).collect();
        // Its shell first, so nothing it started keeps writing in the folder.
        self.shells.remove(path, None);
        for id in &agents {
            let _ = self.agents.stop(id);
        }
        // Checked above; git refuses any worktree holding submodules unless forced.
        self.git(&p).worktree_remove(Path::new(path), true).await?;
        // Their folder is gone, so the sessions cannot run again.
        for id in &agents {
            let _ = self.agents.remove(id);
        }
        self.store.with_project(project_id, |p| {
            for m in p.branches.values_mut() {
                if m.worktree.as_deref() == Some(path) {
                    m.worktree = None;
                }
            }
            Ok(())
        })?;
        self.changed(project_id);
        Ok(())
    }

    /// Refuses any folder that isn't one of the project's checkouts.
    async fn require_own_checkout(&self, p: &Project, path: &str) -> Result<()> {
        let want = crate::shell::key(path);
        let ours = crate::shell::key(&p.path) == want
            || self.git(p).worktrees().await?.iter().any(|w| crate::shell::key(&w.path) == want);
        if !ours {
            return Err(Error::Invalid("Not a checkout of this project".into()));
        }
        Ok(())
    }

    /// Opens the terminal of one of the project's checkouts; any other folder is refused.
    pub async fn shell_open(&self, project_id: &str, path: &str, tab: u32, cols: u16, rows: u16) -> Result<crate::shell::Snapshot> {
        let p = self.store.project(project_id)?;
        self.require_own_checkout(&p, path).await?;
        self.shells.open(path, tab, cols, rows)
    }

    /// Commands of every project tool found in one of the project's checkouts (tracked or not ignored files),
    /// minus those whose program isn't installed.
    pub async fn shell_scripts(&self, project_id: &str, path: &str) -> Result<Vec<Scripts>> {
        let p = self.store.project(project_id)?;
        self.require_own_checkout(&p, path).await?;
        let mut args = vec!["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"];
        args.extend_from_slice(project_commands::PATHSPECS);
        let root = Path::new(path);
        let out = self.git_at(root).run(&args).await?;
        let files: Vec<&str> = out.split('\0').filter(|f| !f.is_empty()).collect();
        let mut all = project_commands::project_commands(&files, |f| std::fs::read_to_string(root.join(f)).ok(), |f| project_commands::executable(&root.join(f)), &p.name);
        let installed = project_commands::installed().await;
        for g in &mut all {
            g.scripts.retain(|(_, cmd)| installed(cmd));
        }
        all.retain(|g| !g.scripts.is_empty());
        Ok(all)
    }

    /// `pick` overrides the "agent" routing when it names a provider; its empty
    /// fields fall back to the template's model and the provider's setup, its permission and ultracode to the routing's.
    /// Its permission and ultracode count without a provider too: a request for a stricter mode must not start in Bypass.
    fn agent_ai(&self, t: &Template, pick: Route) -> Result<Resolved> {
        if pick.provider.as_deref().is_some_and(|s| !s.is_empty()) {
            let tm = if pick.model.as_deref().is_some_and(|s| !s.is_empty()) { None } else { t.model.as_deref() };
            self.store.read(|c| {
                let agent = c.ai.routing.get("agent");
                let permission = pick.permission.clone().or_else(|| agent.and_then(|r| r.permission.clone()));
                let ultracode = pick.ultracode.or_else(|| agent.and_then(|r| r.ultracode));
                ai::resolve_route(&c.ai, Route { permission, ultracode, ..pick }, tm)
            })
        } else {
            let mut r = self.route("agent", Some(t))?;
            if let Some(permission) = pick.permission {
                r.permission = permission;
            }
            if let Some(ultracode) = pick.ultracode {
                r.ultracode = ultracode;
            }
            Ok(r)
        }
    }

    pub async fn start_agent(&self, project_id: &str, branch: Option<&str>, cwd: &Path, worktree: bool, request: &str, pick: Route) -> Result<AgentSession> {
        let p = self.store.project(project_id)?;
        let t = self.template("agent", None, Some(&p.id))?;
        let r = self.agent_ai(&t, pick)?;
        if let Some(rules) = self.policies(project_id) {
            crate::account::check_agent(&rules, &r.provider, &r.permission)?;
        }
        // Its model list, so the CLI gets only an effort the model takes.
        ai::warm(&r.provider).await;
        let branch = match branch {
            Some(b) => b.to_string(),
            None => Git::new(cwd).current_branch().await?.unwrap_or_else(|| "HEAD".into()),
        };
        let mut vars: BTreeMap<String, String> = BTreeMap::new();
        vars.insert("request".into(), request.to_string());
        vars.insert("branch".into(), branch.clone());
        vars.insert("worktree".into(), cwd.to_string_lossy().to_string());
        let mut prompt = t.body.clone();
        for (k, v) in &vars {
            prompt = prompt.replace(&format!("{{{k}}}"), v);
        }
        prompt = prompt.replace("{language}", templates::language_name(&self.gen_lang(&p.gen_lang.commit)));
        let (ticket, mut notes) = self.agent_ticket(project_id, &branch, cwd).await;
        // Last, so nothing in the ticket is taken for a placeholder.
        prompt = insert_ticket(&prompt, &ticket);
        // Where the agent saves the images and audio it shows: the log reads them from there only.
        let shots = attach_root(cwd).await?.join("shared");
        std::fs::create_dir_all(&shots)?;
        prompt = format!("{prompt}\n\n{}\n\n{}", templates::share_media(&shots.to_string_lossy()), templates::NO_AI_CREDIT);
        // The created hooks of a new worktree run alongside: the agent starts once they have set it up.
        if !hooks::settle(cwd).await {
            notes.push(LogLine::new("dim", "  ⚠ The hooks were still running after 30 seconds: started without waiting for them"));
        }
        self.agents.start(StartArgs {
            project_id: project_id.into(),
            branch,
            cwd: cwd.to_path_buf(),
            worktree,
            request: request.into(),
            prompt,
            ai: r,
            notes,
            study: None,
        })
    }

    /// The prompt section for the branch's ticket ("" without one), with log lines saying what
    /// happened. The ticket is also saved in the checkout's git dir so the agent can read it again.
    /// A tracker that fails or is slow never keeps the agent from starting.
    async fn agent_ticket(&self, project_id: &str, branch: &str, cwd: &Path) -> (String, Vec<LogLine>) {
        let note = |text: String| vec![LogLine::new("dim", text)];
        let t = match tokio::time::timeout(TICKET_TIMEOUT, self.branch_ticket(project_id, branch)).await {
            Ok(Ok(Some(t))) => t,
            Ok(Ok(None)) => return (String::new(), vec![]),
            Ok(Err(e)) => return (String::new(), note(format!("  ⚠ Could not load the branch's ticket: {e}"))),
            Err(_) => return (String::new(), note("  ⚠ The branch's ticket took too long to load: starting without it".into())),
        };
        let body = ticket_context(&t);
        let saved = match Git::new(cwd).git_paths(&[TICKET_FILE]).await {
            Ok(paths) => paths.into_iter().next().filter(|f| std::fs::write(f, &body).is_ok()),
            Err(_) => None,
        };
        (ticket_section(project_id, &t.key, &body, saved.as_deref()), note(format!("  ↳ Ticket {} added to the context", t.key)))
    }

    /// An agent on a branch always works in that branch's own worktree, made
    /// here if needed, so it keeps going while the main checkout moves on.
    /// Without a branch it runs on the main checkout.
    pub async fn start_agent_on(&self, project_id: &str, branch: Option<String>, request: &str, ticket: Option<String>, pick: Route, files: &[Attachment]) -> Result<AgentSession> {
        let p = self.store.project(project_id)?;
        let (cwd, b) = match branch {
            Some(b) => (self.agent_worktree(&p, &b).await?, Some(b)),
            None => (top_path(&p), None),
        };
        let wt = cwd != Path::new(&p.path);
        let mut request = request.to_string();
        if let Some(t) = ticket.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            // Linked before the start, which loads the branch's ticket into the agent's context.
            if let Some(b) = &b {
                self.store.with_project(project_id, |p| Ok(link_ticket(p, b, t)))?;
            }
            request = format!("{request} (ticket {t})");
        }
        let request = attach(&cwd, &request, files).await?;
        self.start_agent(project_id, b.as_deref(), &cwd, wt, &request, pick).await
    }

    async fn agent_worktree(&self, p: &Project, branch: &str) -> Result<PathBuf> {
        let top = top_path(p);
        let git = self.git(p);
        let default = git.default_branch().await?;
        // Checked before the main checkout gets switched off it below; create_worktree refuses it too.
        if branch == default {
            return Err(Error::Invalid(format!("{default} is reserved: create a new branch for the agent.")));
        }
        match self.checkout_dir(p, branch).await? {
            Some(dir) if dir != top => return Ok(dir),
            Some(_) => {
                // Checked out in the main checkout: move the main checkout off it first.
                if git.has_uncommitted().await? {
                    return Err(Error::Invalid(format!(
                        "{branch} has uncommitted changes in the main checkout. Commit or stash them first: the agent gets its own worktree."
                    )));
                }
                let base = self.base_of(p, branch, &default).await;
                if base == branch || git.switch(&base).await.is_err() {
                    git.switch_detach("HEAD").await?;
                }
            }
            None => {}
        }
        Ok(PathBuf::from(self.create_worktree(&p.id, branch).await?))
    }

    pub async fn agent_message(&self, id: &str, text: &str, files: &[Attachment]) -> Result<()> {
        let s = self.agents.get(id)?;
        let r = match s.ai {
            Some(r) => r,
            None => self.route("agent", None)?,
        };
        ai::warm(&r.provider).await;
        let text = attach(Path::new(&s.cwd), text, files).await?;
        self.agents.message(id, &text, &r)
    }

    /// Run agent `id`'s last prompt again, after it failed.
    pub fn agent_retry(&self, id: &str) -> Result<()> {
        let r = match self.agents.get(id)?.ai {
            Some(r) => r,
            None => self.route("agent", None)?,
        };
        self.agents.retry(id, &r)
    }

    /// Continue agent `id` after the usage limit it stopped at, without waiting for the reset.
    pub fn agent_continue(&self, id: &str) -> Result<()> {
        let r = match self.agents.get(id)?.ai {
            Some(r) => r,
            None => self.route("agent", None)?,
        };
        self.agents.carry_on(id, &r)
    }

    /// File `path` as a turn of agent `id` changed it: between snapshots `from` and `to` of its checkout.
    pub async fn agent_diff(&self, id: &str, from: &str, to: &str, path: &str, full: bool) -> Result<Vec<Hunk>> {
        let cwd = self.agents.get(id)?.cwd;
        Git::new(cwd).file_diff(path, Some(&format!("{}..{}", check_sha(from)?, check_sha(to)?)), full).await
    }

    /// Both versions of `path` around a turn of agent `id`, base64 (image previews), as `agent_diff` picks them.
    pub async fn agent_blobs(&self, id: &str, from: &str, to: &str, path: &str) -> Result<Blobs> {
        let cwd = self.agents.get(id)?.cwd;
        Git::new(cwd).blobs(Side::Rev(check_sha(from)?), Side::Rev(check_sha(to)?), path).await
    }

    /// A file sent to agent `id`, base64, as its log lists it.
    pub async fn agent_file(&self, id: &str, path: &str) -> Result<String> {
        attachment(Path::new(&self.agents.get(id)?.cwd), path).await
    }

    /// Where `agent_file` reads from, for the desktop window to copy or save it.
    pub async fn agent_file_path(&self, id: &str, path: &str) -> Result<PathBuf> {
        attachment_path(Path::new(&self.agents.get(id)?.cwd), path).await
    }

    /// Applies from the next message on. Resolved like a new session's pick,
    /// so "Default" model or effort means the same in both.
    pub fn agent_configure(&self, id: &str, pick: Route) -> Result<AgentSession> {
        let s = self.agents.get(id)?;
        let t = self.template("agent", None, Some(&s.project_id))?;
        let provider = pick.provider.clone().filter(|p| !p.is_empty()).or(s.ai.map(|r| r.provider));
        let r = self.agent_ai(&t, Route { provider, ..pick })?;
        if let Some(rules) = self.policies(&s.project_id) {
            crate::account::check_agent(&rules, &r.provider, &r.permission)?;
        }
        self.agents.set_ai(id, r)
    }

    // ---------- AI setup ----------

    pub async fn ai_test(&self, provider: &str) -> Result<serde_json::Value> {
        let r = self.store.read(|c| {
            let conf = c.ai.providers.get(provider).cloned().unwrap_or_default();
            Resolved { provider: provider.into(), method: conf.method, model: conf.model, effort: conf.effort, base_url: conf.base_url, permission: String::new(), ultracode: false }
        });
        let t0 = Instant::now();
        let reply = ai::complete(&r, "Reply with the single word: ok", None).await?;
        let ms = t0.elapsed().as_millis() as u64;
        // A CLI found on PATH has no saved settings until now: it works the same with defaults.
        self.store.write(|c| Ok(c.ai.providers.entry(provider.into()).or_default().connected = true))?;
        self.config_changed();
        Ok(serde_json::json!({ "ms": ms, "model": r.label(), "reply": reply.chars().take(80).collect::<String>() }))
    }

    pub async fn template_preview(&self, project_id: &str, template_id: &str, language: &str) -> Result<(String, String)> {
        let p = self.store.project(project_id)?;
        let mut t = self.template("", Some(template_id), Some(&p.id))?;
        let git = self.git(&p);
        let current = git.current_branch().await?.unwrap_or_else(|| "HEAD".into());
        let default = git.default_branch().await?;
        let mut vars = BTreeMap::new();
        let source: String;
        match t.kind.as_str() {
            "commit" => {
                let mut d = git.run(&["diff", "HEAD", "--stat", "-p"]).await.unwrap_or_default();
                if d.trim().is_empty() {
                    d = git.run(&["show", "--stat", "-p", "HEAD"]).await.unwrap_or_default();
                    source = "the last commit (no uncommitted changes)".into();
                } else {
                    source = format!("uncommitted changes on {current}");
                }
                crate::git::truncate_utf8(&mut d, 40_000);
                vars.insert("diff".into(), d);
                vars.insert("files".into(), git.run(&["diff", "HEAD", "--name-status"]).await.unwrap_or_default());
                vars.insert("branch".into(), current.clone());
                vars.insert("ticket".into(), "(none)".into());
            }
            "branch" => {
                let last = git.log("HEAD", Some(1)).await?.into_iter().next().map(|c| c.subject).unwrap_or_else(|| "Add a new feature".into());
                source = format!("“{last}”");
                vars.insert("description".into(), last);
                vars.insert("type".into(), "feat".into());
                vars.insert("ticket".into(), String::new());
            }
            "pr" => {
                let base = self.base_of(&p, &current, &default).await;
                source = format!("{current} → {base}");
                vars.insert("diff".into(), git.range_diff(&format!("{base}...{current}"), 40_000).await.unwrap_or_default());
                vars.insert("commits".into(), commit_lines(&git.log(&format!("{base}..{current}"), Some(50)).await.unwrap_or_default()));
                vars.insert("branch".into(), current.clone());
                vars.insert("base".into(), base);
                vars.insert("ticket".into(), "(none)".into());
            }
            "release" => {
                let from = git.tags().await?.first().map(|t| t.name.clone()).unwrap_or_else(|| default.clone());
                source = format!("{from} → {current}");
                let commits = git.log(&format!("{from}..{current}"), Some(NOTES_MAX_COMMITS)).await.unwrap_or_default();
                let (note, projects) = commit_projects(&git, &commits, &current).await;
                templates::prepare_release(&mut t);
                t.body.push_str(&note);
                vars = release_vars(&git, &from, &current, &commits, true, &projects).await;
            }
            "ticket" => {
                let (base, diff, commits) = self.branch_work(&p, &current, None).await?;
                source = format!("{current} → {base}");
                vars.insert("project".into(), p.name.clone());
                vars.insert("diff".into(), diff);
                vars.insert("commits".into(), commits);
                vars.insert("branch".into(), current.clone());
                vars.insert("base".into(), base);
                templates::prepare_ticket(&mut t, &vars);
            }
            "agent" => {
                return Ok((
                    format!("Agent templates run as a live session. Prompt that would be sent:\n\n{}", t.body.replace("{request}", "squash my last 3 commits").replace("{branch}", &current).replace("{worktree}", &p.path)),
                    "“squash my last 3 commits”".into(),
                ));
            }
            templates::GLOBAL => {
                return Ok(("Global skills that are on go in front of every other template, conflict resolution and voice dictation aside. Preview one of those to see them at work.".into(), "no data".into()));
            }
            _ => {
                return Ok(("Conflict templates run when a rebase stops on a conflict.".into(), "a conflicted file".into()));
            }
        }
        let task = t.kind.clone();
        let out = self.ask(&task, &t, vars, language, None).await?;
        Ok((out, source))
    }

    // ---------- pull requests ----------

    pub async fn github(&self, project_id: &str) -> Result<GitHub> {
        let p = self.store.project(project_id)?;
        let url = self.git(&p).remote_url("origin").await?.ok_or_else(|| Error::NotConnected("This repository has no origin remote".into()))?;
        let repo = parse_remote(&url).ok_or_else(|| Error::Unsupported(format!("remote {url}")))?;
        let api =self.store.read(|c| c.integrations.github_api.clone()).filter(|s| !s.is_empty());
        if !github_host_ok(&repo.host, api.is_some()) {
            return Err(Error::Unsupported(format!(
                "{} remotes need a GitHub Enterprise API URL in the menu, under Git providers — github.com only otherwise",
                repo.host
            )));
        }
        let token = providers::github_auth::token(None).await?;
        Ok(GitHub::new(repo, token, api))
    }

    /// The linked GitHub account's repositories, to pick one to clone.
    pub async fn github_repos(&self) -> Result<Vec<UserRepo>> {
        let api = self.store.read(|c| c.integrations.github_api.clone()).filter(|s| !s.is_empty());
        let token = providers::github_auth::token(None).await?;
        GitHub::new(RepoRef::default(), token, api).user_repos().await
    }

    /// The repositories of the linked `kind` account (github, gitlab, bitbucket, gitea), to pick one to clone.
    pub async fn host_repos(&self, kind: &str) -> Result<Vec<UserRepo>> {
        if kind == "github" {
            return self.github_repos().await;
        }
        let i = self.store.read(|c| c.integrations.clone());
        providers::connect(kind, RepoRef::default(), &i).await?.user_repos().await
    }

    /// Where the project's pull requests live: Azure DevOps for an Azure remote, the GitLab, Bitbucket
    /// or Gitea connection whose server origin is on, GitHub otherwise.
    pub async fn pr_host(&self, project_id: &str) -> Result<PrHost> {
        let p = self.store.project(project_id)?;
        if let Some(url) = self.git(&p).remote_url("origin").await? {
            if let Some(repo) = azure::parse_remote(&url) {
                return Ok(PrHost::Azure(azure::Azure::new(repo, azure_auth::authorization().await?)));
            }
            if let Some(repo) = parse_remote(&url) {
                let i = self.store.read(|c| c.integrations.clone());
                if let Some(kind) = providers::host_kind(&repo, &i) {
                    return providers::connect(kind, repo, &i).await;
                }
            }
        }
        Ok(PrHost::GitHub(self.github(project_id).await?))
    }

    /// [`Self::pr_host`] for pull requests: a GitHub fork's go to the repository it was forked from once picked on the
    /// pull requests page. Renames and protected branches stay with origin's.
    pub async fn prs_host(&self, project_id: &str) -> Result<PrHost> {
        match self.pr_host(project_id).await? {
            PrHost::GitHub(gh) => {
                let to = self.pr_target(project_id, &gh.repo)?;
                Ok(PrHost::GitHub(match to {
                    Some(to) => gh.retarget(to),
                    None => gh,
                }))
            }
            other => Ok(other),
        }
    }

    /// The repository pull requests go to instead of origin `repo`, as picked for this origin.
    fn pr_target(&self, project_id: &str, repo: &RepoRef) -> Result<Option<RepoRef>> {
        let origin = format!("{}/{}", repo.owner, repo.repo);
        let p = self.store.project(project_id)?;
        Ok(p.pr_repo.filter(|r| r.origin.eq_ignore_ascii_case(&origin) && !r.to.eq_ignore_ascii_case(&origin)).and_then(|r| {
            let (owner, name) = r.to.split_once('/')?;
            Some(RepoRef { owner: owner.into(), repo: name.into(), ..repo.clone() })
        }))
    }

    /// Where pull requests' commits are fetched from: origin, or the URL of the repository they go to instead.
    async fn pr_source(&self, p: &Project) -> Result<String> {
        let url = self.git(p).remote_url("origin").await?;
        let target = match url.as_deref().and_then(parse_remote) {
            Some(repo) => self.pr_target(&p.id, &repo)?.map(|to| swap_repo(url.as_deref().unwrap_or_default(), &repo, &to)),
            None => None,
        };
        Ok(target.unwrap_or_else(|| "origin".into()))
    }

    /// For the pull requests page, when origin is a GitHub fork or the user can't push to it: origin (owner/repo as
    /// its URL names it), the repository it was forked from, push access, and where pull requests go as picked (null:
    /// never picked, so origin). None otherwise, or when GitHub can't be asked.
    pub async fn pr_fork(&self, project_id: &str) -> Option<serde_json::Value> {
        let gh = self.github(project_id).await.ok()?;
        let info = gh.info().await.ok()?;
        if info.parent.is_none() && info.can_push {
            return None;
        }
        let origin = format!("{}/{}", gh.repo.owner, gh.repo.repo);
        let to = self.store.project(project_id).ok()?.pr_repo.filter(|r| r.origin.eq_ignore_ascii_case(&origin)).map(|r| r.to);
        Some(serde_json::json!({ "origin": origin, "parent": info.parent, "canPush": info.can_push, "to": to }))
    }

    /// Forks origin to the user's GitHub account (or finds their fork), gives it a remote here unless one points at it,
    /// and pushes `branch` there, tracking it so its later pushes go there too. Returns the fork (owner/repo).
    async fn push_to_fork(&self, p: &Project, gh: &GitHub, branch: &str) -> Result<String> {
        let git = match self.checkout_dir(p, branch).await? {
            Some(d) => self.git_at(&d),
            None => self.git(p),
        };
        let fork = gh.fork().await?;
        let owner = fork.full_name.split_once('/').map(|(o, _)| o.to_string()).ok_or_else(|| Error::Http(format!("GitHub named the fork “{}”", fork.full_name)))?;
        let remotes = git.remotes().await?;
        let remote = match remote_of(&remotes, &fork.full_name) {
            Some(r) => r.to_string(),
            None => {
                let name = fork_remote_name(&remotes, &owner);
                // Same protocol as origin, so the same sign-in (credential helper or ssh key) pushes to it.
                let ssh = git.remote_url("origin").await?.is_some_and(|u| !u.starts_with("http"));
                git.add_remote(&name, if ssh { &fork.ssh_url } else { &fork.clone_url }).await?;
                name
            }
        };
        // A new fork takes a few seconds to copy: GitHub answers "not found" until then.
        for left in (0..10).rev() {
            match git.push_to(&remote, branch, true).await {
                Err(Error::Git { stderr, .. }) if left > 0 && stderr.to_lowercase().contains("not found") => tokio::time::sleep(std::time::Duration::from_secs(3)).await,
                r => {
                    r?;
                    break;
                }
            }
        }
        self.changed(&p.id);
        Ok(fork.full_name)
    }

    /// Pushes `branch` to the user's GitHub fork of origin, made if needed: for an origin they can't push to. Returns
    /// the fork (owner/repo).
    pub async fn push_via_fork(&self, project_id: &str, branch: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let gh = self.github(project_id).await?;
        self.push_to_fork(&p, &gh, branch).await
    }

    /// Which host [`Self::pr_host`] connects to, read from origin without signing in: its [`PrHost::provider`].
    async fn pr_kind(&self, p: &Project) -> Result<&'static str> {
        let Some(url) = self.git(p).remote_url("origin").await? else { return Ok("github") };
        if azure::parse_remote(&url).is_some() {
            return Ok("azure");
        }
        let i = self.store.read(|c| c.integrations.clone());
        Ok(parse_remote(&url).and_then(|r| providers::host_kind(&r, &i)).unwrap_or("github"))
    }

    /// The diff range of pull request `number` as its host shows it: from where its head commit left the base commit
    /// to the head, both as the host names them. A clone without them fetches them from origin first; a base it still
    /// lacks (its branch since rewritten) gives way to origin's copy of the base branch.
    async fn pr_range(&self, p: &Project, number: u64, pr: &PrRefs) -> Result<String> {
        let git = self.git(p);
        let from = self.pr_source(p).await?;
        let refs = providers::head_refs(self.pr_kind(p).await?, number, &pr.head);
        let head = fetched_commit(&git, &from, &pr.head_sha, &refs).await?.ok_or_else(|| Error::NotFound(format!("the commits of #{number} on origin")))?;
        let base_refs: Vec<String> = providers::plain_branch(&pr.base).then(|| format!("refs/heads/{}", pr.base)).into_iter().collect();
        let base = match fetched_commit(&git, &from, &pr.base_sha, &base_refs).await? {
            Some(b) => b,
            None => git.branch_rev(&pr.base).await?.ok_or_else(|| Error::NotFound(format!("{} on origin", pr.base)))?,
        };
        Ok(format!("{base}...{head}"))
    }

    /// The files pull request `number` changes, renamed ones with their old path.
    pub async fn pr_files(&self, project_id: &str, number: u64, pr: &PrRefs) -> Result<Vec<FileChange>> {
        let p = self.store.project(project_id)?;
        let range = self.pr_range(&p, number, pr).await?;
        self.git(&p).range_changes(&range).await
    }

    /// One file's diff in pull request `number`, as its host draws it; `from` is its old path when renamed.
    pub async fn pr_diff(&self, project_id: &str, number: u64, pr: &PrRefs, path: &str, from: Option<&str>) -> Result<Vec<Hunk>> {
        let p = self.store.project(project_id)?;
        let range = self.pr_range(&p, number, pr).await?;
        self.git(&p).review_diff(&range, path, from).await
    }

    /// The title and description AI writes for `branch`'s pull request, from its changes against `base` (its base by
    /// default).
    pub async fn generate_pr(&self, project_id: &str, branch: &str, base: Option<&str>) -> Result<(String, String)> {
        let p = self.store.project(project_id)?;
        let t = self.template("pr", None, Some(&p.id))?;
        let ticket = p.branches.get(branch).and_then(|m| m.ticket.clone()).unwrap_or_else(|| "(none)".into());
        let (base, diff, commits) = self.branch_work(&p, branch, base).await?;
        let mut vars = BTreeMap::new();
        vars.insert("diff".into(), diff);
        vars.insert("commits".into(), commits);
        vars.insert("branch".into(), branch.into());
        vars.insert("base".into(), base);
        vars.insert("ticket".into(), ticket);
        let out = self.ask("pr", &t, vars, &p.gen_lang.pr, None).await?;
        let (title, body) = out.split_once('\n').map(|(a, b)| (a.trim().trim_start_matches('#').trim().to_string(), b.trim().to_string())).unwrap_or((out.clone(), String::new()));
        Ok((title, body))
    }

    /// What `branch` brings over `base` (its base by default): that base, the diff (cut to 60 000 bytes) and the commits.
    async fn branch_work(&self, p: &Project, branch: &str, base: Option<&str>) -> Result<(String, String, String)> {
        let git = self.git(p);
        let base = match base.filter(|b| !b.is_empty()) {
            Some(b) => b.to_string(),
            None => self.base_of(p, branch, &git.default_branch().await?).await,
        };
        // The default branch is its own base: through a fork, its pull request holds what it adds to origin's copy.
        // A base picked from origin's branches may have no local copy.
        let base_ref = if base == branch || !git.ref_exists(&format!("refs/heads/{base}")).await? { format!("origin/{base}") } else { base.clone() };
        let (base_rev, rev) = tokio::join!(git.rev_of(&base_ref), git.rev_of(branch));
        let diff = git.range_diff(&format!("{base_rev}...{rev}"), 60_000).await?;
        let commits = commit_lines(&git.log(&format!("{base_rev}..{rev}"), Some(100)).await?);
        Ok((base, diff, commits))
    }

    /// Pushes `branch` and opens its pull request into `base` (its base by default). On GitHub, an origin the user can't
    /// push to gets it through their fork of it, made if needed; when origin is a fork, `to` (owner/repo) picks the
    /// repository it opens on, origin or the one it was forked from (as picked for the list by default).
    pub async fn create_pr(&self, project_id: &str, branch: &str, base: Option<String>, to: Option<String>, draft: bool, title: Option<String>, body: Option<String>) -> Result<crate::providers::github::PrSummary> {
        let p = self.store.project(project_id)?;
        let gh = match (to.filter(|t| !t.is_empty()), self.pr_host(project_id).await?) {
            (Some(to), PrHost::GitHub(g)) => {
                let origin = format!("{}/{}", g.repo.owner, g.repo.repo);
                if to.eq_ignore_ascii_case(&origin) {
                    PrHost::GitHub(g)
                } else {
                    // Only the repository origin was forked from: a pull request goes nowhere else.
                    let parent = g.info().await?.parent;
                    if !parent.as_deref().is_some_and(|p| p.eq_ignore_ascii_case(&to)) {
                        return Err(Error::Invalid(format!("{to} is neither origin nor the repository it was forked from")));
                    }
                    let (owner, name) = to.split_once('/').ok_or_else(|| Error::Invalid(format!("{to} is not owner/repo")))?;
                    let repo = RepoRef { owner: owner.into(), repo: name.into(), ..g.repo.clone() };
                    PrHost::GitHub(g.retarget(repo))
                }
            }
            _ => self.prs_host(project_id).await?,
        };
        let git = self.git(&p);
        let base = match base.filter(|b| !b.is_empty()) {
            Some(b) => b,
            None => self.base_of(&p, branch, &git.default_branch().await?).await,
        };
        // GitHub says origin is read only to the user (a fork's own pull requests already go through origin, theirs).
        let via_fork = match &gh {
            PrHost::GitHub(g) if !g.retargeted() => g.info().await.is_ok_and(|i| !i.can_push),
            _ => false,
        };
        // In another repository than its own, the head is named `owner:branch`.
        let head = match &gh {
            PrHost::GitHub(g) if via_fork => {
                let fork = self.push_to_fork(&p, g, branch).await?;
                format!("{}:{branch}", fork.split_once('/').map_or(fork.as_str(), |(owner, _)| owner))
            }
            _ => {
                let head = match &gh {
                    PrHost::GitHub(g) => g.head_of(branch),
                    _ => branch.to_string(),
                };
                // The base must exist on the remote too (its own repository's: a fork's pull requests go to its parent's).
                if head == branch && !git.ref_exists(&format!("refs/remotes/origin/{base}")).await? {
                    git.push(&base, true).await?;
                }
                // A branch only on origin is already there.
                if git.ref_exists(&format!("refs/heads/{branch}")).await? {
                    if let Some(u) = git.upstream(branch).await? {
                        if git.ref_exists(&format!("refs/remotes/{u}")).await? && !git.is_ancestor(&u, branch).await? {
                            return Err(Error::Invalid(format!("{branch} was rewritten since it was pushed (rebased?). Force push it to {u} first, then open the pull request.")));
                        }
                    }
                    self.push(project_id, branch, false).await?;
                }
                head
            }
        };
        let (title, body) = match (title.filter(|s| !s.is_empty()), body) {
            (Some(t), b) => (t, b.unwrap_or_default()),
            (None, _) => self.generate_pr(project_id, branch, Some(&base)).await?,
        };
        let pr = gh.create(&head, &base, &title, &body, draft).await?;
        self.changed(project_id);
        Ok(pr)
    }

    /// A reply for a review conversation; with `draft`, the author's started reply polished instead.
    /// `editing` is the comment the draft rewrites: the conversation then stops before it.
    pub async fn draft_reply(&self, project_id: &str, number: u64, thread_id: &str, draft: Option<&str>, editing: Option<&str>) -> Result<String> {
        let gh = self.prs_host(project_id).await?;
        let d = gh.detail(number).await?;
        let th = d.threads.iter().find(|t| t.id == thread_id).ok_or_else(|| Error::NotFound("thread".into()))?;
        let mut convo = String::new();
        if let Some(path) = &th.path {
            convo.push_str(&format!("File: {path}:{}\n{}\n\n", th.line.unwrap_or(0), th.snippet.join("\n")));
        }
        for c in th.comments.iter().take_while(|c| Some(c.id.as_str()) != editing) {
            convo.push_str(&format!("{}: {}\n\n", c.author, c.body));
        }
        let p = self.store.project(project_id)?;
        let ask = match draft.map(str::trim).filter(|d| !d.is_empty()) {
            Some(draft) => format!(
                "You are the author of pull request “{}” and started a reply to this review conversation. Improve it: fix spelling, grammar and punctuation, and rephrase what reads awkwardly or unclearly. Keep its meaning, tone and roughly its length, and add nothing it does not say. Answer with the reply only, in the language the draft is written in (if unclear, {{language}}).\n\n{convo}Draft reply:\n{draft}",
                d.summary.title
            ),
            None => format!(
                "You are the author of pull request “{}”. Draft a short, friendly reply to this review conversation. If a change is needed, say what you will change.\n\n{convo}",
                d.summary.title
            ),
        };
        let t = self.with_globals(Template { kind: "pr".into(), body: ask, ..Default::default() }, project_id);
        self.ask("pr", &t, BTreeMap::new(), &p.gen_lang.pr, None).await
    }

    pub async fn draft_review(&self, project_id: &str, number: u64) -> Result<String> {
        let p = self.store.project(project_id)?;
        let gh = self.prs_host(project_id).await?;
        let d = gh.detail(number).await?;
        let git = self.git(&p);
        let _ = git.fetch().await;
        let diff = git
            .range_diff(&format!("origin/{}...origin/{}", d.summary.base, d.summary.head), 60_000)
            .await
            .unwrap_or_default();
        let t = Template {
            kind: "pr".into(),
            body: format!(
                "Review pull request “{}” ({} → {}). Write a short overall review summary for the author: what looks good, and anything that must change. Be specific and brief.\n\nDescription:\n{}\n\nDiff:\n{diff}",
                d.summary.title, d.summary.head, d.summary.base, d.body
            ),
            ..Default::default()
        };
        let t = self.with_globals(t, project_id);
        self.ask("pr", &t, BTreeMap::new(), &p.gen_lang.pr, None).await
    }

    // ---------- tickets ----------

    /// `mine`: only Jira, Linear and GitHub tickets assigned to the user (Trello and Asana ones are always theirs).
    /// `sprint`: only Jira tickets in an open sprint and Linear issues in an active cycle; the others have no sprints, so none of theirs.
    /// Callers turn it off when the project has neither Jira nor Linear cycles: it would hide every ticket.
    /// GitHub issues come from the project's own origin repository, with the GitHub account of Git providers.
    pub async fn tickets(&self, project_id: &str, mine: bool, sprint: bool) -> Result<Vec<TicketView>> {
        let mut p = self.store.project(project_id)?;
        let integ = self.store.read(|c| c.integrations.clone());
        // One source failing (missing token, keychain refusal, HTTP error)
        // must not hide tickets from the others.
        // Each with the projects its connection shows in.
        let mut results: Vec<(&[String], std::result::Result<Vec<Ticket>, String>)> = Vec::new();
        let here = [project_id.to_string()];
        if !sprint {
            if let Ok(gh) = self.github(project_id).await {
                results.push((&here[..], tickets::github(&gh, mine).await.map_err(|e| e.to_string())));
            }
        }
        for j in integ.jira.iter().filter(|j| crate::store::shows_in(&j.repos, project_id)) {
            results.push((&j.repos, match tickets::jira_auth::token(j).await {
                Ok(tok) => tickets::jira(j, &tok, mine, sprint).await.map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            }));
        }
        for t in integ.trello.iter().filter(|t| !sprint && crate::store::shows_in(&t.repos, project_id)) {
            results.push((&t.repos, match tickets::trello_token(t).await {
                Ok(tok) => tickets::trello(t, &tok).await.map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            }));
        }
        for a in integ.asana.iter().filter(|a| !sprint && crate::store::shows_in(&a.repos, project_id)) {
            results.push((&a.repos, match tickets::asana_token(a).await {
                Ok(tok) => tickets::asana(a, &tok).await.map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            }));
        }
        for l in integ.linear.iter().filter(|l| crate::store::shows_in(&l.repos, project_id)) {
            results.push((&l.repos, match tickets::linear_token(l).await {
                Ok(tok) => tickets::linear(l, &tok, mine, sprint).await.map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            }));
        }
        let mut all: Vec<(Ticket, &[String])> = Vec::new();
        let mut errors = Vec::new();
        for (repos, r) in results {
            match r {
                Ok(v) => all.extend(v.into_iter().map(|t| (t, repos))),
                Err(e) => errors.push(e),
            }
        }
        if all.is_empty() && !errors.is_empty() {
            // Each message already carries its own "http error:" prefix.
            return Err(Error::Other(errors.join(" · ")));
        }
        // Only this project's links move: another project's old key can name a card of a connection not listed here.
        let moves: Vec<(String, String)> = all.iter().filter_map(|(t, _)| t.old_key.clone().filter(|o| *o != t.key).map(|o| (o, t.key.clone()))).collect();
        if move_ticket_keys(&mut p, &moves) {
            self.store.with_project(project_id, |sp| {
                move_ticket_keys(sp, &moves);
                Ok(())
            })?;
            self.changed(project_id);
        }
        // A ticket's branch: one made for it, or one with its key in the name (feat/ATL-212_login, fix/128-crash for GitHub's #128),
        // looked for in this project first, then in the other projects its connection shows in.
        let others = self.store.read(|c| c.projects.clone()).into_iter().filter(|q| q.id != p.id && all.iter().any(|(_, repos)| crate::store::shows_in(repos, &q.id)));
        let mut scan = Vec::new();
        for q in std::iter::once(p.clone()).chain(others) {
            let local: Vec<(String, Vec<String>)> = self
                .git(&q)
                .branches()
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|b| {
                    let mut keys = ticket_keys(&b.name, true);
                    keys.extend(tickets::issue_key(&b.name));
                    (b.name, keys)
                })
                .collect();
            scan.push((q, local));
        }
        let find = |q: &Project, local: &[(String, Vec<String>)], key: &str| {
            q.branches
                .iter()
                .find(|(_, m)| m.ticket.as_deref() == Some(key))
                .map(|(b, _)| b.clone())
                .or_else(|| local.iter().find(|(_, keys)| keys.iter().any(|k| k.eq_ignore_ascii_case(key))).map(|(b, _)| b.clone()))
        };
        let mut views = all
            .into_iter()
            .map(|(t, repos)| {
                let (in_project, branch) = scan
                    .iter()
                    .filter(|(q, _)| q.id == p.id || crate::store::shows_in(repos, &q.id))
                    .find_map(|(q, local)| find(q, local, &t.key).map(|b| (q.id.clone(), b)))
                    .unzip();
                let here = in_project.as_deref() == Some(p.id.as_str());
                let release = p
                    .ticket_releases
                    .get(&t.key)
                    .cloned()
                    .or_else(|| branch.as_ref().filter(|_| here).and_then(|b| p.branches.get(b)).and_then(|m| m.release.clone()))
                    .or_else(|| fix_version_release(&t.fix_versions, &p.releases))
                    .unwrap_or_default();
                TicketView { priority_rank: tickets::priority_rank(&t.priority), ticket: t, release, branch, branch_project: in_project.filter(|_| !here) }
            })
            .collect::<Vec<_>>();
        // Most urgent first; a stable sort keeps each tracker's own order within a priority.
        views.sort_by_key(|v| v.priority_rank);
        // Still unplanned: the release its branch is a child of, or was merged into.
        // shortcut: base_of reloads refs per branch when the overview cache is stale, share one Refs if ticket lists get slow.
        let default = self.git(&p).default_branch().await.unwrap_or_else(|_| "main".into());
        for v in views.iter_mut().filter(|v| v.release.is_empty() && v.branch_project.is_none()) {
            let Some(b) = &v.branch else { continue };
            let parent = self.base_of(&p, b, &default).await;
            if let Some(r) = p.releases.iter().find(|r| r.branch == parent) {
                v.release = r.version.clone();
            }
        }
        Ok(views)
    }

    /// Ticket `key` from the connections this project shows: Jira, Linear and GitHub asked for it directly, so a done
    /// or unassigned ticket is found too; Trello and Asana looked up in their lists, a Trello card also by its old key.
    pub async fn ticket(&self, project_id: &str, key: &str) -> Result<Option<Ticket>> {
        let integ = self.store.read(|c| c.integrations.clone());
        let on = |repos: &[String]| crate::store::shows_in(repos, project_id);
        let mut err = None;
        if let Some(n) = key.trim().strip_prefix('#').and_then(|n| n.parse::<u64>().ok()) {
            if let Ok(gh) = self.github(project_id).await {
                match gh.issue(n).await {
                    Ok(Some(i)) => return Ok(Some(tickets::github_ticket(&i, &tickets::github_repo(&gh), ""))),
                    Ok(None) => {}
                    Err(e) => err = Some(e),
                }
            }
        }
        if let Some(jira_key) = ticket_keys(key, true).into_iter().find(|k| k.eq_ignore_ascii_case(key.trim())) {
            let prefix = jira_key.split('-').next().unwrap_or("");
            // A connection scoped to other Jira projects cannot have it.
            for j in integ.jira.iter().filter(|j| on(&j.repos) && (j.projects.is_empty() || j.projects.iter().any(|p| p.eq_ignore_ascii_case(prefix)))) {
                let got = match tickets::jira_auth::token(j).await {
                    Ok(tok) => tickets::jira_issue(j, &tok, &jira_key).await,
                    Err(e) => Err(e),
                };
                match got {
                    Ok(Some(t)) => return Ok(Some(t)),
                    Ok(None) => {}
                    Err(e) => err = Some(e),
                }
            }
            // Linear identifiers (ENG-123) look like Jira keys; the prefix is the team's key.
            for l in integ.linear.iter().filter(|l| on(&l.repos) && (l.teams.is_empty() || l.teams.iter().any(|t| t.eq_ignore_ascii_case(prefix)))) {
                let got = match tickets::linear_token(l).await {
                    Ok(tok) => tickets::linear_issue(l, &tok, &jira_key).await,
                    Err(e) => Err(e),
                };
                match got {
                    Ok(Some(t)) => return Ok(Some(t)),
                    Ok(None) => {}
                    Err(e) => err = Some(e),
                }
            }
        }
        let mut lists = Vec::new();
        for t in integ.trello.iter().filter(|t| on(&t.repos)) {
            lists.push(match tickets::trello_token(t).await {
                Ok(tok) => tickets::trello(t, &tok).await,
                Err(e) => Err(e),
            });
        }
        for a in integ.asana.iter().filter(|a| on(&a.repos)) {
            lists.push(match tickets::asana_token(a).await {
                Ok(tok) => tickets::asana(a, &tok).await,
                Err(e) => Err(e),
            });
        }
        for l in lists {
            match l {
                Ok(v) => {
                    if let Some(t) = v.into_iter().find(|t| t.key.eq_ignore_ascii_case(key.trim()) || t.old_key.as_deref() == Some(key.trim())) {
                        return Ok(Some(t));
                    }
                }
                Err(e) => err = Some(e),
            }
        }
        match err {
            Some(e) => Err(e),
            None => Ok(None),
        }
    }

    /// The ticket `branch` was made for, else the first one its name holds that a connection has.
    pub async fn branch_ticket(&self, project_id: &str, branch: &str) -> Result<Option<Ticket>> {
        let p = self.store.project(project_id)?;
        let made_for = p.branches.get(branch).and_then(|m| m.ticket.clone()).filter(|t| !t.is_empty());
        let mut keys: Vec<String> = Vec::new();
        // Only with GitHub: `#128` would else match the Trello card numbered 128 before short links.
        let issue = if self.github(project_id).await.is_ok() { tickets::issue_key(branch) } else { None };
        for k in made_for.into_iter().chain(ticket_keys(branch, true)).chain(issue) {
            if !keys.iter().any(|seen| seen.eq_ignore_ascii_case(&k)) {
                keys.push(k);
            }
        }
        let mut err = None;
        for k in keys {
            match self.ticket(project_id, &k).await {
                Ok(Some(t)) => return Ok(Some(t)),
                Ok(None) => {}
                Err(e) => err = Some(e),
            }
        }
        match err {
            Some(e) => Err(e),
            None => Ok(None),
        }
    }

    // ---------- new tickets ----------

    /// Where a ticket written in `project_id` can go, from each tracker its Tickets screen shows; a tracker that fails
    /// is left out, its error listed.
    pub async fn ticket_places(&self, project_id: &str) -> Result<(Vec<tickets::Place>, Vec<String>)> {
        self.store.project(project_id)?;
        let integ = self.store.read(|c| c.integrations.clone());
        let shown = |repos: &[String]| crate::store::shows_in(repos, project_id);
        // Only a project whose origin is on GitHub, with a sign-in, files GitHub issues.
        let github = async {
            match self.github(project_id).await {
                Ok(gh) => vec![tickets::github_place(&gh).await.map(|p| vec![p])],
                Err(_) => vec![],
            }
        };
        let jira = join_all(integ.jira.iter().filter(|j| shown(&j.repos)).map(|j| async move { tickets::jira_places(j, &tickets::jira_auth::token(j).await?).await }));
        let linear = join_all(integ.linear.iter().filter(|l| shown(&l.repos)).map(|l| async move { tickets::linear_places(l, &tickets::linear_token(l).await?).await }));
        let trello = join_all(integ.trello.iter().filter(|t| shown(&t.repos)).map(|t| async move { tickets::trello_places(t, &tickets::trello_token(t).await?).await }));
        let asana = join_all(integ.asana.iter().filter(|a| shown(&a.repos)).map(|a| async move { tickets::asana_places(a, &tickets::asana_token(a).await?).await }));
        let (github, jira, linear, trello, asana) = tokio::join!(github, jira, linear, trello, asana);
        let (mut places, mut errors) = (Vec::new(), Vec::new());
        for r in github.into_iter().chain(jira).chain(linear).chain(trello).chain(asana) {
            match r {
                Ok(v) => places.extend(v),
                Err(e) => errors.push(e.to_string()),
            }
        }
        Ok((places, errors))
    }

    /// AI's title and description for a new ticket from `template` (the default ticket template when None): about
    /// `request`, and with `branch`, about the work it adds over its base.
    pub async fn draft_ticket(&self, project_id: &str, template: Option<&str>, branch: Option<&str>, request: &str, language: Option<&str>) -> Result<(String, String)> {
        let p = self.store.project(project_id)?;
        let mut t = self.template("ticket", template.filter(|t| !t.is_empty()), Some(&p.id))?;
        let mut vars = BTreeMap::new();
        vars.insert("project".into(), p.name.clone());
        vars.insert("request".into(), request.trim().to_string());
        if let Some(b) = branch.filter(|b| !b.is_empty()) {
            let (base, diff, commits) = self.branch_work(&p, b, None).await?;
            vars.insert("branch".into(), b.to_string());
            vars.insert("base".into(), base);
            vars.insert("diff".into(), diff);
            vars.insert("commits".into(), commits);
        }
        templates::prepare_ticket(&mut t, &vars);
        let lang = language.filter(|l| !l.is_empty()).unwrap_or(&p.gen_lang.ticket).to_string();
        let (title, body) = templates::split_ticket(&self.ask("ticket", &t, vars, &lang, None).await?);
        if title.is_empty() {
            return Err(Error::Other("AI wrote no ticket. Try again.".into()));
        }
        Ok((title, body))
    }

    /// Creates `t` in its tracker. With `branch`, it becomes the branch's ticket; with `study`, that ticket study's
    /// session and checkouts are deleted after.
    pub async fn create_ticket(&self, project_id: &str, t: &tickets::NewTicket, branch: Option<&str>, study: Option<&str>) -> Result<tickets::Created> {
        self.store.project(project_id)?;
        if t.title.trim().is_empty() {
            return Err(Error::Invalid("A ticket needs a title".into()));
        }
        let integ = self.store.read(|c| c.integrations.clone());
        let missing = || Error::NotConnected(t.source.clone());
        let created = match t.source.as_str() {
            "jira" => {
                let j = integ.jira.iter().find(|j| j.id == t.conn).ok_or_else(missing)?;
                tickets::jira_create(j, &tickets::jira_auth::token(j).await?, t).await?
            }
            "linear" => {
                let l = integ.linear.iter().find(|l| l.id == t.conn).ok_or_else(missing)?;
                tickets::linear_create(&tickets::linear_token(l).await?, t).await?
            }
            "trello" => {
                let c = integ.trello.iter().find(|c| c.id == t.conn).ok_or_else(missing)?;
                tickets::trello_create(c, &tickets::trello_token(c).await?, t).await?
            }
            "asana" => {
                let a = integ.asana.iter().find(|a| a.id == t.conn).ok_or_else(missing)?;
                tickets::asana_create(a, &tickets::asana_token(a).await?, t).await?
            }
            "github" => {
                let (owner, repo) = tickets::github_conn(&t.conn).ok_or_else(|| Error::Invalid(format!("“{}” is not a GitHub repository", t.conn)))?;
                let api = integ.github_api.clone().filter(|s| !s.is_empty());
                let gh = GitHub::new(RepoRef { owner: owner.into(), repo: repo.into(), ..Default::default() }, providers::github_auth::token(None).await?, api);
                tickets::github_create(&gh, t).await?
            }
            other => return Err(Error::Invalid(format!("Gitnetix can't create tickets in {other}"))),
        };
        crate::log::info(format!("Created ticket {} in {}", created.key, t.source));
        if let Some(b) = branch.filter(|b| !b.is_empty()) {
            self.store.with_project(project_id, |p| Ok(link_ticket(p, b, &created.key)))?;
            self.changed(project_id);
        }
        // The ticket exists: a cleanup that fails must not read as a failed create, which a retry would repeat.
        if let Some(id) = study.filter(|s| !s.is_empty()) {
            if let Err(e) = self.remove_agent(id).await {
                crate::log::error(format!("Created {}, but could not delete its ticket study: {e}", created.key));
            }
        }
        Ok(created)
    }

    /// Starts an agent that studies the code of `projects` (`project_id` first) in throwaway checkouts of their default
    /// branch, running it when that helps, then writes a ticket about `request` with `template` and ends its reply with
    /// it. Its session carries where the ticket goes; the checkouts go with it, or once its ticket is created.
    pub async fn start_ticket_study(&self, project_id: &str, request: &str, template: Option<&str>, projects: &[String], to: TicketStudy, language: Option<&str>) -> Result<AgentSession> {
        let p = self.store.project(project_id)?;
        if request.trim().is_empty() {
            return Err(Error::Invalid("Describe what the ticket is about".into()));
        }
        let t = self.template("ticket", template.filter(|t| !t.is_empty()), Some(&p.id))?;
        let r = self.agent_ai(&t, Route::default())?;
        if let Some(rules) = self.policies(project_id) {
            crate::account::check_agent(&rules, &r.provider, &r.permission)?;
        }
        ai::warm(&r.provider).await;
        let mut ids = vec![project_id.to_string()];
        for id in projects {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        let tag = format!("ticket-{}", &new_id()[..6]);
        let mut checkouts: Vec<(StudyCheckout, String)> = Vec::new();
        for id in &ids {
            let made = match self.store.project(id) {
                Ok(q) => self.study_checkout(&q, &tag).await.map(|path| (StudyCheckout { project_id: q.id.clone(), path }, q.name.clone())),
                Err(e) => Err(e),
            };
            match made {
                Ok(c) => checkouts.push(c),
                Err(e) => {
                    self.drop_checkouts(checkouts.iter().map(|(c, _)| c)).await;
                    return Err(e);
                }
            }
        }
        let mut vars = BTreeMap::new();
        vars.insert("project".into(), p.name.clone());
        vars.insert("request".into(), request.trim().to_string());
        let mut tt = t.clone();
        templates::prepare_ticket(&mut tt, &vars);
        // "spoken" is the language of the last dictation, as `ask` reads it.
        let lang = self.gen_lang(language.filter(|l| !l.is_empty()).unwrap_or(&p.gen_lang.ticket));
        let mut prompt = templates::fill(&tt, &vars, &lang);
        if !t.body.contains("{language}") {
            prompt.push_str(&format!("\n\nWrite the ticket in {}.", templates::language_name(&lang)));
        }
        let folders: Vec<String> = checkouts.iter().map(|(c, name)| format!("- {} ({name})", c.path)).collect();
        let cwd = PathBuf::from(&checkouts[0].0.path);
        let started = async {
            // Where the agent saves the images and audio it shows: the log reads them from there only.
            let shots = attach_root(&cwd).await?.join("shared");
            std::fs::create_dir_all(&shots)?;
            prompt = format!(
                "{prompt}\n\n{}\n\n{}\n\n{}",
                templates::ticket_study(&folders.join("\n")),
                templates::share_media(&shots.to_string_lossy()),
                templates::NO_AI_CREDIT
            );
            let notes = checkouts.iter().map(|(c, name)| LogLine::new("dim", format!("  ↳ Checked out {name} in {}", c.path))).collect();
            let study = TicketStudy { template: t.id.clone(), checkouts: checkouts.iter().map(|(c, _)| c.clone()).collect(), ..to };
            self.agents.start(StartArgs { project_id: project_id.into(), branch: "HEAD".into(), cwd: cwd.clone(), worktree: true, request: request.trim().into(), prompt, ai: r, notes, study: Some(study) })
        }
        .await;
        if started.is_err() {
            self.drop_checkouts(checkouts.iter().map(|(c, _)| c)).await;
        }
        for (c, _) in &checkouts {
            self.changed(&c.project_id);
        }
        started
    }

    /// A throwaway checkout of `p`'s default branch, as origin last had it when there is a copy of it, at
    /// `<parent>/<project>.<tag>` with the project's worktree files: what a ticket study reads and runs.
    async fn study_checkout(&self, p: &Project, tag: &str) -> Result<String> {
        let git = self.git(p);
        let default = git.default_branch().await?;
        let from = if git.ref_exists(&format!("refs/remotes/origin/{default}")).await? { format!("origin/{default}") } else { default };
        let path = worktree_path(p, tag);
        let dir = path.to_string_lossy().to_string();
        git.run(&["worktree", "add", "--detach", &dir, &from]).await?;
        init_submodules(&path).await;
        copy_worktree_files(&self.store, p, &path).await;
        Ok(dir)
    }

    /// Deletes ticket study checkouts, with what they hold; one that can't go is logged.
    async fn drop_checkouts(&self, checkouts: impl Iterator<Item = &StudyCheckout>) {
        for c in checkouts {
            if let Err(e) = self.remove_worktree(&c.project_id, &c.path, true).await {
                crate::log::error(format!("Could not delete the ticket study checkout {}: {e}", c.path));
            }
        }
    }

    /// Deletes an agent session, and a ticket study's checkouts with it.
    pub async fn remove_agent(&self, id: &str) -> Result<()> {
        let study = self.agents.get(id).ok().and_then(|s| s.study);
        self.agents.remove(id)?;
        if let Some(st) = study {
            self.drop_checkouts(st.checkouts.iter()).await;
        }
        Ok(())
    }

    pub fn set_ticket_release(&self, project_id: &str, key: &str, release: &str) -> Result<()> {
        self.store.with_project(project_id, |p| {
            p.ticket_releases.insert(key.into(), release.into());
            Ok(())
        })?;
        self.changed(project_id);
        Ok(())
    }

    /// Statuses ticket `id` of connection `conn` can move to or, with `to`, moves it there (and returns none).
    pub async fn ticket_status(&self, source: &str, conn: &str, id: &str, to: Option<&str>) -> Result<Vec<tickets::StatusOption>> {
        let integ = self.store.read(|c| c.integrations.clone());
        let missing = || Error::NotConnected(source.into());
        match source {
            "jira" => {
                let j = integ.jira.iter().find(|j| j.id == conn).ok_or_else(missing)?;
                let tok = tickets::jira_auth::token(j).await?;
                match to {
                    Some(to) => tickets::jira_set_status(j, &tok, id, to).await.map(|_| vec![]),
                    None => tickets::jira_statuses(j, &tok, id).await,
                }
            }
            "trello" => {
                let t = integ.trello.iter().find(|t| t.id == conn).ok_or_else(missing)?;
                let tok = tickets::trello_token(t).await?;
                match to {
                    Some(to) => tickets::trello_set_status(t, &tok, id, to).await.map(|_| vec![]),
                    None => tickets::trello_statuses(t, &tok, id).await,
                }
            }
            "asana" => {
                let a = integ.asana.iter().find(|a| a.id == conn).ok_or_else(missing)?;
                let tok = tickets::asana_token(a).await?;
                match to {
                    Some(to) => tickets::asana_set_status(&tok, id, to).await.map(|_| vec![]),
                    None => tickets::asana_statuses(&tok, id).await,
                }
            }
            "linear" => {
                let l = integ.linear.iter().find(|l| l.id == conn).ok_or_else(missing)?;
                let tok = tickets::linear_token(l).await?;
                match to {
                    Some(to) => tickets::linear_set_status(&tok, id, to).await.map(|_| vec![]),
                    None => tickets::linear_statuses(&tok, id).await,
                }
            }
            "github" => {
                let (owner, repo) = tickets::github_conn(conn).ok_or_else(|| Error::Invalid(format!("“{conn}” is not a GitHub repository")))?;
                let number: u64 = id.parse().map_err(|_| Error::Invalid(format!("“{id}” is not a GitHub issue number")))?;
                let api = integ.github_api.clone().filter(|s| !s.is_empty());
                let token = providers::github_auth::token(None).await?;
                let gh = GitHub::new(RepoRef { owner: owner.into(), repo: repo.into(), ..Default::default() }, token, api);
                match to {
                    Some(to) => tickets::github_set_status(&gh, number, to).await.map(|_| vec![]),
                    None => tickets::github_statuses(&gh, number).await,
                }
            }
            other => Err(Error::Invalid(format!("unknown tracker {other}"))),
        }
    }

    /// The people ticket `id` of connection `conn` can be assigned to or, with `to`, assigns it to that one (and returns
    /// none); an empty `to` leaves it with nobody.
    pub async fn ticket_assignee(&self, source: &str, conn: &str, id: &str, to: Option<&str>) -> Result<Vec<tickets::FieldOption>> {
        let integ = self.store.read(|c| c.integrations.clone());
        let missing = || Error::NotConnected(source.into());
        match source {
            "jira" => {
                let j = integ.jira.iter().find(|j| j.id == conn).ok_or_else(missing)?;
                let tok = tickets::jira_auth::token(j).await?;
                match to {
                    Some(to) => tickets::jira_set_assignee(j, &tok, id, to).await.map(|_| vec![]),
                    None => tickets::jira_assignees(j, &tok, id).await,
                }
            }
            "trello" => {
                let t = integ.trello.iter().find(|t| t.id == conn).ok_or_else(missing)?;
                let tok = tickets::trello_token(t).await?;
                match to {
                    Some(to) => tickets::trello_set_assignee(t, &tok, id, to).await.map(|_| vec![]),
                    None => tickets::trello_assignees(t, &tok, id).await,
                }
            }
            "asana" => {
                let a = integ.asana.iter().find(|a| a.id == conn).ok_or_else(missing)?;
                let tok = tickets::asana_token(a).await?;
                match to {
                    Some(to) => tickets::asana_set_assignee(&tok, id, to).await.map(|_| vec![]),
                    None => tickets::asana_assignees(&tok, id).await,
                }
            }
            "linear" => {
                let l = integ.linear.iter().find(|l| l.id == conn).ok_or_else(missing)?;
                let tok = tickets::linear_token(l).await?;
                match to {
                    Some(to) => tickets::linear_set_assignee(&tok, id, to).await.map(|_| vec![]),
                    None => tickets::linear_assignees(&tok, id).await,
                }
            }
            "github" => {
                let (gh, number) = self.ticket_github(conn, id).await?;
                match to {
                    Some(to) => gh.set_issue_assignee(number, to).await.map(|_| vec![]),
                    None => tickets::github_assignees(&gh).await,
                }
            }
            other => Err(Error::Invalid(format!("unknown tracker {other}"))),
        }
    }

    /// What a Jira or Linear ticket's priority, type and labels can be set to, or, with `edit`, sets them.
    /// The other trackers have none to offer.
    pub async fn ticket_fields(&self, source: &str, conn: &str, id: &str, edit: Option<&tickets::FieldEdit>) -> Result<tickets::FieldOptions> {
        let integ = self.store.read(|c| c.integrations.clone());
        let missing = || Error::NotConnected(source.into());
        match source {
            "jira" => {
                let j = integ.jira.iter().find(|j| j.id == conn).ok_or_else(missing)?;
                let tok = tickets::jira_auth::token(j).await?;
                match edit {
                    Some(e) => tickets::jira_set_fields(j, &tok, id, e).await.map(|_| Default::default()),
                    None => tickets::jira_fields(j, &tok, id).await,
                }
            }
            "linear" => {
                let l = integ.linear.iter().find(|l| l.id == conn).ok_or_else(missing)?;
                let tok = tickets::linear_token(l).await?;
                match edit {
                    Some(e) => tickets::linear_set_fields(&tok, id, e).await.map(|_| Default::default()),
                    None => tickets::linear_fields(&tok, id).await,
                }
            }
            _ if edit.is_none() => Ok(Default::default()),
            other => Err(Error::Invalid(format!("{other} tickets have no priority, type or labels to set here"))),
        }
    }

    /// The sprints (Linear: cycles) a Jira or Linear ticket can move to, or with `parents`, the issues it can go under.
    pub async fn ticket_choices(&self, source: &str, conn: &str, id: &str, parents: bool) -> Result<Vec<tickets::Choice>> {
        let integ = self.store.read(|c| c.integrations.clone());
        let missing = || Error::NotConnected(source.into());
        match source {
            "jira" => {
                let j = integ.jira.iter().find(|j| j.id == conn).ok_or_else(missing)?;
                let tok = tickets::jira_auth::token(j).await?;
                if parents { tickets::jira_parent_choices(j, &tok, id).await } else { tickets::jira_sprint_choices(j, &tok, id).await }
            }
            "linear" => {
                let l = integ.linear.iter().find(|l| l.id == conn).ok_or_else(missing)?;
                let tok = tickets::linear_token(l).await?;
                if parents { tickets::linear_parent_choices(&tok, id).await } else { tickets::linear_cycle_choices(&tok, id).await }
            }
            other => Err(Error::Invalid(format!("{other} tickets have no sprint or parent to set here"))),
        }
    }

    /// Ticket `id`'s comments, oldest first; Linear's threads with their replies.
    pub async fn ticket_comments(&self, source: &str, conn: &str, id: &str) -> Result<Vec<tickets::TicketComment>> {
        let integ = self.store.read(|c| c.integrations.clone());
        let missing = || Error::NotConnected(source.into());
        match source {
            "jira" => {
                let j = integ.jira.iter().find(|j| j.id == conn).ok_or_else(missing)?;
                tickets::jira_comments(j, &tickets::jira_auth::token(j).await?, id).await
            }
            "trello" => {
                let t = integ.trello.iter().find(|t| t.id == conn).ok_or_else(missing)?;
                tickets::trello_comments(t, &tickets::trello_token(t).await?, id).await
            }
            "asana" => {
                let a = integ.asana.iter().find(|a| a.id == conn).ok_or_else(missing)?;
                tickets::asana_comments(&tickets::asana_token(a).await?, id).await
            }
            "linear" => {
                let l = integ.linear.iter().find(|l| l.id == conn).ok_or_else(missing)?;
                tickets::linear_comments(&tickets::linear_token(l).await?, id).await
            }
            "github" => {
                let (gh, number) = self.ticket_github(conn, id).await?;
                tickets::github_comments(&gh, number).await
            }
            other => Err(Error::Invalid(format!("unknown tracker {other}"))),
        }
    }

    /// When ticket `id` was opened and by whom, and since when it has had its status.
    pub async fn ticket_activity(&self, source: &str, conn: &str, id: &str) -> Result<tickets::TicketActivity> {
        let integ = self.store.read(|c| c.integrations.clone());
        let missing = || Error::NotConnected(source.into());
        match source {
            "jira" => {
                let j = integ.jira.iter().find(|j| j.id == conn).ok_or_else(missing)?;
                tickets::jira_activity(j, &tickets::jira_auth::token(j).await?, id).await
            }
            "trello" => {
                let t = integ.trello.iter().find(|t| t.id == conn).ok_or_else(missing)?;
                tickets::trello_activity(t, &tickets::trello_token(t).await?, id).await
            }
            "asana" => {
                let a = integ.asana.iter().find(|a| a.id == conn).ok_or_else(missing)?;
                tickets::asana_activity(&tickets::asana_token(a).await?, id).await
            }
            "linear" => {
                let l = integ.linear.iter().find(|l| l.id == conn).ok_or_else(missing)?;
                tickets::linear_activity(&tickets::linear_token(l).await?, id).await
            }
            "github" => {
                let (gh, number) = self.ticket_github(conn, id).await?;
                tickets::github_activity(&gh, number).await
            }
            other => Err(Error::Invalid(format!("unknown tracker {other}"))),
        }
    }

    /// Posts a comment on ticket `id`, or on Linear a reply under the thread whose first comment is `parent`. `files`
    /// upload to the tracker first, then the comment links them under its text: as Markdown where the tracker reads
    /// it (a picture shown in Linear), else by name and address. GitHub's API takes no files.
    pub async fn ticket_add_comment(&self, source: &str, conn: &str, id: &str, body: &str, parent: Option<&str>, files: &[Attachment]) -> Result<()> {
        if body.trim().is_empty() && files.is_empty() {
            return Err(Error::Invalid("The comment is empty".into()));
        }
        if parent.is_some() && source != "linear" {
            return Err(Error::Invalid(format!("{source} comments have no threads to reply in")));
        }
        let files = comment_files(files)?;
        let integ = self.store.read(|c| c.integrations.clone());
        let missing = || Error::NotConnected(source.into());
        // The text, then a line per file.
        let text = |links: Vec<String>| [body.trim().to_string()].into_iter().chain(links).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n\n");
        let md = |name: &str, url: &str| format!("[{}]({url})", name.replace(['[', ']'], ""));
        match source {
            "linear" => {
                let l = integ.linear.iter().find(|l| l.id == conn).ok_or_else(missing)?;
                let tok = tickets::linear_token(l).await?;
                let mut links = Vec::new();
                for (name, bytes) in &files {
                    let url = tickets::linear_put_file(&tok, name, bytes).await?;
                    links.push(if crate::net::sniff(bytes).is_some() { format!("!{}", md(name, &url)) } else { md(name, &url) });
                }
                tickets::linear_add_comment(&tok, id, &text(links), parent).await
            }
            "jira" => {
                let j = integ.jira.iter().find(|j| j.id == conn).ok_or_else(missing)?;
                let tok = tickets::jira_auth::token(j).await?;
                let mut links = Vec::new();
                for (name, bytes) in &files {
                    links.push(md(name, &tickets::jira_attach(j, &tok, id, name, bytes).await?));
                }
                tickets::jira_add_comment(j, &tok, id, &text(links)).await
            }
            "trello" => {
                let t = integ.trello.iter().find(|t| t.id == conn).ok_or_else(missing)?;
                let tok = tickets::trello_token(t).await?;
                let mut links = Vec::new();
                for (name, bytes) in &files {
                    links.push(md(name, &tickets::trello_attach(t, &tok, id, name, bytes).await?));
                }
                tickets::trello_add_comment(t, &tok, id, &text(links)).await
            }
            "asana" => {
                let a = integ.asana.iter().find(|a| a.id == conn).ok_or_else(missing)?;
                let tok = tickets::asana_token(a).await?;
                let mut links = Vec::new();
                for (name, bytes) in &files {
                    links.push(format!("{name}: {}", tickets::asana_attach(&tok, id, name, bytes).await?));
                }
                tickets::asana_add_comment(&tok, id, &text(links)).await
            }
            "github" => {
                if !files.is_empty() {
                    return Err(Error::Unsupported("GitHub's API takes no files in comments".into()));
                }
                let (gh, number) = self.ticket_github(conn, id).await?;
                gh.comment(number, body.trim()).await
            }
            other => Err(Error::Invalid(format!("unknown tracker {other}"))),
        }
    }

    /// Leaves reaction `emoji` (a character, or a reaction's key from [`Self::ticket_comments`]) on comment `comment` of
    /// ticket `id`, or takes the user's away. Jira's and Asana's APIs can't.
    pub async fn ticket_react(&self, source: &str, conn: &str, id: &str, comment: &str, emoji: &str, add: bool) -> Result<()> {
        let integ = self.store.read(|c| c.integrations.clone());
        let missing = || Error::NotConnected(source.into());
        match source {
            "linear" => {
                let l = integ.linear.iter().find(|l| l.id == conn).ok_or_else(missing)?;
                tickets::linear_react(&tickets::linear_token(l).await?, comment, emoji, add).await
            }
            "trello" => {
                let t = integ.trello.iter().find(|t| t.id == conn).ok_or_else(missing)?;
                tickets::trello_react(t, &tickets::trello_token(t).await?, comment, emoji, add).await
            }
            "github" => tickets::github_react(&self.ticket_github(conn, id).await?.0, comment, emoji, add).await,
            other => Err(Error::Unsupported(format!("{other}'s API can't change reactions"))),
        }
    }

    /// Where origin's pages for the project's files start (`https://github.com/acme/web`) and which host that is,
    /// read from the remote without signing in; None without an origin to link into.
    async fn web_repo(&self, p: &Project) -> Result<Option<(&'static str, String)>> {
        let Some(url) = self.git(p).remote_url("origin").await? else { return Ok(None) };
        if let Some(a) = azure::parse_remote(&url) {
            return Ok(Some(("azure", format!("https://dev.azure.com/{}/{}/_git/{}", a.org, a.project, a.repo))));
        }
        let Some(r) = parse_remote(&url) else { return Ok(None) };
        let i = self.store.read(|c| c.integrations.clone());
        let kind = providers::host_kind(&r, &i).unwrap_or("github");
        let base = match kind {
            // A server of one's own may serve its pages under a path: its address as connected.
            "gitlab" => i.gitlab.url.clone().unwrap_or_else(|| providers::gitlab::CLOUD.into()),
            "gitea" => i.gitea.url.clone().unwrap_or_default(),
            _ => format!("https://{}{}", r.host, r.port.map(|n| format!(":{n}")).unwrap_or_default()),
        };
        Ok(Some((kind, format!("{}/{}/{}", base.trim_end_matches('/'), r.owner, r.repo))))
    }

    /// A web link to lines `lines` of `path` as origin has it on `branch`, else on the default branch (`branch` not
    /// pushed, or without the file there), for a comment to point at.
    pub async fn permalink(&self, project_id: &str, branch: &str, path: &str, lines: Option<(u32, u32)>) -> Result<Permalink> {
        let p = self.store.project(project_id)?;
        let (kind, root) = self.web_repo(&p).await?.ok_or_else(|| Error::NotConnected("This repository has no origin remote to link to".into()))?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        for b in [branch, default.as_str()].into_iter().filter(|b| !b.is_empty()) {
            let (ok, sha, _) = git.try_run(&["rev-parse", "--verify", "-q", &format!("refs/remotes/origin/{b}^{{commit}}")]).await?;
            let sha = sha.trim();
            if ok && git.try_run(&["cat-file", "-e", &format!("{sha}:{path}")]).await?.0 {
                return Ok(Permalink { url: providers::file_link(kind, &root, sha, path, lines)?, sha: sha.chars().take(7).collect(), branch: b.into() });
            }
        }
        Err(Error::Invalid(format!("{path} isn't on origin yet: push {branch} first")))
    }

    /// The lines a link into the project's origin points at (a [`Self::permalink`], or the host's own link to a file at
    /// a commit), read from this clone: 40 at most. None for a link elsewhere, a commit the clone lacks or a binary file.
    pub async fn linked_lines(&self, project_id: &str, url: &str) -> Result<Option<LinkedLines>> {
        const MAX: usize = 40;
        let p = self.store.project(project_id)?;
        let Some((kind, root)) = self.web_repo(&p).await? else { return Ok(None) };
        let Some((sha, path, lines)) = providers::parse_file_link(kind, &root, url) else { return Ok(None) };
        let Some(text) = self.git(&p).show_file(&sha, &path).await?.filter(|t| !t.contains('\0')) else { return Ok(None) };
        let all: Vec<&str> = text.lines().collect();
        let (start, end) = lines.unwrap_or((1, all.len() as u32));
        let first = (start.max(1) as usize - 1).min(all.len());
        let last = (end as usize).clamp(first, all.len());
        Ok(Some(LinkedLines {
            sha: sha.chars().take(7).collect(),
            start: first as u32 + 1,
            end: last as u32,
            // A minified line stays a line.
            lines: all[first..last].iter().take(MAX).map(|l| l.chars().take(400).collect()).collect(),
            more: (last - first).saturating_sub(MAX) as u32,
            path,
        }))
    }

    /// A picture in ticket `id` that needs the tracker's sign-in, as a data: URL. The sign-in only goes to the tracker.
    pub async fn ticket_picture(&self, source: &str, conn: &str, id: &str, src: &str) -> Result<String> {
        let integ = self.store.read(|c| c.integrations.clone());
        let missing = || Error::NotConnected(source.into());
        match source {
            "jira" => {
                let j = integ.jira.iter().find(|j| j.id == conn).ok_or_else(missing)?;
                tickets::jira_picture(j, &tickets::jira_auth::token(j).await?, id, src).await
            }
            "trello" => {
                let t = integ.trello.iter().find(|t| t.id == conn).ok_or_else(missing)?;
                tickets::trello_picture(t, &tickets::trello_token(t).await?, src).await
            }
            "linear" => {
                let l = integ.linear.iter().find(|l| l.id == conn).ok_or_else(missing)?;
                tickets::linear_picture(&tickets::linear_token(l).await?, src).await
            }
            "github" => self.ticket_github(conn, id).await?.0.picture(src).await,
            other => Err(Error::Invalid(format!("{other} pictures can't load here"))),
        }
    }

    /// The files of ticket `id`: Jira, Trello and Asana attachments, the uploads in a Linear or GitHub ticket's text.
    pub async fn ticket_files(&self, source: &str, conn: &str, id: &str) -> Result<Vec<tickets::TicketFile>> {
        let integ = self.store.read(|c| c.integrations.clone());
        let missing = || Error::NotConnected(source.into());
        match source {
            "jira" => {
                let j = integ.jira.iter().find(|j| j.id == conn).ok_or_else(missing)?;
                tickets::jira_files(j, &tickets::jira_auth::token(j).await?, id).await
            }
            "trello" => {
                let t = integ.trello.iter().find(|t| t.id == conn).ok_or_else(missing)?;
                tickets::trello_files(t, &tickets::trello_token(t).await?, id).await
            }
            "asana" => {
                let a = integ.asana.iter().find(|a| a.id == conn).ok_or_else(missing)?;
                tickets::asana_files(&tickets::asana_token(a).await?, id).await
            }
            "linear" => {
                let l = integ.linear.iter().find(|l| l.id == conn).ok_or_else(missing)?;
                tickets::linear_files(&tickets::linear_token(l).await?, id).await
            }
            "github" => {
                let (gh, number) = self.ticket_github(conn, id).await?;
                tickets::github_files(&gh, number).await
            }
            other => Err(Error::Invalid(format!("unknown tracker {other}"))),
        }
    }

    /// File `file` of ticket `id`, by its id from [`Self::ticket_files`], as a data: URL. The sign-in only goes to the tracker.
    pub async fn ticket_file(&self, source: &str, conn: &str, id: &str, file: &str) -> Result<String> {
        let integ = self.store.read(|c| c.integrations.clone());
        let missing = || Error::NotConnected(source.into());
        match source {
            "jira" => {
                let j = integ.jira.iter().find(|j| j.id == conn).ok_or_else(missing)?;
                tickets::jira_file(j, &tickets::jira_auth::token(j).await?, file).await
            }
            "trello" => {
                let t = integ.trello.iter().find(|t| t.id == conn).ok_or_else(missing)?;
                tickets::trello_file(t, &tickets::trello_token(t).await?, id, file).await
            }
            "asana" => {
                let a = integ.asana.iter().find(|a| a.id == conn).ok_or_else(missing)?;
                tickets::asana_file(&tickets::asana_token(a).await?, file).await
            }
            "linear" => {
                let l = integ.linear.iter().find(|l| l.id == conn).ok_or_else(missing)?;
                tickets::linear_file(&tickets::linear_token(l).await?, file).await
            }
            "github" => self.ticket_github(conn, id).await?.0.file(file).await,
            other => Err(Error::Invalid(format!("unknown tracker {other}"))),
        }
    }

    /// The GitHub client and issue number of GitHub ticket `id` in repository `conn`.
    async fn ticket_github(&self, conn: &str, id: &str) -> Result<(GitHub, u64)> {
        let (owner, repo) = tickets::github_conn(conn).ok_or_else(|| Error::Invalid(format!("“{conn}” is not a GitHub repository")))?;
        let number: u64 = id.parse().map_err(|_| Error::Invalid(format!("“{id}” is not a GitHub issue number")))?;
        let api = self.store.read(|c| c.integrations.github_api.clone()).filter(|s| !s.is_empty());
        let token = providers::github_auth::token(None).await?;
        Ok((GitHub::new(RepoRef { owner: owner.into(), repo: repo.into(), ..Default::default() }, token, api), number))
    }

    /// Whether a Linear connection of the project has a team with cycles turned on, Linear's sprints.
    /// A failed check counts as one: the ticket fetch shows its error.
    pub async fn linear_cycles(&self, project_id: &str) -> bool {
        let linear = self.store.read(|c| c.integrations.linear.clone());
        for l in linear.iter().filter(|l| crate::store::shows_in(&l.repos, project_id)) {
            let on = match tickets::linear_token(l).await {
                Ok(tok) => tickets::linear_cycles(l, &tok).await.unwrap_or(true),
                Err(_) => true,
            };
            if on {
                return true;
            }
        }
        false
    }

    pub async fn triage(&self, project_id: &str) -> Result<Vec<Suggestion>> {
        let p = self.store.project(project_id)?;
        let list = self.tickets(project_id, false, false).await?;
        let unplanned: Vec<&TicketView> = list.iter().filter(|t| t.release.is_empty() && t.ticket.status != "done").collect();
        if unplanned.is_empty() {
            return Ok(Vec::new());
        }
        let open: Vec<String> = p
            .releases
            .iter()
            .filter(|r| r.shipped_at.is_none())
            .map(|r| format!("{} ({})", r.version, if r.kind == ReleaseKind::Hotfix { "hotfix: small, urgent fixes only" } else { "next feature release" }))
            .collect();
        if open.is_empty() {
            return Err(Error::Invalid("Create a release first".into()));
        }
        let items: Vec<String> = unplanned
            .iter()
            .map(|t| format!("- {} [{}] {}: {}", t.ticket.key, t.ticket.kind, t.ticket.title, t.ticket.description.chars().take(300).collect::<String>()))
            .collect();
        let prompt = format!(
            "Plan these tickets into releases.\n\nOpen releases:\n{}\n\nTickets:\n{}\n\nAnswer with a JSON array only, one object per ticket: {{\"key\":\"…\",\"kind\":\"feature\"|\"fix\",\"release\":\"<version from the list>\",\"reason\":\"one short sentence\"}}",
            open.join("\n"),
            items.join("\n")
        );
        let r = self.route("triage", None)?;
        let out = ai::complete(&r, &prompt, None).await?;
        let start = out.find('[').ok_or_else(|| Error::Ai("AI did not return a list".into()))?;
        let end = out.rfind(']').ok_or_else(|| Error::Ai("AI did not return a list".into()))?;
        let mut v: Vec<Suggestion> = serde_json::from_str(&out[start..=end]).map_err(|e| Error::Ai(format!("bad triage answer: {e}")))?;
        let versions: Vec<&str> = p.releases.iter().filter(|r| r.shipped_at.is_none()).map(|r| r.version.as_str()).collect();
        v.retain_mut(|s| {
            s.release = s.release.trim_start_matches('v').into();
            versions.contains(&s.release.as_str())
        });
        Ok(v)
    }

    // ---------- release notes ----------

    pub async fn notes_refs(&self, project_id: &str) -> Result<serde_json::Value> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let tags: Vec<String> = git.tags().await?.into_iter().map(|t| t.name).collect();
        let branches: Vec<String> = git.branches().await?.into_iter().map(|b| b.name).collect();
        Ok(serde_json::json!({ "tags": tags, "branches": branches }))
    }

    pub async fn notes_range(&self, project_id: &str, from: &str, to: &str) -> Result<serde_json::Value> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let range = format!("{from}..{to}");
        let commits = git.log(&range, Some(NOTES_MAX_COMMITS)).await?;
        let merges = merge_shas(&git, &range).await;
        let branches = commits.iter().filter(|c| merged_branch(c, merges.contains(&c.sha)).is_some()).count();
        let items: Vec<NotesItem> = range_items(&git, from, to, &commits, &merges).await.into_iter().map(|(item, _)| item).collect();
        Ok(serde_json::json!({
            "commits": commits.len(),
            "branches": branches,
            "tickets": tickets::extract_keys(&release_commit_lines(&commits, &HashMap::new())).len(),
            "items": items,
        }))
    }

    /// `exclude`: ids of `notes_range` items left out, with every commit they bring.
    pub async fn generate_notes(&self, project_id: &str, from: &str, to: &str, template_id: Option<&str>, language: &str, inc: NotesInclude, exclude: &[String]) -> Result<(String, String)> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let range = format!("{from}..{to}");
        let commits = git.log(&range, Some(NOTES_MAX_COMMITS)).await?;
        let mut dropped = HashSet::new();
        if !exclude.is_empty() {
            let merges = merge_shas(&git, &range).await;
            for (item, shas) in range_items(&git, from, to, &commits, &merges).await {
                if exclude.contains(&item.id) {
                    dropped.extend(shas);
                }
            }
        }
        let kept: Vec<_> = commits
            .into_iter()
            .filter(|c| !dropped.contains(&c.sha))
            .filter(|c| match change_kind(&c.subject) {
                ChangeKind::Feat => inc.feat,
                ChangeKind::Fix => inc.fix,
                ChangeKind::Internal => inc.internal,
            })
            .collect();
        if kept.is_empty() {
            return Err(Error::Invalid("No commits in this range match the filters".into()));
        }
        let mut t = self.template("release", template_id, Some(&p.id))?;
        templates::prepare_release(&mut t);
        let (note, projects) = commit_projects(&git, &kept, to).await;
        t.body.push_str(&note);
        let vars = release_vars(&git, from, to, &kept, inc.tickets, &projects).await;
        let r = self.route("release", Some(&t))?;
        let out = self.ask("release", &t, vars, language, None).await?;
        Ok((out, format!("{} · {} commits read", r.label(), kept.len())))
    }

    pub fn add_to_changelog(&self, project_id: &str, markdown: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let path = Path::new(&p.path).join("CHANGELOG.md");
        not_a_link(&path)?;
        let existing = std::fs::read_to_string(&path).unwrap_or_else(|_| "# Changelog\n".into());
        let (head, rest) = match existing.find("\n## ") {
            Some(i) => existing.split_at(i + 1),
            None => (existing.as_str(), ""),
        };
        let mut out = head.trim_end().to_string();
        out.push_str("\n\n");
        out.push_str(markdown.trim());
        out.push_str("\n\n");
        out.push_str(rest);
        std::fs::write(&path, out.trim_end().to_string() + "\n")?;
        self.changed(project_id);
        Ok(path.to_string_lossy().to_string())
    }

    /// AI adds the changes `branch` brings over its base to the `Unreleased` section of
    /// the branch's CHANGELOG.md, and commits that on the branch. The default branch, or
    /// one with nothing over its base (main, dev), uses the commits since its latest tag.
    /// `request`: what the user asks of this changelog ("keep it short"), added to the prompt when not empty.
    pub async fn update_changelog(&self, project_id: &str, branch: &str, request: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let text = git.show_file(branch, CHANGELOG).await?.ok_or_else(|| Error::Invalid(format!("{branch} has no {CHANGELOG}")))?;
        let default = git.default_branch().await?;
        let mut base = self.base_of(&p, branch, &default).await;
        let rev = git.rev_of(branch).await;
        let mut commits = if branch == default { Vec::new() } else { git.log(&format!("{}..{rev}", git.rev_of(&base).await), Some(200)).await? };
        if commits.is_empty() {
            let tag = git.run(&["describe", "--tags", "--abbrev=0", &rev]).await.ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
            commits = match &tag {
                Some(t) => git.log(&format!("{t}..{rev}"), Some(200)).await?,
                None => git.log(&rev, Some(100)).await?,
            };
            base = tag.unwrap_or_else(|| "the start of its history".into());
        }
        if commits.is_empty() {
            return Err(Error::Invalid(format!("{branch} has no commits since {base}")));
        }
        let mut t = self.template("changelog", None, Some(&p.id))?;
        let (note, projects) = commit_projects(&git, &commits, &rev).await;
        t.body.push_str(&note);
        let request = request.trim();
        if !request.is_empty() {
            // A variable, so braces in the user's text stay as typed.
            t.body.push_str("\n\nThe person publishing asks for this. Follow it, and still answer with the section body only:\n{request}");
        }
        for c in &mut commits {
            if let Some(touched) = projects.get(&c.sha) {
                c.subject = format!("{} [{touched}]", c.subject);
            }
        }
        let current = section_body(&text, "unreleased");
        // A release branch whose Unreleased entries were already moved under its version.
        let released = branch.strip_prefix("release/").map(|v| section_body(&text, v)).unwrap_or_default();
        let mut vars = BTreeMap::new();
        vars.insert("commits".into(), commit_lines(&commits));
        vars.insert("unreleased".into(), if current.is_empty() { "(empty)".into() } else { current.clone() });
        vars.insert("released".into(), if released.is_empty() { "(none)".into() } else { released });
        vars.insert("branch".into(), branch.into());
        vars.insert("base".into(), base);
        vars.insert("request".into(), request.into());
        let out = self.ask("release", &t, vars, &p.gen_lang.release, None).await?;
        let out = section_lines(&out);
        // Some models repeat the heading they were told to leave out.
        let body = out.strip_prefix("## [Unreleased]").unwrap_or(&out).trim().to_string();
        if body.is_empty() && !current.is_empty() {
            return Err(Error::Ai("AI answered without changelog entries. The Unreleased section was left as it was.".into()));
        }
        if body == current {
            return Ok("Changelog already lists these changes".into());
        }
        let updated = replace_section(&text, "Unreleased", &body);
        self.commit_changelog(&p, &git, branch, &updated, &format!("docs(changelog): add changes from {branch}")).await?;
        self.changed(project_id);
        Ok(format!("Changelog updated on {branch}"))
    }

    // ---------- submodules ----------

    pub async fn submodules(&self, project_id: &str) -> Result<Vec<Submodule>> {
        submodules::list(&self.git(&self.store.project(project_id)?)).await
    }

    /// The submodule at `path`, so actions only ever touch a declared one.
    async fn submodule(&self, git: &Git, path: &str) -> Result<Submodule> {
        let path = submodules::check_path(path)?;
        submodules::list(git).await?.into_iter().find(|s| s.path == path).ok_or_else(|| Error::NotFound(format!("submodule {path}")))
    }

    /// Add a submodule; `path` defaults to the URL's last segment.
    pub async fn add_submodule(&self, project_id: &str, url: &str, path: Option<&str>, branch: Option<&str>) -> Result<String> {
        let url = url.trim();
        if url.is_empty() {
            return Err(Error::Invalid("Give the repository URL.".into()));
        }
        let fallback = submodules::default_path(url);
        let path = submodules::check_path(path.map(str::trim).filter(|p| !p.is_empty()).unwrap_or(&fallback))?;
        let git = self.git(&self.store.project(project_id)?);
        if git.cwd().join(path).exists() {
            return Err(Error::Invalid(format!("{path} already exists in the project. Pick another folder.")));
        }
        let out = submodules::add(&git, url, path, branch.map(str::trim).filter(|b| !b.is_empty())).await;
        self.changed(project_id);
        out
    }

    /// Check out the recorded commits (`remote` = the tracked branches' tips instead). `path` None = all.
    pub async fn update_submodules(&self, project_id: &str, path: Option<&str>, remote: bool) -> Result<String> {
        let git = self.git(&self.store.project(project_id)?);
        if let Some(p) = path {
            self.submodule(&git, p).await?;
        }
        let out = submodules::update(&git, path.map(|p| p.trim().trim_end_matches('/')), remote).await;
        self.changed(project_id);
        out
    }

    pub async fn sync_submodules(&self, project_id: &str, path: Option<&str>) -> Result<String> {
        let git = self.git(&self.store.project(project_id)?);
        if let Some(p) = path {
            self.submodule(&git, p).await?;
        }
        submodules::sync(&git, path.map(|p| p.trim().trim_end_matches('/'))).await
    }

    pub async fn set_submodule(&self, project_id: &str, path: &str, url: Option<&str>, branch: Option<&str>) -> Result<()> {
        let git = self.git(&self.store.project(project_id)?);
        let s = self.submodule(&git, path).await?;
        let url = url.map(str::trim).filter(|u| !u.is_empty() && *u != s.url);
        let branch = branch.map(str::trim).filter(|b| Some(*b) != s.branch.as_deref().or(Some("")));
        submodules::set(&git, &s.path, url, branch).await?;
        self.changed(project_id);
        Ok(())
    }

    /// Stage the commit checked out in a submodule as its new pin, ready to commit.
    pub async fn stage_submodule(&self, project_id: &str, path: &str) -> Result<()> {
        let git = self.git(&self.store.project(project_id)?);
        let s = self.submodule(&git, path).await?;
        git.run(&["add", "--", &s.path]).await?;
        self.changed(project_id);
        Ok(())
    }

    pub async fn remove_submodule(&self, project_id: &str, path: &str) -> Result<()> {
        let git = self.git(&self.store.project(project_id)?);
        let s = self.submodule(&git, path).await?;
        let out = submodules::remove(&git, &s).await;
        self.changed(project_id);
        out
    }

    pub async fn fetch_submodules(&self, project_id: &str) -> Result<FetchReport> {
        let git = self.git(&self.store.project(project_id)?);
        let list = submodules::list(&git).await?;
        Ok(submodules::fetch(&git, &list).await)
    }

    // ---------- analytics ----------

    /// The projects in `project_ids`; empty or `"all"` means every project.
    fn analytics_projects(&self, project_ids: &[String]) -> Vec<Project> {
        let all = project_ids.is_empty() || project_ids.iter().any(|id| id == "all");
        self.store.read(|c| c.projects.iter().filter(|p| all || project_ids.contains(&p.id)).cloned().collect())
    }

    /// Stats over the projects in `project_ids` (empty or `"all"` means every project), counting the people of
    /// `emails` only (empty: everyone).
    pub async fn analytics(&self, project_ids: &[String], days: i64, emails: &[String]) -> Result<crate::analytics::Analytics> {
        let chosen = self.analytics_projects(project_ids);
        let repos = chosen.iter().map(|p| (p.name.clone(), Git::new(&p.path), p.ai_commits.as_slice())).collect();
        crate::analytics::compute(crate::analytics::Input { repos, range_days: days, emails }).await
    }

    /// Commits the people of `emails` (empty: anyone) authored on `date` in the projects in `project_ids`, with the
    /// branch each was made on.
    pub async fn analytics_day(&self, project_ids: &[String], date: chrono::NaiveDate, emails: &[String]) -> Vec<crate::analytics::DayCommit> {
        let repos = self.analytics_projects(project_ids).iter().map(|p| (p.name.clone(), Git::new(&p.path))).collect();
        crate::analytics::day(repos, date, emails).await
    }

    /// Sprint stats of the Jira connections shown in the projects in `project_ids` (empty or `"all"`: every project),
    /// over the last `count` sprints of each board, counting the tickets of `assignees` only (empty: everyone's).
    /// Jira's answers of the last [`SPRINT_TTL`] are used again unless `fresh`. A connection failing leaves its error
    /// next to the others' boards.
    pub async fn sprint_report(&self, project_ids: &[String], count: usize, assignees: &[String], fresh: bool) -> Result<crate::sprints::Report> {
        let chosen = self.analytics_projects(project_ids);
        let jira: Vec<crate::store::JiraConf> =
            self.store.read(|c| c.integrations.jira.iter().filter(|j| chosen.iter().any(|p| crate::store::shows_in(&j.repos, &p.id))).cloned().collect());
        let now = chrono::Utc::now();
        let mut boards = Vec::new();
        let mut errors = Vec::new();
        let mut everyone = Vec::new();
        // When the oldest answer used came.
        let mut synced: Option<String> = None;
        for j in &jira {
            let key = format!("{}\n{}\n{}\n{count}", j.id, j.base_url, j.projects.join(","));
            let kept = (!fresh).then(|| self.sprint_fetches.lock().unwrap().get(&key).filter(|(at, ..)| at.elapsed() < SPRINT_TTL).map(|(_, when, f)| (when.clone(), f.clone()))).flatten();
            let got = match kept {
                Some(k) => Ok(k),
                None => {
                    let got = match tickets::jira_auth::token(j).await {
                        Ok(tok) => tickets::jira_sprints(j, &tok, count).await,
                        Err(e) => Err(e),
                    };
                    got.map(|f| {
                        let (when, f) = (crate::store::now(), Arc::new(f));
                        self.sprint_fetches.lock().unwrap().insert(key, (Instant::now(), when.clone(), f.clone()));
                        (when, f)
                    })
                }
            };
            match got {
                Ok((when, f)) => {
                    let (sprints, issues, names) = &*f;
                    everyone.extend(issues.iter().map(|i| i.assignee.clone()));
                    let shown: Vec<tickets::SprintIssue> = issues.iter().filter(|i| assignees.is_empty() || assignees.contains(&i.assignee)).cloned().collect();
                    let site = j.base_url.trim_end_matches('/').trim_start_matches("https://");
                    boards.extend(crate::sprints::boards(&j.id, site, sprints, &shown, names, now));
                    synced = Some(synced.map_or(when.clone(), |s| s.min(when)));
                }
                Err(e) => errors.push(e.to_string()),
            }
        }
        if boards.is_empty() && !errors.is_empty() {
            return Err(Error::Other(errors.join(" · ")));
        }
        // The code of each ticket, from a month before the first sprint shown (branches often start before their sprint),
        // in every project the connections show in: a ticket's code can live in another repository than the one picked.
        let first = boards.iter().flat_map(|b| &b.sprints).filter_map(|s| chrono::NaiveDate::parse_from_str(&s.start, "%Y-%m-%d").ok()).min();
        if let Some(first) = first {
            let keys: std::collections::HashSet<String> = boards.iter().flat_map(|b| &b.sprints).flat_map(|s| &s.tickets).map(|t| t.key.clone()).collect();
            let linked = linked_projects(&self.store.read(|c| c.projects.clone()), &jira);
            let code = self.ticket_code(&linked, &keys, first - chrono::Duration::days(30)).await;
            for t in boards.iter_mut().flat_map(|b| &mut b.sprints).flat_map(|s| &mut s.tickets) {
                t.code = code.get(&t.key).cloned();
            }
        }
        let mut r = crate::sprints::report(jira.len(), boards, errors, everyone);
        r.synced_at = synced.unwrap_or(r.synced_at);
        Ok(r)
    }

    /// Commits and branches about each of `keys` in the git history of `projects` since `since`: commits naming the
    /// key in their message, and the commits of branches named after it or linked to it, merged and deleted ones too.
    async fn ticket_code(&self, projects: &[Project], keys: &std::collections::HashSet<String>, since: chrono::NaiveDate) -> HashMap<String, crate::sprints::TicketCode> {
        use crate::sprints::{TicketBranch, TicketCode, TicketCommit};
        const FMT: &str = "--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e";
        let since = format!("--since={} 00:00", since.format("%Y-%m-%d"));
        let mut out: HashMap<String, TicketCode> = HashMap::new();
        let parse = |raw: &str| -> Vec<(String, String, String, String, String)> {
            raw.split('\x1e')
                .filter_map(|rec| {
                    let f: Vec<&str> = rec.trim_start_matches('\n').splitn(5, '\x1f').collect();
                    (f.len() == 5).then(|| (f[0].to_string(), f[1].to_string(), f[2].to_string(), f[3].to_string(), f[4].to_string()))
                })
                .collect()
        };
        for p in projects {
            let git = self.git(p);
            let default = git.default_branch().await.unwrap_or_else(|_| "main".into());
            let origin = format!("origin/{default}");
            let has_origin = git.run(&["rev-parse", "--verify", "--quiet", &origin]).await.is_ok_and(|o| !o.trim().is_empty());
            // (key, what to log, branch name, still there): branches named after a key or linked to it, local and origin
            // copies both, since either can hold commits the other lacks.
            let mut walks: Vec<(String, Vec<String>, String, bool)> = Vec::new();
            let mut live = std::collections::HashSet::new();
            let refs = git.run(&["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"]).await.unwrap_or_default();
            for r in refs.lines() {
                let name = r.strip_prefix("origin/").unwrap_or(r);
                if name == "HEAD" || name == "origin" || name == default {
                    continue;
                }
                live.insert(name.to_string());
                let linked = p.branches.get(name).and_then(|m| m.ticket.clone());
                for key in ticket_keys(name, true).into_iter().chain(linked).filter(|k| keys.contains(k)) {
                    let mut range = vec![r.to_string(), format!("^{default}")];
                    range.extend(has_origin.then(|| format!("^{origin}")));
                    walks.push((key, range, name.to_string(), true));
                }
            }
            // Merges since then: the branch each took in names its tickets, deleted since or not.
            for l in git.run(&["log", "--all", "--merges", &since, "--format=%H%x1f%s"]).await.unwrap_or_default().lines() {
                let Some((sha, subject)) = l.split_once('\x1f') else { continue };
                let Some(branch) = crate::analytics::merged_branch(subject).filter(|b| !live.contains(*b)) else { continue };
                for key in ticket_keys(branch, true).into_iter().filter(|k| keys.contains(k)) {
                    walks.push((key, vec![format!("{sha}^1..{sha}^2")], branch.to_string(), false));
                }
            }
            let commit = |sha: &str, author: &str, date: &str, subject: &str, branch: &str| TicketCommit {
                sha: sha.chars().take(10).collect(),
                date: date.into(),
                author: author.into(),
                subject: subject.into(),
                branch: branch.into(),
                project: p.name.clone(),
                project_id: p.id.clone(),
            };
            for (key, range, name, is_live) in walks.into_iter().take(400) {
                let args: Vec<&str> = ["log", "--no-merges", "-n", "100", FMT].into_iter().chain(range.iter().map(String::as_str)).chain(["--"]).collect();
                let code = out.entry(key).or_default();
                if !code.branches.iter().any(|b| b.name == name && b.project_id == p.id) {
                    code.branches.push(TicketBranch { name: name.clone(), project: p.name.clone(), project_id: p.id.clone(), live: is_live });
                }
                for (sha, author, date, subject, _) in parse(&git.run(&args).await.unwrap_or_default()) {
                    if !code.commits.iter().any(|c| sha.starts_with(&c.sha)) {
                        code.commits.push(commit(&sha, &author, &date, &subject, &name));
                    }
                }
            }
            // Commits whose message names a key, on any branch.
            for (sha, author, date, subject, body) in parse(&git.run(&["log", "--all", "--no-merges", &since, FMT]).await.unwrap_or_default()) {
                for key in ticket_keys(&format!("{subject}\n{body}"), false).into_iter().filter(|k| keys.contains(k)) {
                    let code = out.entry(key).or_default();
                    if !code.commits.iter().any(|c| sha.starts_with(&c.sha)) {
                        code.commits.push(commit(&sha, &author, &date, &subject, ""));
                    }
                }
            }
        }
        for code in out.values_mut() {
            code.commits.sort_by(|a, b| b.date.cmp(&a.date));
            code.commits.truncate(50);
        }
        out
    }

    /// Tickets done per week over the last `weeks` weeks, from every tracker shown in the projects in `project_ids`
    /// (empty or `"all"`: every project) and the GitHub issues of their repositories. A tracker failing leaves its error next to the others' tickets.
    pub async fn weekly_report(&self, project_ids: &[String], weeks: usize) -> Result<crate::sprints::WeeklyReport> {
        let chosen = self.analytics_projects(project_ids);
        let on = |repos: &[String]| chosen.iter().any(|p| crate::store::shows_in(repos, &p.id));
        let integ = self.store.read(|c| c.integrations.clone());
        let now = chrono::Utc::now();
        let since = crate::sprints::weeks_start(now, weeks);
        let mut sources: Vec<String> = Vec::new();
        let mut tickets = Vec::new();
        let mut errors = Vec::new();
        let mut keep = |source: &str, got: Result<Vec<tickets::DoneTicket>>| {
            if !sources.iter().any(|s| s == source) {
                sources.push(source.into());
            }
            match got {
                Ok(v) => tickets.extend(v),
                Err(e) => errors.push(e.to_string()),
            }
        };
        for j in integ.jira.iter().filter(|j| on(&j.repos)) {
            let got = match tickets::jira_auth::token(j).await {
                Ok(tok) => tickets::jira_done(j, &tok, since).await,
                Err(e) => Err(e),
            };
            keep("jira", got);
        }
        for t in integ.trello.iter().filter(|t| on(&t.repos)) {
            let got = match tickets::trello_token(t).await {
                Ok(tok) => tickets::trello_done(t, &tok, since).await,
                Err(e) => Err(e),
            };
            keep("trello", got);
        }
        for a in integ.asana.iter().filter(|a| on(&a.repos)) {
            let got = match tickets::asana_token(a).await {
                Ok(tok) => tickets::asana_done(a, &tok, since).await,
                Err(e) => Err(e),
            };
            keep("asana", got);
        }
        for l in integ.linear.iter().filter(|l| on(&l.repos)) {
            let got = match tickets::linear_token(l).await {
                Ok(tok) => tickets::linear_done(l, &tok, since).await,
                Err(e) => Err(e),
            };
            keep("linear", got);
        }
        // Each GitHub repository once, however many of the chosen projects clone it.
        let mut repos = std::collections::HashSet::new();
        for p in &chosen {
            let Ok(gh) = self.github(&p.id).await else { continue };
            if repos.insert(tickets::github_repo(&gh)) {
                keep("github", tickets::github_done(&gh, since).await);
            }
        }
        if tickets.is_empty() && !errors.is_empty() {
            return Err(Error::Other(errors.join(" · ")));
        }
        Ok(crate::sprints::weekly(sources, tickets, errors, weeks, now))
    }

    /// `question` about the tickets on the analytics screen answered by AI from `data`, a board's sprints or the
    /// weekly view as the screen has them (JSON), after the earlier questions and answers of `history`.
    pub async fn ask_tickets(&self, question: &str, data: &str, history: &[(String, String)]) -> Result<String> {
        let question = question.trim();
        if question.is_empty() {
            return Err(Error::Invalid("Type a question first".into()));
        }
        let r = self.route("analytics", None)?;
        let mut data = data.to_string();
        if data.len() > ASK_DATA_MAX {
            let cut = (0..=ASK_DATA_MAX).rev().find(|i| data.is_char_boundary(*i)).unwrap_or(0);
            data.truncate(cut);
            data.push_str(" …(cut to fit)");
        }
        let earlier: String = history.iter().map(|(q, a)| format!("Question: {q}\nAnswer: {a}\n\n")).collect();
        let today = chrono::Utc::now().format("%A, %B %-d, %Y");
        let prompt = format!("{TICKET_QUESTION}\n\nToday is {today}.\n\nData:\n{data}\n\n{earlier}Question: {question}");
        Ok(self.complete("analytics", &r, &prompt, None).await?.trim().to_string())
    }
}

/// The projects any of `jira` shows in: where the code of its tickets is looked for.
fn linked_projects(projects: &[Project], jira: &[crate::store::JiraConf]) -> Vec<Project> {
    projects.iter().filter(|p| jira.iter().any(|j| crate::store::shows_in(&j.repos, &p.id))).cloned().collect()
}

/// Most bytes of sprint data sent along with a question.
const ASK_DATA_MAX: usize = 150_000;

/// How AI answers questions about the ticket charts.
const TICKET_QUESTION: &str = "You answer questions about a software team's tickets, from the data below, as the analytics screen of their Git app shows it.

How to read the data:
- With `sprints`, it is a Jira board's last sprints, oldest first; `selected` names the one on screen. With `weeks`, it is the tickets done each week (Monday first, the last week still running) in Jira, Trello, Asana or Linear.
- Work counts three ways: tickets, story points and estimated hours. `unit` is the one on screen: answer in it unless the question asks for another.
- Per sprint, `committed` is the work in it and `completed` the work done in it, its velocity. `scopeStart`, `added` and `carried` are the work there from the start, created after it started, and brought over from an earlier sprint. `leftEstimate` and `leftRemaining` are the original and remaining estimates, in hours, of the tickets not completed. `bugsFixed` counts the bugs completed. `workdays` and `workdaysDone` count its working days and those begun so far. `cycleMedian` and `cycleP85` are the hours from start to done that half and 85% of its completed tickets took at most.
- `people` splits the same per assignee and `burndown` gives the work left at the end of each day next to the ideal line. `tickets` lists each ticket with its status, `cycleHours` (start to done), `ageHours` (time since it started, still open), `stages` (hours in each status) and `code` (the commits and branches about it). Only the selected sprint and the one before it list their tickets and days.
- In the weekly view, each ticket has its `doneAt`, its `week` and `leadHours`, the hours from created to done.

Answer in the language of the question. Lead with the answer, then the figures behind it, in short Markdown: a list or a small table when it helps. Use only this data. When it cannot answer, say what is missing.";

/// Branch types, by prefix, with the spellings people also use for them.
const KINDS: &[(&str, &[&str])] = &[
    ("feat", &["feature", "features"]),
    ("fix", &["bugfix", "bug", "hotfix"]),
    ("refactor", &["refacto", "refractor"]),
    ("perf", &["performance"]),
    ("style", &["styles"]),
    ("test", &["tests"]),
    ("docs", &["doc"]),
    ("chore", &[]),
    ("ci", &[]),
    ("a11y", &["accessibility"]),
    ("build", &["deps"]),
    ("poc", &["spike"]),
];

/// `feature` → `feat`, `Fix` → `fix`; None when it is not a known type.
pub(crate) fn normalize_kind(kind: &str) -> Option<&'static str> {
    let k = kind.trim().to_ascii_lowercase();
    KINDS.iter().find(|(id, aliases)| *id == k || aliases.contains(&k.as_str())).map(|(id, _)| *id)
}

/// A branch type of the user's own (`wip`): one part of a branch name, and not `release`, which is the release dialog's.
pub(crate) fn custom_type(s: &str) -> Option<&str> {
    let s = s.trim();
    let ok = !s.is_empty() && s.len() <= 40 && !s.contains('/') && !s.starts_with('.') && !s.ends_with(".lock") && !s.eq_ignore_ascii_case("release") && valid_branch_name(&format!("{s}/x"));
    ok.then_some(s)
}

/// `feature` → feat, a type of the user's own (`wip`) as it is; None for anything else.
fn type_of(kind: &str) -> Option<String> {
    normalize_kind(kind).or_else(|| custom_type(kind)).map(str::to_string)
}

/// `name` with its prefix one of `types`, as listed (`feature/x` → `feat/x`); a prefix not among them becomes `kind`.
fn offered_type(name: &str, types: &[String], kind: &str) -> String {
    match name.split_once('/') {
        Some((pre, rest)) => {
            let k = type_of(pre).unwrap_or_default();
            let pre = types.iter().find(|t| t.eq_ignore_ascii_case(&k)).map_or(kind, |t| t.as_str());
            format!("{pre}/{rest}")
        }
        None => name.to_string(),
    }
}

/// Kind implied by a branch name's prefix (`feature/x` → feat).
fn kind_of_branch(name: &str) -> Option<&'static str> {
    name.split_once('/').and_then(|(pre, _)| normalize_kind(pre))
}

fn top_path(p: &Project) -> PathBuf {
    PathBuf::from(&p.path)
}

/// The variables every hook of `p` gets: its main checkout and the branch the moment is about.
fn hook_vars(p: &Project, branch: &str) -> hooks::Vars {
    vec![("MAIN", p.path.clone()), ("BRANCH", branch.to_string())]
}

/// `~` and `~/x` in a path the user typed, from the home folder.
fn expand_home(raw: &str) -> PathBuf {
    match (raw.strip_prefix('~'), dirs::home_dir()) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with(['/', '\\']) => home.join(rest.trim_start_matches(['/', '\\'])),
        _ => PathBuf::from(raw),
    }
}

/// Worktrees live next to the main checkout: `<parent>/<project>.<branch with / as ->`.
/// The whole branch name is kept so `feat/login` and `fix/login` do not collide.
fn worktree_path(p: &Project, branch: &str) -> PathBuf {
    let top = top_path(p);
    let parent = top.parent().map(Path::to_path_buf).unwrap_or_else(|| top.clone());
    // `/`, not `join`: on Windows the project path is git's `C:/…` and `git worktree list` gives back all `/`.
    PathBuf::from(format!("{}/{}.{}", parent.to_string_lossy().trim_end_matches('/'), p.name, branch.replace('/', "-")))
}

/// `git worktree add` leaves submodule folders empty: clone them at the branch's pins.
/// A failed clone (offline, SSH key) still leaves a usable worktree, so it is only logged.
async fn init_submodules(path: &Path) {
    if let Err(e) = submodules::update(&Git::new(path), None, false).await {
        crate::log::error(format!("Could not clone the submodules of {}: {e}", path.display()));
    }
}

/// `git worktree add` leaves ignored files out too: link, then copy, the listed ones (a graph, `.env`), for every
/// project and this one, from the main checkout. A path in both lists is linked (the copy finds it there).
/// Copies by default: tools that rewrite them in the worktree must not change the main checkout's.
async fn copy_worktree_files(store: &Store, p: &Project, path: &Path) {
    let (mut files, mut links) = store.read(|c| (c.worktree_files.clone(), c.worktree_links.clone()));
    files.extend(p.worktree_files.iter().cloned());
    links.extend(p.worktree_links.iter().cloned());
    let (top, dir) = (top_path(p), path.to_path_buf());
    let linked = tokio::task::spawn_blocking(move || {
        let mut linked = Vec::new();
        for (f, is_link) in links.into_iter().map(|f| (f, true)).chain(files.into_iter().map(|f| (f, false))) {
            // Rebuilt from components: no trailing `/` (a link can't be made at `x/`), `\` on Windows.
            let (from, to): (PathBuf, PathBuf) = (top.join(&f).components().collect(), dir.join(&f).components().collect());
            // Tracked paths are already checked out; missing ones have nothing to copy. A link the branch has there, even
            // one to a missing file, or as one of its folders, is never written through: it could point anywhere.
            if !from.exists() || to.symlink_metadata().is_ok() || through_link(&dir, Path::new(&f)) {
                continue;
            }
            let res = to.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| if is_link { link(&from, &from, &to) } else { copy_tree(&from, &to) });
            match res {
                Ok(()) if is_link => linked.push(f),
                Ok(()) => {}
                Err(e) => crate::log::error(format!("Could not {} {f} into {}: {e}", if is_link { "link" } else { "copy" }, dir.display())),
            }
        }
        linked
    })
    .await
    .unwrap_or_default();
    if let Err(e) = exclude_links(path, &linked).await {
        crate::log::error(format!("Could not hide the links of {} from git: {e}", path.display()));
    }
}

/// Whether a folder on the way from `root` to `rel` is a link: a checked-out branch can hold one, and a write under it
/// lands wherever it points.
fn through_link(root: &Path, rel: &Path) -> bool {
    let mut at = root.to_path_buf();
    let parts: Vec<_> = rel.components().collect();
    parts[..parts.len().saturating_sub(1)].iter().any(|c| {
        at.push(c);
        at.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink())
    })
}

/// A link at `to` to `target`, so the worktree reads and writes the main checkout's. `real` is the main checkout's
/// path that `target` stands for: `target` can be relative to the link's folder, which Windows needs resolved.
fn link(target: &Path, real: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let _ = real;
        std::os::unix::fs::symlink(target, to)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{symlink_dir, symlink_file};
        let dir = real.is_dir();
        match if dir { symlink_dir(target, to) } else { symlink_file(target, to) } {
            // ERROR_PRIVILEGE_NOT_HELD: symlinks need Developer Mode or admin. A hard link needs neither, and the
            // worktree sits next to the main checkout, on its drive. Canonical: a hard link to a link isn't followed.
            Err(e) if e.raw_os_error() == Some(1314) && !dir => std::fs::hard_link(std::fs::canonicalize(real)?, to),
            Err(e) if e.raw_os_error() == Some(1314) => Err(std::io::Error::other("Windows needs Developer Mode on to link folders")),
            r => r,
        }
    }
}

/// Git's `dir/` patterns don't match a link, which is no folder to it: exclude the links it doesn't ignore yet,
/// or they show as new files to commit. `info/exclude` is shared by all checkouts, where these are ignored already.
async fn exclude_links(path: &Path, linked: &[String]) -> Result<()> {
    if linked.is_empty() {
        return Ok(());
    }
    let git = Git::new(path);
    let names: Vec<&str> = linked.iter().map(|l| l.trim_end_matches('/')).collect();
    let ignored = git.ignored(&names).await?;
    let file = git.git_paths(&["info/exclude"]).await?.remove(0);
    let mut text = std::fs::read_to_string(&file).unwrap_or_default();
    for n in names.iter().filter(|n| !ignored.iter().any(|i| i == **n)) {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&format!("/{n}\n"));
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    Ok(std::fs::write(&file, text)?)
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let kind = std::fs::symlink_metadata(from)?.file_type();
    if kind.is_dir() {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        }
    } else if kind.is_symlink() {
        // Same target text, so a relative link inside a copied folder points into the copy.
        link(&std::fs::read_link(from)?, from, to)?;
    } else {
        std::fs::copy(from, to)?;
    }
    Ok(())
}

/// A commit id from the UI goes straight to `git diff`, so it must not read as an option.
/// Stash message naming what it holds: "3 files: a.rs, b.rs, c.rs" (a few names, then "+N more").
fn stash_message(files: &[FileChange]) -> String {
    const SHOWN: usize = 3;
    let names: Vec<&str> = files.iter().take(SHOWN).map(|f| f.path.rsplit('/').next().unwrap_or(&f.path)).collect();
    let more = files.len().saturating_sub(SHOWN);
    let count = if files.len() == 1 { "1 file".to_string() } else { format!("{} files", files.len()) };
    format!("{count}: {}{}", names.join(", "), if more > 0 { format!(" +{more} more") } else { String::new() })
}

fn check_sha(sha: &str) -> Result<&str> {
    if (4..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(sha)
    } else {
        Err(Error::Invalid(format!("not a commit id: {sha:?}")))
    }
}

/// A branch from the UI goes to `git log` or `git blame` as a revision, so it must not read as an option.
fn check_rev(rev: String) -> Result<String> {
    if rev.starts_with('-') { Err(Error::Invalid(format!("not a branch: {rev:?}"))) } else { Ok(rev) }
}

fn commit_lines(commits: &[crate::git::Commit]) -> String {
    commits
        .iter()
        .map(|c| {
            let sha = &c.sha[..7.min(c.sha.len())];
            let body = c.body.lines().filter(|l| !l.trim().is_empty()).take(3).collect::<Vec<_>>().join(" / ");
            if body.is_empty() {
                format!("- {} ({sha})", c.subject)
            } else {
                format!("- {} ({sha}) — {body}", c.subject)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Files that make the folder holding them a project of its own.
const MANIFESTS: &[&str] = &["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "composer.json", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "pubspec.yaml", "mix.exs", "Package.swift"];

/// The folders of a tree's `files` that hold a project ("" = the root), deepest first. Members of
/// the root's Cargo workspace (`cargo` = its Cargo.toml) build as one with the root, so they belong to it.
fn project_dirs(files: &[&str], cargo: Option<&str>) -> Vec<String> {
    let members = cargo.map(cargo_members).unwrap_or_default();
    let member = |d: &str| members.iter().any(|m| m == d || m.strip_suffix("/*").is_some_and(|parent| d.rsplit_once('/').is_some_and(|(p, _)| p == parent)));
    let mut dirs: Vec<String> = files
        .iter()
        .map(|f| f.rsplit_once('/').unwrap_or(("", f)))
        .filter(|(dir, name)| MANIFESTS.contains(name) && !dir.split('/').any(|s| s == "node_modules" || s == "vendor") && !member(dir))
        .map(|(dir, _)| dir.to_string())
        .collect();
    dirs.sort();
    dirs.dedup();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.len()));
    dirs
}

/// The `members` paths of a Cargo.toml's `[workspace]` table, as written ("crates/*" included).
// shortcut: reads the usual `members = [...]` line, not every TOML form; use a TOML parser if a repo needs more.
fn cargo_members(toml: &str) -> Vec<String> {
    let Some((_, table)) = toml.split_once("[workspace]") else { return Vec::new() };
    let table = table.split("\n[").next().unwrap_or_default();
    let Some(i) = table.find("\nmembers") else { return Vec::new() };
    let list = &table[i..];
    let list = &list[..list.find(']').unwrap_or(list.len())];
    list.split('"').skip(1).step_by(2).map(|m| m.trim_end_matches('/').to_string()).collect()
}

/// The project of `dirs` (deepest first, see `project_dirs`) that holds `path`.
fn project_of<'a>(path: &str, dirs: &'a [String]) -> Option<&'a str> {
    dirs.iter().find(|d| d.is_empty() || path.strip_prefix(d.as_str()).is_some_and(|rest| rest.starts_with('/'))).map(String::as_str)
}

/// The name a project folder goes by in a changelog heading: "App" for the root, else its last folder, capitalized ("Website").
// shortcut: folders with the same last name (apps/web, packages/web) share a name; use the whole path if a repo needs both.
fn project_name(dir: &str) -> String {
    let mut c = dir.rsplit('/').next().unwrap_or(dir).chars();
    match c.next() {
        Some(first) => first.to_uppercase().chain(c).collect(),
        None => "App".into(),
    }
}

/// When `rev`'s tree holds several projects (see `project_dirs`): the instruction a changelog or release-notes
/// prompt ends with, and the projects each of `commits` touches by sha ("App, Website"). Empty for a single project.
async fn commit_projects(git: &Git, commits: &[Commit], rev: &str) -> (String, HashMap<String, String>) {
    let files = git.run(&["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", rev]).await.unwrap_or_default();
    let cargo = git.show_file(rev, "Cargo.toml").await.ok().flatten();
    let dirs = project_dirs(&files.lines().collect::<Vec<_>>(), cargo.as_deref());
    if dirs.len() < 2 || commits.is_empty() {
        return Default::default();
    }
    // App first, then the others by name: the order their headings follow.
    let mut all: Vec<String> = dirs.iter().map(|d| project_name(d)).collect();
    all.sort_by_key(|n| (n != "App", n.clone()));
    // On stdin: a thousand shas as arguments would pass Windows' command line limit.
    let shas: String = commits.iter().map(|c| format!("{}\n", c.sha)).collect();
    let log = git.run_stdin(&["-c", "core.quotePath=false", "log", "--no-walk=unsorted", "--stdin", "--format=%x1e%H", "--name-only"], shas).await.unwrap_or_default();
    let mut touched = HashMap::new();
    for rec in log.split('\x1e') {
        let mut lines = rec.lines().filter(|l| !l.is_empty());
        let Some(sha) = lines.next() else { continue };
        let hit: Vec<String> = lines.filter_map(|f| project_of(f, &dirs)).map(project_name).collect();
        let names: Vec<&str> = all.iter().filter(|n| hit.contains(n)).map(String::as_str).collect();
        if !names.is_empty() {
            touched.insert(sha.to_string(), names.join(", "));
        }
    }
    let note = format!(
        "\n\nThis repository holds several projects, in this order: {}. Each commit ends with the projects it touches, in brackets. Split each group of changes by project: repeat the group's heading for each project with changes, with the project's name in parentheses after it, like \"### Added ({})\" then \"### Added ({})\". Follow the order of the projects and skip empty headings. An entry that changes several projects goes under the one listed first. Do not start entries with a project name.",
        all.join(", "),
        all[0],
        all[1]
    );
    (note, touched)
}

/// Most commits release notes read from a range.
const NOTES_MAX_COMMITS: u32 = 1000;

/// The changes in `from..to`, newest first, each with the shas of the commits it brings: every commit
/// on the range's first-parent line, a merge taking the commits of the branch it merged.
/// `commits`: `git log from..to`; `merges`: its merge commits.
async fn range_items(git: &Git, from: &str, to: &str, commits: &[Commit], merges: &HashSet<String>) -> Vec<(NotesItem, Vec<String>)> {
    let by_sha: HashMap<&str, &Commit> = commits.iter().map(|c| (c.sha.as_str(), c)).collect();
    let line = git.run(&["rev-list", "--first-parent", &format!("{from}..{to}")]).await.unwrap_or_default();
    let mut out = Vec::new();
    for sha in line.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Some(c) = by_sha.get(sha) else { continue };
        let mut shas = vec![c.sha.clone()];
        if merges.contains(&c.sha) {
            let merged = git.run(&["rev-list", &format!("{sha}^2"), "--not", &format!("{sha}^1"), from]).await.unwrap_or_default();
            shas.extend(merged.lines().map(str::trim).filter(|l| by_sha.contains_key(l)).map(String::from));
        }
        let mine: Vec<Commit> = shas.iter().filter_map(|s| by_sha.get(s.as_str()).map(|c| (*c).clone())).collect();
        let mut kind = change_kind(&c.subject);
        // A merge whose message names no type takes the strongest type of what it merged.
        if kind == ChangeKind::Internal {
            let kinds: Vec<ChangeKind> = mine.iter().map(|m| change_kind(&m.subject)).collect();
            kind = if kinds.contains(&ChangeKind::Feat) { ChangeKind::Feat } else if kinds.contains(&ChangeKind::Fix) { ChangeKind::Fix } else { ChangeKind::Internal };
        }
        let (title, pr) = change_title(c);
        out.push((
            NotesItem {
                id: c.sha.clone(),
                kind: match kind {
                    ChangeKind::Feat => "feat",
                    ChangeKind::Fix => "fix",
                    ChangeKind::Internal => "internal",
                },
                title,
                pr,
                commits: shas.len(),
                tickets: tickets::extract_keys(&release_commit_lines(&mine, &HashMap::new())),
            },
            shas,
        ));
    }
    out
}

/// What a change is called on the notes page, and the PR number its message names: the branch a merge
/// brings, a PR's title, else the subject.
fn change_title(c: &Commit) -> (String, Option<String>) {
    let s = c.subject.trim();
    let pr = |n: &str| Some(format!("#{}", n.trim_start_matches('#')));
    if let Some(rest) = s.strip_prefix("Merged PR ") {
        // Azure DevOps: "Merged PR 12: title".
        return match rest.split_once(": ") {
            Some((n, title)) => (title.trim().into(), pr(n)),
            None => (s.into(), None),
        };
    }
    if let Some(rest) = s.strip_prefix("Merge pull request ") {
        // GitHub: "#3 from owner/branch", the PR's title on the body's first line.
        let (n, head) = rest.split_once(" from ").unwrap_or((rest, ""));
        let branch = head.split_once('/').map_or(head, |(_, b)| b);
        let title = c.body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(branch);
        return (if title.is_empty() { s.into() } else { title.into() }, pr(n));
    }
    if let Some(rest) = s.strip_prefix("Merge branch '").and_then(|r| r.split_once('\'')) {
        return (rest.0.into(), None);
    }
    if let Some((title, n)) = s.rsplit_once(" (#").and_then(|(t, n)| Some((t, n.strip_suffix(')')?))).filter(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())) {
        return (title.into(), pr(n));
    }
    (s.into(), None)
}

/// Merge commits in `range`, by full sha.
async fn merge_shas(git: &Git, range: &str) -> std::collections::HashSet<String> {
    git.run(&["rev-list", "--merges", range]).await.unwrap_or_default().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()
}

/// What release notes read about `from..to`: `commits` (git log order) with their whole messages,
/// the PRs and branches they merge, and the net changes, as template variables.
/// `projects`: sha → the projects the commit touches (see `commit_projects`).
async fn release_vars(git: &Git, from: &str, to: &str, commits: &[Commit], tickets: bool, projects: &HashMap<String, String>) -> BTreeMap<String, String> {
    let merges = merge_shas(git, &format!("{from}..{to}")).await;
    let net = format!("{from}...{to}");
    let numstat = git.run(&["diff", "--numstat", &net]).await.unwrap_or_default();
    let diff = git.run(&["diff", "--no-color", "--no-ext-diff", "-p", &net, "--", ":(exclude)*.lock", ":(exclude)*-lock.json", ":(exclude)*-lock.yaml"]).await.unwrap_or_default();
    let text = release_commit_lines(commits, projects);
    let branches: Vec<String> = commits.iter().rev().filter_map(|c| merged_branch(c, merges.contains(&c.sha))).collect();
    let or_none = |s: String| if s.trim().is_empty() { "(none)".to_string() } else { s };
    let mut vars = BTreeMap::new();
    vars.insert("tickets".into(), if tickets { or_none(tickets::extract_keys(&text).join(", ")) } else { "(do not mention ticket keys)".into() });
    vars.insert("commits".into(), text);
    vars.insert("branches".into(), or_none(branches.join("\n")));
    vars.insert("files".into(), or_none(file_lines(&numstat, 400)));
    vars.insert("diff".into(), or_none(net_diff(&diff, 3_000, 40_000)));
    vars.insert("from".into(), from.into());
    vars.insert("to".into(), to.into());
    vars
}

/// The PR or branch `c` merges, as one line: a merge commit, or a squashed PR ("Merged PR 12: …"
/// from Azure DevOps, "Title (#12)" from GitHub). None for any other commit.
fn merged_branch(c: &Commit, merge: bool) -> Option<String> {
    let s = c.subject.trim();
    let sha = &c.sha[..7.min(c.sha.len())];
    let line = if let Some(rest) = s.strip_prefix("Merged PR ") {
        format!("PR {rest}")
    } else if let Some(rest) = s.strip_prefix("Merge pull request ") {
        // "#3 from owner/branch": GitHub puts the PR title on the body's first line.
        match c.body.lines().map(str::trim).find(|l| !l.is_empty()) {
            Some(title) => format!("PR {rest}: {title}"),
            None => format!("PR {rest}"),
        }
    } else if let Some((title, n)) = s.rsplit_once(" (#").and_then(|(t, n)| Some((t, n.strip_suffix(')')?))).filter(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())) {
        format!("PR #{n}: {title}")
    } else if merge {
        s.to_string()
    } else {
        return None;
    };
    Some(format!("- {line} ({sha})"))
}

/// `commits` as git log lists them (newest first), written oldest first, each with its date and whole
/// message. Messages are cut so the list stays near 60 KB, subjects always kept.
fn release_commit_lines(commits: &[Commit], projects: &HashMap<String, String>) -> String {
    let per = (60_000 / commits.len().max(1)).clamp(200, 1_500);
    let mut out = String::new();
    for c in commits.iter().rev() {
        let sha = &c.sha[..7.min(c.sha.len())];
        let date = c.date.get(..10).unwrap_or(&c.date);
        let touched = projects.get(&c.sha).map(|p| format!(" [{p}]")).unwrap_or_default();
        out.push_str(&format!("- {date} {sha} {}{touched}\n", c.subject.trim()));
        let body = c.body.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n");
        let cut = body.chars().count() > per;
        let body: String = body.chars().take(per).collect();
        for l in body.lines() {
            out.push_str("  ");
            out.push_str(l);
            out.push('\n');
        }
        if cut {
            out.push_str("  …\n");
        }
    }
    out.trim_end().to_string()
}

/// `git diff --numstat` output as "+12 -3 path" lines, at most `max`.
fn file_lines(numstat: &str, max: usize) -> String {
    let rows: Vec<String> = numstat
        .lines()
        .filter_map(|l| {
            let mut f = l.splitn(3, '\t');
            let (add, del, path) = (f.next()?, f.next()?, f.next()?);
            Some(if add == "-" { format!("binary {path}") } else { format!("+{add} -{del} {path}") })
        })
        .collect();
    let mut out = rows.iter().take(max).cloned().collect::<Vec<_>>().join("\n");
    if rows.len() > max {
        out.push_str(&format!("\n… {} more files", rows.len() - max));
    }
    out
}

/// `diff` (`git diff -p`) with each file's part cut to `per_file` bytes, smallest parts first so the
/// most files fit whole, until `total` bytes. The files left out are counted at the end.
fn net_diff(diff: &str, per_file: usize, total: usize) -> String {
    let mut parts: Vec<String> = diff
        .split("\ndiff --git ")
        .enumerate()
        .filter(|(_, p)| !p.trim().is_empty())
        .map(|(i, p)| {
            let mut p = if i == 0 { p.to_string() } else { format!("diff --git {p}") };
            crate::git::truncate_utf8(&mut p, per_file);
            p.truncate(p.trim_end().len());
            p.push('\n');
            p
        })
        .collect();
    parts.sort_by_key(String::len);
    let mut out = String::new();
    let mut left = 0;
    for p in parts {
        if out.len() + p.len() > total {
            left += 1;
        } else {
            out.push_str(&p);
        }
    }
    if left > 0 {
        out.push_str(&format!("… {left} more files left out here: the file list has them all"));
    }
    out.trim_end().to_string()
}

#[derive(Debug, PartialEq)]
enum ChangeKind {
    Feat,
    Fix,
    Internal,
}

/// What a commit brings, for the release-notes filters, read from its type or from the branch a
/// merged PR names: "feat: …", "Merged PR 12: feature/MNC-1-…", "Merge pull request #3 from me/fix/…".
fn change_kind(subject: &str) -> ChangeKind {
    let s = subject.trim();
    let s = if let Some(rest) = s.strip_prefix("Merged PR ") {
        rest.split_once(": ").map_or(rest, |(_, title)| title)
    } else if let Some(rest) = s.strip_prefix("Merge pull request ") {
        // "#3 from owner/fix/login": the branch comes after the owner.
        rest.split_once(" from ").map_or(rest, |(_, head)| head.split_once('/').map_or(head, |(_, branch)| branch))
    } else if let Some(rest) = s.strip_prefix("Merge branch '") {
        rest
    } else {
        s
    };
    let s = s.to_ascii_lowercase();
    let starts = |words: &[&str]| words.iter().any(|w| s.strip_prefix(w).is_some_and(|r| !r.starts_with(|c: char| c.is_ascii_alphanumeric())));
    if starts(&["feat", "feature"]) {
        ChangeKind::Feat
    } else if starts(&["fix", "bugfix", "hotfix"]) {
        ChangeKind::Fix
    } else {
        ChangeKind::Internal
    }
}

/// Summary of a squashed branch: "squash | feat/add login" for `feat/add-login`.
fn squash_title(branch: &str) -> String {
    format!("squash | {}", branch.replace('-', " "))
}

/// The project release a Jira fix version names: "2.4.0", "v2.4.0", "api 2.4.0", "api-v2.4.0" → 2.4.0, open releases first.
fn fix_version_release(fix_versions: &[String], releases: &[Release]) -> Option<String> {
    // The last word of the name, so a product prefix doesn't hide the version.
    let version = |f: &str| f.trim().rsplit([' ', '-', '_', '/']).next().unwrap_or("").trim_start_matches(['v', 'V']).to_string();
    let named = |r: &&Release| fix_versions.iter().any(|f| version(f) == r.version);
    let mut known = releases.iter().filter(named).collect::<Vec<_>>();
    known.sort_by_key(|r| r.shipped_at.is_some());
    known.first().map(|r| r.version.clone())
}

#[cfg(test)]
mod tests {

    #[test]
    fn fork_remotes_follow_origins_protocol_and_names() {
        let repo = |o: &str, r: &str| RepoRef { host: "github.com".into(), owner: o.into(), repo: r.into(), port: None };
        let (from, to) = (repo("me", "app"), repo("acme", "app"));
        assert_eq!(swap_repo("git@github.com:me/app.git", &from, &to), "git@github.com:acme/app.git");
        assert_eq!(swap_repo("https://tok@github.com/me/app", &from, &to), "https://tok@github.com/acme/app");
        // A URL naming it otherwise: plain https on the host.
        assert_eq!(swap_repo("ssh://example/x", &from, &to), "https://github.com/acme/app.git");

        // The two ways GitHub turns down a push from someone without write access, and a push refused for another reason.
        assert!(push_refused("ERROR: Permission to Swess/exe_launcher.git denied to t1gu1.\nfatal: Could not read from remote repository."));
        assert!(push_refused("remote: Permission to o/r.git denied to me.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403"));
        assert!(!push_refused(" ! [rejected]        main -> main (fetch first)"));

        assert_eq!(own_remote("fork/feat/x", "feat/x"), Some("fork"));
        assert_eq!(own_remote("origin/main", "feat/x"), None);
        assert_eq!(own_remote("feat/x", "feat/x"), None);

        let remotes = vec![("origin".to_string(), "git@github.com:acme/app.git".to_string()), ("mine".to_string(), "https://github.com/Me/App.git".to_string())];
        assert_eq!(remote_of(&remotes, "me/app"), Some("mine"));
        assert_eq!(remote_of(&remotes, "other/app"), None);
        assert_eq!(fork_remote_name(&remotes, "me"), "fork");
        let taken = vec![("fork".to_string(), String::new()), ("me".to_string(), String::new())];
        assert_eq!(fork_remote_name(&taken[..1], "me"), "me");
        assert_eq!(fork_remote_name(&taken, "me"), "me-fork");
    }
    use super::*;

    #[test]
    fn an_ai_branch_name_keeps_an_offered_type_only() {
        let types = ["feat".to_string(), "fix".into(), "WIP".into()];
        assert_eq!(offered_type("fix/login-crash", &types, "feat"), "fix/login-crash");
        assert_eq!(offered_type("feature/login", &types, "fix"), "feat/login", "an alias of an offered type");
        assert_eq!(offered_type("wip/try-it", &types, "feat"), "WIP/try-it", "as the project lists it");
        assert_eq!(offered_type("docs/readme", &types, "feat"), "feat/readme", "not offered");
        assert_eq!(offered_type("fix/x", &["docs".to_string()], "docs"), "docs/x", "the type the user picked wins");
        assert_eq!(offered_type("no-prefix", &types, "feat"), "no-prefix");
    }

    #[tokio::test]
    async fn an_agent_pick_without_a_provider_still_sets_its_permission_and_ultracode() {
        let dir = tempfile::tempdir().unwrap();
        let k = Gitnetix::open(dir.path()).unwrap();
        let t = k.template("agent", None, None).unwrap();
        let none = k.agent_ai(&t, Route::default()).unwrap();
        assert_eq!((none.permission.as_str(), none.ultracode), ("", false), "the routing's, which has none: Bypass");
        let asked = Route { permission: Some("acceptEdits".into()), ultracode: Some(true), ..Default::default() };
        let r = k.agent_ai(&t, asked).unwrap();
        assert_eq!((r.permission.as_str(), r.ultracode), ("acceptEdits", true));
    }

    #[tokio::test]
    async fn a_copied_profile_signs_in_again_where_a_refresh_token_works_once() {
        use crate::store::{UserProfile, FIRST_PROFILE};
        let _turn = secrets::test_turn();
        secrets::use_profile(FIRST_PROFILE);
        let dir = tempfile::tempdir().unwrap();
        let k = Gitnetix::open(dir.path()).unwrap();
        // GitHub: a sign-in, whose refresh token one renewal voids. GitLab: a pasted token, which has none.
        secrets::set("github", r#"{"accessToken":"a","refreshToken":"r1","expiresAt":1}"#).unwrap();
        secrets::set("gitlab", r#"{"accessToken":"pasted"}"#).unwrap();
        k.store
            .write(|c| {
                c.integrations.github_connected = true;
                c.integrations.github_user = Some("me".into());
                c.integrations.gitlab.connected = true;
                Ok(())
            })
            .unwrap();
        let copy = k.create_profile(UserProfile { name: "Copy".into(), ..Default::default() }, Some(FIRST_PROFILE), None).unwrap();
        secrets::use_profile(&copy.id);
        assert_eq!(secrets::get("github").unwrap(), None);
        assert_eq!(secrets::get("gitlab").unwrap().as_deref(), Some(r#"{"accessToken":"pasted"}"#));
        let i = k.store.profile_config(&copy.id).unwrap().integrations;
        assert!(!i.github_connected && i.github_user.is_none(), "shown as signed out, not as connected without a token");
        assert!(i.gitlab.connected);
        // The source keeps its own.
        secrets::use_profile(FIRST_PROFILE);
        assert!(secrets::get("github").unwrap().is_some());
        secrets::delete("github").unwrap();
        secrets::delete("gitlab").unwrap();
    }

    #[test]
    fn ticket_code_is_looked_for_in_every_project_jira_shows_in() {
        let p = |id: &str| Project { id: id.into(), ..Default::default() };
        let projects = [p("cms"), p("api"), p("web"), p("other")];
        let jira = |repos: &[&str]| crate::store::JiraConf { repos: repos.iter().map(|r| r.to_string()).collect(), ..Default::default() };
        let ids = |v: Vec<Project>| v.into_iter().map(|p| p.id).collect::<Vec<_>>();
        assert_eq!(ids(linked_projects(&projects, &[jira(&["cms", "api", "web"])])), ["cms", "api", "web"]);
        // A connection limited to no project shows in all of them.
        assert_eq!(ids(linked_projects(&projects, &[jira(&["cms"]), jira(&[])])).len(), 4);
        assert!(linked_projects(&projects, &[]).is_empty());
    }

    #[tokio::test]
    async fn ticket_code_finds_branches_merges_and_mentions() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("atlas");
        std::fs::create_dir(&repo).unwrap();
        let sh = |args: &[&str]| assert!(std::process::Command::new("git").current_dir(&repo).args(["-c", "user.name=Ana", "-c", "user.email=a@x", "-c", "commit.gpgsign=false"]).args(args).status().unwrap().success(), "git {args:?}");
        let commit = |m: &str| sh(&["commit", "-q", "--allow-empty", "-m", m]);
        sh(&["init", "-q", "-b", "main"]);
        commit("base");
        sh(&["switch", "-qc", "fix/MNC-2-crash"]);
        commit("guard empty feed");
        sh(&["switch", "-q", "main"]);
        sh(&["merge", "-q", "--no-ff", "fix/MNC-2-crash", "-m", "Merge branch 'fix/MNC-2-crash'"]);
        sh(&["branch", "-qD", "fix/MNC-2-crash"]);
        commit("MNC-3: fix the title");
        sh(&["switch", "-qc", "feat/MNC-1_login"]);
        commit("login form");
        commit("login api");
        let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
        let p = Project { id: "p1".into(), name: "atlas".into(), path: repo.to_string_lossy().into(), ..Default::default() };
        let keys = ["MNC-1", "MNC-2", "MNC-3", "MNC-9"].map(String::from).into_iter().collect();
        let code = k.ticket_code(&[p], &keys, chrono::Utc::now().date_naive() - chrono::Duration::days(1)).await;
        let of = |key: &str| {
            let c = &code[key];
            (c.commits.iter().map(|c| (c.subject.as_str(), c.branch.as_str())).collect::<Vec<_>>(), c.branches.iter().map(|b| (b.name.as_str(), b.live)).collect::<Vec<_>>())
        };
        let (commits, branches) = of("MNC-1");
        assert_eq!(commits.len(), 2);
        assert!(commits.contains(&("login form", "feat/MNC-1_login")) && commits.contains(&("login api", "feat/MNC-1_login")));
        assert_eq!(branches, [("feat/MNC-1_login", true)]);
        // Deleted once merged: found through its merge.
        assert_eq!(of("MNC-2"), (vec![("guard empty feed", "fix/MNC-2-crash")], vec![("fix/MNC-2-crash", false)]));
        assert_eq!(of("MNC-3"), (vec![("MNC-3: fix the title", "")], vec![]));
        assert!(!code.contains_key("MNC-9"));
        assert_eq!(code["MNC-2"].commits[0].project_id, "p1");
    }

    fn commit(sha: &str, date: &str, subject: &str, body: &str) -> Commit {
        Commit {
            sha: sha.into(),
            author: String::new(),
            email: String::new(),
            date: date.into(),
            subject: subject.into(),
            body: body.into(),
            tags: Vec::new(),
            local: false,
            origin: false,
            unpulled: false,
            unpushed: false,
            base: false,
            merged: Vec::new(),
        }
    }

    #[test]
    fn merged_branch_counts_merges_and_squashed_prs() {
        let c = |subject: &str, body: &str| commit("394b339b1111", "2026-10-01T10:00:00+02:00", subject, body);
        assert_eq!(merged_branch(&c("Merged PR 122219: fix/MNC-7393-update-title", ""), false).as_deref(), Some("- PR 122219: fix/MNC-7393-update-title (394b339)"));
        assert_eq!(merged_branch(&c("Merged PR 7: feat/x", ""), true).as_deref(), Some("- PR 7: feat/x (394b339)"));
        assert_eq!(merged_branch(&c("Merge pull request #3 from octo/fix/login", "\nFix the login loop\n"), true).as_deref(), Some("- PR #3 from octo/fix/login: Fix the login loop (394b339)"));
        assert_eq!(merged_branch(&c("Add dark mode (#42)", ""), false).as_deref(), Some("- PR #42: Add dark mode (394b339)"));
        assert_eq!(merged_branch(&c("Merge branch 'feature/search'", ""), true).as_deref(), Some("- Merge branch 'feature/search' (394b339)"));
        assert_eq!(merged_branch(&c("feat: dark mode", ""), false), None);
        assert_eq!(merged_branch(&c("Support (#hash) links", ""), false), None);
    }

    #[test]
    fn release_commits_read_oldest_first_with_their_message() {
        let newest_first = [
            commit("bbbbbbb222", "2026-10-02T10:00:00+02:00", "revert: remove dark mode", ""),
            commit("aaaaaaa111", "2026-10-01T10:00:00+02:00", "Merged PR 12: feat/dark-mode", "## Summary\n\nAdds a dark theme.\n"),
        ];
        assert_eq!(
            release_commit_lines(&newest_first, &HashMap::new()),
            "- 2026-10-01 aaaaaaa Merged PR 12: feat/dark-mode\n  ## Summary\n  Adds a dark theme.\n- 2026-10-02 bbbbbbb revert: remove dark mode"
        );
        let long = [commit("ccccccc333", "2026-10-03", "feat: x", &"y".repeat(2_000))];
        let out = release_commit_lines(&long, &HashMap::new());
        assert!(out.ends_with(&format!("  {}\n  …", "y".repeat(1_500))), "{out}");
    }

    #[test]
    fn projects_are_folders_with_a_manifest_outside_the_root_cargo_workspace() {
        // Gitnetix: a Cargo workspace app at the root, the website on its own.
        let cargo = "[workspace]\nresolver = \"2\"\nmembers = [\"crates/core\", \"crates/server\", \"src-tauri\"]\n\n[workspace.package]\nversion = \"0.1.0\"\n";
        let files = ["Cargo.toml", "package.json", "crates/core/Cargo.toml", "crates/server/Cargo.toml", "src-tauri/Cargo.toml", "src/App.tsx", "website/package.json", "website/src/index.astro"];
        let dirs = project_dirs(&files, Some(cargo));
        assert_eq!(dirs, ["website", ""]);
        assert_eq!(project_of("website/src/index.astro", &dirs), Some("website"));
        assert_eq!(project_of("crates/core/src/app.rs", &dirs), Some(""));
        assert_eq!(project_of("websites/x", &dirs), Some(""), "a folder name prefix is not the folder");
        // A JS monorepo: each workspace package counts, nested ones too; vendored code does not.
        let files = ["package.json", "apps/web/package.json", "apps/web/node_modules/x/package.json", "packages/ui/package.json", "packages/ui/icons/package.json", "vendor/lib/go.mod"];
        let dirs = project_dirs(&files, None);
        assert_eq!(dirs, ["packages/ui/icons", "packages/ui", "apps/web", ""]);
        assert_eq!(project_of("packages/ui/icons/a.svg", &dirs), Some("packages/ui/icons"));
        assert_eq!(project_of("README.md", &["api".to_string()]), None, "no root project");
        // A glob member, and a workspace with no app of its own at the root.
        assert_eq!(project_dirs(&["Cargo.toml", "crates/a/Cargo.toml", "crates/b/Cargo.toml", "tools/x/Cargo.toml"], Some("[workspace]\nmembers = [\n  \"crates/*\", # all crates\n]\n[workspace.dependencies]\nserde = \"1\"\n")), ["tools/x", ""]);
        assert!(cargo_members("[package]\nname = \"x\"\n").is_empty());
        assert_eq!([project_name(""), project_name("website"), project_name("packages/ui")], ["App", "Website", "Ui"]);
    }

    #[tokio::test]
    async fn commits_name_the_projects_they_touch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        let sh = |args: &[&str]| assert!(std::process::Command::new("git").current_dir(repo).args(["-c", "user.name=Ana", "-c", "user.email=a@x", "-c", "commit.gpgsign=false"]).args(args).status().unwrap().success(), "git {args:?}");
        let write = |path: &str| {
            std::fs::create_dir_all(repo.join(path).parent().unwrap()).unwrap();
            std::fs::write(repo.join(path), path).unwrap();
        };
        sh(&["init", "-q", "-b", "main"]);
        write("package.json");
        write("website/package.json");
        sh(&["add", "."]);
        sh(&["commit", "-qm", "init"]);
        write("website/index.html");
        sh(&["add", "."]);
        sh(&["commit", "-qm", "feat: new home page"]);
        write("src/app.ts");
        write("website/app.ts");
        sh(&["add", "."]);
        sh(&["commit", "-qm", "feat: both"]);
        let git = Git::new(repo);
        let commits = git.log("main~2..main", None).await.unwrap();
        let (note, projects) = commit_projects(&git, &commits, "main").await;
        assert!(note.contains("in this order: App, Website.") && note.contains("\"### Added (App)\" then \"### Added (Website)\""), "{note}");
        let of = |subject: &str| projects[&commits.iter().find(|c| c.subject == subject).unwrap().sha].clone();
        assert_eq!(of("feat: new home page"), "Website");
        assert_eq!(of("feat: both"), "App, Website");
        // A single project adds nothing.
        std::fs::remove_dir_all(repo.join("website")).unwrap();
        sh(&["add", "-A"]);
        sh(&["commit", "-qm", "chore: drop the website"]);
        assert_eq!(commit_projects(&git, &commits, "main").await, Default::default());
    }

    #[test]
    fn net_changes_fit_their_budget() {
        assert_eq!(file_lines("12\t3\tsrc/a.ts\n-\t-\tlogo.png\n", 400), "+12 -3 src/a.ts\nbinary logo.png");
        assert_eq!(file_lines("1\t0\ta\n1\t0\tb\n1\t0\tc\n", 2), "+1 -0 a\n+1 -0 b\n… 1 more files");
        let big = format!("diff --git a/big b/big\n{}\n", "+x\n".repeat(2_000));
        let diff = format!("{big}diff --git a/small b/small\n+one\ndiff --git a/mid b/mid\n{}", "+m\n".repeat(20));
        let out = net_diff(&diff, 3_000, 40_000);
        assert!(out.starts_with("diff --git a/small b/small\n+one\ndiff --git a/mid b/mid\n"), "smallest first: {out}");
        assert!(out.contains("… [diff truncated]"), "a big file is cut");
        let tight = net_diff(&diff, 3_000, 200);
        assert!(tight.ends_with("… 1 more files left out here: the file list has them all"), "{tight}");
        assert_eq!(net_diff("", 3_000, 40_000), "");
    }

    #[test]
    fn change_title_names_the_branch_or_pr() {
        let c = |subject: &str, body: &str| commit("394b339b1111", "2026-10-01T10:00:00+02:00", subject, body);
        assert_eq!(change_title(&c("Merged PR 122219: fix/MNC-7393-update-title", "")), ("fix/MNC-7393-update-title".into(), Some("#122219".into())));
        assert_eq!(change_title(&c("Merge pull request #3 from octo/fix/login", "\nFix the login loop\n")), ("Fix the login loop".into(), Some("#3".into())));
        assert_eq!(change_title(&c("Merge pull request #3 from octo/fix/login", "")), ("fix/login".into(), Some("#3".into())));
        assert_eq!(change_title(&c("Merge branch 'feat/search' into release/1.2.0", "")), ("feat/search".into(), None));
        assert_eq!(change_title(&c("Add dark mode (#42)", "")), ("Add dark mode".into(), Some("#42".into())));
        assert_eq!(change_title(&c("fix: shout beta", "")), ("fix: shout beta".into(), None));
    }

    #[test]
    fn change_kind_reads_types_and_merged_branches() {
        use ChangeKind::*;
        for (subject, kind) in [
            ("feat(deploy): ajoute les scripts", Feat),
            ("fix: include missing commit", Fix),
            ("Fix some playright screenshot test error", Fix),
            ("Merged PR 122219: fix/MNC-7393-update-maintenance-screen-title", Fix),
            ("Merged PR 121663: Feature/MNC 7298 ajout modale", Feat),
            ("Merged PR 121766: feat/MNC_7387-update-node-bun-expo-minor", Feat),
            ("Merged PR 122624: fix: Correct router.replace navigation", Fix),
            ("Merged PR 121936: refactor: Improve custom style strategy", Internal),
            ("Merged PR 120925: MNC-7298 APP | Ajout de modale", Internal),
            ("Merge pull request #12 from octo/hotfix/login", Fix),
            ("Merge branch 'feature/search' into main", Feat),
            ("Fixture cleanup", Internal),
            ("chore: 1.2.3", Internal),
        ] {
            assert_eq!(change_kind(subject), kind, "{subject}");
        }
    }

    #[test]
    fn expands_the_home_folder() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~/code/app"), home.join("code/app"));
        assert_eq!(expand_home("~bob/app"), PathBuf::from("~bob/app"));
        assert_eq!(expand_home("/srv/app"), PathBuf::from("/srv/app"));
    }

    #[test]
    fn project_icon_prefers_favicon_then_app_icon_then_logo() {
        let mut files = vec![
            "docs/logo.svg", "public/apple-touch-icon.png", "src/assets/icons/close.svg", "web/favicon.ico", "web/Favicon.svg",
            "vendor/x/favicon.svg", "logo-dark.png", "README.md", "iconography.png", "src-tauri/icons/icon.png", "logo192.png",
        ];
        files.retain(|f| icon_rank(f).is_some());
        files.sort_by_key(|f| icon_rank(f));
        assert_eq!(files, ["web/Favicon.svg", "web/favicon.ico", "public/apple-touch-icon.png", "src-tauri/icons/icon.png", "docs/logo.svg", "logo-dark.png", "logo192.png"]);
    }

    #[test]
    fn fix_version_names_a_release() {
        let rel = |v: &str, shipped: bool| Release { version: v.into(), shipped_at: shipped.then(now), ..Default::default() };
        let releases = [rel("2.3.0", true), rel("2.4.0", false)];
        assert_eq!(fix_version_release(&["v2.3.0".into(), "2.4.0".into()], &releases).as_deref(), Some("2.4.0"));
        assert_eq!(fix_version_release(&[" V2.3.0".into()], &releases).as_deref(), Some("2.3.0"));
        assert_eq!(fix_version_release(&["Backlog".into()], &releases), None);
        assert_eq!(fix_version_release(&["mauril-api v2.4.0".into()], &releases).as_deref(), Some("2.4.0"));
        assert_eq!(fix_version_release(&["api-2.3.0".into()], &releases).as_deref(), Some("2.3.0"));
        assert_eq!(fix_version_release(&["2.4.0-rc1".into()], &releases), None);
    }

    #[test]
    fn deleting_a_shipped_release_branch_rebuilds_only_its_branches() {
        let p = Project {
            releases: vec![
                Release { version: "1.0.0".into(), branch: "release/1.0.0".into(), shipped_at: Some(now()), ..Default::default() },
                Release { version: "1.1.0".into(), branch: "release/1.1.0".into(), ..Default::default() },
            ],
            ..Default::default()
        };
        let refs = Refs::new(vec![], vec![]);
        let view = |n: &str, parent: &str| plain_view(&p, &refs, n, Some(parent.into()));
        let built = BuiltViews {
            refs: "refs/heads/main a\nrefs/heads/release/1.0.0 b\nrefs/remotes/origin/release/1.0.0 b\nrefs/heads/release/1.1.0 c\nrefs/heads/feat/x d\nrefs/heads/feat/y e".into(),
            shared: 0,
            views: vec![view("release/1.0.0", "main"), view("feat/x", "release/1.0.0"), view("feat/y", "main")],
        };
        // Gone locally and on origin: only it and the branch under it rebuild.
        let kept = unmoved_views(&p, "main", &built, "refs/heads/main a\nrefs/heads/release/1.1.0 c\nrefs/heads/feat/x d\nrefs/heads/feat/y e").unwrap();
        assert_eq!(kept.keys().collect::<Vec<_>>(), ["feat/y"]);
        // Still on origin, or an open release gone: everything rebuilds.
        assert!(unmoved_views(&p, "main", &built, "refs/heads/main a\nrefs/remotes/origin/release/1.0.0 b\nrefs/heads/release/1.1.0 c\nrefs/heads/feat/x d\nrefs/heads/feat/y e").is_err());
        assert!(unmoved_views(&p, "main", &built, "refs/heads/main a\nrefs/heads/release/1.0.0 b\nrefs/remotes/origin/release/1.0.0 b\nrefs/heads/feat/x d\nrefs/heads/feat/y e").is_err());
    }

    #[test]
    fn link_ticket_sets_the_branch_ticket_and_plans_it() {
        let mut p = Project::default();
        p.branches.insert("feat/a".into(), BranchMeta { release: Some("1.2.0".into()), ticket: Some("OLD-1".into()), ..Default::default() });
        link_ticket(&mut p, "feat/a", "ATL-7");
        link_ticket(&mut p, "feat/untracked", "ATL-8");
        assert_eq!(p.branches["feat/a"].ticket.as_deref(), Some("ATL-7"));
        assert_eq!(p.ticket_releases.get("ATL-7").map(String::as_str), Some("1.2.0"));
        assert_eq!(p.branches["feat/untracked"].ticket.as_deref(), Some("ATL-8"));
        assert!(!p.ticket_releases.contains_key("ATL-8"));
    }

    #[test]
    fn trello_links_move_to_the_short_link_keys() {
        let mut p = Project::default();
        p.ticket_releases.insert("#12".into(), "1.2.0".into());
        p.ticket_releases.insert("ATL-7".into(), "1.3.0".into());
        p.branches.insert("feat/a".into(), BranchMeta { ticket: Some("#12".into()), ..Default::default() });
        p.branches.insert("feat/b".into(), BranchMeta { ticket: Some("ATL-7".into()), ..Default::default() });
        // `#12` on two boards: both stay planned, the branch stays on the first.
        let moves = [("#12".to_string(), "#Rk3u9QaP".to_string()), ("#12".into(), "#Zz81mNbc".into()), ("#4".into(), "#Lq0dXv2e".into())];
        assert!(move_ticket_keys(&mut p, &moves));
        let releases: Vec<_> = p.ticket_releases.iter().map(|(k, r)| (k.as_str(), r.as_str())).collect();
        assert_eq!(releases, [("#Rk3u9QaP", "1.2.0"), ("#Zz81mNbc", "1.2.0"), ("ATL-7", "1.3.0")]);
        assert_eq!(p.branches["feat/a"].ticket.as_deref(), Some("#Rk3u9QaP"));
        assert_eq!(p.branches["feat/b"].ticket.as_deref(), Some("ATL-7"));
        assert!(!move_ticket_keys(&mut p, &moves), "nothing left to move the second time");
    }

    #[test]
    fn a_branch_type_goes_in_the_first_unpinned_place() {
        use crate::store::{BranchType, BranchTypes};
        let t = |id: &str, pinned| BranchType { id: id.into(), pinned };
        let mut b = BranchTypes { list: vec![t("a", true), t("b", false), t("c", true), t("d", false)], one_row: false, tag_v: None };
        b.add("n");
        let ids: Vec<_> = b.list.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["a", "n", "c", "b", "d"], "the pinned a and c keep their places");
        b.add("N");
        assert_eq!(b.list.len(), 5, "listed already, in another case");
        let mut all = BranchTypes { list: vec![t("a", true)], one_row: false, tag_v: None };
        all.add("n");
        assert_eq!(all.list.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["a", "n"], "after the last pinned one");
        let of = |k: &str| type_of(k).unwrap_or_default();
        assert_eq!([of("Feature"), of("wip"), of("release"), of("a b"), of(""), of("x.lock")], ["feat", "wip", "", "", "", ""]);
        let mut gone = BranchTypes::default();
        assert_eq!(gone.first(), "feat");
        gone.list.retain(|t| t.id != "feat");
        assert_eq!(gone.first(), "fix", "Feature removed: the first listed, as the dialogs start on");
    }

    #[test]
    fn new_item_takes_the_agent_pick() {
        let req: NewItem = serde_json::from_value(serde_json::json!({ "from": "dev", "startAgent": true, "provider": "codex", "effort": "high" })).unwrap();
        assert_eq!(req.from.as_deref(), Some("dev"));
        assert!(req.start_agent);
        assert_eq!(req.pick.provider.as_deref(), Some("codex"));
        assert_eq!(req.pick.effort.as_deref(), Some("high"));
        assert!(req.pick.model.is_none());
    }

    #[tokio::test]
    async fn a_project_taken_from_another_profile_keeps_its_agent_pick() {
        use crate::store::UserProfile;
        let dir = tempfile::tempdir().unwrap();
        let k = Gitnetix::open(dir.path()).unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&repo).status().unwrap().success());
        git(&["init", "-q"]);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        let path = std::fs::canonicalize(&repo).unwrap().to_string_lossy().into_owned();
        let pick = Route { provider: Some("copilot".into()), model: Some("gpt-5".into()), ..Default::default() };
        k.store
            .write(|c| {
                c.projects.push(Project { id: "old".into(), name: "repo".into(), path: path.clone(), agent: pick.clone(), ..Default::default() });
                Ok(())
            })
            .unwrap();
        let other = k.create_profile(UserProfile { name: "Work".into(), ..Default::default() }, None, None).unwrap();
        k.switch_profile(&other.id).unwrap();
        let added = k.add_projects(vec![path], false).await.unwrap();
        assert_eq!(added[0].agent, pick);
    }

    #[tokio::test]
    async fn agent_default_effort_is_the_providers() {
        let tmp = tempfile::tempdir().unwrap();
        let ai = serde_json::json!({ "provider": "claude", "method": "cli", "model": "claude-opus-5-5", "effort": "xhigh", "baseUrl": null });
        let s = serde_json::json!([{ "id": "a", "projectId": "p", "branch": "b", "cwd": ".", "worktree": false, "status": "waiting", "request": "r", "agentLabel": "", "lines": [], "startedAt": "", "updatedAt": "", "resumeId": null, "ai": ai }]);
        std::fs::write(tmp.path().join("agents.json"), s.to_string()).unwrap();
        let k = Gitnetix::open(tmp.path()).unwrap();
        let pick = |m: &str, e: &str| Route { provider: Some("claude".into()), model: Some(m.into()), effort: Some(e.into()), permission: None, ultracode: None };
        // "Default effort" on a running session means the provider's setup, as on a new session.
        let r = k.agent_configure("a", pick("claude-opus-5-5", "")).unwrap().ai.unwrap();
        assert_eq!((r.model.as_str(), r.effort.as_str()), ("claude-opus-5-5", "medium"));
        assert_eq!(k.agent_configure("a", pick("", "max")).unwrap().ai.unwrap().effort, "max");
        // No permission picked: the "Free-form agent" routing's.
        k.store.write(|c| Ok(c.ai.routing.entry("agent".into()).or_default().permission = Some("auto".into()))).unwrap();
        assert_eq!(k.agent_configure("a", pick("", "")).unwrap().ai.unwrap().permission, "auto");
        let edits = Route { permission: Some("acceptEdits".into()), ..pick("", "") };
        assert_eq!(k.agent_configure("a", edits).unwrap().ai.unwrap().permission, "acceptEdits");
        // Ultracode: the routing's when not picked, the pick's otherwise.
        assert!(!k.agent_configure("a", pick("", "")).unwrap().ai.unwrap().ultracode);
        k.store.write(|c| Ok(c.ai.routing.entry("agent".into()).or_default().ultracode = Some(true))).unwrap();
        assert!(k.agent_configure("a", pick("", "")).unwrap().ai.unwrap().ultracode);
        assert!(!k.agent_configure("a", Route { ultracode: Some(false), ..pick("", "") }).unwrap().ai.unwrap().ultracode);
    }

    #[test]
    fn github_token_stays_on_trusted_hosts() {
        assert!(github_host_ok("github.com", false));
        assert!(!github_host_ok("github.evil.io", false));
        assert!(!github_host_ok("notgithub.com", false));
        assert!(github_host_ok("github.corp.com", true));
        assert!(!github_host_ok("gitlab.com", true));
    }

    #[test]
    fn ignore_line_anchors_and_escapes() {
        assert_eq!(ignore_line("src/a.log", false), "/src/a.log\n");
        assert_eq!(ignore_line("build", true), "/build/\n");
        assert_eq!(ignore_line("x[1]*.txt", false), "/x\\[1]\\*.txt\n");
    }

    #[test]
    fn origin_is_asked_less_often_the_longer_it_stays_unchanged() {
        let secs = std::time::Duration::from_secs;
        assert_eq!(ask_gap(secs(0)), AUTO_FETCH_GAP);
        assert_eq!(ask_gap(secs(60)), secs(12));
        assert_eq!(ask_gap(secs(3600)), secs(60), "capped");
    }

    #[tokio::test]
    async fn auto_fetch_gives_up_on_an_origin_that_never_answers() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").current_dir(&repo).args(["-c", "user.name=A", "-c", "user.email=a@x", "-c", "commit.gpgsign=false"]).args(args).status().unwrap().success());
        git(&["init", "-q", "-b", "main"]);
        git(&["commit", "-q", "--allow-empty", "-m", "init"]);
        // An ssh that connects and then hangs, like a connection the network dropped.
        git(&["remote", "add", "origin", "ssh://git@example.invalid/r.git"]);
        git(&["config", "core.sshCommand", "sleep 30;:"]);
        let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
        let added = crate::rpc::call(&k, "projects.add", serde_json::json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
        let pid = added[0]["id"].as_str().unwrap().to_string();
        let started = Instant::now();
        let err = k.auto_fetch(&pid, false).await.unwrap_err();
        assert!(err.to_string().contains("did not answer"), "{err}");
        assert!(started.elapsed() < TIPS_TIMEOUT + std::time::Duration::from_secs(3), "{:?}", started.elapsed());
        // The project's check is free again: the next one answers at once (asked too soon, it skips).
        let again = Instant::now();
        assert!(!k.auto_fetch(&pid, false).await.unwrap());
        assert!(again.elapsed() < std::time::Duration::from_secs(1));
    }

    #[tokio::test]
    async fn cleanup_takes_the_squash_answers_the_branch_map_saved() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").current_dir(&repo).args(["-c", "user.name=A", "-c", "user.email=a@x", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}");
            String::from_utf8(out.stdout).unwrap().trim().to_string()
        };
        std::fs::create_dir_all(&repo).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["commit", "-q", "--allow-empty", "-m", "init"]);
        // Two branches with a commit main lacks: git's own check finds neither squashed in.
        for b in ["feat/saved", "feat/asked"] {
            git(&["switch", "-qc", b, "main"]);
            git(&["commit", "-q", "--allow-empty", "-m", b]);
        }
        git(&["switch", "-q", "main"]);
        let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
        let added = crate::rpc::call(&k, "projects.add", serde_json::json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
        let pid = added[0]["id"].as_str().unwrap().to_string();
        // As the branch map would have saved it from its squash index.
        k.commits.insert("squash2", &git(&["rev-parse", "feat/saved"]), &git(&["rev-parse", "main"]), true);

        let r = k.cleanup_branches(&pid, &["feat/saved".into(), "feat/asked".into()], false, false).await.unwrap();
        assert_eq!(r.deleted, ["feat/saved"], "{:?}", r.skipped);
        assert_eq!(r.skipped.len(), 1);
        assert!(r.skipped[0].branch == "feat/asked" && r.skipped[0].reason.contains("not merged"), "{:?}", r.skipped);
    }

    #[tokio::test]
    async fn coming_back_asks_origin_without_waiting_out_its_quiet_spell() {
        let tmp = tempfile::tempdir().unwrap();
        let (origin, repo) = (tmp.path().join("origin.git"), tmp.path().join("repo"));
        let git = |dir: &Path, args: &[&str]| {
            let ok = std::process::Command::new("git").current_dir(dir).args(["-c", "user.name=A", "-c", "user.email=a@x", "-c", "commit.gpgsign=false"]).args(args).status();
            assert!(ok.unwrap().success(), "git {args:?}");
        };
        git(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
        git(tmp.path(), &["init", "-q", "-b", "main", repo.to_str().unwrap()]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        git(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
        git(&repo, &["push", "-q", "origin", "main"]);
        let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
        let added = crate::rpc::call(&k, "projects.add", serde_json::json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
        let pid = added[0]["id"].as_str().unwrap().to_string();
        assert!(k.auto_fetch(&pid, false).await.unwrap(), "the first look fetches");

        // Origin unchanged for 100 s and asked 10 s ago: the next look is due 20 s after that one.
        let slot = k.auto_fetch.lock().unwrap()[&pid].clone();
        let ago = |secs| Instant::now().checked_sub(std::time::Duration::from_secs(secs)).unwrap();
        let asked = ago(10);
        {
            let mut s = slot.lock().await;
            s.moved = Some(ago(100));
            s.asked = Some(asked);
        }
        assert!(!k.auto_fetch(&pid, false).await.unwrap());
        assert_eq!(slot.lock().await.asked, Some(asked), "waits out the gap");
        assert!(!k.auto_fetch(&pid, true).await.unwrap(), "origin has nothing new");
        assert!(slot.lock().await.asked.unwrap() > asked, "coming back asks at once");
    }

    #[tokio::test]
    async fn squash_index_answers_like_squash_check() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("repo");
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let ok = std::process::Command::new("git").current_dir(&dir).args(["-c", "user.name=A", "-c", "user.email=a@x", "-c", "commit.gpgsign=false"]).args(args).status().unwrap().success();
            assert!(ok, "git {args:?}");
        };
        let commit = |file: &str, body: &str, msg: &str| {
            std::fs::write(dir.join(file), body).unwrap();
            run(&["add", "-A"]);
            run(&["commit", "-qm", msg]);
        };
        run(&["init", "-q", "-b", "main"]);
        commit("base.txt", "0\n", "init");
        // Squashed in as one commit; rebased in commit by commit; its first commit picked, the rest squashed; still open;
        // a change undone (no net change at all).
        run(&["switch", "-qc", "sq"]);
        commit("sq1.txt", "a\n", "sq 1");
        commit("sq2.txt", "b\n", "sq 2");
        run(&["switch", "-qc", "rb", "main"]);
        commit("rb.txt", "r\n", "rb 1");
        run(&["switch", "-qc", "part", "main"]);
        commit("p1.txt", "1\n", "p 1");
        commit("p2.txt", "2\n", "p 2");
        commit("p3.txt", "3\n", "p 3");
        run(&["switch", "-qc", "open", "main"]);
        commit("o.txt", "o\n", "open 1");
        run(&["switch", "-qc", "gone", "main"]);
        commit("g.txt", "g\n", "g add");
        run(&["rm", "-q", "g.txt"]);
        run(&["commit", "-qm", "g rm"]);
        run(&["switch", "-q", "main"]);
        commit("m1.txt", "m\n", "main moves");
        run(&["checkout", "sq", "--", "sq1.txt", "sq2.txt"]);
        run(&["commit", "-qm", "sq (#1)"]);
        run(&["cherry-pick", "rb"]);
        run(&["cherry-pick", "part~2"]);
        run(&["checkout", "part", "--", "p2.txt", "p3.txt"]);
        run(&["commit", "-qm", "part rest (#2)"]);
        commit("m2.txt", "m2\n", "main moves again");

        let git = Git::new(&dir);
        let listed = git.read_refs().await.unwrap();
        let refs = Refs::new(listed.branches, listed.remote_branches);
        refs.set_batch(true);
        let cache = CommitCache::open(&tmp.path().join("home"));
        let index = SquashIndex::read(&refs, &git, &cache, "main", 0).await.expect("index");
        for b in ["sq", "rb", "part", "open", "gone"] {
            let tip = git.rev_parse(b).await.unwrap();
            let want = git.squash_check(b, "main", None).await.unwrap();
            assert_eq!(index.verdict(&git, &cache, &tip).await, Some(want.clone()), "{b}");
            assert_eq!(want.0, ["sq", "rb", "part"].contains(&b), "{b}");
        }
    }

    #[tokio::test]
    async fn graph_answers_like_git() {
        let tmp = tempfile::tempdir().unwrap();
        let git = Git::new(tmp.path());
        let sh = |args: &'static [&'static str]| {
            let git = git.clone();
            async move { git.run(&[&["-c", "user.name=A", "-c", "user.email=a@x", "-c", "commit.gpgsign=false"], args].concat()).await.unwrap() }
        };
        sh(&["init", "-q", "-b", "main"]).await;
        for step in [
            &["commit", "-q", "--allow-empty", "-m", "c1"][..],
            &["branch", "old"],
            &["commit", "-q", "--allow-empty", "-m", "c2"],
            &["switch", "-qc", "feat"],
            &["commit", "-q", "--allow-empty", "-m", "c3"],
            &["switch", "-qc", "side", "main"],
            &["commit", "-q", "--allow-empty", "-m", "s1"],
            &["switch", "-q", "main"],
            &["merge", "-q", "--no-ff", "feat", "-m", "merge feat"],
            &["commit", "-q", "--allow-empty", "-m", "c4"],
            // Criss-cross: x and y each merge the other's first commit, two best common ancestors.
            &["switch", "-qc", "x"],
            &["commit", "-q", "--allow-empty", "-m", "x1"],
            &["switch", "-qc", "y", "main"],
            &["commit", "-q", "--allow-empty", "-m", "y1"],
            &["switch", "-q", "x"],
            &["merge", "-q", "--no-ff", "y", "-m", "x2"],
            &["switch", "-q", "y"],
            &["merge", "-q", "--no-ff", "x^1", "-m", "y2"],
        ] {
            sh(step).await;
        }
        let refs = Refs::new(git.branches().await.unwrap(), vec![]);
        // The graph is read only when most branches get weighed.
        refs.set_batch(true);
        let g = refs.graph(&git).await.unwrap();
        // Counts as git 2.41's `%(ahead-behind)` gives them, for git without it.
        for base in ["main", "feat", "x", "y"] {
            let tip = git.rev_parse(base).await.unwrap();
            assert_eq!(g.counts(&tip, refs.local.iter().map(|b| (b.name.clone(), &b.sha))), git.left_right_all(base).await.unwrap(), "against {base}");
        }
        let all: Vec<String> = git.run(&["rev-list", "--all"]).await.unwrap().lines().map(String::from).collect();
        for a in &all {
            let (mut mine, mut theirs) = (refs.containing(&git, a).await, git.branches_containing(a).await.unwrap());
            mine.sort();
            theirs.sort();
            assert_eq!(mine, theirs, "containing {a}");
            for b in &all {
                assert_eq!(g.holds(b, a), Some(git.is_ancestor(a, b).await.unwrap()), "{a} in {b}");
                assert_eq!(g.merged_by_commit(a, b), Some(git.merged_by_commit(a, b).await.unwrap()), "{a} merged in {b}");
                match g.merge_base(a, b) {
                    Some(base) => assert_eq!(base, git.merge_base(a, b).await.unwrap(), "merge base of {a} {b}"),
                    None => assert!(git.run(&["merge-base", "--all", a, b]).await.unwrap().lines().count() > 1, "{a} {b} have one merge base"),
                }
            }
        }
        let tip = |b: &str| refs.local(b).unwrap().sha.clone();
        assert_eq!(g.merge_base(&tip("x"), &tip("y")), None);
        assert_eq!(g.holds("0000000000000000000000000000000000000000", &all[0]), None);
    }

    #[tokio::test]
    async fn attachments_land_in_the_git_dir() {
        let tmp = tempfile::tempdir().unwrap();
        Git::new(tmp.path().to_str().unwrap()).run(&["init", "-q"]).await.unwrap();
        let up = |name: &str, data: &str| Attachment { name: name.into(), data: Some(data.into()), path: None };
        assert_eq!(attach(tmp.path(), "hi", &[]).await.unwrap(), "hi");
        // "aGk=" is "hi"; the second image.png must not overwrite the first, "../x" must not escape.
        let text = attach(tmp.path(), "look", &[up("image.png", "aGk="), up("image.png", "aGk="), up("../x.txt", "aGk=")]).await.unwrap();
        let paths: Vec<&str> = text.lines().filter_map(|l| l.strip_prefix("- ")).collect();
        assert!(text.starts_with("look\n\nAttached files:\n- "));
        assert_eq!(paths.len(), 3);
        // Either slash: on Windows the checkout path joins with `\`.
        let slashed = |p: &str| p.replace('\\', "/");
        assert!(slashed(paths[0]).ends_with("/image.png") && slashed(paths[1]).ends_with("/2-image.png") && slashed(paths[2]).ends_with("/x.txt"));
        assert!(paths.iter().all(|p| slashed(p).contains(&format!(".git/{ATTACH_DIR}/")) && std::fs::read(p).unwrap() == b"hi"));
        assert!(attach(tmp.path(), "", &[up("a", "not base64!")]).await.is_err());
        // Read back for the log's previews, but nothing else of the checkout.
        assert_eq!(attachment(tmp.path(), paths[0]).await.unwrap(), "aGk=");
        // So are the images the agent shows, saved where its prompt says.
        let shot = attach_root(tmp.path()).await.unwrap().join("shared/app.png");
        std::fs::create_dir_all(shot.parent().unwrap()).unwrap();
        std::fs::write(&shot, "hi").unwrap();
        assert_eq!(attachment(tmp.path(), shot.to_str().unwrap()).await.unwrap(), "aGk=");
        let inside = format!("{}/.git/{ATTACH_DIR}/../config", tmp.path().display());
        assert!(attachment(tmp.path(), &inside).await.is_err());
        assert!(attachment(tmp.path(), tmp.path().join(".git/HEAD").to_str().unwrap()).await.is_err());
    }

    #[tokio::test]
    async fn host_says_which_pull_request_took_a_tip() {
        let tmp = tempfile::tempdir().unwrap();
        let git = Git::new(tmp.path().to_str().unwrap());
        git.run(&["init", "-q"]).await.unwrap();
        let info = |name: &str, sha: &str| BranchInfo { name: name.into(), sha: sha.into(), upstream: None, date: "2026-09-18T13:14:52-04:00".into(), author: String::new(), email: String::new() };
        let pr = MergedPr { id: 119772, target: "release/8.23.0".into(), merge_commit: "f28".into() };
        let refs = Refs::new(vec![info("feature/MNC-7187", "913")], vec![info("feature/other", "aaa")]).with_hosted(HashMap::from([("913".to_string(), vec![pr])]));
        assert_eq!(refs.tips(), ["913", "aaa"]);
        assert_eq!(refs.pr_merges(&git, "feature/MNC-7187").await, ["f28"]);
        assert_eq!(refs.hosted_targets("feature/MNC-7187"), ["release/8.23.0"]);
        assert!(refs.pr_merges(&git, "feature/other").await.is_empty());
    }

    #[test]
    fn tagged_releases_ship() {
        let release = |v: &str| Release { version: v.into(), branch: format!("release/{v}"), ..Default::default() };
        let mut p = Project { releases: vec![release("1.0.0"), release("1.1.0"), release("2.0.0")], ..Default::default() };
        let tags = [("v1.0.0", "2026-01-01"), ("1.1.0", "2026-02-01")].map(|(n, d)| TagInfo { name: n.into(), date: d.into(), sha: String::new() });
        assert!(ship_tagged_releases(&mut p, &tags));
        let state: Vec<_> = p.releases.iter().map(|r| (r.shipped_at.as_deref(), r.tag.as_deref())).collect();
        assert_eq!(state, [(Some("2026-01-01"), Some("v1.0.0")), (Some("2026-02-01"), Some("1.1.0")), (None, None)]);
        assert!(!ship_tagged_releases(&mut p, &tags));
    }

    #[test]
    fn releases_passed_by_a_later_patch_ship() {
        let release = |v: &str| Release { version: v.into(), branch: format!("release/{v}"), ..Default::default() };
        let mut p = Project { releases: vec![release("8.17.0"), release("8.5.5"), release("9.0.0"), release("8.23.2")], ..Default::default() };
        let tags = [("8.17.1", "2026-06-22"), ("8.5.6", "2026-01-10"), ("8.24.0", "2026-10-16"), ("8.23.1", "2026-10-15")]
            .map(|(n, d)| TagInfo { name: n.into(), date: d.into(), sha: String::new() });
        assert!(ship_tagged_releases(&mut p, &tags));
        let state: Vec<_> = p.releases.iter().map(|r| (r.version.as_str(), r.shipped_at.as_deref(), r.tag.as_deref())).collect();
        // A later minor (8.24.0) passes neither 9.0.0 nor a hotfix still to come for 8.23.
        assert_eq!(state, [("8.17.0", Some("2026-06-22"), None), ("8.5.5", Some("2026-01-10"), None), ("9.0.0", None, None), ("8.23.2", None, None)]);
    }

    #[test]
    fn slugs() {
        assert_eq!(slugify("Let users sign in with Google and GitHub.", 4), "sign-google-github");
        assert_eq!(slugify("!!!", 4), "change");
    }

    #[test]
    fn changelog_unreleased() {
        let text = "# Changelog\n\n## [Unreleased]\n\n### Added\n- Stash.\n\n## [0.0.6] - 2026-10-18\n\n- Tags.\n";
        assert_eq!(section_body(text, "unreleased"), "### Added\n- Stash.");
        assert_eq!(section_body(text, "0.0.6"), "- Tags.");
        assert_eq!(
            replace_section(text, "Unreleased", "### Added\n- Stash.\n- Azure.\n"),
            "# Changelog\n\n## [Unreleased]\n\n### Added\n- Stash.\n- Azure.\n\n## [0.0.6] - 2026-10-18\n\n- Tags.\n"
        );
        // No Unreleased section yet: opened above the latest version.
        assert_eq!(replace_section("# Changelog\n\n## [0.0.6]\n- Tags.\n", "Unreleased", "- Fix."), "# Changelog\n\n## [Unreleased]\n\n- Fix.\n\n## [0.0.6]\n- Tags.\n");
        assert_eq!(replace_section("# Changelog\n", "Unreleased", "- Fix."), "# Changelog\n## [Unreleased]\n\n- Fix.\n");
        assert_eq!(replace_section("## [Unreleased]\r\n\r\n## [1.0.0]\r\n- A.\r\n", "Unreleased", "- B."), "## [Unreleased]\r\n\r\n- B.\r\n\r\n## [1.0.0]\r\n- A.\r\n");
        // A version section keeps its dated heading; the next version is left alone.
        assert_eq!(
            replace_section("## [Unreleased]\n\n## [0.0.7] - 2026-10-19\n- A.\n- B.\n\n## [0.0.6]\n- Tags.\n", "0.0.7", "### Added\n- B.\n- A."),
            "## [Unreleased]\n\n## [0.0.7] - 2026-10-19\n\n### Added\n- B.\n- A.\n\n## [0.0.6]\n- Tags.\n"
        );
        assert_eq!(latest_changelog_version(text).as_deref(), Some("0.0.6"));
        assert_eq!(latest_changelog_version("# Changelog\n\n## [Unreleased]\n- Fix.\n"), None);
    }

    #[test]
    fn rename_moves_the_version_section_and_stashes_follow() {
        let text = "## [Unreleased]\n\n## [2.4.0] - 2026-10-20\r\n- A.\n## [2.4.01]\n";
        assert_eq!(rename_changelog_version(text, "2.4.0", "2.5.0").as_deref(), Some("## [Unreleased]\n\n## [2.5.0] - 2026-10-20\r\n- A.\n## [2.4.01]\n"));
        assert_eq!(rename_changelog_version("## [Unreleased]\n", "2.4.0", "2.5.0"), None);

        // a → b → c, then a new branch takes the name a again; renaming back never loops.
        let mut p = Project::default();
        renamed(&mut p, "a", "b").unwrap();
        renamed(&mut p, "b", "c").unwrap();
        let stash = |b: &str| StashInfo { sha: String::new(), branch: Some(b.into()), message: String::new(), date: String::new(), untracked: false };
        let mut s = vec![stash("a"), stash("b")];
        relabel_stashes(&p, &mut s, |_| false);
        assert_eq!(s.iter().map(|s| s.branch.as_deref().unwrap()).collect::<Vec<_>>(), ["c", "c"]);
        let mut s = vec![stash("a")];
        relabel_stashes(&p, &mut s, |n| n == "a");
        assert_eq!(s[0].branch.as_deref(), Some("a"));
        renamed(&mut p, "c", "a").unwrap();
        let mut s = vec![stash("b")];
        relabel_stashes(&p, &mut s, |_| false);
        assert_eq!(s[0].branch.as_deref(), Some("a"));
    }

    #[test]
    fn changelog_answers_keep_only_headings_and_entries() {
        let answer = "Here is the section:\n```markdown\n### Added (App)\n\n- Blame a file.\n  Click a label to open its commit.\n- File history.\n\n\n### Fixed (Website)\n* Hero glow.\n```\n\nSkipped: I did not check the diff.\n";
        assert_eq!(section_lines(answer), "### Added (App)\n\n- Blame a file.\n  Click a label to open its commit.\n- File history.\n\n### Fixed (Website)\n* Hero glow.");
        assert_eq!(section_lines("## [Unreleased]\n- Stash.\r\n"), "## [Unreleased]\n- Stash.");
        assert_eq!(section_lines("Nothing new to add."), "");
    }

    #[test]
    fn changelog_stamp() {
        let text = "# Changelog\n\n## [Unreleased]\n\n### Added\n- Stash.\n\n## [0.0.6] - 2026-10-18\n\n- Tags.\n";
        assert_eq!(
            stamp_changelog(text, "0.0.7", "2026-10-19").as_deref(),
            Some("# Changelog\n\n## [Unreleased]\n\n## [0.0.7] - 2026-10-19\n\n### Added\n- Stash.\n\n## [0.0.6] - 2026-10-18\n\n- Tags.\n")
        );
        // Late entries merge into the existing version section, by kind, keeping its date.
        let late = "## [Unreleased]\n\n### Fixed\n- Crash.\n\n### Added\n- Stash.\n- Azure.\n\n## [0.0.7] - 2026-10-19\n\n- Misc.\n\n### Added\n- Stash.\n\n### Removed\n- Old.\n\n## [0.0.6]\n- Tags.\n";
        assert_eq!(
            stamp_changelog(late, "0.0.7", "2026-10-22").as_deref(),
            Some("## [Unreleased]\n\n## [0.0.7] - 2026-10-19\n\n- Misc.\n\n### Added\n- Stash.\n- Azure.\n\n### Removed\n- Old.\n\n### Fixed\n- Crash.\n\n## [0.0.6]\n- Tags.\n")
        );
        // A project in parentheses splits a kind: its headings stay apart and in kind order.
        let projects = "## [Unreleased]\n\n### Added (Website)\n- Hero.\n\n### Added (App)\n- Azure.\n\n## [0.0.7] - 2026-10-19\n\n### Added (App)\n- Stash.\n\n### Fixed (App)\n- Crash.\n\n## [0.0.6]\n- Tags.\n";
        assert_eq!(
            stamp_changelog(projects, "0.0.7", "2026-10-22").as_deref(),
            Some("## [Unreleased]\n\n## [0.0.7] - 2026-10-19\n\n### Added (App)\n- Stash.\n- Azure.\n\n### Added (Website)\n- Hero.\n\n### Fixed (App)\n- Crash.\n\n## [0.0.6]\n- Tags.\n")
        );
        // Nothing unreleased, or no Unreleased section at all.
        assert_eq!(stamp_changelog("## [Unreleased]\n\n## [0.0.6]\n- Tags.\n", "0.0.7", "2026-10-19"), None);
        assert_eq!(stamp_changelog("# Changelog\n", "0.0.7", "2026-10-19"), None);
        assert_eq!(
            stamp_changelog("## [Unreleased]\r\n- Fix.\r\n", "1.0.0", "2026-10-19").as_deref(),
            Some("## [Unreleased]\r\n\r\n## [1.0.0] - 2026-10-19\r\n- Fix.\r\n")
        );
    }

    #[test]
    fn branch_names() {
        assert!(valid_branch_name("feat/oauth-login"));
        assert_eq!(normalize_kind("Feature"), Some("feat"));
        assert_eq!(normalize_kind("docs"), Some("docs"));
        assert_eq!(normalize_kind("wip"), None);
        assert!(!valid_branch_name("feat/ bad"));
        assert!(!valid_branch_name("feat/.."));
    }

    #[test]
    fn agent_ticket_context() {
        let t: Ticket = serde_json::from_value(serde_json::json!({
            "key": "ATL-212", "source": "jira", "title": "Login", "kind": "Story", "status": "progress", "statusLabel": "In Progress",
            "assignee": "Ana", "mine": false, "description": "Users sign in.\n", "criteria": [{"text": "SSO", "done": true}, {"text": "MFA", "done": false}],
            "comments": 0, "url": "https://x.atlassian.net/browse/ATL-212", "whereLabel": "", "place": ""
        }))
        .unwrap();
        let body = ticket_context(&t);
        assert_eq!(body, "# ATL-212 · Story · Login\nhttps://x.atlassian.net/browse/ATL-212\nStatus: In Progress\n\nUsers sign in.\n\nAcceptance criteria:\n- [x] SSO\n- [ ] MFA");

        let section = ticket_section("p1", "ATL-212", &body, Some(Path::new("/r/.git/gitnetix-ticket.md")));
        assert!(section.contains(&body));
        assert!(section.contains("/r/.git/gitnetix-ticket.md"));
        assert!(section.contains(r#"projectId "p1" and key "ATL-212""#));
        assert!(!ticket_section("p1", "ATL-212", &body, None).contains("A copy is in"));

        assert_eq!(insert_ticket("Do it.\n{ticket}\nThanks", "T"), "Do it.\nT\nThanks");
        assert_eq!(insert_ticket("Do it.", "T"), "Do it.\n\nT");
        assert_eq!(insert_ticket("Do it.", ""), "Do it.");
        assert_eq!(insert_ticket("Do it.\n{ticket}", ""), "Do it.\n");
    }

    #[test]
    fn long_ticket_description_is_cut() {
        let mut t: Ticket = serde_json::from_value(serde_json::json!({
            "key": "#12", "source": "trello", "title": "T", "kind": "Card", "status": "todo", "statusLabel": "To do",
            "assignee": "", "mine": true, "description": "", "criteria": [], "comments": 0, "url": "", "whereLabel": "", "place": ""
        }))
        .unwrap();
        t.description = "é".repeat(TICKET_DESCRIPTION_MAX + 5);
        let body = ticket_context(&t);
        assert_eq!(body.matches('é').count(), TICKET_DESCRIPTION_MAX);
        assert!(body.ends_with("(cut, see the ticket)"));
    }

    #[test]
    fn ticket_in_branch() {
        assert_eq!(with_ticket("feat/login", "ATL-212"), "feat/ATL-212_login");
        assert_eq!(with_ticket("feat/atl-212-login", "ATL-212"), "feat/ATL-212_login");
        assert_eq!(with_ticket("feat/ATL-212_login", "ATL-212"), "feat/ATL-212_login");
        assert_eq!(with_ticket("feat/login", ""), "feat/login");
        assert_eq!(with_ticket("feat/atl-212", "ATL-212"), "feat/ATL-212");
        assert_eq!(with_ticket("feat/login", "#12"), "feat/12_login");
        assert_eq!(with_ticket("feat/login", "#aB3dE9fG"), "feat/aB3dE9fG_login");
    }

    #[test]
    fn hotfix_bases() {
        // Newest first, like Git::tags: a 1.9 backport tagged after 2.0.0.
        let tags: Vec<TagInfo> = ["deploy-prod", "v1.9.5", "v2.0.0", "v1.9.4"]
            .iter()
            .map(|n| TagInfo { name: n.to_string(), date: String::new(), sha: String::new() })
            .collect();
        assert_eq!(hotfix_base(&tags, "2.0.1").as_deref(), Some("v2.0.0"));
        assert_eq!(hotfix_base(&tags, "1.9.6").as_deref(), Some("v1.9.5"));
        assert_eq!(hotfix_base(&tags, "3.1.1").as_deref(), Some("v2.0.0"));
        assert_eq!(hotfix_base(&tags[..1], "1.0.1").as_deref(), Some("deploy-prod"));
        assert_eq!(hotfix_base(&[], "1.0.1"), None);
    }

    #[test]
    fn versions() {
        assert_eq!(parse_version("v2.4.1"), Some([2, 4, 1]));
        assert_eq!(parse_version("2.4"), Some([2, 4, 0]));
        assert_eq!(parse_version("2.4.0-rc1"), None);
        assert_eq!(parse_version("latest"), None);
        assert_eq!(parse_version("1.18446744073709551615"), None);
    }

    #[test]
    fn tag_prefix_follows_the_version_tags() {
        assert!(tags_use_v([]), "no tags yet: v");
        assert!(tags_use_v(["deploy-prod", "latest"]), "no version tags: v");
        assert!(!tags_use_v(["1.0.0", "1.1.0", "deploy-prod"]));
        assert!(tags_use_v(["v1.0.0", "1.1.0"]), "a tie goes to v");
        assert!(!tags_use_v(["v1.0.0", "1.1.0", "1.2.0", "v2.0.0-rc1"]), "pre-releases don't count");
        assert!(tags_use_v(["v1.0.0", "v1.1.0", "1.2.0"]));
        assert_eq!(release_tag(true, "2.4.0"), "v2.4.0");
        assert_eq!(release_tag(true, "v2.4.0"), "v2.4.0");
        assert_eq!(release_tag(false, "v2.4.0"), "2.4.0");
        assert_eq!(release_tag(false, "2.4.0"), "2.4.0");
    }

    #[test]
    fn publishable_versions_are_tag_names_git_takes() {
        for ok in ["2.4.0", "1", "1.0.0-rc.1", "2026.11", "1.2.0-beta-2"] {
            assert!(publishable_version(ok), "{ok}");
        }
        for bad in ["", "-x", "v1.0.0", "x1", "1.2.", "1..2", "1.2.lock", "1.0 beta", "1/2", "1.0~1"] {
            assert!(!publishable_version(bad), "{bad}");
        }
    }

    #[test]
    fn squash_title_drops_dashes() {
        assert_eq!(squash_title("feat/add-login-page"), "squash | feat/add login page");
    }
}

/// Line ranges [start, end) of `lines` to ask AI about: each conflict (`<<<<<<<` to `>>>>>>>`)
/// with `context` lines on each side, ranges that touch merged into one.
fn conflict_regions(lines: &[&str], context: usize) -> Vec<(usize, usize)> {
    let mut regions: Vec<(usize, usize)> = Vec::new();
    let mut open = None;
    for (i, l) in lines.iter().enumerate() {
        if l.starts_with("<<<<<<<") {
            open = Some(i);
        } else if let (Some(s), true) = (open, l.starts_with(">>>>>>>")) {
            open = None;
            let (start, end) = (s.saturating_sub(context), (i + 1 + context).min(lines.len()));
            match regions.last_mut() {
                Some(last) if start <= last.1 => last.1 = end,
                _ => regions.push((start, end)),
            }
        }
    }
    regions
}

/// What each side of conflicted `path` holds (index stages 2 and 3), the sides it has.
async fn sides_of(git: &Git, path: &str) -> Vec<String> {
    let mut sides = Vec::new();
    for stage in [2, 3] {
        if let Ok((true, text, _)) = git.try_run(&["show", &format!(":{stage}:{path}")]).await {
            sides.push(text);
        }
    }
    sides
}

/// The conflicts of `lines` (each `<<<<<<<` to `>>>>>>>`), less the marker blocks a side already holds word for
/// word: conflict markers shown as text (a page about conflicts), which stay as they are.
// shortcut: an example block inside a conflicting side hides that conflict's own markers (it is then left to the
// user); regenerate the file with git's `conflict-marker-size` if that case shows up.
fn real_conflicts(lines: &[&str], sides: &[String]) -> Vec<(usize, usize)> {
    let sides: Vec<Vec<&str>> = sides.iter().map(|s| s.lines().collect()).collect();
    conflict_regions(lines, 0).into_iter().filter(|&(s, e)| !sides.iter().any(|side| side.windows(e - s).any(|w| w == &lines[s..e]))).collect()
}

/// The new lines of conflicted file `lines` from AI's answer to its `conflicts`: its edits made in order, or,
/// answered with no edits, the whole text when the lines around the conflicts came back as they were.
/// Err says why it can't be used, for AI to be told when asked again.
fn resolve_answer(lines: &[&str], conflicts: &[(usize, usize)], answer: &str) -> std::result::Result<Vec<String>, String> {
    let edits = parse_edits(answer)?;
    let out = if edits.is_empty() { fit_answer(lines, answer).ok_or("it has no [[FIND]] … [[END]] edit")? } else { apply_edits(lines, &edits)? };
    // Markers outside the conflicts (a page about them) stay.
    let marker = |l: &str| l.starts_with("<<<<<<<") || l.starts_with("|||||||") || l.starts_with(">>>>>>>") || l.trim_end() == "=======";
    let inside: usize = conflicts.iter().map(|&(s, e)| lines[s..e].iter().filter(|l| marker(l)).count()).sum();
    if out.iter().filter(|l| marker(l)).count() + inside > lines.iter().filter(|l| marker(l)).count() {
        return Err("conflict markers are left in the file: each conflict, from <<<<<<< to >>>>>>>, goes inside the FIND of an edit".into());
    }
    Ok(out)
}

/// Which of two `words` AI's answer picks: the one it holds. Err, for AI to be told when asked again,
/// when it holds neither or both.
fn pick_word(answer: &str, words: [&str; 2]) -> std::result::Result<usize, String> {
    let said = answer.to_lowercase();
    match (said.contains(words[0]), said.contains(words[1])) {
        (true, false) => Ok(0),
        (false, true) => Ok(1),
        _ => Err(format!("it should be one word, {} or {}, and was: {}", words[0], words[1], answer.trim())),
    }
}

/// The lines AI gave to take one conflict's place: a code fence around them dropped, none for [[NOTHING]].
/// Err, for AI to be told when asked again, when empty or still holding conflict markers.
fn conflict_answer(answer: &str) -> std::result::Result<Vec<String>, String> {
    let mut lines: Vec<&str> = answer.lines().collect();
    while lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    if lines.len() >= 2 && lines[0].trim_start().starts_with("```") && lines[lines.len() - 1].trim() == "```" {
        lines = lines[1..lines.len() - 1].to_vec();
    }
    match lines[..] {
        [] => return Err("the answer is empty: answer [[NOTHING]] when no line should stay".into()),
        [only] if only.trim() == "[[NOTHING]]" => return Ok(Vec::new()),
        _ => {}
    }
    let marker = |l: &str| l.starts_with("<<<<<<<") || l.starts_with("|||||||") || l.starts_with(">>>>>>>") || l.trim_end() == "=======";
    if lines.iter().any(|l| marker(l)) {
        return Err("conflict markers are left in it: answer with the resolved lines only".into());
    }
    Ok(lines.iter().map(|l| l.to_string()).collect())
}

/// One of AI's edits to a conflicted file: lines copied from it (FIND), and the ones that take their place (REPLACE).
type Edit<'a> = (Vec<&'a str>, Vec<&'a str>);

/// AI's edits to a conflicted file, each written as [[FIND]] lines [[REPLACE]] lines [[END]]. What's
/// around them is left out.
fn parse_edits(answer: &str) -> std::result::Result<Vec<Edit<'_>>, String> {
    let mut edits: Vec<Edit> = Vec::new();
    // 0: between edits, 1: in a FIND, 2: in a REPLACE.
    let mut part = 0;
    for l in answer.lines() {
        match (l.trim(), part) {
            ("[[FIND]]", 0) => {
                edits.push((Vec::new(), Vec::new()));
                part = 1;
            }
            ("[[REPLACE]]", 1) => part = 2,
            ("[[END]]", 2) => part = 0,
            (d @ ("[[FIND]]" | "[[REPLACE]]" | "[[END]]"), _) => return Err(format!("{d} is out of place")),
            (_, 1) => edits.last_mut().expect("open edit").0.push(l),
            (_, 2) => edits.last_mut().expect("open edit").1.push(l),
            _ => {}
        }
    }
    if part != 0 {
        return Err(format!("edit {} has no [[END]]", edits.len()));
    }
    Ok(edits)
}

/// `lines` with each edit made in turn: its FIND, found in one place of the lines as the edits before
/// left them, swapped for its REPLACE. Found as written, else whitespace aside: its REPLACE then
/// takes the file's indent.
fn apply_edits(lines: &[&str], edits: &[Edit]) -> std::result::Result<Vec<String>, String> {
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    for (n, (find, replace)) in edits.iter().enumerate() {
        let Some(k) = find.iter().position(|l| !l.trim().is_empty()) else {
            return Err(format!("the FIND of edit {} is empty", n + 1));
        };
        let at = |same: fn(&str, &str) -> bool| -> Vec<usize> { (0..(out.len() + 1).saturating_sub(find.len())).filter(|&i| find.iter().zip(&out[i..]).all(|(f, o)| same(f, o))).collect() };
        let exact = at(|f, o| f == o);
        let (found, loose) = if exact.is_empty() { (at(|f, o| f.trim() == o.trim()), true) } else { (exact, false) };
        let i = match found[..] {
            [i] => i,
            [] => return Err(format!("the FIND of edit {} (from \"{}\") is not in the file", n + 1, find[k].trim())),
            _ => return Err(format!("the FIND of edit {} (from \"{}\") matches {} places", n + 1, find[k].trim(), found.len())),
        };
        let indent = |l: &str| l.len() - l.trim_start().len();
        let (given, real) = (&find[k][..indent(find[k])], out[i + k][..indent(&out[i + k])].to_string());
        let new: Vec<String> = replace
            .iter()
            .map(|l| match l.strip_prefix(given) {
                Some(rest) if loose && !l.trim().is_empty() => format!("{real}{rest}"),
                _ => l.to_string(),
            })
            .collect();
        out.splice(i..i + find.len(), new);
    }
    Ok(out)
}

/// AI's answer with the whole text of `excerpt` (conflicts with the lines around them) cut back to it:
/// AI may add a preamble. The lines on each side of the conflicts are found in the answer (whitespace
/// aside) and kept as they were, what's between them taken.
/// None when the answer doesn't hold them: it can't be placed safely.
fn fit_answer(excerpt: &[&str], answer: &str) -> Option<Vec<String>> {
    let first = excerpt.iter().position(|l| l.starts_with("<<<<<<<"))?;
    let last = excerpt.iter().rposition(|l| l.starts_with(">>>>>>>"))?;
    let (head, tail) = (&excerpt[..first], &excerpt[last + 1..]);
    // The answer comes back trimmed: blank lines at the excerpt's ends can't be matched.
    let h = &head[head.iter().position(|l| !l.trim().is_empty()).unwrap_or(head.len())..];
    let t = &tail[..tail.iter().rposition(|l| !l.trim().is_empty()).map_or(0, |i| i + 1)];
    let a: Vec<&str> = answer.lines().collect();
    let same = |at: usize, ctx: &[&str]| ctx.iter().zip(&a[at..]).all(|(c, l)| c.trim() == l.trim());
    let from = (0..=a.len().checked_sub(h.len())?).find(|&i| same(i, h))? + h.len();
    // Last match: the resolved lines may repeat some of the context.
    let to = (from..=a.len().checked_sub(t.len())?).rev().find(|&j| same(j, t))?;
    let keep = |ls: &[&str]| ls.iter().map(|l| l.to_string()).collect::<Vec<_>>();
    Some([keep(head), keep(&a[from..to]), keep(tail)].concat())
}

#[cfg(test)]
mod fit_answer_tests {
    use super::fit_answer;

    const EXCERPT: [&str; 9] = ["fn a() {", "    one();", "<<<<<<< HEAD", "    two();", "=======", "    three();", ">>>>>>> b", "    four();", "}"];

    #[test]
    fn excerpt_answer_keeps_context_as_it_was() {
        // Trimmed answer: the first line lost its indent, the context comes back from the excerpt.
        let got = fit_answer(&EXCERPT, "fn a() {\n one();\n    two();\n    three();\n    four();\n}").unwrap();
        assert_eq!(got, ["fn a() {", "    one();", "    two();", "    three();", "    four();", "}"]);
    }

    #[test]
    fn whole_file_or_preamble_cut_back_to_the_excerpt() {
        let whole = "use x;\n\nfn a() {\n    one();\n    two();\n    three();\n    four();\n}\n\nfn b() {}";
        let want = ["fn a() {", "    one();", "    two();", "    three();", "    four();", "}"];
        assert_eq!(fit_answer(&EXCERPT, whole).unwrap(), want);
        let chatty = "Here is the resolved text:\nfn a() {\n    one();\n    two();\n    three();\n    four();\n}";
        assert_eq!(fit_answer(&EXCERPT, chatty).unwrap(), want);
    }

    #[test]
    fn answer_without_the_context_is_refused() {
        assert_eq!(fit_answer(&EXCERPT, "    two();\n    three();"), None);
        assert_eq!(fit_answer(&EXCERPT, "fn a() {\n    one();\n    two();"), None);
    }

    #[test]
    fn conflict_at_file_start_or_end() {
        let start = ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> x", "c"];
        assert_eq!(fit_answer(&start, "a\nb\nc").unwrap(), ["a", "b", "c"]);
        let end = ["", "c", "<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> x"];
        assert_eq!(fit_answer(&end, "c\na\nb").unwrap(), ["", "c", "a", "b"]);
        assert_eq!(fit_answer(&["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> x"], "ab").unwrap(), ["ab"]);
    }
}

#[cfg(test)]
mod resolve_answer_tests {
    use super::{conflict_regions, real_conflicts, resolve_answer};

    /// Every block between markers taken for a conflict.
    fn resolve(lines: &[&str], answer: &str) -> Result<Vec<String>, String> {
        resolve_answer(lines, &conflict_regions(lines, 0), answer)
    }

    /// Rebasing a branch onto a release: both declare `hidden`, the branch's line merged cleanly next
    /// to the conflicts. Resolving takes renaming it, outside the markers.
    const FILE: [&str; 22] = [
        "export function Worktrees() {",
        "  const [hidden, setHidden] = useStored<string[]>(\"gnx.worktrees.hidden\", []);",
        "",
        "  const hidden = useHidden();",
        "<<<<<<< 5647557",
        "  const all: Row[] = useMemo(() => {",
        "=======",
        "  // Worktrees a background action is taking away are gone from the click on.",
        "  const rows: Row[] = useMemo(() => {",
        ">>>>>>> 32867d5",
        "    const list = load();",
        "<<<<<<< 5647557",
        "    return list;",
        "  }, [wts.data]);",
        "  const rows = all.filter((r) => !hidden.includes(r.projectId));",
        "=======",
        "    return list.filter((r) => !hidden.has(wtKey(r.path)));",
        "  }, [wts.data, hidden]);",
        ">>>>>>> 32867d5",
        "",
        "  const cur = rows[0];",
        "}",
    ];

    #[test]
    fn edits_change_lines_outside_the_conflicts_too() {
        let answer = "[[FIND]]\n  const hidden = useHidden();\n<<<<<<< 5647557\n  const all: Row[] = useMemo(() => {\n=======\n  // Worktrees a background action is taking away are gone from the click on.\n  const rows: Row[] = useMemo(() => {\n>>>>>>> 32867d5\n[[REPLACE]]\n  const leaving = useHidden();\n  // Worktrees a background action is taking away are gone from the click on.\n  const all: Row[] = useMemo(() => {\n[[END]]\n\n[[FIND]]\n<<<<<<< 5647557\n    return list;\n  }, [wts.data]);\n  const rows = all.filter((r) => !hidden.includes(r.projectId));\n=======\n    return list.filter((r) => !hidden.has(wtKey(r.path)));\n  }, [wts.data, hidden]);\n>>>>>>> 32867d5\n[[REPLACE]]\n    return list.filter((r) => !leaving.has(wtKey(r.path)));\n  }, [wts.data, leaving]);\n  const rows = all.filter((r) => !hidden.includes(r.projectId));\n[[END]]";
        let got = resolve(&FILE, answer).unwrap();
        assert_eq!(
            got,
            [
                "export function Worktrees() {",
                "  const [hidden, setHidden] = useStored<string[]>(\"gnx.worktrees.hidden\", []);",
                "",
                "  const leaving = useHidden();",
                "  // Worktrees a background action is taking away are gone from the click on.",
                "  const all: Row[] = useMemo(() => {",
                "    const list = load();",
                "    return list.filter((r) => !leaving.has(wtKey(r.path)));",
                "  }, [wts.data, leaving]);",
                "  const rows = all.filter((r) => !hidden.includes(r.projectId));",
                "",
                "  const cur = rows[0];",
                "}",
            ]
        );
        // Far from any conflict, with a preamble and the edits fenced.
        let far = format!("Here are the edits:\n```\n[[FIND]]\nexport function Worktrees() {{\n[[REPLACE]]\nexport function Worktrees({{ initial }}: Props) {{\n[[END]]\n{}\n```", &answer);
        assert_eq!(resolve(&FILE, &far).unwrap()[0], "export function Worktrees({ initial }: Props) {");
    }

    #[test]
    fn find_whitespace_aside_takes_the_file_indent() {
        let file = ["fn a() {", "\tone();  ", "<<<<<<< HEAD", "\ttwo();", "=======", "\tthree();", ">>>>>>> b", "}"];
        let answer = "[[FIND]]\n    one();\n<<<<<<< HEAD\n    two();\n=======\n    three();\n>>>>>>> b\n[[REPLACE]]\n    one();\n    two();\n\n        three();\n[[END]]";
        assert_eq!(resolve(&file, answer).unwrap(), ["fn a() {", "\tone();", "\ttwo();", "", "\t    three();", "}"]);
    }

    #[test]
    fn whole_file_answer_still_fits() {
        let file = ["a", "<<<<<<< HEAD", "b", "=======", "c", ">>>>>>> x", "d"];
        assert_eq!(resolve(&file, "a\nb\nc\nd").unwrap(), ["a", "b", "c", "d"]);
    }

    #[test]
    fn markers_outside_the_conflicts_stay() {
        let doc = ["```", "<<<<<<< HEAD", "```", "<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> x"];
        let answer = "[[FIND]]\n```\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n[[REPLACE]]\n```\na b\n[[END]]";
        assert_eq!(resolve(&doc, answer).unwrap(), ["```", "<<<<<<< HEAD", "```", "a b"]);
    }

    #[test]
    fn markers_a_side_already_holds_are_text() {
        let side = "```\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n```\n- Pull first.\n- Rebase often.\n";
        let doc = ["```", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feature", "```", "- Pull first.", "<<<<<<< HEAD", "- Rebase often.", "=======", "- Commit small.", ">>>>>>> 1a2b3c4 (docs: commit small)"];
        let conflicts = real_conflicts(&doc, &[side.to_string()]);
        assert_eq!(conflicts, [(8, 13)]);
        let answer = "[[FIND]]\n<<<<<<< HEAD\n- Rebase often.\n=======\n- Commit small.\n>>>>>>> 1a2b3c4 (docs: commit small)\n[[REPLACE]]\n- Rebase often.\n- Commit small.\n[[END]]";
        let want: Vec<&str> = [&doc[..8], &["- Rebase often.", "- Commit small."]].concat();
        assert_eq!(resolve_answer(&doc, &conflicts, answer).unwrap(), want);
        // Taken for a conflict, the example would have to go.
        assert!(resolve(&doc, answer).is_err());
    }

    #[test]
    fn unusable_answers_say_why() {
        let why = |answer: &str| resolve(&FILE, answer).unwrap_err();
        assert!(why("[[FIND]]\n  const nope = 1;\n[[REPLACE]]\n[[END]]").contains("the FIND of edit 1 (from \"const nope = 1;\") is not in the file"));
        assert!(why("[[FIND]]\n\n[[REPLACE]]\nx\n[[END]]").contains("the FIND of edit 1 is empty"));
        assert!(why("[[FIND]]\n  }, [wts.data, hidden]);\n[[REPLACE]]\n[[END]]\n[[FIND]]\n\n[[REPLACE]]\n[[END]]").contains("edit 2"));
        assert!(why("[[FIND]]\n\n  const cur = rows[0];\n[[REPLACE]]\n[[END]]").contains("conflict markers are left"));
        assert!(why("[[FIND]]\n  const cur = rows[0];\n[[REPLACE]]\n  const cur = rows[1];").contains("edit 1 has no [[END]]"));
        assert!(why("[[FIND]]\n  const cur = rows[0];\n[[FIND]]").contains("[[FIND]] is out of place"));
        assert!(why("Resolved: I kept both.").contains("it has no [[FIND]]"));
        let twice = ["x();", "<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> y", "x();"];
        assert!(resolve(&twice, "[[FIND]]\nx();\n[[REPLACE]]\nz();\n[[END]]").unwrap_err().contains("matches 2 places"));
    }
}

#[cfg(test)]
mod conflict_regions_tests {
    use super::conflict_regions;

    #[test]
    fn each_conflict_with_its_context_and_close_ones_merged() {
        let mut lines = vec!["x"; 40];
        lines[5] = "<<<<<<< HEAD";
        lines[7] = ">>>>>>> b";
        lines[10] = "<<<<<<< HEAD";
        lines[12] = ">>>>>>> b";
        lines[30] = "<<<<<<< HEAD";
        lines[32] = ">>>>>>> b";
        assert_eq!(conflict_regions(&lines, 2), vec![(3, 15), (28, 35)]);
        assert_eq!(conflict_regions(&lines, 10), vec![(0, 40)]);
        assert!(conflict_regions(&["a", "b"], 10).is_empty());
    }
}
