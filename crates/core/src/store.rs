//! Persistent app state: projects, release metadata, profiles, AI setup,
//! templates and integration settings. One JSON file, written atomically.
//! Secrets never live here — see `secrets`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::templates::{default_templates, Template};

pub const CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    pub projects: Vec<Project>,
    pub profiles: Vec<GitProfile>,
    pub ai: AiConfig,
    pub templates: Vec<Template>,
    pub integrations: Integrations,
    pub ui: UiPrefs,
    pub server: ServerConfig,
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
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub profile_id: Option<String>,
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
    /// Merge dialog options, as last chosen.
    pub merge: MergePrefs,
    /// Commit button options.
    pub commit: CommitPrefs,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GenLangs {
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
    /// Branch type: "feat", "fix", "refactor", "perf", "style", "test", "docs", "chore", "ci", "build" or "poc".
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
    pub id: String,
    pub label: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiConfig {
    pub default_provider: String,
    pub providers: BTreeMap<String, ProviderConf>,
    /// Task id (commit, branch, pr, release, conflict, agent, triage) → route.
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
        let r = |m: &str, e: &str| Route { provider: Some("claude".into()), model: Some(m.into()), effort: Some(e.into()) };
        routing.insert("commit".into(), r("claude-haiku-5-5", "low"));
        routing.insert("branch".into(), r("claude-haiku-5-5", "low"));
        routing.insert("pr".into(), r("claude-sonnet-5-5", "medium"));
        routing.insert("release".into(), r("claude-sonnet-5-5", "medium"));
        routing.insert("conflict".into(), r("claude-opus-5-5", "high"));
        routing.insert("agent".into(), r("claude-opus-5-5", "xhigh"));
        routing.insert("triage".into(), r("claude-haiku-5-5", "low"));
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
    /// One per Jira site or account. Older configs held a single object, for each tracker.
    #[serde(deserialize_with = "one_or_many")]
    pub jira: Vec<JiraConf>,
    #[serde(deserialize_with = "one_or_many")]
    pub trello: Vec<TrelloConf>,
    #[serde(deserialize_with = "one_or_many")]
    pub asana: Vec<AsanaConf>,
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
    pub api_key: String,
    pub board_id: Option<String>,
    /// Gitnetix projects whose Tickets screen shows it; empty = all.
    pub repos: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AsanaConf {
    pub id: String,
    pub workspace_gid: String,
    pub project_gid: Option<String>,
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
}

impl Default for UiPrefs {
    fn default() -> Self {
        UiPrefs { language: "en".into(), theme: "system".into(), last_project: None, view: BTreeMap::new(), animations_off: Vec::new() }
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
    path: PathBuf,
    data: RwLock<Config>,
}

fn save(path: &Path, cfg: &Config) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    write_private(&tmp, serde_json::to_string_pretty(cfg)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
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
        let path = dir.join("config.json");
        let data = if path.exists() {
            let raw = std::fs::read_to_string(&path)?;
            let mut cfg: Config = serde_json::from_str(&raw)?;
            // Kinds added since the config was written get their default templates.
            for t in default_templates() {
                if !cfg.templates.iter().any(|x| x.kind == t.kind) {
                    cfg.templates.push(t);
                }
            }
            cfg
        } else {
            Config::default()
        };
        save(&path, &data)?;
        Ok(Store { path, data: RwLock::new(data) })
    }

    pub fn read<R>(&self, f: impl FnOnce(&Config) -> R) -> R {
        f(&self.data.read().expect("config lock"))
    }

    /// Mutate and persist. Saved under the lock: concurrent saves would share the temp file.
    pub fn write<R>(&self, f: impl FnOnce(&mut Config) -> Result<R>) -> Result<R> {
        let mut g = self.data.write().expect("config lock");
        let r = f(&mut g)?;
        save(&self.path, &g)?;
        Ok(r)
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
    fn reads_old_single_connections() {
        use super::Connection;
        let i: super::Integrations = serde_json::from_str(r#"{"trello":{"apiKey":"k"},"asana":null}"#).unwrap();
        assert_eq!(i.trello[0].secret(), "trello");
        assert!(i.asana.is_empty());
        let i: super::Integrations = serde_json::from_str(r#"{"jira":{"baseUrl":"https://a.atlassian.net","email":"e"}}"#).unwrap();
        assert_eq!(i.jira.len(), 1);
        assert_eq!(i.jira[0].secret(), "jira");
        let i: super::Integrations = serde_json::from_str(r#"{"jira":null}"#).unwrap();
        assert!(i.jira.is_empty());
        let i: super::Integrations = serde_json::from_str(r#"{"jira":[{"id":"x"},{"id":"y"}]}"#).unwrap();
        assert_eq!(i.jira[1].secret(), "jira.y");
    }
}
