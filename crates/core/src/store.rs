//! Persistent app state: projects, release metadata, profiles, AI setup,
//! templates and integration settings. One JSON file per user profile, written atomically.
//! Secrets never live here — see `secrets`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::templates::{default_templates, Template, OLD_BODIES};

pub const CONFIG_VERSION: u32 = 1;

/// Copied into every new worktree unless removed: ignored files a fresh checkout lacks.
/// A knowledge graph (graphify), Claude Code's local settings, local environment variables and their examples.
pub const DEFAULT_WORKTREE_FILES: &[&str] = &["graphify-out/", ".claude/settings.local.json", ".env", ".env.local", ".env.example", ".env.example.local"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    pub projects: Vec<Project>,
    /// This profile's Git identity: Gitnetix commits with it in all its projects; none leaves it to the Git config.
    /// A list under its old name, so versions that kept several still read it: only the first counts.
    pub profiles: Vec<GitProfile>,
    pub ai: AiConfig,
    pub templates: Vec<Template>,
    pub integrations: Integrations,
    pub ui: UiPrefs,
    pub server: ServerConfig,
    /// Paths copied from the main checkout into each new worktree of every project, with the project's own.
    pub worktree_files: Vec<String>,
    /// Defaults already put in `worktree_files`: each is added once, so one removed stays removed.
    /// Empty in files saved before it, so those get every default.
    #[serde(default)]
    pub worktree_defaults_added: Vec<String>,
    /// Paths linked from the main checkout into each new worktree of every project, with the project's own.
    pub worktree_links: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            version: CONFIG_VERSION,
            projects: Vec::new(),
            profiles: Vec::new(),
            ai: AiConfig::default(),
            templates: default_templates(),
            integrations: Integrations::default(),
            ui: UiPrefs::default(),
            server: ServerConfig::default(),
            worktree_files: DEFAULT_WORKTREE_FILES.iter().map(|f| f.to_string()).collect(),
            worktree_defaults_added: DEFAULT_WORKTREE_FILES.iter().map(|f| f.to_string()).collect(),
            worktree_links: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub gen_lang: GenLangs,
    pub releases: Vec<Release>,
    /// Branch name → what Gitnetix knows about it.
    pub branches: BTreeMap<String, BranchMeta>,
    /// Ticket key → release version it is planned for ("" = unplanned).
    pub ticket_releases: BTreeMap<String, String>,
    /// Commits whose message was written by AI (for analytics).
    pub ai_commits: Vec<String>,
    pub added_at: String,
    /// Closed from the project bar; still saved and listed on the welcome screen.
    pub hidden: bool,
    /// Versions forgotten with `releases.delete`; their branches are not re-imported.
    pub forgotten_releases: Vec<String>,
    /// Old branch name → what it was renamed to: stashes made before a rename still name the old one.
    pub renamed_branches: BTreeMap<String, String>,
    /// Merge dialog options, as last chosen.
    pub merge: MergePrefs,
    /// Commit button options.
    pub commit: CommitPrefs,
    /// What the other dialogs start with, set in the project's settings.
    pub dialogs: DialogPrefs,
    /// Paths from the checkout root (ignored files git leaves out) copied from the main checkout into each new worktree.
    pub worktree_files: Vec<String>,
    /// Paths linked, not copied: the worktree reads and writes the main checkout's.
    pub worktree_links: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct MergePrefs {
    /// Squash the branch into one commit first.
    pub squash: bool,
    /// Who writes the squashed commit's message.
    pub squash_message: SquashMessage,
    /// Rebase and fast-forward instead of a merge commit.
    pub rebase: bool,
    pub delete_branch: bool,
    /// Push the target to origin after.
    pub push: bool,
    /// Let AI resolve the conflicts a merge, rebase, cherry-pick, revert or stash runs into, and carry on.
    pub resolve_conflicts: bool,
}

impl Default for MergePrefs {
    fn default() -> Self {
        MergePrefs { squash: false, squash_message: SquashMessage::Branch, rebase: false, delete_branch: true, push: false, resolve_conflicts: true }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SquashMessage {
    /// "squash | <branch name>", then the squashed commits' subjects.
    #[default]
    Branch,
    /// Written by AI from the branch's changes, with the commit template.
    Ai,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CommitPrefs {
    /// Push the branch after each commit.
    pub auto_push: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct DialogPrefs {
    /// How a worktree session ends: keep its branch to continue on, or merge it.
    pub finish: FinishWith,
    /// Switch to where the worktree's code lands once it is closed.
    pub finish_switch: bool,
    /// A new branch gets its own worktree instead of being switched to.
    pub new_worktree: bool,
    /// Start an AI agent on a new branch right away.
    pub new_agent: bool,
    /// Push the default branch and the tag when shipping a release.
    pub ship_push: bool,
    /// Let AI update the release's CHANGELOG.md before shipping it.
    pub ship_changelog: bool,
    /// Also delete a deleted branch on origin.
    pub delete_origin: bool,
    /// Also delete the cleaned-up behind branches on origin.
    pub cleanup_origin: bool,
    /// Show pictures and GitHub's HTML in pull requests, their comments and GitHub issues: pictures load from wherever
    /// they are hosted.
    pub pr_media: bool,
}

impl Default for DialogPrefs {
    fn default() -> Self {
        DialogPrefs { finish: FinishWith::Merge, finish_switch: true, new_worktree: false, new_agent: false, ship_push: true, ship_changelog: true, delete_origin: false, cleanup_origin: true, pr_media: false }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FinishWith {
    Continue,
    Merge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GenLangs {
    /// Language codes ("fr"), or "spoken" for the language of the last dictation.
    pub commit: String,
    pub pr: String,
    pub release: String,
}

impl Default for GenLangs {
    fn default() -> Self {
        GenLangs { commit: "en".into(), pr: "en".into(), release: "en".into() }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseKind {
    #[default]
    Next,
    Hotfix,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Release {
    /// "2.4.0" (no leading v).
    pub version: String,
    pub kind: ReleaseKind,
    /// "release/2.4.0"
    pub branch: String,
    /// Branch it was cut from (usually main).
    pub base: String,
    pub created_at: String,
    pub shipped_at: Option<String>,
    pub tag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct BranchMeta {
    /// Branch type: "feat", "fix", "refactor", "perf", "style", "test", "docs", "chore", "ci", "a11y", "build" or "poc".
    pub kind: String,
    /// Release version this branch ships in.
    pub release: Option<String>,
    /// Branch it merges into when it is in no release (e.g. `dev`). Inferred from history when unset.
    pub parent: Option<String>,
    pub ticket: Option<String>,
    pub worktree: Option<String>,
    pub description: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GitProfile {
    pub name: String,
    pub email: String,
    pub sign: bool,
    /// Path to the SSH public key used for signing (`~/.ssh/id_ed25519.pub`).
    pub signing_key: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ConnectMethod {
    #[default]
    Cli,
    Api,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderConf {
    pub method: ConnectMethod,
    pub model: String,
    pub effort: String,
    pub base_url: Option<String>,
    /// Set once a test call succeeded.
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Route {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Agents only: how their actions get approved (`agents::claude_permission`). None = Bypass.
    pub permission: Option<String>,
    /// Claude agents only: Claude Code's ultracode (standing workflow orchestration). None = off.
    pub ultracode: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiConfig {
    pub default_provider: String,
    pub providers: BTreeMap<String, ProviderConf>,
    /// Task id (commit, branch, pr, release, conflict, agent, triage, dictation, analytics) → route.
    pub routing: BTreeMap<String, Route>,
}

impl Default for AiConfig {
    fn default() -> Self {
        let mut providers = BTreeMap::new();
        providers.insert(
            "claude".into(),
            ProviderConf { method: ConnectMethod::Cli, model: "claude-sonnet-5-5".into(), effort: "medium".into(), ..Default::default() },
        );
        let mut routing = BTreeMap::new();
        let r = |m: &str, e: &str| Route { provider: Some("claude".into()), model: Some(m.into()), effort: Some(e.into()), permission: None, ultracode: None };
        routing.insert("commit".into(), r("claude-haiku-5-5", "low"));
        routing.insert("branch".into(), r("claude-haiku-5-5", "low"));
        routing.insert("pr".into(), r("claude-sonnet-5-5", "medium"));
        routing.insert("release".into(), r("claude-sonnet-5-5", "medium"));
        routing.insert("conflict".into(), r("claude-opus-5-5", "high"));
        routing.insert("agent".into(), r("claude-opus-5-5", "xhigh"));
        routing.insert("triage".into(), r("claude-haiku-5-5", "low"));
        routing.insert("dictation".into(), r("claude-haiku-5-5", "low"));
        routing.insert("analytics".into(), r("claude-sonnet-5-5", "medium"));
        AiConfig { default_provider: "claude".into(), providers, routing }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Integrations {
    /// GitHub API base, None = api.github.com. Token in keychain "github".
    pub github_api: Option<String>,
    pub github_connected: bool,
    /// Account signed in with "Sign in with GitHub"; None for a pasted token.
    pub github_user: Option<String>,
    /// Signed in with "Sign in with Azure DevOps". Tokens in keychain "azure".
    pub azure_connected: bool,
    pub azure_user: Option<String>,
    /// Tokens in keychain "gitlab", "bitbucket" and "gitea".
    pub gitlab: HostConf,
    pub bitbucket: HostConf,
    pub gitea: HostConf,
    /// One per Jira site or account. Older configs held a single object, for each tracker.
    #[serde(deserialize_with = "one_or_many")]
    pub jira: Vec<JiraConf>,
    #[serde(deserialize_with = "one_or_many")]
    pub trello: Vec<TrelloConf>,
    #[serde(deserialize_with = "one_or_many")]
    pub asana: Vec<AsanaConf>,
    pub linear: Vec<LinearConf>,
}

impl Integrations {
    /// The `gitlab`, `bitbucket` or `gitea` connection.
    pub fn host_mut(&mut self, kind: &str) -> Option<&mut HostConf> {
        match kind {
            "gitlab" => Some(&mut self.gitlab),
            "bitbucket" => Some(&mut self.bitbucket),
            "gitea" => Some(&mut self.gitea),
            _ => None,
        }
    }
}

/// A GitLab, Bitbucket or Gitea connection.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct HostConf {
    /// The server, `https://gitlab.example.com`; None = gitlab.com or bitbucket.org. Gitea always has one.
    pub url: Option<String>,
    /// OAuth application registered on that server, to sign in there; also renews the tokens.
    pub client_id: Option<String>,
    pub connected: bool,
    pub user: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct JiraConf {
    /// "" for the connection made before there could be several.
    pub id: String,
    /// https://yourteam.atlassian.net
    pub base_url: String,
    pub email: String,
    /// Optional JQL; defaults to open issues assigned to or reported by me.
    pub jql: Option<String>,
    /// Set when signed in with Atlassian (OAuth); `email` is unused then.
    pub cloud_id: Option<String>,
    /// Set for a scoped API token, which only works through api.atlassian.com.
    pub api_cloud_id: Option<String>,
    /// Jira project keys to show tickets from; empty = all.
    pub projects: Vec<String>,
    /// Gitnetix projects whose Tickets screen shows this connection; empty = all.
    pub repos: Vec<String>,
}

/// A tracker connection; there can be several of each kind.
pub trait Connection {
    const KIND: &'static str;
    /// "" for the connection made before there could be several.
    fn id(&self) -> &str;
    /// Keychain key of this connection's token.
    fn secret(&self) -> String {
        if self.id().is_empty() { Self::KIND.into() } else { format!("{}.{}", Self::KIND, self.id()) }
    }
}

impl Connection for JiraConf {
    const KIND: &'static str = "jira";
    fn id(&self) -> &str {
        &self.id
    }
}

impl Connection for TrelloConf {
    const KIND: &'static str = "trello";
    fn id(&self) -> &str {
        &self.id
    }
}

impl Connection for AsanaConf {
    const KIND: &'static str = "asana";
    fn id(&self) -> &str {
        &self.id
    }
}

impl Connection for LinearConf {
    const KIND: &'static str = "linear";
    fn id(&self) -> &str {
        &self.id
    }
}

/// Replaces the connection with `item`'s id, or adds it.
pub fn upsert<T: Connection>(list: &mut Vec<T>, item: T) {
    match list.iter_mut().find(|x| x.id() == item.id()) {
        Some(x) => *x = item,
        None => list.push(item),
    }
}

/// Whether a connection limited to `repos` shows in project `id`.
pub fn shows_in(repos: &[String], id: &str) -> bool {
    repos.is_empty() || repos.iter().any(|r| r == id)
}

fn one_or_many<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> std::result::Result<Vec<T>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany<T> {
        Many(Vec<T>),
        One(Option<T>),
    }
    Ok(match OneOrMany::deserialize(d)? {
        OneOrMany::Many(v) => v,
        OneOrMany::One(o) => o.into_iter().collect(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TrelloConf {
    pub id: String,
    /// Unused when signed in with Trello.
    pub api_key: String,
    /// Boards to show the cards of; empty = the cards assigned to me. Older configs held one `boardId`.
    #[serde(alias = "boardId", deserialize_with = "one_or_many")]
    pub boards: Vec<String>,
    /// Signed in with Trello (OAuth): the keychain holds its tokens, not one pasted with `api_key`.
    pub oauth: bool,
    /// Gitnetix projects whose Tickets screen shows it; empty = all.
    pub repos: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AsanaConf {
    pub id: String,
    pub workspace_gid: String,
    /// Projects to show the tasks of; empty = the tasks assigned to me. Older configs held one `projectGid`.
    #[serde(alias = "projectGid", deserialize_with = "one_or_many")]
    pub projects: Vec<String>,
    /// Signed in with Asana (OAuth): the keychain holds its tokens, not a personal access token.
    pub oauth: bool,
    /// Gitnetix projects whose Tickets screen shows it; empty = all.
    pub repos: Vec<String>,
}

/// A Linear workspace.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LinearConf {
    pub id: String,
    /// Keys of the teams to show the issues of (`ENG`); empty = every team.
    pub teams: Vec<String>,
    /// Signed in with Linear (OAuth): the keychain holds its tokens, not a personal API key.
    pub oauth: bool,
    /// Gitnetix projects whose Tickets screen shows it; empty = all.
    pub repos: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UiPrefs {
    pub language: String,
    pub theme: String,
    pub last_project: Option<String>,
    /// How the screens were left (pane widths, collapsed sections…), by key, as the UI wrote them.
    pub view: BTreeMap<String, String>,
    /// Animations the user turned off, by id (see the UI's list); every other one plays.
    pub animations_off: Vec<String>,
    /// The language the last dictation was mostly in: what the "spoken" generation language follows.
    pub spoken_language: Option<String>,
    /// AI rewrites each dictation into clear text, with the project's context, when a provider is set up.
    pub dictation_polish: bool,
    /// The first-run setup is still to show: set on a first launch only, so files from older versions read false.
    pub onboarding: bool,
}

impl Default for UiPrefs {
    fn default() -> Self {
        UiPrefs { language: "en".into(), theme: "tokyo-night-storm".into(), last_project: None, view: BTreeMap::new(), animations_off: Vec::new(), spoken_language: None, dictation_polish: true, onboarding: false }
    }
}

/// The companion API used by the mobile app and the MCP bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ServerConfig {
    pub enabled: bool,
    pub port: u16,
    /// Listen on all interfaces (for a phone on the same network).
    pub lan: bool,
    /// Bearer token required on every request.
    pub token: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        ServerConfig { enabled: true, port: 7421, lan: false, token: new_token() }
    }
}

pub fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Id of the profile made before there were profiles: its settings stay in config.json.
pub const FIRST_PROFILE: &str = "default";

/// The people or contexts sharing Gitnetix on this computer (work, personal…), each with its own
/// projects, connections, AI setup and settings file. In profiles.json, which older versions never
/// read: they keep using config.json, the first profile's settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Profiles {
    /// The profile Gitnetix opens on.
    pub active: String,
    pub list: Vec<UserProfile>,
}

impl Default for Profiles {
    fn default() -> Self {
        Profiles { active: FIRST_PROFILE.into(), list: vec![UserProfile { id: FIRST_PROFILE.into(), name: "Default".into(), ..Default::default() }] }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct UserProfile {
    pub id: String,
    pub name: String,
    /// An emoji, a photo as an image data URL, "gravatar:" and an email, or "" for the default avatar.
    pub avatar: String,
    /// Hue (0-359) of its color; none follows the theme's accent.
    pub hue: Option<u16>,
}

/// Where profile `id`'s settings live.
fn profile_path(dir: &Path, id: &str) -> PathBuf {
    if id == FIRST_PROFILE { dir.join("config.json") } else { dir.join("profiles").join(format!("{id}.json")) }
}

fn load_profiles(dir: &Path) -> Profiles {
    std::fs::read_to_string(dir.join("profiles.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// The settings file of the profile Gitnetix opens on.
pub fn active_config_path(dir: &Path) -> PathBuf {
    profile_path(dir, &load_profiles(dir).active)
}

/// Where config, logs and (without keychain) secrets live.
pub fn data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("GITNETIX_HOME") {
        return PathBuf::from(p);
    }
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("gitnetix")
}

/// Write a file only its owner can read: it holds the companion token, agent logs or secrets.
pub fn write_private(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        opts.mode(0o600);
        // The mode applies on create only; a file left from an older version keeps its own.
        if path.exists() {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    std::io::Write::write_all(&mut opts.open(path)?, contents.as_ref())
}

pub struct Store {
    dir: PathBuf,
    /// The profile whose settings `data` holds.
    active: Mutex<String>,
    data: RwLock<Config>,
    /// The file as this process last read or wrote it. Another instance on the same folder (a dev
    /// build next to the installed app) writes it too: a different stamp means take theirs in first.
    seen: Mutex<Option<Stamp>>,
}

/// Modification time and size of a file.
type Stamp = (SystemTime, u64);

fn stamp(path: &Path) -> Option<Stamp> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// Returns the stamp of what it wrote.
fn save(path: &Path, cfg: &impl Serialize) -> Result<Option<Stamp>> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // One temp file per process: two instances saving at once would mix their writes in a shared one.
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    write_private(&tmp, serde_json::to_string_pretty(cfg)?)?;
    // Before the rename: a save by another instance right after it then still reads as theirs.
    let saved = stamp(&tmp);
    std::fs::rename(&tmp, path)?;
    Ok(saved)
}

/// A config file, with templates and worktree files added since it was written and unedited default templates brought up to date.
fn parse(raw: &str) -> Result<Config> {
    let mut cfg: Config = serde_json::from_str(raw)?;
    // Kinds added since the config was written get their default templates, and
    // defaults never edited get the body this version ships.
    for t in default_templates() {
        if let Some(x) = cfg.templates.iter_mut().find(|x| x.id == t.id && OLD_BODIES.contains(&(&*x.id, &*x.body))) {
            x.body = t.body.clone();
        }
        if !cfg.templates.iter().any(|x| x.kind == t.kind) {
            cfg.templates.push(t);
        }
    }
    for f in DEFAULT_WORKTREE_FILES.iter().map(|f| f.to_string()) {
        if !cfg.worktree_defaults_added.contains(&f) {
            if !cfg.worktree_files.contains(&f) {
                cfg.worktree_files.push(f.clone());
            }
            cfg.worktree_defaults_added.push(f);
        }
    }
    Ok(cfg)
}

/// The settings at `path`; defaults when there is no file yet.
fn read_config(path: &Path) -> Result<Config> {
    if path.exists() { parse(&std::fs::read_to_string(path)?) } else { Ok(Config::default()) }
}

impl Store {
    pub fn open(dir: &Path) -> Result<Store> {
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Best effort: a GITNETIX_HOME owned by someone else must still open.
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        let active = load_profiles(dir).active;
        let path = profile_path(dir, &active);
        // Nothing saved yet, not even another profile: a first launch.
        let fresh = !path.exists() && !dir.join("profiles.json").exists();
        let mut data = read_config(&path)?;
        data.ui.onboarding |= fresh;
        let seen = save(&path, &data)?;
        crate::secrets::use_profile(&active);
        Ok(Store { dir: dir.to_path_buf(), active: Mutex::new(active), data: RwLock::new(data), seen: Mutex::new(seen) })
    }

    /// The active profile's settings file.
    fn path(&self) -> PathBuf {
        profile_path(&self.dir, &self.active.lock().unwrap())
    }

    pub fn active(&self) -> String {
        self.active.lock().unwrap().clone()
    }

    /// Every profile, the one in use here as the active one.
    pub fn profiles(&self) -> Profiles {
        Profiles { active: self.active(), ..load_profiles(&self.dir) }
    }

    /// Profile `id`'s settings.
    pub fn profile_config(&self, id: &str) -> Result<Config> {
        if id == self.active() {
            return Ok(self.snapshot());
        }
        if !load_profiles(&self.dir).list.iter().any(|p| p.id == id) {
            return Err(Error::NotFound(format!("profile {id}")));
        }
        read_config(&profile_path(&self.dir, id))
    }

    /// Load profile `id`'s settings in place of the current ones, and open on it from now on.
    pub fn switch(&self, id: &str) -> Result<()> {
        // Under the lock: profile changes are read-modify-writes of profiles.json.
        let mut g = self.data.write().expect("config lock");
        if id == self.active() {
            return Ok(());
        }
        let mut profiles = load_profiles(&self.dir);
        if !profiles.list.iter().any(|p| p.id == id) {
            return Err(Error::NotFound(format!("profile {id}")));
        }
        let path = profile_path(&self.dir, id);
        let mut next = read_config(&path)?;
        // The companion API belongs to the computer, not to a profile: the paired phone stays paired.
        next.server = g.server.clone();
        let seen = save(&path, &next)?;
        profiles.active = id.into();
        save(&self.dir.join("profiles.json"), &profiles)?;
        *self.active.lock().unwrap() = id.into();
        *self.seen.lock().unwrap() = seen;
        *g = next;
        crate::secrets::use_profile(id);
        Ok(())
    }

    /// Add profile `p` with settings `data`.
    pub fn add_profile(&self, p: UserProfile, mut data: Config) -> Result<()> {
        let g = self.data.write().expect("config lock");
        data.server = g.server.clone();
        save(&profile_path(&self.dir, &p.id), &data)?;
        let mut profiles = load_profiles(&self.dir);
        profiles.list.push(p);
        save(&self.dir.join("profiles.json"), &profiles)?;
        Ok(())
    }

    /// Rename profile `p.id` or change its avatar.
    pub fn update_profile(&self, p: UserProfile) -> Result<()> {
        let _g = self.data.write().expect("config lock");
        let mut profiles = load_profiles(&self.dir);
        let x = profiles.list.iter_mut().find(|x| x.id == p.id).ok_or_else(|| Error::NotFound(format!("profile {}", p.id)))?;
        *x = p;
        save(&self.dir.join("profiles.json"), &profiles)?;
        Ok(())
    }

    /// Forget profile `id`, which must not be the one in use, and delete its settings file. Returns what they were.
    pub fn remove_profile(&self, id: &str) -> Result<Config> {
        let _g = self.data.write().expect("config lock");
        if id == self.active() {
            return Err(Error::Invalid("Switch to another profile before deleting this one".into()));
        }
        let mut profiles = load_profiles(&self.dir);
        if !profiles.list.iter().any(|p| p.id == id) {
            return Err(Error::NotFound(format!("profile {id}")));
        }
        profiles.list.retain(|p| p.id != id);
        if profiles.active == id {
            profiles.active = self.active();
        }
        let path = profile_path(&self.dir, id);
        // Unreadable settings still go: only the tokens they point to are lost track of.
        let data = read_config(&path).unwrap_or_default();
        save(&self.dir.join("profiles.json"), &profiles)?;
        let _ = std::fs::remove_file(&path);
        Ok(data)
    }

    pub fn read<R>(&self, f: impl FnOnce(&Config) -> R) -> R {
        if stamp(&self.path()) != *self.seen.lock().unwrap() {
            // Never waits: while anyone reads (this thread included) the next read takes it in.
            if let Ok(mut g) = self.data.try_write() {
                self.take_in(&mut g);
            }
        }
        f(&self.data.read().expect("config lock"))
    }

    /// Mutate and persist, on top of what another instance saved meanwhile. Saved under the lock: concurrent saves would share the temp file.
    pub fn write<R>(&self, f: impl FnOnce(&mut Config) -> Result<R>) -> Result<R> {
        let mut g = self.data.write().expect("config lock");
        self.take_in(&mut g);
        let r = f(&mut g)?;
        let saved = save(&self.path(), &*g)?;
        *self.seen.lock().unwrap() = saved;
        Ok(r)
    }

    /// Replace `cfg` (held under the write lock) with the file when another instance saved it since. Kept as is when unreadable.
    fn take_in(&self, cfg: &mut Config) {
        let path = self.path();
        let mut seen = self.seen.lock().unwrap();
        let now = stamp(&path);
        if now == *seen {
            return;
        }
        if let Some(theirs) = std::fs::read_to_string(&path).ok().and_then(|raw| parse(&raw).ok()) {
            *cfg = theirs;
            *seen = now;
        }
    }

    pub fn snapshot(&self) -> Config {
        self.read(|c| c.clone())
    }

    pub fn project(&self, id: &str) -> Result<Project> {
        self.read(|c| c.projects.iter().find(|p| p.id == id).cloned())
            .ok_or_else(|| Error::NotFound(format!("project {id}")))
    }

    pub fn with_project<R>(&self, id: &str, f: impl FnOnce(&mut Project) -> Result<R>) -> Result<R> {
        self.write(|c| {
            let p = c
                .projects
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| Error::NotFound(format!("project {id}")))?;
            f(p)
        })
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn write_private_is_owner_only_even_over_an_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("config.json");
        std::fs::write(&f, "old").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        super::write_private(&f, "new").unwrap();
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "new");
    }

    #[test]
    fn only_a_first_launch_gets_the_first_run_setup() {
        let onboarding = |dir: &std::path::Path| super::Store::open(dir).unwrap().read(|c| c.ui.onboarding);
        let fresh = tempfile::tempdir().unwrap();
        assert!(onboarding(fresh.path()));
        assert!(onboarding(fresh.path()), "shows again until it is finished");
        super::Store::open(fresh.path()).unwrap().write(|c| Ok(c.ui.onboarding = false)).unwrap();
        assert!(!onboarding(fresh.path()));
        // Saved by a version without the setup: the user already went through the app.
        let old = tempfile::tempdir().unwrap();
        std::fs::write(old.path().join("config.json"), r#"{"projects":[]}"#).unwrap();
        assert!(!onboarding(old.path()));
    }

    #[test]
    fn unedited_default_templates_get_todays_body() {
        let dir = tempfile::tempdir().unwrap();
        let open = |id: &str, body: &str| {
            let cfg = serde_json::json!({ "templates": [{ "id": id, "kind": id, "name": "Default", "isDefault": true, "body": body }] });
            std::fs::write(dir.path().join("config.json"), cfg.to_string()).unwrap();
            super::Store::open(dir.path()).unwrap().read(|c| c.templates.iter().find(|t| t.id == id).unwrap().body.clone())
        };
        let today = |id: &str| crate::templates::default_templates().into_iter().find(|t| t.id == id).unwrap().body;
        for &(id, old) in crate::templates::OLD_BODIES {
            assert_eq!(open(id, old), today(id));
        }
        assert_eq!(open("changelog", "Edited."), "Edited.");
    }

    #[test]
    fn configs_from_before_global_skills_get_unslop_on() {
        let dir = tempfile::tempdir().unwrap();
        let globals = |templates: serde_json::Value| {
            std::fs::write(dir.path().join("config.json"), serde_json::json!({ "templates": templates }).to_string()).unwrap();
            super::Store::open(dir.path()).unwrap().read(|c| c.templates.iter().filter(|t| t.kind == "global").map(|t| (t.id.clone(), t.is_default)).collect::<Vec<_>>())
        };
        let old = serde_json::json!([{ "id": "commit-conv", "kind": "commit", "name": "Mine", "isDefault": true, "body": "Edited." }]);
        assert_eq!(globals(old), [("unslop".to_string(), true)]);
        let off = serde_json::json!([{ "id": "unslop", "kind": "global", "name": "Unslop", "isDefault": false, "body": "Edited." }]);
        assert_eq!(globals(off), [("unslop".to_string(), false)], "a skill turned off stays off");
    }

    #[test]
    fn default_worktree_files_are_added_once() {
        let dir = tempfile::tempdir().unwrap();
        let files = || super::Store::open(dir.path()).unwrap().read(|c| c.worktree_files.clone());
        // Saved before the defaults, with its own list: kept, defaults added after it.
        std::fs::write(dir.path().join("config.json"), r#"{"worktreeFiles":["data/", ".env"]}"#).unwrap();
        assert_eq!(files(), ["data/", ".env", "graphify-out/", ".claude/settings.local.json", ".env.local", ".env.example", ".env.example.local"]);
        // Removed ones stay removed.
        super::Store::open(dir.path()).unwrap().write(|c| Ok(c.worktree_files = vec!["data/".into()])).unwrap();
        assert_eq!(files(), ["data/"]);
        // A new profile starts with them, and removing them sticks too.
        let fresh = tempfile::tempdir().unwrap();
        let store = super::Store::open(fresh.path()).unwrap();
        assert_eq!(store.read(|c| c.worktree_files.clone()), super::DEFAULT_WORKTREE_FILES);
        store.write(|c| Ok(c.worktree_files.clear())).unwrap();
        assert!(super::Store::open(fresh.path()).unwrap().read(|c| c.worktree_files.is_empty()));
    }

    #[test]
    fn concurrent_writes_keep_the_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let store = super::Store::open(dir.path()).unwrap();
        std::thread::scope(|s| {
            for i in 0..16 {
                let store = &store;
                s.spawn(move || {
                    for j in 0..20 {
                        store.write(|c| Ok(c.ui.view.insert(format!("k{i}-{j}"), "x".repeat(i * j)))).unwrap();
                    }
                });
            }
        });
        let reopened = super::Store::open(dir.path()).unwrap();
        assert_eq!(reopened.read(|c| c.ui.view.len()), 16 * 20);
    }

    #[test]
    fn another_instance_on_the_same_folder_is_seen_and_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let (mine, theirs) = (super::Store::open(dir.path()).unwrap(), super::Store::open(dir.path()).unwrap());
        let set = |s: &super::Store, k: &str| s.write(|c| Ok(c.ui.view.insert(k.into(), "1".into()))).unwrap();
        let keys = |s: &super::Store| s.read(|c| c.ui.view.keys().cloned().collect::<Vec<_>>());
        set(&theirs, "a");
        assert_eq!(keys(&mine), ["a"]);
        // Written without reading first: theirs is taken in, then saved with mine.
        set(&theirs, "b");
        set(&mine, "c");
        assert_eq!(keys(&super::Store::open(dir.path()).unwrap()), ["a", "b", "c"]);
        assert_eq!(keys(&theirs), ["a", "b", "c"]);
    }

    #[test]
    fn each_profile_keeps_its_own_settings_and_config_json_the_first_ones() {
        use super::{Config, Project, Store, UserProfile, FIRST_PROFILE};
        let _turn = crate::secrets::test_turn();
        let dir = tempfile::tempdir().unwrap();
        let names = |s: &Store| s.read(|c| c.projects.iter().map(|p| p.name.clone()).collect::<Vec<_>>());
        let add = |s: &Store, name: &str| {
            s.write(|c| {
                c.projects.push(Project { name: name.into(), ..Default::default() });
                Ok(())
            })
            .unwrap()
        };
        let store = Store::open(dir.path()).unwrap();
        add(&store, "home");
        store
            .write(|c| {
                c.server.port = 7500;
                Ok(())
            })
            .unwrap();
        store.add_profile(UserProfile { id: "w1".into(), name: "Work".into(), ..Default::default() }, Config::default()).unwrap();
        store.switch("w1").unwrap();
        assert!(names(&store).is_empty());
        assert_eq!(store.read(|c| c.server.port), 7500, "the companion API stays the computer's");
        add(&store, "job");
        // What an older version reads, and rewrites without knowing profiles: the first profile's settings.
        let first: Config = serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap()).unwrap();
        assert_eq!(first.projects[0].name, "home");

        let reopened = Store::open(dir.path()).unwrap();
        assert_eq!(names(&reopened), ["job"], "opens on the profile last switched to");
        assert_eq!(reopened.profiles().list.len(), 2);
        assert!(reopened.remove_profile("w1").is_err(), "the profile in use stays");
        reopened.switch(FIRST_PROFILE).unwrap();
        assert_eq!(names(&reopened), ["home"]);
        assert_eq!(reopened.remove_profile("w1").unwrap().projects[0].name, "job");
        assert!(!dir.path().join("profiles").join("w1.json").exists());
        assert_eq!(reopened.profiles().list.len(), 1);
    }

    #[test]
    fn reads_old_single_connections() {
        use super::Connection;
        let i: super::Integrations = serde_json::from_str(r#"{"trello":{"apiKey":"k"},"asana":null}"#).unwrap();
        assert_eq!(i.trello[0].secret(), "trello");
        assert!(i.asana.is_empty());
        // One board or project per connection, before there could be several.
        let i: super::Integrations = serde_json::from_str(r#"{"trello":[{"boardId":"b1"},{"boardId":null},{"boards":["b2","b3"]}],"asana":[{"projectGid":"p1"}]}"#).unwrap();
        assert_eq!(i.trello.iter().map(|t| t.boards.len()).collect::<Vec<_>>(), [1, 0, 2]);
        assert_eq!(i.asana[0].projects, ["p1"]);
        assert!(serde_json::to_string(&i.trello[0]).unwrap().contains(r#""boards":["b1"]"#));
        let i: super::Integrations = serde_json::from_str(r#"{"jira":{"baseUrl":"https://a.atlassian.net","email":"e"}}"#).unwrap();
        assert_eq!(i.jira.len(), 1);
        assert_eq!(i.jira[0].secret(), "jira");
        let i: super::Integrations = serde_json::from_str(r#"{"jira":null}"#).unwrap();
        assert!(i.jira.is_empty());
        let i: super::Integrations = serde_json::from_str(r#"{"jira":[{"id":"x"},{"id":"y"}]}"#).unwrap();
        assert_eq!(i.jira[1].secret(), "jira.y");
    }
}
