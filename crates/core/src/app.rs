//! `Gitnetix`: the one service every front end talks to (Tauri window,
//! companion HTTP API for mobile, MCP bridge). All behaviour lives here;
//! `rpc` only maps method names onto these calls.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, OnceCell};

use crate::agents::{AgentManager, AgentSession, AgentStatus, StartArgs};
use crate::ai::{self, Resolved};
use crate::error::{Error, Result};
use crate::events::Event;
use crate::git::{BranchInfo, Commit, FileChange, Git, Hunk, Identity, WorktreeInfo};
use crate::providers::{github::GitHub, parse_remote};
use crate::secrets;
use crate::store::{new_id, now, BranchMeta, GitProfile, Project, Release, ReleaseKind, Store};
use crate::templates::{self, Template};
use crate::tickets::{self, Ticket};

pub struct Gitnetix {
    pub store: Store,
    pub agents: AgentManager,
    pub events: broadcast::Sender<Event>,
    pub dir: PathBuf,
}

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchView {
    pub name: String,
    pub kind: String,
    pub short: String,
    pub worktree: Option<String>,
    pub checked_out: bool,
    pub running: bool,
    pub conflict: bool,
    /// Files with uncommitted changes in its checkout (0 when not checked out).
    pub wip: u32,
    /// Commits not yet in the base (release, or default branch).
    pub ahead: u32,
    /// Commits in the base the branch does not have.
    pub behind: u32,
    pub upstream: Option<String>,
    pub upstream_ahead: u32,
    pub upstream_behind: u32,
    pub ticket: Option<String>,
    /// Exists locally or on origin (false: Gitnetix still tracks it but it is gone).
    pub exists: bool,
    /// Its commits are all in the base (merged, nothing new since).
    pub merged: bool,
    /// Branch it merges into; None for the default branch.
    pub parent: Option<String>,
    /// trunk (default or dev branch) | release (open release branch) | branch
    pub role: String,
    /// Open release it ships in (a release branch: its own version).
    pub release: Option<String>,
    /// Version this release branch shipped as (role "branch" once shipped).
    pub shipped: Option<String>,
    pub local: bool,
    /// Exists on origin.
    pub remote: bool,
    /// Date of its last commit (ISO 8601).
    pub date: String,
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
    pub items: Vec<BranchView>,
    pub note: String,
    /// The release branch itself (open releases only).
    pub view: Option<BranchView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub project: Project,
    pub current_branch: Option<String>,
    pub default_branch: String,
    pub releases: Vec<ReleaseView>,
    /// Branches no release claims (excluding default and release/*).
    pub other_branches: Vec<BranchView>,
    /// The default branch itself (tracking state for pull/push).
    pub default_view: Option<BranchView>,
    /// Every branch (local, origin-only and tracked-but-gone), each with its parent.
    pub branches: Vec<BranchView>,
    pub rebasing: bool,
    pub conflicts: Vec<String>,
    pub remote: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub sha: String,
    pub message: String,
    pub ai_written: bool,
}

#[derive(Debug, Clone, Serialize)]
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
    pub agent: Option<AgentSession>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketView {
    #[serde(flatten)]
    pub ticket: Ticket,
    pub release: String,
    pub branch: Option<String>,
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
    pub kind: String,
    pub description: String,
    pub branch_name: Option<String>,
    pub ticket: Option<String>,
    /// switch | worktree
    pub r#where: String,
    pub start_agent: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewItemResult {
    pub branch: String,
    pub worktree: Option<String>,
    pub agent_session: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub into: String,
    /// Tip of `into` after the merge.
    pub sha: String,
    pub already_merged: bool,
    pub deleted: bool,
    /// The main checkout was on the deleted branch and moved to `into`.
    pub switched: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct NotesInclude {
    pub feat: bool,
    pub fix: bool,
    pub internal: bool,
    pub tickets: bool,
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

fn valid_branch_name(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && !s.contains("..")
        && !s.ends_with('/')
        && !s.ends_with(".lock")
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
}

fn release_branch(version: &str) -> String {
    format!("release/{}", version.trim_start_matches('v'))
}

/// Register `release/x.y.z` branches Gitnetix does not know yet. Returns whether any were added.
fn import_release_branches(p: &mut Project, branches: &[BranchInfo], default: &str) -> bool {
    let mut added = false;
    for b in branches {
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

/// Long-lived integration branches that sit under the default branch.
const DEV_TRUNKS: &[&str] = &["develop", "dev", "development"];

/// Long-lived branches that are never work: dev branches, and `main`/`master`
/// when the default branch is something else (gitflow).
fn is_trunk(name: &str) -> bool {
    DEV_TRUNKS.contains(&name) || matches!(name, "main" | "master")
}

/// Local and origin branches, looked up by name, plus what recent merge commits say.
struct Refs {
    local: Vec<BranchInfo>,
    remote: Vec<BranchInfo>,
    /// Merge commit subject, keyed by the tip it merged in; read on first use (a long history walk).
    merges: OnceCell<HashMap<String, String>>,
}

impl Refs {
    async fn load(git: &Git, local: Vec<BranchInfo>) -> Refs {
        Refs { local, remote: git.remote_branches().await.unwrap_or_default(), merges: OnceCell::new() }
    }

    /// Branch a merge commit of `name` says it went into (`Merge branch 'name' into y`);
    /// git leaves out "into" for the default branch. The subject must name this branch:
    /// another branch sitting on the same commit was not the one merged.
    async fn merged_into(&self, git: &Git, name: &str, default: &str) -> Option<String> {
        let sha = &self.local(name).or_else(|| self.remote(name))?.sha;
        let merges = self.merges.get_or_init(|| async { git.merge_subjects(5000).await.unwrap_or_default() }).await;
        let subject = merges.get(sha)?;
        let rest = subject.strip_prefix("Merge branch '").or_else(|| subject.strip_prefix("Merge remote-tracking branch '"))?;
        let (merged, tail) = rest.split_once('\'')?;
        if merged != name && merged.strip_prefix("origin/") != Some(name) {
            return None;
        }
        Some(tail.rsplit_once(" into ").map(|(_, t)| t.trim().to_string()).unwrap_or_else(|| default.to_string()))
    }

    fn local(&self, name: &str) -> Option<&BranchInfo> {
        self.local.iter().find(|b| b.name == name)
    }

    fn remote(&self, name: &str) -> Option<&BranchInfo> {
        self.remote.iter().find(|b| b.name == name)
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

/// Branches work can merge into, most specific first: open releases, dev branches, the default branch.
fn merge_targets(p: &Project, refs: &Refs, default: &str) -> Vec<String> {
    let mut t: Vec<String> = p.releases.iter().filter(|r| r.shipped_at.is_none() && refs.rev(&r.branch).is_some()).map(|r| r.branch.clone()).collect();
    t.extend(DEV_TRUNKS.iter().filter(|d| **d != default && refs.rev(d).is_some()).map(|d| d.to_string()));
    t.push(default.to_string());
    t
}

impl Gitnetix {
    pub fn open(dir: &Path) -> Result<Arc<Gitnetix>> {
        let store = Store::open(dir)?;
        let (events, _) = broadcast::channel(1024);
        let agents = AgentManager::new(events.clone(), dir);
        Ok(Arc::new(Gitnetix { store, agents, events, dir: dir.to_path_buf() }))
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

    fn identity(&self, p: &Project) -> Option<Identity> {
        let pid = p.profile_id.as_ref()?;
        let prof: GitProfile = self.store.read(|c| c.profiles.iter().find(|x| &x.id == pid).cloned())?;
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

    fn git_at(&self, p: &Project, cwd: &Path) -> Git {
        let g = Git::new(cwd);
        match self.identity(p) {
            Some(id) => g.with_identity(&id),
            None => g,
        }
    }

    fn git(&self, p: &Project) -> Git {
        self.git_at(p, Path::new(&p.path))
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
        Ok(self.git_at(p, &dir))
    }

    /// Branch `branch` merges into (rebases onto, diffs against); the default branch maps to itself.
    async fn base_of(&self, p: &Project, branch: &str, default: &str) -> String {
        let git = self.git(p);
        let refs = Refs::load(&git, git.branches().await.unwrap_or_default()).await;
        self.base_in(p, &git, &refs, branch, default).await
    }

    /// `base_of` with the refs already loaded.
    async fn base_in(&self, p: &Project, git: &Git, refs: &Refs, branch: &str, default: &str) -> String {
        self.parent_of(p, git, refs, default, branch).await.unwrap_or_else(|| default.to_string())
    }

    /// The branch `name` merges into: an open release branch's base, the release
    /// it is attached to, the parent it was given, else the closest target by
    /// history (fewest commits of its own, then fewest missing). None for the default branch.
    async fn parent_of(&self, p: &Project, git: &Git, refs: &Refs, default: &str, name: &str) -> Option<String> {
        if name == default {
            return None;
        }
        // Release branches, open or shipped, sit under the branch they were cut from.
        if let Some(r) = p.releases.iter().find(|r| r.branch == name) {
            return Some(r.base.clone());
        }
        if name.starts_with("release/") || is_trunk(name) {
            return Some(default.to_string());
        }
        if let Some(m) = p.branches.get(name) {
            // Its release, while open, or shipped as long as the release branch is still around.
            if let Some(r) = m.release.as_ref().and_then(|v| p.releases.iter().find(|r| &r.version == v)) {
                if r.shipped_at.is_none() || refs.rev(&r.branch).is_some() {
                    return Some(r.branch.clone());
                }
            }
            if let Some(parent) = m.parent.as_ref().filter(|x| *x != name && refs.rev(x).is_some()) {
                return Some(parent.clone());
            }
        }
        // Merged by hand: the merge commit names where it went.
        if let Some(t) = refs.merged_into(git, name, default).await.filter(|t| t != name && refs.rev(t).is_some()) {
            return Some(t);
        }
        let (Some(rev), targets) = (refs.rev(name), merge_targets(p, refs, default)) else {
            return Some(default.to_string());
        };
        let mut best: Option<((u32, u32, usize), String)> = None;
        if targets.len() > 1 {
            for (i, t) in targets.into_iter().enumerate().filter(|(_, t)| t != name) {
                let Some(trev) = refs.rev(&t) else { continue };
                let Ok((behind, ahead)) = git.left_right(&trev, &rev).await else { continue };
                // On a tie, work in progress belongs to the most specific target; a branch that
                // already landed everywhere belongs to the most upstream one (shipped to main).
                let key = (ahead, behind, if ahead == 0 { usize::MAX - i } else { i });
                if best.as_ref().is_none_or(|(k, _)| key < *k) {
                    best = Some((key, t));
                }
            }
        }
        Some(best.map(|(_, t)| t).unwrap_or_else(|| default.to_string()))
    }

    fn template(&self, kind: &str, id: Option<&str>, project_id: Option<&str>) -> Result<Template> {
        self.store.read(|c| {
            let ok_scope = |t: &&Template| t.scope == "all" || Some(t.scope.as_str()) == project_id;
            if let Some(id) = id {
                return c.templates.iter().find(|t| t.id == id).cloned();
            }
            c.templates
                .iter()
                .filter(|t| t.kind == kind)
                .filter(ok_scope)
                .find(|t| t.is_default)
                .or_else(|| c.templates.iter().filter(|t| t.kind == kind).find(ok_scope))
                .cloned()
        })
        .ok_or_else(|| Error::NotFound(format!("{kind} template")))
    }

    fn route(&self, task: &str, t: Option<&Template>) -> Result<Resolved> {
        self.store.read(|c| ai::resolve(&c.ai, task, t.and_then(|t| t.model.as_deref())))
    }

    async fn ask(&self, task: &str, t: &Template, vars: BTreeMap<String, String>, lang: &str, cwd: Option<&Path>) -> Result<String> {
        let r = self.route(task, Some(t))?;
        let prompt = templates::render(t, &vars, lang);
        ai::complete(&r, &prompt, cwd).await
    }

    // ---------- projects ----------

    pub async fn projects(&self) -> Vec<ProjectSummary> {
        let agents = self.agents.list();
        self.store.read(|c| {
            c.projects
                .iter()
                .map(|p| ProjectSummary {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    path: p.path.clone(),
                    exists: Path::new(&p.path).exists(),
                    next_release: p.releases.iter().find(|r| r.shipped_at.is_none() && r.kind == ReleaseKind::Next).map(|r| r.version.clone()),
                    running_agents: agents.iter().filter(|a| a.project_id == p.id && a.status == AgentStatus::Running).count(),
                    hidden: p.hidden,
                })
                .collect()
        })
    }

    pub async fn add_projects(&self, paths: Vec<String>) -> Result<Vec<Project>> {
        let mut added = Vec::new();
        for raw in paths {
            let expanded = if let Some(rest) = raw.strip_prefix("~/") {
                dirs::home_dir().map(|h| h.join(rest)).unwrap_or_else(|| PathBuf::from(&raw))
            } else {
                PathBuf::from(&raw)
            };
            let top = Git::new(&expanded)
                .toplevel()
                .await
                .map_err(|_| Error::Invalid(format!("{} is not a Git repository", expanded.display())))?;
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
            let mut project = Project { id: new_id(), name, path, added_at: now(), ..Default::default() };
            project.profile_id = self.store.read(|c| c.profiles.first().map(|p| p.id.clone()));
            self.import_release_branches(&mut project).await;
            self.store.write(|c| {
                c.projects.push(project.clone());
                Ok(())
            })?;
            added.push(project);
        }
        self.config_changed();
        Ok(added)
    }

    /// Pick up existing `release/x.y.z` branches on first open.
    async fn import_release_branches(&self, p: &mut Project) {
        let git = Git::new(&p.path);
        let default = git.default_branch().await.unwrap_or_else(|_| "main".into());
        let branches = git.branches().await.unwrap_or_default();
        import_release_branches(p, &branches, &default);
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
        self.config_changed();
        Ok(())
    }

    // ---------- workspace ----------

    pub async fn overview(&self, project_id: &str) -> Result<Overview> {
        let mut p = self.store.project(project_id)?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let current = git.current_branch().await?;
        let branches = git.branches().await?;
        // Release branches created outside Gitnetix (or after the project was added).
        if import_release_branches(&mut p.clone(), &branches, &default) {
            p = self.store.with_project(project_id, |p| {
                import_release_branches(p, &branches, &default);
                Ok(p.clone())
            })?;
        }
        let wts = git.worktrees().await?;
        let agents = self.agents.list();
        let rebasing = git.is_rebasing().await.unwrap_or(false);
        let conflicts = if rebasing { git.conflicted_files().await.unwrap_or_default() } else { Vec::new() };

        let refs = Refs::load(&git, branches).await;
        let open: Vec<&Release> = p.releases.iter().filter(|r| r.shipped_at.is_none()).collect();
        // Every branch once: local, origin-only, and the ones Gitnetix tracks that are gone.
        // An origin branch a local one tracks under another name is that local branch.
        let tracked: Vec<&str> = refs.local.iter().filter_map(|b| b.upstream.as_deref()?.strip_prefix("origin/")).collect();
        let remote_only = refs.remote.iter().filter(|b| !tracked.contains(&b.name.as_str()));
        let mut names: Vec<String> = refs.local.iter().chain(remote_only).map(|b| b.name.clone()).collect();
        names.extend(p.branches.keys().cloned());
        names.extend(open.iter().map(|r| r.branch.clone()));
        names.sort();
        names.dedup();
        // A few git calls per branch: run several branches at once, keeping the order.
        let (pr, g, r, d, w, a) = (&p, &git, &refs, default.as_str(), wts.as_slice(), agents.as_slice());
        let all: Vec<BranchView> = stream::iter(names)
            .map(|n| async move {
                let parent = self.parent_of(pr, g, r, d, &n).await;
                self.branch_view(pr, g, r, &n, parent, w, a).await
            })
            .buffered(8)
            .collect()
            .await;
        let find = |n: &str| all.iter().find(|b| b.name == n).cloned();

        let mut releases = Vec::new();
        for r in &open {
            let items = all.iter().filter(|b| p.branches.get(&b.name).and_then(|m| m.release.as_deref()) == Some(r.version.as_str())).cloned().collect();
            releases.push(ReleaseView {
                version: r.version.clone(),
                tag: match r.kind {
                    ReleaseKind::Next => "next".into(),
                    ReleaseKind::Hotfix => "hotfix".into(),
                },
                branch: r.branch.clone(),
                base: r.branch.clone(),
                open: true,
                items,
                note: String::new(),
                view: find(&r.branch),
            });
        }
        // Last shipped releases, from tags.
        for t in git.tags().await.unwrap_or_default().into_iter().take(3) {
            let v = t.name.trim_start_matches('v').to_string();
            let shipped = p.branches.values().filter(|m| m.release.as_deref() == Some(v.as_str())).count();
            let date = t.date.get(..10).unwrap_or("").to_string();
            releases.push(ReleaseView {
                branch: p.releases.iter().find(|r| r.version == v).map(|r| r.branch.clone()).unwrap_or_default(),
                version: v,
                tag: "released".into(),
                base: format!("{default} · tagged {date}"),
                open: false,
                items: vec![],
                view: None,
                note: if shipped > 0 { format!("{shipped} branches shipped") } else { String::new() },
            });
        }
        let other_branches = all
            .iter()
            .filter(|b| b.local && b.name != default && !p.releases.iter().any(|r| r.branch == b.name) && !p.branches.contains_key(&b.name))
            .cloned()
            .collect();
        let default_view = find(&default);
        let remote = git.remote_url("origin").await.ok().flatten();
        Ok(Overview { project: p, current_branch: current, default_branch: default, releases, other_branches, default_view, branches: all, rebasing, conflicts, remote })
    }

    #[allow(clippy::too_many_arguments)]
    async fn branch_view(&self, p: &Project, git: &Git, refs: &Refs, name: &str, parent: Option<String>, wts: &[WorktreeInfo], agents: &[AgentSession]) -> BranchView {
        let wt = wts.iter().find(|w| w.branch.as_deref() == Some(name));
        let info = refs.local(name);
        let rev = refs.rev(name);
        let base_rev = parent.as_deref().and_then(|b| refs.rev(b));
        let (behind, ahead) = match (&rev, &base_rev) {
            (Some(r), Some(b)) => git.left_right(b, r).await.unwrap_or((0, 0)),
            _ => (0, 0),
        };
        let upstream = info.and_then(|b| b.upstream.clone());
        let (upstream_ahead, upstream_behind) = match &upstream {
            Some(u) if git.ref_exists(&format!("refs/remotes/{u}")).await.unwrap_or(false) => git.left_right(name, u).await.unwrap_or((0, 0)),
            _ => (0, 0),
        };
        let (conflict, wip) = match wt {
            Some(w) => {
                let g = Git::new(&w.path);
                let conflict = g.is_rebasing().await.unwrap_or(false) && !g.conflicted_files().await.unwrap_or_default().is_empty();
                (conflict, g.wip_count().await.unwrap_or(0))
            }
            None => (false, 0),
        };
        let own_release = p.releases.iter().find(|r| r.branch == name);
        let role = if own_release.is_some_and(|r| r.shipped_at.is_none()) {
            "release"
        } else if parent.is_none() || is_trunk(name) {
            "trunk"
        } else {
            "branch"
        };
        // Trunks and open releases live on; only work gets merged away.
        let merged = match (&rev, &base_rev) {
            (Some(r), Some(b)) if ahead == 0 && role == "branch" => {
                // Origin-only branches have no creation reflog: fully contained and left behind counts.
                git.is_merged_into(r, b).await.unwrap_or(false) || (info.is_none() && behind > 0)
            }
            _ => false,
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
            worktree: wt.filter(|w| !w.main).map(|w| w.path.clone()),
            checked_out: wt.is_some(),
            running: agents.iter().any(|a| a.branch == name && a.project_id == p.id && a.status == AgentStatus::Running),
            conflict,
            wip,
            ahead,
            behind,
            upstream,
            upstream_ahead,
            upstream_behind,
            ticket: meta.and_then(|m| m.ticket.clone()),
            exists: rev.is_some(),
            merged,
            parent,
            role: role.into(),
            release: own_release.filter(|r| r.shipped_at.is_none()).map(|r| r.version.clone()).or_else(|| meta.and_then(|m| m.release.clone()).filter(|v| open_release(v))),
            shipped: own_release.filter(|r| r.shipped_at.is_some()).map(|r| r.version.clone()),
            local: info.is_some(),
            remote: refs.remote(name).is_some(),
            date: info.or_else(|| refs.remote(name)).map(|b| b.date.clone()).unwrap_or_default(),
        }
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
                    .map(|path| known.remove(&path).unwrap_or(FileChange { path, status: ' ', additions: 0, deletions: 0, staged: None }))
                    .collect();
                all.extend(known.into_values());
                all.sort_by(|a, b| a.path.cmp(&b.path));
                Ok(all)
            }
        }
    }

    /// `staged` picks the side of a WIP file (None = working tree vs HEAD).
    pub async fn diff(&self, project_id: &str, branch: &str, mode: ViewMode, path: &str, staged: Option<bool>) -> Result<Vec<Hunk>> {
        let p = self.store.project(project_id)?;
        if let (ViewMode::Wip, Some(staged)) = (mode, staged) {
            return match self.checkout_dir(&p, branch).await? {
                Some(dir) => Git::new(dir).file_diff_side(path, staged).await,
                None => Ok(Vec::new()),
            };
        }
        if mode != ViewMode::Branch {
            match self.checkout_dir(&p, branch).await? {
                Some(dir) => {
                    let wip = Git::new(&dir).file_diff(path, None).await?;
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
        git.file_diff(path, Some(&format!("{base_rev}...{rev}"))).await
    }

    /// Commits a branch has that its base does not, newest first; a trunk lists its recent history.
    pub async fn commits(&self, project_id: &str, branch: &str) -> Result<Vec<Commit>> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let base = self.base_of(&p, branch, &default).await;
        let (base_rev, rev) = tokio::join!(git.rev_of(&base), git.rev_of(branch));
        if base == branch {
            return git.log(&rev, Some(200)).await;
        }
        git.log(&format!("{base_rev}..{rev}"), Some(500)).await
    }

    /// Files one commit changed, against its first parent.
    pub async fn commit_files(&self, project_id: &str, sha: &str) -> Result<Vec<FileChange>> {
        let git = self.git(&self.store.project(project_id)?);
        git.range_changes(&git.commit_range(check_sha(sha)?).await?).await
    }

    pub async fn commit_diff(&self, project_id: &str, sha: &str, path: &str) -> Result<Vec<Hunk>> {
        let git = self.git(&self.store.project(project_id)?);
        git.file_diff(path, Some(&git.commit_range(check_sha(sha)?).await?)).await
    }

    /// Revert one commit of `branch` with a new commit on it.
    pub async fn revert_commit(&self, project_id: &str, branch: &str, sha: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let out = self.require_checkout(&p, branch).await?.revert(check_sha(sha)?).await;
        self.changed(project_id);
        out
    }

    /// Copy one commit onto `onto`.
    pub async fn cherry_pick(&self, project_id: &str, onto: &str, sha: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let out = self.require_checkout(&p, onto).await?.cherry_pick(check_sha(sha)?).await;
        self.changed(project_id);
        out
    }

    /// Move `branch` to one of its commits: soft keeps the changes staged, mixed unstaged, hard drops them.
    pub async fn reset_branch(&self, project_id: &str, branch: &str, sha: &str, mode: &str) -> Result<()> {
        let p = self.store.project(project_id)?;
        self.require_checkout(&p, branch).await?.reset(check_sha(sha)?, mode).await?;
        self.changed(project_id);
        Ok(())
    }

    pub async fn switch_branch(&self, project_id: &str, branch: &str) -> Result<()> {
        let p = self.store.project(project_id)?;
        if let Some(dir) = self.checkout_dir(&p, branch).await? {
            if dir != Path::new(&p.path) {
                return Err(Error::Invalid(format!("{branch} is open in a worktree at {}", dir.display())));
            }
            return Ok(());
        }
        self.git(&p).switch(branch).await?;
        self.changed(project_id);
        Ok(())
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
        self.require_checkout(&p, branch).await?.stage(paths).await?;
        self.changed(project_id);
        Ok(())
    }

    /// Unstage `paths` (all when empty), keeping the working tree.
    pub async fn unstage(&self, project_id: &str, branch: &str, paths: &[String]) -> Result<()> {
        let p = self.store.project(project_id)?;
        self.require_checkout(&p, branch).await?.unstage(paths).await?;
        self.changed(project_id);
        Ok(())
    }

    /// Throw away one side of the uncommitted work for `paths` (every file on that side when empty).
    pub async fn discard(&self, project_id: &str, branch: &str, staged: bool, paths: &[String]) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        let paths: Vec<String> = if paths.is_empty() {
            git.wip_split().await?.into_iter().filter(|f| f.staged == Some(staged)).map(|f| f.path).collect()
        } else {
            paths.to_vec()
        };
        if staged {
            git.discard_staged(&paths).await?;
        } else {
            git.discard_unstaged(&paths).await?;
        }
        self.changed(project_id);
        Ok(())
    }

    /// AI commit message for what is staged.
    pub async fn generate_commit_message(&self, project_id: &str, branch: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = self.staged_checkout(&p, branch, false).await?;
        self.commit_message_for(&p, &git, branch).await
    }

    async fn commit_message_for(&self, p: &Project, git: &Git, branch: &str) -> Result<String> {
        let t = self.template("commit", None, Some(&p.id))?;
        let diff = git.staged_diff(60_000).await?;
        let files = git.run(&["diff", "--cached", "--name-status"]).await?;
        let ticket = p.branches.get(branch).and_then(|m| m.ticket.clone()).unwrap_or_default();
        let mut vars = BTreeMap::new();
        vars.insert("diff".into(), diff);
        vars.insert("files".into(), files);
        vars.insert("branch".into(), branch.to_string());
        vars.insert("ticket".into(), if ticket.is_empty() { "(none)".into() } else { ticket });
        self.ask("commit", &t, vars, &p.gen_lang.commit, Some(git.cwd())).await
    }

    /// Commit what is staged (`all` stages everything first). An empty message is written by AI.
    pub async fn commit(&self, project_id: &str, branch: &str, message: Option<String>, all: bool) -> Result<CommitResult> {
        let p = self.store.project(project_id)?;
        let git = self.staged_checkout(&p, branch, all).await?;
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

    pub async fn push(&self, project_id: &str, branch: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = match self.checkout_dir(&p, branch).await? {
            Some(d) => self.git_at(&p, &d),
            None => self.git(&p),
        };
        let has_upstream = git.ref_exists(&format!("refs/remotes/origin/{branch}")).await?;
        let out = git.push(branch, !has_upstream).await?;
        self.changed(project_id);
        Ok(out)
    }

    /// Rebase a branch onto its release. Returns conflicted files (empty = done).
    pub async fn rebase(&self, project_id: &str, branch: &str) -> Result<Vec<String>> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        let default = git.default_branch().await?;
        let base = self.base_of(&p, branch, &default).await;
        let ok = git.rebase(&git.rev_of(&base).await).await?;
        self.changed(project_id);
        if ok {
            Ok(Vec::new())
        } else {
            git.conflicted_files().await
        }
    }

    pub async fn rebase_continue(&self, project_id: &str, branch: &str) -> Result<Vec<String>> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        let ok = git.rebase_continue().await?;
        self.changed(project_id);
        if ok {
            Ok(Vec::new())
        } else {
            git.conflicted_files().await
        }
    }

    pub async fn rebase_abort(&self, project_id: &str, branch: &str) -> Result<()> {
        let p = self.store.project(project_id)?;
        self.require_checkout(&p, branch).await?.rebase_abort().await?;
        self.changed(project_id);
        Ok(())
    }

    pub async fn conflict_propose(&self, project_id: &str, branch: &str, path: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        let content = std::fs::read_to_string(git.cwd().join(path))?;
        let default = git.default_branch().await?;
        let t = self.template("conflict", None, Some(&p.id))?;
        let mut vars = BTreeMap::new();
        vars.insert("conflict".into(), content);
        vars.insert("path".into(), path.to_string());
        vars.insert("ours".into(), branch.to_string());
        vars.insert("theirs".into(), self.base_of(&p, branch, &default).await);
        let out = self.ask("conflict", &t, vars, "en", Some(git.cwd())).await?;
        if out.contains("<<<<<<<") || out.contains(">>>>>>>") {
            return Err(Error::Ai("The AI answer still has conflict markers. Try again or resolve by hand.".into()));
        }
        Ok(out)
    }

    pub async fn conflict_apply(&self, project_id: &str, branch: &str, path: &str, content: &str) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        let mut body = content.to_string();
        if !body.ends_with('\n') {
            body.push('\n');
        }
        std::fs::write(git.cwd().join(path), body)?;
        git.add(path).await?;
        self.changed(project_id);
        Ok(())
    }

    // ---------- releases ----------

    pub async fn create_release(&self, project_id: &str, version: &str, kind: ReleaseKind, from: Option<String>) -> Result<Release> {
        let version = version.trim().trim_start_matches('v').to_string();
        if version.is_empty() || !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
            return Err(Error::Invalid("Version like 2.4.0".into()));
        }
        let p = self.store.project(project_id)?;
        if p.releases.iter().any(|r| r.version == version && r.shipped_at.is_none()) {
            return Err(Error::Invalid(format!("v{version} already exists")));
        }
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let from = match from.filter(|s| !s.is_empty()) {
            Some(f) => f,
            None if kind == ReleaseKind::Hotfix => git.tags().await?.first().map(|t| t.name.clone()).unwrap_or(default.clone()),
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
        self.changed(project_id);
        Ok(r)
    }

    /// Ship: move the default branch to the release (fast-forward only),
    /// tag it, optionally push both.
    pub async fn ship_release(&self, project_id: &str, version: &str, push: bool) -> Result<String> {
        let p = self.store.project(project_id)?;
        let r = p
            .releases
            .iter()
            .find(|r| r.version == version && r.shipped_at.is_none())
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("open release v{version}")))?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        if !git.is_ancestor(&default, &r.branch).await? {
            return Err(Error::Invalid(format!(
                "{default} has commits that are not in {}. Merge {default} into the release first.",
                r.branch
            )));
        }
        let sha = git.rev_parse(&r.branch).await?;
        match self.checkout_dir(&p, &default).await? {
            Some(dir) => {
                let g = Git::new(&dir);
                if !g.wip_changes().await?.is_empty() {
                    return Err(Error::Invalid(format!("{default} has uncommitted changes at {}", dir.display())));
                }
                g.merge_ff_only(&r.branch).await?;
            }
            None => git.update_ref(&format!("refs/heads/{default}"), &sha).await?,
        }
        let tag = format!("v{version}");
        git.tag(&tag, &sha, &format!("Release {tag}")).await?;
        if push {
            git.push(&default, false).await?;
            git.push_tag(&tag).await?;
        }
        self.store.with_project(project_id, |p| {
            if let Some(x) = p.releases.iter_mut().find(|x| x.version == version && x.shipped_at.is_none()) {
                x.shipped_at = Some(now());
                x.tag = Some(tag.clone());
            }
            Ok(())
        })?;
        self.changed(project_id);
        Ok(tag)
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

    pub async fn suggest_branch_name(&self, project_id: &str, kind: &str, description: &str, ticket: Option<&str>) -> Result<(String, bool)> {
        let p = self.store.project(project_id)?;
        let t = self.template("branch", None, Some(&p.id))?;
        let max_words = templates::rule_num(&t, "maxWords").unwrap_or(4) as usize;
        let fallback = || {
            let mut slug = slugify(description, max_words);
            if templates::rule_bool(&t, "ticketPrefix") {
                if let Some(k) = ticket.filter(|k| !k.is_empty()) {
                    slug = format!("{}-{slug}", k.to_lowercase());
                }
            }
            format!("{kind}/{slug}")
        };
        let mut vars = BTreeMap::new();
        vars.insert("description".into(), description.to_string());
        vars.insert("type".into(), kind.to_string());
        vars.insert("ticket".into(), ticket.unwrap_or("").to_string());
        match self.ask("branch", &t, vars, "en", Some(Path::new(&p.path))).await {
            Ok(name) => {
                let name = name.lines().next().unwrap_or("").trim().trim_matches('`').to_string();
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
        let git = self.git(&p);
        let release = match req.release.trim() {
            "" => None,
            v => Some(
                p.releases
                    .iter()
                    .find(|r| r.version == v && r.shipped_at.is_none())
                    .cloned()
                    .ok_or_else(|| Error::NotFound(format!("open release v{v}")))?,
            ),
        };
        // Without a release, the branch starts from (and later merges into) `from`.
        let start = match &release {
            Some(r) => r.branch.clone(),
            None => match req.from.clone().filter(|f| !f.trim().is_empty()) {
                Some(f) => git.branch_rev(&f).await?.ok_or_else(|| Error::NotFound(format!("branch {f}")))?,
                None => git.default_branch().await?,
            },
        };
        let kind = normalize_kind(&req.kind).unwrap_or("feat");
        let branch = match req.branch_name.clone().filter(|s| !s.trim().is_empty()) {
            Some(b) if b.contains('/') => b.trim().to_string(),
            Some(b) => format!("{kind}/{}", b.trim()),
            None => self.suggest_branch_name(project_id, kind, &req.description, req.ticket.as_deref()).await?.0,
        };
        if !valid_branch_name(&branch) {
            return Err(Error::Invalid(format!("“{branch}” is not a valid branch name")));
        }
        if git.ref_exists(&format!("refs/heads/{branch}")).await? {
            return Err(Error::Invalid(format!("{branch} already exists")));
        }
        let mut worktree = None;
        let cwd = if req.r#where == "worktree" {
            let path = worktree_path(&p, &branch);
            git.worktree_add(&path, &branch, Some(&start)).await?;
            worktree = Some(path.to_string_lossy().to_string());
            path
        } else {
            git.switch_create(&branch, &start).await?;
            top_path(&p)
        };
        let meta = BranchMeta {
            kind: kind.into(),
            release: release.as_ref().map(|r| r.version.clone()),
            parent: release.is_none().then(|| start.trim_start_matches("origin/").to_string()),
            ticket: req.ticket.clone().filter(|t| !t.is_empty()),
            worktree: worktree.clone(),
            description: Some(req.description.clone()),
            created_at: now(),
        };
        self.store.with_project(project_id, |p| {
            p.branches.insert(branch.clone(), meta);
            if let (Some(t), Some(r)) = (req.ticket.as_ref().filter(|t| !t.is_empty()), &release) {
                p.ticket_releases.insert(t.clone(), r.version.clone());
            }
            Ok(())
        })?;
        let mut agent_session = None;
        if req.start_agent {
            let mut request = req.description.clone();
            if let Some(t) = req.ticket.as_ref().filter(|t| !t.is_empty()) {
                request = format!("{request} (ticket {t})");
            }
            let s = self.start_agent(project_id, Some(&branch), &cwd, worktree.is_some(), &request).await?;
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
            if p.releases.iter().any(|r| r.branch == branch && r.shipped_at.is_none()) {
                return Err(Error::Invalid(format!("{branch} is a release branch")));
            }
            let release = p.releases.iter().find(|r| r.branch == parent && r.shipped_at.is_none()).map(|r| r.version.clone());
            let m = p.branches.entry(branch.to_string()).or_insert_with(|| BranchMeta { created_at: now(), ..Default::default() });
            if m.kind.is_empty() {
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
            return self.delete_branch(project_id, branch, true).await;
        }
        self.store.with_project(project_id, |p| {
            p.branches.remove(branch);
            Ok(())
        })?;
        self.changed(project_id);
        Ok(())
    }

    // ---------- branches ----------

    /// Delete a local branch and forget it. Its worktree (if any) goes too;
    /// without `force`, refuses when the branch has commits not in its base.
    pub async fn delete_branch(&self, project_id: &str, branch: &str, force: bool) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        if branch == default {
            return Err(Error::Invalid(format!("{branch} is the default branch")));
        }
        if let Some(r) = p.releases.iter().find(|r| r.branch == branch && r.shipped_at.is_none()) {
            return Err(Error::Invalid(format!("{branch} is the branch of open release v{}", r.version)));
        }
        if git.ref_exists(&format!("refs/heads/{branch}")).await? {
            let base = self.base_of(&p, branch, &default).await;
            let base_rev = git.rev_of(&base).await;
            if !force && !git.is_ancestor(branch, &base_rev).await? {
                let n = git.count(&format!("{base_rev}..{branch}")).await?;
                return Err(Error::Invalid(format!(
                    "{branch} has {n} commit{} not merged into {base}. Merge it first or force the delete.",
                    if n == 1 { "" } else { "s" }
                )));
            }
            if let Some(dir) = self.checkout_dir(&p, branch).await? {
                if dir == Path::new(&p.path) {
                    return Err(Error::Invalid(format!("{branch} is checked out. Switch away first.")));
                }
                self.remove_worktree(project_id, &dir.to_string_lossy(), false).await?;
            }
            git.delete_branch(branch, true).await?;
        }
        self.store.with_project(project_id, |p| {
            p.branches.remove(branch);
            Ok(())
        })?;
        self.changed(project_id);
        Ok(())
    }

    /// Fast-forward a branch to its upstream, checked out or not.
    /// Stash a checked-out branch's uncommitted changes (untracked files included).
    pub async fn stash_branch(&self, project_id: &str, branch: &str) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.require_checkout(&p, branch).await?;
        if git.wip_count().await? == 0 {
            return Err(Error::Invalid(format!("{branch} has no uncommitted changes to stash.")));
        }
        git.stash(&format!("Gitnetix: {branch}")).await?;
        self.changed(project_id);
        Ok(())
    }

    pub async fn pull_branch(&self, project_id: &str, branch: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let upstream = git
            .branches()
            .await?
            .into_iter()
            .find(|b| b.name == branch)
            .ok_or_else(|| Error::NotFound(format!("branch {branch}")))?
            .upstream
            .ok_or_else(|| Error::Invalid(format!("{branch} has no upstream. Push it first.")))?;
        let out = match self.checkout_dir(&p, branch).await? {
            Some(dir) => self.git_at(&p, &dir).pull_ff(branch, &upstream, true).await,
            None => git.pull_ff(branch, &upstream, false).await,
        }
        .map_err(|e| match e {
            Error::Git { stderr, .. } if stderr.contains("non-fast-forward") || stderr.contains("Not possible to fast-forward") || stderr.contains("rejected") => {
                Error::Invalid(format!("{branch} and {upstream} have diverged. Rebase or merge by hand."))
            }
            e => e,
        })?;
        self.changed(project_id);
        Ok(out)
    }

    /// Merge a branch into its base (its release, else its parent) with a
    /// merge commit. Works whether or not the base is checked out; stops
    /// before touching anything when the merge would conflict.
    pub async fn merge_branch(&self, project_id: &str, branch: &str, delete_after: bool) -> Result<MergeResult> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let into = self.base_of(&p, branch, &default).await;
        if into == branch {
            return Err(Error::Invalid(format!("{branch} has no other branch to merge into")));
        }
        // Deleting the branch the main checkout is on means moving that checkout to `into`:
        // make sure that can happen before merging anything.
        let switch = delete_after && self.checkout_dir(&p, branch).await?.is_some_and(|d| d == Path::new(&p.path));
        if switch {
            if let Some(dir) = self.checkout_dir(&p, &into).await? {
                return Err(Error::Invalid(format!(
                    "{into} is open in a worktree at {}, so this checkout can't switch to it. Merge without deleting, or close that worktree first.",
                    dir.display()
                )));
            }
        }
        let (sha, already_merged) = self.merge_refs(&p, branch, &into).await?;
        self.changed(project_id);
        if switch {
            git.switch(&into)
                .await
                .map_err(|e| Error::Invalid(format!("Merged into {into}, but switching to it failed, so {branch} was kept: {e}")))?;
        }
        if delete_after {
            self.delete_branch(project_id, branch, false).await?;
        }
        Ok(MergeResult { into, sha, already_merged, deleted: delete_after, switched: switch })
    }

    /// Bring a branch up to date with its base by merging the base into it
    /// (no history rewrite: right for shared release and dev branches).
    pub async fn sync_branch(&self, project_id: &str, branch: &str) -> Result<MergeResult> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let from = self.base_of(&p, branch, &default).await;
        if from == branch {
            return Err(Error::Invalid(format!("{branch} has no base to update from")));
        }
        let (sha, already_merged) = self.merge_refs(&p, &from, branch).await?;
        self.changed(project_id);
        Ok(MergeResult { into: branch.to_string(), sha, already_merged, deleted: false, switched: false })
    }

    /// Merge commit of `from` into local branch `into`. Returns (new tip, already merged).
    async fn merge_refs(&self, p: &Project, from: &str, into: &str) -> Result<(String, bool)> {
        let git = self.git(p);
        for b in [from, into] {
            if !git.ref_exists(&format!("refs/heads/{b}")).await? {
                return Err(Error::NotFound(format!("local branch {b}")));
            }
        }
        if git.is_ancestor(from, into).await? {
            return Ok((git.rev_parse(into).await?, true));
        }
        let tree = git.merge_tree(into, from).await?.map_err(|files| {
            Error::Invalid(format!("Merging {from} into {into} conflicts in {}. Rebase onto the base and resolve first.", files.join(", ")))
        })?;
        let message = format!("Merge branch '{from}' into {into}");
        let sha = match self.checkout_dir(p, into).await? {
            Some(dir) => {
                let g = self.git_at(p, &dir);
                if g.is_rebasing().await? || !g.wip_changes().await?.is_empty() {
                    return Err(Error::Invalid(format!("{into} has uncommitted changes at {}", dir.display())));
                }
                g.merge_no_ff(from, &message).await?
            }
            None => {
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
        self.git(&p).fetch().await?;
        self.changed(project_id);
        Ok(())
    }

    // ---------- worktrees & agents ----------

    pub async fn worktrees(&self) -> Result<Vec<WorktreeView>> {
        let projects = self.store.read(|c| c.projects.clone());
        let agents = self.agents.list();
        let mut out = Vec::new();
        for p in projects {
            let git = self.git(&p);
            let Ok(list) = git.worktrees().await else { continue };
            let default = git.default_branch().await.unwrap_or_else(|_| "main".into());
            let refs = Refs::load(&git, git.branches().await.unwrap_or_default()).await;
            for w in list {
                let (mut add, mut del) = (0, 0);
                for f in Git::new(&w.path).wip_changes().await.unwrap_or_default() {
                    add += f.additions;
                    del += f.deletions;
                }
                let meta = w.branch.as_ref().and_then(|b| p.branches.get(b));
                let base = match &w.branch {
                    Some(b) => Some(self.base_in(&p, &git, &refs, b, &default).await).filter(|x| x != b),
                    None => None,
                };
                out.push(WorktreeView {
                    project_id: p.id.clone(),
                    project_name: p.name.clone(),
                    base,
                    ticket: meta.and_then(|m| m.ticket.clone()),
                    agent: agents.iter().find(|a| a.cwd == w.path).cloned(),
                    path: w.path,
                    branch: w.branch,
                    main: w.main,
                    additions: add,
                    deletions: del,
                });
            }
        }
        Ok(out)
    }

    pub async fn create_worktree(&self, project_id: &str, branch: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let path = worktree_path(&p, branch);
        // A branch only on origin is checked out tracking it (git's DWIM).
        if git.branch_rev(branch).await?.is_some() {
            git.worktree_add(&path, branch, None).await?;
        } else {
            let default = git.default_branch().await?;
            git.worktree_add(&path, branch, Some(&default)).await?;
        }
        self.store.with_project(project_id, |p| {
            if let Some(m) = p.branches.get_mut(branch) {
                m.worktree = Some(path.to_string_lossy().to_string());
            }
            Ok(())
        })?;
        self.changed(project_id);
        Ok(path.to_string_lossy().to_string())
    }

    pub async fn remove_worktree(&self, project_id: &str, path: &str, force: bool) -> Result<()> {
        let p = self.store.project(project_id)?;
        if Path::new(path) == Path::new(&p.path) {
            return Err(Error::Invalid("That is the main checkout".into()));
        }
        for a in self.agents.list().into_iter().filter(|a| a.cwd == path) {
            let _ = self.agents.stop(&a.id);
        }
        self.git(&p).worktree_remove(Path::new(path), force).await?;
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

    pub async fn start_agent(&self, project_id: &str, branch: Option<&str>, cwd: &Path, worktree: bool, request: &str) -> Result<AgentSession> {
        let p = self.store.project(project_id)?;
        let t = self.template("agent", None, Some(&p.id))?;
        let r = self.route("agent", Some(&t))?;
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
        prompt = prompt.replace("{language}", templates::language_name(&p.gen_lang.commit));
        self.agents.start(StartArgs {
            project_id: project_id.into(),
            branch,
            cwd: cwd.to_path_buf(),
            worktree,
            request: request.into(),
            prompt,
            ai: r,
        })
    }

    pub async fn start_agent_on(&self, project_id: &str, branch: Option<String>, request: &str) -> Result<AgentSession> {
        let p = self.store.project(project_id)?;
        let (cwd, b) = match branch {
            Some(b) => {
                let dir = self.checkout_dir(&p, &b).await?.ok_or_else(|| Error::Invalid(format!("{b} is not checked out")))?;
                (dir, Some(b))
            }
            None => (top_path(&p), None),
        };
        let wt = cwd != Path::new(&p.path);
        self.start_agent(project_id, b.as_deref(), &cwd, wt, request).await
    }

    pub fn agent_message(&self, id: &str, text: &str) -> Result<()> {
        let r = self.route("agent", None)?;
        self.agents.message(id, text, &r)
    }

    // ---------- AI setup ----------

    pub async fn ai_test(&self, provider: &str) -> Result<serde_json::Value> {
        let r = self.store.read(|c| {
            let conf = c.ai.providers.get(provider).cloned().unwrap_or_default();
            Resolved { provider: provider.into(), method: conf.method, model: conf.model, effort: conf.effort, base_url: conf.base_url }
        });
        let t0 = Instant::now();
        let reply = ai::complete(&r, "Reply with the single word: ok", None).await?;
        let ms = t0.elapsed().as_millis() as u64;
        self.store.write(|c| {
            if let Some(p) = c.ai.providers.get_mut(provider) {
                p.connected = true;
            }
            Ok(())
        })?;
        self.config_changed();
        Ok(serde_json::json!({ "ms": ms, "model": r.label(), "reply": reply.chars().take(80).collect::<String>() }))
    }

    pub async fn template_preview(&self, project_id: &str, template_id: &str, language: &str) -> Result<(String, String)> {
        let p = self.store.project(project_id)?;
        let t = self.template("", Some(template_id), Some(&p.id))?;
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
                let commits = git.log(&format!("{from}..{current}"), Some(200)).await.unwrap_or_default();
                vars.insert("tickets".into(), tickets::extract_keys(&commit_lines(&commits)).join(", "));
                vars.insert("commits".into(), commit_lines(&commits));
                vars.insert("from".into(), from);
                vars.insert("to".into(), current.clone());
            }
            "agent" => {
                return Ok((
                    format!("Agent templates run as a live session. Prompt that would be sent:\n\n{}", t.body.replace("{request}", "squash my last 3 commits").replace("{branch}", &current).replace("{worktree}", &p.path)),
                    "“squash my last 3 commits”".into(),
                ));
            }
            _ => {
                return Ok(("Conflict templates run when a rebase stops on a conflict.".into(), "a conflicted file".into()));
            }
        }
        let task = t.kind.clone();
        let out = self.ask(&task, &t, vars, language, Some(Path::new(&p.path))).await?;
        Ok((out, source))
    }

    // ---------- pull requests ----------

    pub async fn github(&self, project_id: &str) -> Result<GitHub> {
        let p = self.store.project(project_id)?;
        let url = self.git(&p).remote_url("origin").await?.ok_or_else(|| Error::NotConnected("This repository has no origin remote".into()))?;
        let repo = parse_remote(&url).ok_or_else(|| Error::Unsupported(format!("remote {url}")))?;
        if !repo.host.contains("github") {
            return Err(Error::Unsupported(format!(
                "{} remotes are not supported yet — GitHub only for now",
                repo.host
            )));
        }
        let token = secrets::require("github", "Connect GitHub in Settings › Git providers")?;
        let api = self.store.read(|c| c.integrations.github_api.clone());
        Ok(GitHub::new(repo, token, api))
    }

    pub async fn generate_pr(&self, project_id: &str, branch: &str) -> Result<(String, String)> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let base = self.base_of(&p, branch, &default).await;
        let t = self.template("pr", None, Some(&p.id))?;
        let ticket = p.branches.get(branch).and_then(|m| m.ticket.clone()).unwrap_or_else(|| "(none)".into());
        let (base_rev, rev) = tokio::join!(git.rev_of(&base), git.rev_of(branch));
        let mut vars = BTreeMap::new();
        vars.insert("diff".into(), git.range_diff(&format!("{base_rev}...{rev}"), 60_000).await?);
        vars.insert("commits".into(), commit_lines(&git.log(&format!("{base_rev}..{rev}"), Some(100)).await?));
        vars.insert("branch".into(), branch.into());
        vars.insert("base".into(), base);
        vars.insert("ticket".into(), ticket);
        let out = self.ask("pr", &t, vars, &p.gen_lang.pr, Some(Path::new(&p.path))).await?;
        let (title, body) = out.split_once('\n').map(|(a, b)| (a.trim().trim_start_matches('#').trim().to_string(), b.trim().to_string())).unwrap_or((out.clone(), String::new()));
        Ok((title, body))
    }

    pub async fn create_pr(&self, project_id: &str, branch: &str, draft: bool, title: Option<String>, body: Option<String>) -> Result<crate::providers::github::PrSummary> {
        let p = self.store.project(project_id)?;
        let gh = self.github(project_id).await?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let base = self.base_of(&p, branch, &default).await;
        // The base must exist on the remote too.
        if !git.ref_exists(&format!("refs/remotes/origin/{base}")).await? {
            git.push(&base, true).await?;
        }
        // A branch only on origin is already there.
        if git.ref_exists(&format!("refs/heads/{branch}")).await? {
            self.push(project_id, branch).await?;
        }
        let (title, body) = match (title.filter(|s| !s.is_empty()), body) {
            (Some(t), b) => (t, b.unwrap_or_default()),
            (None, _) => self.generate_pr(project_id, branch).await?,
        };
        let pr = gh.create(branch, &base, &title, &body, draft).await?;
        self.changed(project_id);
        Ok(pr)
    }

    pub async fn draft_reply(&self, project_id: &str, number: u64, thread_id: &str) -> Result<String> {
        let gh = self.github(project_id).await?;
        let d = gh.detail(number).await?;
        let th = d.threads.iter().find(|t| t.id == thread_id).ok_or_else(|| Error::NotFound("thread".into()))?;
        let mut convo = String::new();
        if let Some(path) = &th.path {
            convo.push_str(&format!("File: {path}:{}\n{}\n\n", th.line.unwrap_or(0), th.snippet.join("\n")));
        }
        for c in &th.comments {
            convo.push_str(&format!("{}: {}\n\n", c.author, c.body));
        }
        let p = self.store.project(project_id)?;
        let t = Template {
            kind: "pr".into(),
            body: format!("You are the author of pull request “{}”. Draft a short, friendly reply to this review conversation. If a change is needed, say what you will change.\n\n{convo}", d.summary.title),
            ..Default::default()
        };
        self.ask("pr", &t, BTreeMap::new(), &p.gen_lang.pr, None).await
    }

    pub async fn draft_review(&self, project_id: &str, number: u64) -> Result<String> {
        let p = self.store.project(project_id)?;
        let gh = self.github(project_id).await?;
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
        self.ask("pr", &t, BTreeMap::new(), &p.gen_lang.pr, None).await
    }

    // ---------- tickets ----------

    pub async fn tickets(&self, project_id: &str) -> Result<Vec<TicketView>> {
        let p = self.store.project(project_id)?;
        let integ = self.store.read(|c| c.integrations.clone());
        // One source failing (missing token, keychain refusal, HTTP error)
        // must not hide tickets from the others.
        let token = |name: &str, label: &str| match secrets::get(name) {
            Ok(Some(tok)) => Ok(tok),
            Ok(None) => Err(format!("{label} token missing")),
            Err(e) => Err(format!("{label}: {e}")),
        };
        let mut results: Vec<std::result::Result<Vec<Ticket>, String>> = Vec::new();
        if let Some(j) = &integ.jira {
            results.push(match token("jira", "Jira") {
                Ok(tok) => tickets::jira(j, &tok).await.map_err(|e| e.to_string()),
                Err(e) => Err(e),
            });
        }
        if let Some(t) = &integ.trello {
            results.push(match token("trello", "Trello") {
                Ok(tok) => tickets::trello(t, &tok).await.map_err(|e| e.to_string()),
                Err(e) => Err(e),
            });
        }
        if let Some(a) = &integ.asana {
            results.push(match token("asana", "Asana") {
                Ok(tok) => tickets::asana(a, &tok).await.map_err(|e| e.to_string()),
                Err(e) => Err(e),
            });
        }
        let mut all: Vec<Ticket> = Vec::new();
        let mut errors = Vec::new();
        for r in results {
            match r {
                Ok(v) => all.extend(v),
                Err(e) => errors.push(e),
            }
        }
        if all.is_empty() && !errors.is_empty() {
            return Err(Error::Http(errors.join(" · ")));
        }
        Ok(all
            .into_iter()
            .map(|t| {
                let branch = p.branches.iter().find(|(_, m)| m.ticket.as_deref() == Some(t.key.as_str())).map(|(b, _)| b.clone());
                let release = p
                    .ticket_releases
                    .get(&t.key)
                    .cloned()
                    .or_else(|| branch.as_ref().and_then(|b| p.branches.get(b)).and_then(|m| m.release.clone()))
                    .unwrap_or_default();
                TicketView { ticket: t, release, branch }
            })
            .collect())
    }

    pub fn set_ticket_release(&self, project_id: &str, key: &str, release: &str) -> Result<()> {
        self.store.with_project(project_id, |p| {
            p.ticket_releases.insert(key.into(), release.into());
            Ok(())
        })?;
        self.changed(project_id);
        Ok(())
    }

    pub async fn triage(&self, project_id: &str) -> Result<Vec<Suggestion>> {
        let p = self.store.project(project_id)?;
        let list = self.tickets(project_id).await?;
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
        let commits = git.log(&format!("{from}..{to}"), Some(1000)).await?;
        let range = format!("{from}..{to}");
        let merges: u32 = git
            .run(&["rev-list", "--count", "--merges", &range])
            .await
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        let text = commit_lines(&commits);
        Ok(serde_json::json!({
            "commits": commits.len(),
            "branches": merges,
            "tickets": tickets::extract_keys(&text).len(),
        }))
    }

    pub async fn generate_notes(&self, project_id: &str, from: &str, to: &str, template_id: Option<&str>, language: &str, inc: NotesInclude) -> Result<(String, String)> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let commits = git.log(&format!("{from}..{to}"), Some(500)).await?;
        let kept: Vec<_> = commits
            .into_iter()
            .filter(|c| {
                let s = c.subject.as_str();
                if s.starts_with("feat") {
                    inc.feat
                } else if s.starts_with("fix") {
                    inc.fix
                } else {
                    inc.internal
                }
            })
            .collect();
        if kept.is_empty() {
            return Err(Error::Invalid("No commits in this range match the filters".into()));
        }
        let t = self.template("release", template_id, Some(&p.id))?;
        let text = commit_lines(&kept);
        let mut vars = BTreeMap::new();
        vars.insert("commits".into(), text.clone());
        vars.insert(
            "tickets".into(),
            if inc.tickets { tickets::extract_keys(&text).join(", ") } else { "(do not mention ticket keys)".into() },
        );
        vars.insert("from".into(), from.into());
        vars.insert("to".into(), to.into());
        let r = self.route("release", Some(&t))?;
        let out = self.ask("release", &t, vars, language, Some(Path::new(&p.path))).await?;
        Ok((out, format!("{} · {} commits read", r.label(), kept.len())))
    }

    pub fn add_to_changelog(&self, project_id: &str, markdown: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let path = Path::new(&p.path).join("CHANGELOG.md");
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

    // ---------- analytics ----------

    pub async fn analytics(&self, project_id: &str, days: i64) -> Result<crate::analytics::Analytics> {
        let projects = self.store.read(|c| c.projects.clone());
        let chosen: Vec<&Project> = projects.iter().filter(|p| project_id == "all" || p.id == project_id).collect();
        let repos = chosen.iter().map(|p| (Git::new(&p.path), p.ai_commits.as_slice())).collect();
        crate::analytics::compute(crate::analytics::Input { repos, range_days: days }).await
    }
}

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
    ("poc", &["spike"]),
];

/// `feature` → `feat`, `Fix` → `fix`; None when it is not a known type.
fn normalize_kind(kind: &str) -> Option<&'static str> {
    let k = kind.trim().to_ascii_lowercase();
    KINDS.iter().find(|(id, aliases)| *id == k || aliases.contains(&k.as_str())).map(|(id, _)| *id)
}

/// Kind implied by a branch name's prefix (`feature/x` → feat).
fn kind_of_branch(name: &str) -> Option<&'static str> {
    name.split_once('/').and_then(|(pre, _)| normalize_kind(pre))
}

fn top_path(p: &Project) -> PathBuf {
    PathBuf::from(&p.path)
}

/// Worktrees live next to the main checkout: `<parent>/<project>.<branch with / as ->`.
/// The whole branch name is kept so `feat/login` and `fix/login` do not collide.
fn worktree_path(p: &Project, branch: &str) -> PathBuf {
    let top = top_path(p);
    let parent = top.parent().map(Path::to_path_buf).unwrap_or_else(|| top.clone());
    parent.join(format!("{}.{}", p.name, branch.replace('/', "-")))
}

/// A commit id from the UI goes straight to `git diff`, so it must not read as an option.
fn check_sha(sha: &str) -> Result<&str> {
    if (4..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(sha)
    } else {
        Err(Error::Invalid(format!("not a commit id: {sha:?}")))
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slugify("Let users sign in with Google and GitHub.", 4), "sign-google-github");
        assert_eq!(slugify("!!!", 4), "change");
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
}
