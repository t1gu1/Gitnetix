//! `Gitnetix`: the one service every front end talks to (Tauri window,
//! companion HTTP API for mobile, MCP bridge). All behaviour lives here;
//! `rpc` only maps method names onto these calls.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::agents::{AgentManager, AgentSession, AgentStatus, StartArgs};
use crate::ai::{self, Resolved};
use crate::error::{Error, Result};
use crate::events::Event;
use crate::git::{FileChange, Git, Hunk, Identity};
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
    pub ahead: u32,
    pub ticket: Option<String>,
    pub exists: bool,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub project: Project,
    pub current_branch: Option<String>,
    pub default_branch: String,
    pub releases: Vec<ReleaseView>,
    /// Branches no release claims (excluding default and release/*).
    pub other_branches: Vec<String>,
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
    pub release: String,
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

    fn base_of(&self, p: &Project, branch: &str, default: &str) -> String {
        p.branches
            .get(branch)
            .and_then(|m| m.release.as_ref())
            .and_then(|v| p.releases.iter().find(|r| &r.version == v))
            .map(|r| r.branch.clone())
            .or_else(|| p.releases.iter().find(|r| r.branch == branch).map(|r| r.base.clone()))
            .unwrap_or_else(|| default.to_string())
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
            if let Some(existing) = self.store.read(|c| c.projects.iter().find(|p| p.path == path).cloned()) {
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
        for b in git.branches().await.unwrap_or_default() {
            if let Some(v) = b.name.strip_prefix("release/") {
                if !p.releases.iter().any(|r| r.version == v) {
                    let hotfix = v.split('.').nth(2).is_some_and(|patch| patch != "0");
                    p.releases.push(Release {
                        version: v.into(),
                        kind: if hotfix { ReleaseKind::Hotfix } else { ReleaseKind::Next },
                        branch: b.name.clone(),
                        base: default.clone(),
                        created_at: now(),
                        ..Default::default()
                    });
                }
            }
        }
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
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let current = git.current_branch().await?;
        let branches = git.branches().await?;
        let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        let wts = git.worktrees().await?;
        let agents = self.agents.list();
        let rebasing = git.is_rebasing().await.unwrap_or(false);
        let conflicts = if rebasing { git.conflicted_files().await.unwrap_or_default() } else { Vec::new() };

        let mut releases = Vec::new();
        let open: Vec<&Release> = p.releases.iter().filter(|r| r.shipped_at.is_none()).collect();
        for r in &open {
            let mut items = Vec::new();
            for (name, meta) in p.branches.iter().filter(|(_, m)| m.release.as_deref() == Some(r.version.as_str())) {
                let exists = names.contains(&name.as_str());
                let wt = wts.iter().find(|w| w.branch.as_deref() == Some(name.as_str()));
                let ahead = if exists { git.count(&format!("{}..{}", r.branch, name)).await.unwrap_or(0) } else { 0 };
                let wt_conflict = match wt {
                    Some(w) => {
                        let g = Git::new(&w.path);
                        g.is_rebasing().await.unwrap_or(false) && !g.conflicted_files().await.unwrap_or_default().is_empty()
                    }
                    None => false,
                };
                items.push(BranchView {
                    short: name.split_once('/').map(|(_, b)| b.to_string()).unwrap_or_else(|| name.clone()),
                    name: name.clone(),
                    kind: meta.kind.clone(),
                    worktree: wt.filter(|w| !w.main).map(|w| w.path.clone()),
                    checked_out: wt.is_some(),
                    running: agents.iter().any(|a| &a.branch == name && a.project_id == p.id && a.status == AgentStatus::Running),
                    conflict: wt_conflict,
                    ahead,
                    ticket: meta.ticket.clone(),
                    exists,
                });
            }
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
            });
        }
        // Last shipped releases, from tags.
        for t in git.tags().await.unwrap_or_default().into_iter().take(3) {
            let v = t.name.trim_start_matches('v').to_string();
            let shipped = p.branches.values().filter(|m| m.release.as_deref() == Some(v.as_str())).count();
            let date = t.date.get(..10).unwrap_or("").to_string();
            releases.push(ReleaseView {
                version: v,
                tag: "released".into(),
                branch: String::new(),
                base: format!("{default} · tagged {date}"),
                open: false,
                items: vec![],
                note: if shipped > 0 { format!("{shipped} branches shipped") } else { String::new() },
            });
        }
        let claimed: Vec<&String> = p.branches.keys().collect();
        let other_branches = branches
            .iter()
            .map(|b| b.name.clone())
            .filter(|n| n != &default && !n.starts_with("release/") && !claimed.contains(&n))
            .collect();
        let remote = git.remote_url("origin").await.ok().flatten();
        Ok(Overview { project: p, current_branch: current, default_branch: default, releases, other_branches, rebasing, conflicts, remote })
    }

    pub async fn files(&self, project_id: &str, branch: &str, mode: &str) -> Result<Vec<FileChange>> {
        let p = self.store.project(project_id)?;
        if mode == "wip" {
            return match self.checkout_dir(&p, branch).await? {
                Some(dir) => Git::new(dir).wip_changes().await,
                None => Ok(Vec::new()),
            };
        }
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let base = self.base_of(&p, branch, &default);
        match mode {
            "branch" => {
                if base == branch {
                    return Ok(Vec::new());
                }
                git.branch_changes(&base, branch).await
            }
            _ => {
                let dir = self.checkout_dir(&p, branch).await?;
                let mut known: HashMap<String, FileChange> = HashMap::new();
                if base != branch {
                    for f in git.branch_changes(&base, branch).await? {
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
                        let out = git.run(&["ls-tree", "-r", "--name-only", "-z", branch]).await?;
                        out.split('\0').filter(|s| !s.is_empty()).map(String::from).collect()
                    }
                };
                let mut all: Vec<FileChange> = listing
                    .into_iter()
                    .map(|path| known.remove(&path).unwrap_or(FileChange { path, status: ' ', additions: 0, deletions: 0 }))
                    .collect();
                all.extend(known.into_values());
                all.sort_by(|a, b| a.path.cmp(&b.path));
                Ok(all)
            }
        }
    }

    pub async fn diff(&self, project_id: &str, branch: &str, mode: &str, path: &str) -> Result<Vec<Hunk>> {
        let p = self.store.project(project_id)?;
        if matches!(mode, "wip" | "project") {
            if let Some(dir) = self.checkout_dir(&p, branch).await? {
                let wip = Git::new(&dir).file_diff(path, None).await?;
                if !wip.is_empty() || mode == "wip" {
                    return Ok(wip);
                }
            }
        }
        let git = self.git(&p);
        let default = git.default_branch().await?;
        let base = self.base_of(&p, branch, &default);
        if base == branch {
            return Ok(Vec::new());
        }
        git.file_diff(path, Some(&format!("{base}...{branch}"))).await
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

    /// Stage everything in the branch's checkout; errors when there is nothing to commit.
    async fn stage_all(&self, p: &Project, branch: &str) -> Result<Git> {
        let git = self.require_checkout(p, branch).await?;
        git.add_all().await?;
        if !git.has_staged().await? {
            return Err(Error::Invalid("Nothing to commit".into()));
        }
        Ok(git)
    }

    pub async fn generate_commit_message(&self, project_id: &str, branch: &str) -> Result<String> {
        let p = self.store.project(project_id)?;
        let git = self.stage_all(&p, branch).await?;
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

    /// Stage everything and commit. An empty message is written by AI.
    pub async fn commit(&self, project_id: &str, branch: &str, message: Option<String>) -> Result<CommitResult> {
        let p = self.store.project(project_id)?;
        let git = self.stage_all(&p, branch).await?;
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
        let base = self.base_of(&p, branch, &default);
        let ok = git.rebase(&base).await?;
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
        vars.insert("theirs".into(), self.base_of(&p, branch, &default));
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
        let release = p
            .releases
            .iter()
            .find(|r| r.version == req.release && r.shipped_at.is_none())
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("open release v{}", req.release)))?;
        let kind = if req.kind == "fix" { "fix" } else { "feat" };
        let branch = match req.branch_name.clone().filter(|s| !s.trim().is_empty()) {
            Some(b) => b.trim().to_string(),
            None => self.suggest_branch_name(project_id, kind, &req.description, req.ticket.as_deref()).await?.0,
        };
        if !valid_branch_name(&branch) {
            return Err(Error::Invalid(format!("“{branch}” is not a valid branch name")));
        }
        let git = self.git(&p);
        if git.ref_exists(&format!("refs/heads/{branch}")).await? {
            return Err(Error::Invalid(format!("{branch} already exists")));
        }
        let mut worktree = None;
        let cwd = if req.r#where == "worktree" {
            let path = worktree_path(&p, &branch);
            git.worktree_add(&path, &branch, Some(&release.branch)).await?;
            worktree = Some(path.to_string_lossy().to_string());
            path
        } else {
            git.switch_create(&branch, &release.branch).await?;
            top_path(&p)
        };
        let meta = BranchMeta {
            kind: kind.into(),
            release: Some(release.version.clone()),
            ticket: req.ticket.clone().filter(|t| !t.is_empty()),
            worktree: worktree.clone(),
            description: Some(req.description.clone()),
            created_at: now(),
        };
        self.store.with_project(project_id, |p| {
            p.branches.insert(branch.clone(), meta);
            if let Some(t) = req.ticket.as_ref().filter(|t| !t.is_empty()) {
                p.ticket_releases.insert(t.clone(), release.version.clone());
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
            m.kind = if kind.is_empty() { "feat".into() } else { kind.into() };
            m.release = release.filter(|s| !s.is_empty());
            Ok(())
        })?;
        self.changed(project_id);
        Ok(())
    }

    pub async fn remove_item(&self, project_id: &str, branch: &str, delete_branch: bool) -> Result<()> {
        let p = self.store.project(project_id)?;
        let git = self.git(&p);
        if delete_branch {
            if let Some(dir) = self.checkout_dir(&p, branch).await? {
                if dir != Path::new(&p.path) {
                    git.worktree_remove(&dir, false).await?;
                } else {
                    return Err(Error::Invalid(format!("{branch} is checked out. Switch away first.")));
                }
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

    // ---------- worktrees & agents ----------

    pub async fn worktrees(&self) -> Result<Vec<WorktreeView>> {
        let projects = self.store.read(|c| c.projects.clone());
        let agents = self.agents.list();
        let mut out = Vec::new();
        for p in projects {
            let git = self.git(&p);
            let Ok(list) = git.worktrees().await else { continue };
            let default = git.default_branch().await.unwrap_or_else(|_| "main".into());
            for w in list {
                let (mut add, mut del) = (0, 0);
                for f in Git::new(&w.path).wip_changes().await.unwrap_or_default() {
                    add += f.additions;
                    del += f.deletions;
                }
                let meta = w.branch.as_ref().and_then(|b| p.branches.get(b));
                out.push(WorktreeView {
                    project_id: p.id.clone(),
                    project_name: p.name.clone(),
                    base: w.branch.as_ref().map(|b| self.base_of(&p, b, &default)).filter(|b| Some(b) != w.branch.as_ref()),
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
        if git.ref_exists(&format!("refs/heads/{branch}")).await? {
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
                let base = self.base_of(&p, &current, &default);
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
        let base = self.base_of(&p, branch, &default);
        let t = self.template("pr", None, Some(&p.id))?;
        let ticket = p.branches.get(branch).and_then(|m| m.ticket.clone()).unwrap_or_else(|| "(none)".into());
        let mut vars = BTreeMap::new();
        vars.insert("diff".into(), git.range_diff(&format!("{base}...{branch}"), 60_000).await?);
        vars.insert("commits".into(), commit_lines(&git.log(&format!("{base}..{branch}"), Some(100)).await?));
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
        let base = self.base_of(&p, branch, &default);
        // The base must exist on the remote too.
        if !git.ref_exists(&format!("refs/remotes/origin/{base}")).await? {
            git.push(&base, true).await?;
        }
        self.push(project_id, branch).await?;
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
        let mut all: Vec<Ticket> = Vec::new();
        let mut errors = Vec::new();
        let mut absorb = |r: Result<Vec<Ticket>>| match r {
            Ok(v) => all.extend(v),
            Err(e) => errors.push(e.to_string()),
        };
        if let Some(j) = &integ.jira {
            match secrets::get("jira")? {
                Some(tok) => absorb(tickets::jira(j, &tok).await),
                None => absorb(Err(Error::Other("Jira token missing".into()))),
            }
        }
        if let Some(t) = &integ.trello {
            if let Some(tok) = secrets::get("trello")? {
                absorb(tickets::trello(t, &tok).await);
            }
        }
        if let Some(a) = &integ.asana {
            if let Some(tok) = secrets::get("asana")? {
                absorb(tickets::asana(a, &tok).await);
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

fn top_path(p: &Project) -> PathBuf {
    PathBuf::from(&p.path)
}

/// Worktrees live next to the main checkout: `<parent>/<project>.<last branch segment>`.
fn worktree_path(p: &Project, branch: &str) -> PathBuf {
    let top = top_path(p);
    let parent = top.parent().map(Path::to_path_buf).unwrap_or_else(|| top.clone());
    let slug = branch.rsplit('/').next().unwrap_or(branch);
    parent.join(format!("{}.{}", p.name, slug))
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
        assert!(!valid_branch_name("feat/ bad"));
        assert!(!valid_branch_name("feat/.."));
    }
}
