//! The Gitnetix account: sign-in to the Gitnetix server, plan and billing, the account's encryption keys, encrypted
//! sync of the project list and settings, and enterprises. Everything the server stores is encrypted here first
//! (vault.rs); the server's side of the contract is the back-end README's "End-to-end encryption".

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, to_value, Value};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::git::Git;
use crate::providers::github_auth::{DeviceCode, Poll};
use crate::store::{Config, Project};
use crate::vault::{self, DataKey, Keys};
use crate::{secrets, Gitnetix};

/// Keychain items: the session's tokens, this install's own key pair, and the account public key it trusts.
const TOKENS: &str = "gitnetix.account";
const INSTALL: &str = "gitnetix.install";
const PIN: &str = "gitnetix.account-pin";

/// A project's fields that belong to this computer or to the repository itself: they never sync.
const LOCAL_ONLY: &[&str] = &["id", "name", "path", "addedAt", "hidden", "releases", "branches", "ticketReleases", "aiCommits", "forgottenReleases", "renamedBranches"];

/// The Gitnetix server; `GITNETIX_API_URL` points a dev build or a self-hosted server elsewhere.
pub fn server() -> String {
    std::env::var("GITNETIX_API_URL").unwrap_or_else(|_| "https://api.gitnetix.app".into()).trim_end_matches('/').to_string()
}

/// What this install last synced, to tell which side changed since: by repository key, and for the settings,
/// [this computer's hash, the account's hash] when the two were last in step.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncState {
    /// The account the hashes are with: another account starts over.
    pub user: String,
    pub projects: BTreeMap<String, [String; 2]>,
    pub settings: [String; 2],
    /// By project id: the policies of the enterprises whose list has the project. Enforced by the engine (app.rs).
    pub policies: BTreeMap<String, Policies>,
    /// Live updates on this computer (live.rs), and by project id the webhook made for it.
    pub live: bool,
    pub hooks: BTreeMap<String, crate::live::Hook>,
    /// Daily backups turned off on this computer (backup.rs); on by default.
    pub backups_off: bool,
    /// When this computer last backed up (Unix seconds), and the hash of what it sent.
    pub backed_up_at: Option<i64>,
    pub backed_up_hash: String,
}

/// What an enterprise asks of every computer working on a project of its list. All off until an admin turns one on.
/// Guardrails in Gitnetix: plain git in a terminal isn't stopped.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Policies {
    /// The enterprises that set them, for the messages: kept on this computer, never sent.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub by: String,
    /// No push straight to the default branch or a release branch: changes reach them through pull requests.
    pub protected_branches: bool,
    /// Every commit Gitnetix makes is signed: git refuses one without a signing key.
    pub signed_commits: bool,
    /// New branches of these types only; none = any.
    pub branch_types: Vec<String>,
    /// Agents of these providers only (claude, codex, agy, copilot, ollama); none = any, empty = no agents.
    pub agents: Option<Vec<String>>,
    /// No agent in Bypass: they ask before acting, or let their own safety check decide.
    pub agents_ask: bool,
}

impl Policies {
    pub fn any(&self) -> bool {
        self.protected_branches || self.signed_commits || !self.branch_types.is_empty() || self.agents.is_some() || self.agents_ask
    }

    /// Two enterprises listing one repository: the stricter of each rule.
    fn and(mut self, o: &Policies) -> Policies {
        self.by = [self.by.as_str(), o.by.as_str()].iter().filter(|b| !b.is_empty()).cloned().collect::<Vec<_>>().join(" and ");
        self.protected_branches |= o.protected_branches;
        self.signed_commits |= o.signed_commits;
        if self.branch_types.is_empty() {
            self.branch_types = o.branch_types.clone();
        } else if !o.branch_types.is_empty() {
            let both: Vec<String> = self.branch_types.iter().filter(|t| o.branch_types.contains(t)).cloned().collect();
            // Nothing in common would read as "any": the first enterprise's list stands.
            if !both.is_empty() {
                self.branch_types = both;
            }
        }
        self.agents = match (self.agents.take(), &o.agents) {
            (None, a) => a.clone(),
            (a, None) => a,
            (Some(a), Some(b)) => Some(a.into_iter().filter(|x| b.contains(x)).collect()),
        };
        self.agents_ask |= o.agents_ask;
        self
    }
}

/// Refuses a new branch of a type the project's enterprise doesn't allow (the release dialog's always passes).
pub fn check_branch_type(p: &Policies, kind: &str) -> Result<()> {
    if kind.is_empty() || kind == "release" || p.branch_types.is_empty() || p.branch_types.iter().any(|t| t == kind) {
        return Ok(());
    }
    Err(Error::Invalid(format!("{}'s policy: new branches are {}", p.by, p.branch_types.join(", "))))
}

/// Refuses an agent the project's enterprise doesn't allow, or one in Bypass when it wants agents to ask.
pub fn check_agent(p: &Policies, provider: &str, permission: &str) -> Result<()> {
    if let Some(allowed) = &p.agents {
        if !allowed.iter().any(|a| a == provider) {
            let list = if allowed.is_empty() { "none".to_string() } else { allowed.join(", ") };
            return Err(Error::Invalid(format!("{}'s policy: agents on this project: {list}", p.by)));
        }
    }
    // Only Claude Code and Copilot have modes that ask; the other CLIs always run in Bypass.
    if p.agents_ask && (!matches!(provider, "claude" | "copilot") || permission.is_empty()) {
        return Err(Error::Invalid(format!("{}'s policy: no agent in Bypass. Pick a mode that asks, with Claude Code or Copilot", p.by)));
    }
    Ok(())
}

/// The main checkout of the repository at `cwd`: a worktree's `.git` is a file naming `<main>/.git/worktrees/<name>`.
pub fn main_checkout(cwd: &Path) -> PathBuf {
    std::fs::read_to_string(cwd.join(".git"))
        .ok()
        .and_then(|s| s.strip_prefix("gitdir:").map(|g| g.trim().replace('\\', "/")))
        .and_then(|g| g.split_once("/.git/worktrees/").map(|(main, _)| PathBuf::from(main)))
        .unwrap_or_else(|| cwd.to_path_buf())
}

#[derive(Serialize, Deserialize)]
struct Tokens {
    access: String,
    refresh: String,
    expires: i64,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn saved() -> Option<Tokens> {
    secrets::get(TOKENS).ok().flatten().and_then(|s| serde_json::from_str(&s).ok())
}

fn keep(v: &Value) -> Result<String> {
    let t = Tokens {
        access: v["accessToken"].as_str().unwrap_or_default().into(),
        refresh: v["refreshToken"].as_str().unwrap_or_default().into(),
        expires: now() + v["expiresIn"].as_i64().unwrap_or(900),
    };
    if t.access.is_empty() || t.refresh.is_empty() {
        return Err(Error::Http("The Gitnetix server sent no session".into()));
    }
    secrets::set(TOKENS, &serde_json::to_string(&t)?)?;
    Ok(t.access)
}

fn signed_out() -> Error {
    Error::NotConnected("Gitnetix account".into())
}

/// The server's answer, its refusals as the app's errors: 401 asks for a sign-in, 402 for a plan.
async fn answer(res: reqwest::Response) -> Result<Value> {
    let status = res.status().as_u16();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if status < 300 {
        return Ok(v);
    }
    let message = v["message"].as_str().unwrap_or("The Gitnetix server refused").to_string();
    Err(match status {
        401 => signed_out(),
        402 => Error::Upgrade(message),
        404 => Error::NotFound(message),
        409 => Error::Conflict { code: v["code"].as_str().unwrap_or("conflict").into(), message },
        _ => Error::Http(message),
    })
}

/// Renewals take turns: the server ends a session whose refresh token comes twice.
static RENEWING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A live access token, renewed a minute before it runs out, or when the server just refused `stale`.
async fn access(stale: Option<&str>) -> Result<String> {
    let fresh = |t: &Tokens| stale != Some(t.access.as_str()) && t.expires > now() + 60;
    let t = saved().ok_or_else(signed_out)?;
    if fresh(&t) {
        return Ok(t.access);
    }
    let _turn = RENEWING.lock().await;
    // Renewed by another call while this one waited.
    let t = saved().ok_or_else(signed_out)?;
    if fresh(&t) {
        return Ok(t.access);
    }
    let res = crate::net::client().post(format!("{}/v1/auth/refresh", server())).json(&json!({ "refreshToken": t.refresh })).send().await?;
    match answer(res).await {
        Ok(v) => keep(&v),
        Err(e @ Error::NotConnected(_)) => {
            forget_session();
            Err(e)
        }
        Err(e) => Err(e),
    }
}

/// Calls the server as the signed-in account, once more with a renewed token if it refused the first.
async fn call(method: Method, path: &str, body: Option<Value>) -> Result<Value> {
    let send = |token: &str| {
        let req = crate::net::client().request(method.clone(), format!("{}{path}", server())).bearer_auth(token);
        match &body {
            Some(b) => req.json(b).send(),
            None => req.send(),
        }
    };
    let token = access(None).await?;
    let mut res = send(&token).await?;
    if res.status() == 401 {
        res = send(&access(Some(&token)).await?).await?;
    }
    answer(res).await
}

/// Like `call`, with raw bytes both ways: a backup's upload and download.
pub(crate) async fn call_raw(method: Method, path: &str, body: Option<Vec<u8>>) -> Result<Vec<u8>> {
    let send = |token: &str| {
        let req = crate::net::client().request(method.clone(), format!("{}{path}", server())).bearer_auth(token);
        match &body {
            Some(b) => req.header("content-type", "application/octet-stream").body(b.clone()).send(),
            None => req.send(),
        }
    };
    let token = access(None).await?;
    let mut res = send(&token).await?;
    if res.status() == 401 {
        res = send(&access(Some(&token)).await?).await?;
    }
    if !res.status().is_success() {
        return answer(res).await.map(|_| Vec::new());
    }
    Ok(res.bytes().await?.to_vec())
}

/// The signed-in account's id, and its key opened on this install.
pub(crate) async fn account_key() -> Result<(String, Keys)> {
    unlocked().await
}

/// A route of the server, for the thin RPC methods that only pass a request on.
pub async fn api(method: Method, path: &str, body: Option<Value>) -> Result<Value> {
    call(method, path, body).await
}

/// This install's own key pair, made once and kept in the keychain.
pub(crate) fn install() -> Result<Keys> {
    if let Some(s) = secrets::get(INSTALL)?.filter(|s| !s.is_empty()) {
        return Keys::from_secret(&vault::unb64(&s)?);
    }
    let k = Keys::generate();
    secrets::set(INSTALL, &vault::b64(&k.secret()))?;
    Ok(k)
}

pub async fn sign_in_start() -> Result<DeviceCode> {
    let v = answer(crate::net::client().post(format!("{}/v1/auth/github/device", server())).send().await?).await?;
    let text = |k: &str| v[k].as_str().unwrap_or_default().to_string();
    Ok(DeviceCode {
        device_code: text("deviceCode"),
        user_code: text("userCode"),
        verification_uri: text("verificationUri"),
        interval: v["interval"].as_u64().unwrap_or(5),
        expires_in: v["expiresIn"].as_u64().unwrap_or(900),
    })
}

/// Polls the server while the person enters the code on GitHub. Signing in sends this install's public key, for
/// another install of the account to give it the account key.
pub async fn sign_in_poll(device_code: &str) -> Result<Poll> {
    let body = json!({ "deviceCode": device_code, "publicKey": install()?.public() });
    // The session's name in the account's list of installs, where another install approves this one.
    let name = format!("Gitnetix on {}", computer_name());
    let v = answer(crate::net::client().post(format!("{}/v1/auth/github/token", server())).header("user-agent", name).json(&body).send().await?).await?;
    Ok(match v["status"].as_str() {
        Some("ok") => {
            keep(&v)?;
            Poll::Token(String::new())
        }
        Some("slow_down") => Poll::SlowDown(v["interval"].as_u64().unwrap_or(10)),
        _ => Poll::Pending,
    })
}

/// The computer's name (Windows, Linux), else its system's.
pub(crate) fn computer_name() -> String {
    std::env::var("COMPUTERNAME").ok().or_else(|| std::fs::read_to_string("/etc/hostname").ok()).map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| std::env::consts::OS.to_string())
}

fn forget_session() {
    let _ = secrets::delete(TOKENS);
    let _ = secrets::delete(PIN);
    *UNLOCKED.lock().unwrap() = None;
}

pub async fn sign_out() -> Result<()> {
    if let Ok(token) = access(None).await {
        let _ = crate::net::client().post(format!("{}/v1/auth/logout", server())).bearer_auth(token).send().await;
    }
    forget_session();
    Ok(())
}

/// The account key while this install holds it: in memory only, with the id of the account it opens.
static UNLOCKED: Mutex<Option<(String, [u8; 32])>> = Mutex::new(None);

fn remember(user: &str, account: &Keys) -> Result<()> {
    secrets::set(PIN, &account.public())?;
    *UNLOCKED.lock().unwrap() = Some((user.into(), account.secret()));
    Ok(())
}

/// Where this install stands with the account key: none made yet, waiting for approval, unlocked, changed (the
/// account shows another key than the one this install first trusted: a reset elsewhere, or a server lying), or lost
/// (this install's own key is gone, its keychain cleared: only a new sign-in, approved again, helps).
fn unlock(user: &str, keys: &Value) -> Result<&'static str> {
    let Some(public) = keys["publicKey"].as_str() else { return Ok("none") };
    if secrets::get(PIN)?.is_some_and(|pin| pin != public) {
        return Ok("changed");
    }
    if matches!(&*UNLOCKED.lock().unwrap(), Some((u, _)) if u == user) {
        return Ok("unlocked");
    }
    let Some(envelope) = keys["envelope"].as_str() else { return Ok("waiting") };
    let Ok(secret) = install()?.open(envelope) else { return Ok("lost") };
    let account = Keys::from_secret(&secret)?;
    // A server could hand over a key of its own: only the account's real secret matches its public key.
    if account.public() != public {
        return Err(Error::Invalid("The account key this install was given doesn't match the account".into()));
    }
    remember(user, &account)?;
    Ok("unlocked")
}

/// The signed-in account's id and key, on an install that holds it.
async fn unlocked() -> Result<(String, Keys)> {
    let user = call(Method::GET, "/v1/me", None).await?["id"].as_str().unwrap_or_default().to_string();
    if let Some((u, secret)) = UNLOCKED.lock().unwrap().clone() {
        if u == user {
            return Ok((u, Keys::from_secret(&secret)?));
        }
    }
    let keys = call(Method::GET, "/v1/me/keys", None).await?;
    if unlock(&user, &keys)? != "unlocked" {
        return Err(Error::NotConnected("the account key: approve this install from one already set up, or use the recovery key".into()));
    }
    let secret = UNLOCKED.lock().unwrap().clone().map(|(_, s)| s).ok_or_else(signed_out)?;
    Ok((user, Keys::from_secret(&secret)?))
}

/// Everything the Account page shows, in one call; unlocks the account key when this install was given it.
pub async fn status() -> Result<Value> {
    let out = json!({ "signedIn": false, "server": server() });
    if saved().is_none() {
        return Ok(out);
    }
    let me = match call(Method::GET, "/v1/me", None).await {
        Err(Error::NotConnected(_)) => return Ok(out),
        r => r?,
    };
    let keys = call(Method::GET, "/v1/me/keys", None).await?;
    let user = me["id"].as_str().unwrap_or_default();
    let state = unlock(user, &keys)?;
    let pending: Vec<Value> = match (state, keys["pending"].as_array()) {
        ("unlocked", Some(list)) => list
            .iter()
            .map(|s| json!({ "id": s["id"], "userAgent": s["userAgent"], "createdAt": s["createdAt"], "publicKey": s["publicKey"], "fingerprint": vault::fingerprint(s["publicKey"].as_str().unwrap_or_default()) }))
            .collect(),
        _ => Vec::new(),
    };
    Ok(json!({
        "signedIn": true,
        "server": server(),
        "user": { "id": me["id"], "login": me["login"], "name": me["name"], "avatarUrl": me["avatarUrl"] },
        "plan": me["plan"],
        "billing": me["billing"],
        "enterprises": me["enterprises"],
        "keys": state,
        // What this install shows while it waits: the approving install shows the same.
        "fingerprint": vault::fingerprint(&install()?.public()),
        "accountFingerprint": keys["publicKey"].as_str().map(vault::fingerprint),
        "pending": pending,
    }))
}

/// The account's first install: makes the account key and its recovery key. Returns the recovery key, shown once.
pub async fn setup() -> Result<String> {
    let user = call(Method::GET, "/v1/me", None).await?["id"].as_str().unwrap_or_default().to_string();
    let account = Keys::generate();
    let recovery = vault::new_recovery_key();
    let body = json!({
        "publicKey": account.public(),
        "recovery": vault::lock_with_recovery(&recovery, &account.secret()),
        "envelope": vault::seal(&install()?.public(), &account.secret())?,
    });
    call(Method::PUT, "/v1/me/keys", Some(body)).await?;
    remember(&user, &account)?;
    Ok(recovery)
}

/// Gives a waiting install the account key, sealed to its own key, once the person saw the same fingerprint on both.
pub async fn approve(session: &str, public_key: &str) -> Result<()> {
    let (_, account) = unlocked().await?;
    call(Method::PUT, &format!("/v1/me/sessions/{}/envelope", hex_id(session)?), Some(json!({ "envelope": vault::seal(public_key, &account.secret())? }))).await?;
    Ok(())
}

/// Opens the account key with the recovery key, on an install nobody can approve.
pub async fn recover(recovery_key: &str) -> Result<()> {
    let me = call(Method::GET, "/v1/me", None).await?;
    let keys = call(Method::GET, "/v1/me/keys", None).await?;
    let locked = keys["recovery"].as_str().ok_or_else(|| Error::NotFound("This account has no keys yet".into()))?;
    let account = Keys::from_secret(&vault::open_with_recovery(recovery_key, locked)?)?;
    if keys["publicKey"].as_str() != Some(account.public().as_str()) {
        return Err(Error::Invalid("That recovery key doesn't match this account".into()));
    }
    let sessions = call(Method::GET, "/v1/me/sessions", None).await?;
    let mine = sessions.as_array().and_then(|l| l.iter().find(|s| s["current"] == true)).and_then(|s| s["id"].as_str()).ok_or_else(signed_out)?.to_string();
    // A key that changed since this install first trusted one: the recovery key proves the new one.
    secrets::delete(PIN)?;
    let envelope = vault::seal(&install()?.public(), &account.secret())?;
    match call(Method::PUT, &format!("/v1/me/sessions/{mine}/envelope"), Some(json!({ "envelope": envelope }))).await {
        Ok(_) | Err(Error::NotFound(_)) => {}
        Err(e) => return Err(e),
    }
    remember(me["id"].as_str().unwrap_or_default(), &account)
}

/// Every install and the recovery key are lost: deletes what the old key encrypted and makes a new key.
pub async fn reset() -> Result<String> {
    call(Method::DELETE, "/v1/me/keys", None).await?;
    forget_key();
    setup().await
}

/// Trust the account key the server shows now, after a reset made on another install.
pub fn forget_key() {
    let _ = secrets::delete(PIN);
    *UNLOCKED.lock().unwrap() = None;
}

/// A 24-hex id, before it goes into a path.
pub fn hex_id(id: &str) -> Result<&str> {
    if id.len() == 24 && id.bytes().all(|b| b.is_ascii_hexdigit()) { Ok(id) } else { Err(Error::Invalid(format!("not an id: {id}"))) }
}

fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}

/// A project as the account keeps it: its name, its origin, and the settings that mean the same on every computer.
fn project_payload(p: &Project, remote: &str) -> Value {
    let mut settings = serde_json::to_value(p).unwrap_or_default();
    if let Value::Object(m) = &mut settings {
        for k in LOCAL_ONLY {
            m.remove(*k);
        }
    }
    json!({ "name": p.name, "remote": vault::clean_remote(remote), "settings": settings })
}

fn apply_project(p: &mut Project, settings: &Value) -> Result<()> {
    let mut v = serde_json::to_value(&*p)?;
    if let (Value::Object(mine), Value::Object(theirs)) = (&mut v, settings) {
        for (k, val) in theirs.iter().filter(|(k, _)| !LOCAL_ONLY.contains(&k.as_str())) {
            mine.insert(k.clone(), val.clone());
        }
    }
    *p = serde_json::from_value(v)?;
    Ok(())
}

/// The settings that follow the account: look, AI prompts and routing, worktree paths. Not window sizes, not the
/// companion's token, not connections, whose tokens stay in each computer's keychain.
fn settings_payload(c: &Config) -> Value {
    json!({
        "ui": { "language": c.ui.language, "theme": c.ui.theme, "animationsOff": c.ui.animations_off, "dictationPolish": c.ui.dictation_polish },
        "templates": c.templates,
        "ai": { "defaultProvider": c.ai.default_provider, "routing": c.ai.routing },
        "worktreeFiles": c.worktree_files,
        "worktreeLinks": c.worktree_links,
    })
}

fn apply_settings(c: &mut Config, v: &Value) -> Result<()> {
    fn take<T: serde::de::DeserializeOwned>(v: &Value, into: &mut T) -> Result<()> {
        if !v.is_null() {
            *into = serde_json::from_value(v.clone())?;
        }
        Ok(())
    }
    take(&v["ui"]["language"], &mut c.ui.language)?;
    take(&v["ui"]["theme"], &mut c.ui.theme)?;
    take(&v["ui"]["animationsOff"], &mut c.ui.animations_off)?;
    take(&v["ui"]["dictationPolish"], &mut c.ui.dictation_polish)?;
    take(&v["templates"], &mut c.templates)?;
    take(&v["ai"]["defaultProvider"], &mut c.ai.default_provider)?;
    take(&v["ai"]["routing"], &mut c.ai.routing)?;
    take(&v["worktreeFiles"], &mut c.worktree_files)?;
    take(&v["worktreeLinks"], &mut c.worktree_links)
}

/// Each project's origin, by project id: projects without one have nothing to sync.
async fn origins(projects: &[Project]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for p in projects {
        if let Ok(Some(url)) = Git::new(&p.path).remote_url("origin").await {
            out.insert(p.id.clone(), url);
        }
    }
    out
}

/// Two-way sync of the project list and the settings with the account. The side that changed since the last sync
/// wins, this computer when both did; on a first sync here the account wins, so a new computer takes your settings.
/// Returns the account's projects that aren't on this computer, to clone.
pub async fn sync(k: &Gitnetix) -> Result<Value> {
    let (user, account) = unlocked().await?;
    let key = DataKey::derive(&account.secret());
    let mut state = k.store.read(|c| c.account.clone());
    if state.user != user {
        state = SyncState { user: user.clone(), ..Default::default() };
    }
    let before = state.clone();
    let slot = |kind: &str, name: &str| format!("{user}/{kind}/{name}");

    let mut theirs: HashMap<String, (String, Value)> = HashMap::new();
    for r in call(Method::GET, "/v1/me/projects", None).await?.as_array().cloned().unwrap_or_default() {
        let (Some(id), Some(rk), Some(data)) = (r["id"].as_str(), r["key"].as_str(), r["data"].as_str()) else { continue };
        if let Some(v) = key.open(&slot("project", rk), data).ok().and_then(|p| serde_json::from_slice::<Value>(&p).ok()) {
            theirs.insert(rk.into(), (id.into(), v));
        }
    }

    let projects = k.store.read(|c| c.projects.clone());
    let remotes = origins(&projects).await;
    let (mut mine, mut pulled, mut pushed) = (HashSet::new(), Vec::new(), 0);
    for p in &projects {
        let Some(remote) = remotes.get(&p.id) else { continue };
        let rk = key.repo_key(remote);
        mine.insert(rk.clone());
        let local = project_payload(p, remote);
        let (lh, last) = (hash(&local), state.projects.get(&rk).cloned());
        match theirs.get(&rk) {
            Some((_, r)) if last.as_ref().is_some_and(|[l, t]| *l == lh && *t == hash(r)) => {}
            // Only the account changed, or this is the first sync here: the account's settings come in.
            Some((_, r)) if last.as_ref().is_none_or(|[l, _]| *l == lh) => {
                let mut updated = p.clone();
                apply_project(&mut updated, &r["settings"])?;
                state.projects.insert(rk, [hash(&project_payload(&updated, remote)), hash(r)]);
                pulled.push(updated);
            }
            _ => {
                let data = key.seal(&slot("project", &rk), local.to_string().as_bytes());
                call(Method::POST, "/v1/me/projects", Some(json!({ "key": rk, "data": data }))).await?;
                state.projects.insert(rk, [lh.clone(), lh]);
                pushed += 1;
            }
        }
    }
    let missing: Vec<Value> = theirs.iter().filter(|(rk, _)| !mine.contains(*rk)).map(|(_, (id, v))| json!({ "id": id, "name": v["name"], "remote": v["remote"] })).collect();

    let remote_cfg = call(Method::GET, "/v1/me/config", None).await?;
    let entry = &remote_cfg["settings"];
    let remote_settings = entry["data"].as_str().and_then(|d| key.open(&slot("config", "settings"), d).ok()).and_then(|p| serde_json::from_slice::<Value>(&p).ok());
    let local = k.store.read(settings_payload);
    let lh = hash(&local);
    let [last_local, last_theirs] = state.settings.clone();
    let mut settings_pulled = false;
    match remote_settings {
        Some(r) if last_local == lh && last_theirs == hash(&r) => {}
        Some(r) if last_local.is_empty() || last_local == lh => {
            k.store.write(|c| apply_settings(c, &r))?;
            state.settings = [hash(&k.store.read(settings_payload)), hash(&r)];
            settings_pulled = true;
        }
        _ => {
            let body = json!({ "data": key.seal(&slot("config", "settings"), local.to_string().as_bytes()), "version": entry["version"].as_u64().unwrap_or(0) });
            match call(Method::PUT, "/v1/me/config/settings", Some(body)).await {
                Ok(_) => state.settings = [lh.clone(), lh],
                // Another computer wrote in between: the next sync takes theirs in.
                Err(Error::Conflict { .. }) => {}
                Err(e) => return Err(e),
            }
        }
    }

    // Each enterprise's policies, on the projects of its list that this computer has.
    let mut rules: HashMap<String, Policies> = HashMap::new();
    let me = call(Method::GET, "/v1/me", None).await?;
    for e in me["enterprises"].as_array().cloned().unwrap_or_default() {
        let (Some(id), Some(name)) = (e["id"].as_str(), e["name"].as_str()) else { continue };
        // An enterprise whose key this account doesn't hold yet sets nothing here: its rules can't be read.
        let Ok((policies, keys)) = team_policies(id, &account).await else { continue };
        if !policies.any() {
            continue;
        }
        let policies = Policies { by: name.into(), ..policies };
        for remote in team_remotes(id, &keys).await.unwrap_or_default() {
            let merged = match rules.remove(&remote) {
                Some(r) => r.and(&policies),
                None => policies.clone(),
            };
            rules.insert(remote, merged);
        }
    }
    state.policies = projects.iter().filter_map(|p| Some((p.id.clone(), rules.get(&vault::normalize_remote(remotes.get(&p.id)?))?.clone()))).collect();
    // A branch types policy is the project's list of types: the new branch dialogs offer those, and release.
    let typed: Vec<(String, Vec<String>)> = state
        .policies
        .iter()
        .filter(|(_, p)| !p.branch_types.is_empty())
        .map(|(id, p)| (id.clone(), p.branch_types.iter().cloned().chain((!p.branch_types.iter().any(|t| t == "release")).then(|| "release".to_string())).collect::<Vec<_>>()))
        .filter(|(id, types)| projects.iter().any(|p| p.id == *id && p.branch_types.list.iter().map(|t| &t.id).ne(types.iter())))
        .collect();

    if !pulled.is_empty() || !typed.is_empty() || state != before {
        k.store.write(|c| {
            for updated in &pulled {
                if let Some(p) = c.projects.iter_mut().find(|p| p.id == updated.id) {
                    *p = updated.clone();
                }
            }
            for (id, types) in &typed {
                if let Some(p) = c.projects.iter_mut().find(|p| p.id == *id) {
                    p.branch_types.list = types.iter().map(|t| crate::store::BranchType { id: t.clone(), pinned: false }).collect();
                }
            }
            c.account = state.clone();
            Ok(())
        })?;
    }
    // Live updates follow the project list, and the daily backup goes out; their trouble never fails the sync.
    if let Err(e) = crate::live::ensure(k).await {
        crate::log::error(format!("Live updates: {e}"));
    }
    if me["plan"]["id"].as_str().is_some_and(|p| p != "free") {
        if let Err(e) = crate::backup::daily(k).await {
            crate::log::error(format!("Daily backup: {e}"));
        }
    }
    Ok(json!({ "missing": missing, "pushed": pushed, "pulled": pulled.len(), "settingsPulled": settings_pulled }))
}

/// An enterprise's policies from its config (all off when it set none), opened with the key of their epoch.
fn read_policies(enterprise: &str, keys: &BTreeMap<u64, Vec<u8>>, cfg: &Value) -> Result<Policies> {
    let entry = &cfg["policies"];
    match (entry["epoch"].as_u64().and_then(|e| keys.get(&e)), entry["data"].as_str()) {
        (Some(root), Some(data)) => Ok(serde_json::from_slice(&DataKey::derive(root).open(&format!("{enterprise}/config/policies"), data)?)?),
        _ => Ok(Policies::default()),
    }
}

async fn team_policies(enterprise: &str, account: &Keys) -> Result<(Policies, BTreeMap<u64, Vec<u8>>)> {
    let (_, keys, _) = team_keys(enterprise, account).await?;
    let cfg = call(Method::GET, &format!("/v1/enterprises/{enterprise}/config"), None).await?;
    Ok((read_policies(enterprise, &keys, &cfg)?, keys))
}

/// The repositories on an enterprise's list, as `vault::normalize_remote` writes them.
async fn team_remotes(enterprise: &str, keys: &BTreeMap<u64, Vec<u8>>) -> Result<Vec<String>> {
    let list = call(Method::GET, &format!("/v1/enterprises/{enterprise}/projects"), None).await?;
    Ok(list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let root = keys.get(&p["epoch"].as_u64()?)?;
            let plain = DataKey::derive(root).open(&team_slot(enterprise, p["key"].as_str()?), p["data"].as_str()?).ok()?;
            Some(vault::normalize_remote(serde_json::from_slice::<Value>(&plain).ok()?["remote"].as_str()?))
        })
        .collect())
}

/// Admin: the enterprise's policies, encrypted with its key like the rest of its config. Members' apps take them in at
/// their next sync.
pub async fn set_policies(enterprise: &str, policies: &Value) -> Result<()> {
    let id = hex_id(enterprise)?;
    let mut p: Policies = serde_json::from_value(policies.clone())?;
    p.by.clear();
    let (_, account) = unlocked().await?;
    let (epoch, keys, _) = team_keys(id, &account).await?;
    let key = DataKey::derive(keys.get(&epoch).ok_or_else(|| Error::NotConnected("this enterprise's key: another admin shares it with you first".into()))?);
    let data = key.seal(&format!("{id}/config/policies"), serde_json::to_string(&p)?.as_bytes());
    call(Method::PUT, &format!("/v1/enterprises/{id}/config/policies"), Some(json!({ "data": data, "epoch": epoch }))).await?;
    Ok(())
}

/// The enterprise key of each epoch this account holds, and what the server said about them.
async fn team_keys(enterprise: &str, account: &Keys) -> Result<(u64, BTreeMap<u64, Vec<u8>>, Value)> {
    let v = call(Method::GET, &format!("/v1/enterprises/{enterprise}/keys"), None).await?;
    let mut keys = BTreeMap::new();
    for e in v["envelopes"].as_array().into_iter().flatten() {
        if let (Some(epoch), Some(Ok(k))) = (e["epoch"].as_u64(), e["envelope"].as_str().map(|s| account.open(s))) {
            keys.insert(epoch, k);
        }
    }
    Ok((v["epoch"].as_u64().unwrap_or(1), keys, v))
}

fn team_slot(enterprise: &str, rk: &str) -> String {
    format!("{enterprise}/project/{rk}")
}

/// One enterprise for its page: members, invitations (admins), team projects opened with the enterprise key, and the
/// members waiting for that key, with the fingerprint to check before giving it.
pub async fn enterprise(k: &Gitnetix, id: &str) -> Result<Value> {
    let id = hex_id(id)?;
    let (_, account) = unlocked().await?;
    let mut info = call(Method::GET, &format!("/v1/enterprises/{id}"), None).await?;
    let admin = matches!(info["role"].as_str(), Some("owner" | "admin"));
    info["members"] = call(Method::GET, &format!("/v1/enterprises/{id}/members"), None).await?;
    info["invitations"] = if admin { call(Method::GET, &format!("/v1/enterprises/{id}/invitations"), None).await? } else { json!([]) };
    let (epoch, keys, kv) = team_keys(id, &account).await?;
    let local = origins(&k.store.read(|c| c.projects.clone())).await;
    let here: HashSet<String> = local.values().map(|u| vault::normalize_remote(u)).collect();
    let mut projects = Vec::new();
    for p in call(Method::GET, &format!("/v1/enterprises/{id}/projects"), None).await?.as_array().cloned().unwrap_or_default() {
        let opened = p["epoch"].as_u64().and_then(|e| keys.get(&e)).and_then(|root| {
            let plain = DataKey::derive(root).open(&team_slot(id, p["key"].as_str()?), p["data"].as_str()?).ok()?;
            serde_json::from_slice::<Value>(&plain).ok()
        });
        projects.push(match opened {
            Some(v) => json!({ "id": p["id"], "name": v["name"], "remote": v["remote"], "here": here.contains(&vault::normalize_remote(v["remote"].as_str().unwrap_or_default())) }),
            None => json!({ "id": p["id"], "locked": true }),
        });
    }
    // This computer's projects already on the list: the page offers to add the others only.
    let listed: HashSet<String> = projects.iter().filter_map(|p| p["remote"].as_str()).map(vault::normalize_remote).collect();
    info["onList"] = json!(local.iter().filter(|(_, u)| listed.contains(&vault::normalize_remote(u))).map(|(id, _)| id).collect::<Vec<_>>());
    info["projects"] = json!(projects);
    info["hasKey"] = json!(keys.contains_key(&epoch));
    info["policies"] = to_value(read_policies(id, &keys, &call(Method::GET, &format!("/v1/enterprises/{id}/config"), None).await?).unwrap_or_default())?;
    info["waiting"] = json!(kv["waiting"].as_array().into_iter().flatten().map(|w| {
        let mut w = w.clone();
        w["fingerprint"] = json!(vault::fingerprint(w["publicKey"].as_str().unwrap_or_default()));
        w
    }).collect::<Vec<_>>());
    Ok(info)
}

/// A new enterprise with its first key, sealed to this account's own public key.
pub async fn create_enterprise(name: &str) -> Result<Value> {
    let (_, account) = unlocked().await?;
    let envelope = vault::seal(&account.public(), &vault::random32())?;
    call(Method::POST, "/v1/enterprises", Some(json!({ "name": name, "envelope": envelope }))).await
}

/// Admin: gives a member the current enterprise key, sealed to their account key, once the admin checked its fingerprint.
pub async fn share_key(enterprise: &str, member: &str, public_key: &str) -> Result<()> {
    let (enterprise, member) = (hex_id(enterprise)?, hex_id(member)?);
    let (_, account) = unlocked().await?;
    let (epoch, keys, _) = team_keys(enterprise, &account).await?;
    let key = keys.get(&epoch).ok_or_else(|| Error::NotConnected("this enterprise's key: another admin shares it with you first".into()))?;
    call(Method::PUT, &format!("/v1/enterprises/{enterprise}/keys/{member}"), Some(json!({ "epoch": epoch, "envelope": vault::seal(public_key, key)? }))).await?;
    Ok(())
}

/// Admin, after someone left: a new enterprise key for every member with account keys, then every team project
/// encrypted again with it, so the one who left can't open anything written from now on.
pub async fn rotate_key(enterprise: &str) -> Result<()> {
    let id = hex_id(enterprise)?;
    let (user, account) = unlocked().await?;
    let (epoch, keys, _) = team_keys(id, &account).await?;
    let fresh = vault::random32();
    let mut envelopes = vec![json!({ "userId": user, "envelope": vault::seal(&account.public(), &fresh)? })];
    for m in call(Method::GET, &format!("/v1/enterprises/{id}/members"), None).await?.as_array().cloned().unwrap_or_default() {
        if let (Some(uid), Some(pk)) = (m["userId"].as_str(), m["publicKey"].as_str()) {
            if uid != user {
                envelopes.push(json!({ "userId": uid, "envelope": vault::seal(pk, &fresh)? }));
            }
        }
    }
    call(Method::POST, &format!("/v1/enterprises/{id}/keys/rotate"), Some(json!({ "epoch": epoch + 1, "envelopes": envelopes }))).await?;
    let new = DataKey::derive(&fresh);
    for p in call(Method::GET, &format!("/v1/enterprises/{id}/projects"), None).await?.as_array().cloned().unwrap_or_default() {
        let Some(old) = p["epoch"].as_u64().and_then(|e| keys.get(&e)).map(|root| DataKey::derive(root)) else { continue };
        let (Some(pid), Some(rk), Some(data)) = (p["id"].as_str(), p["key"].as_str(), p["data"].as_str()) else { continue };
        let Ok(plain) = old.open(&team_slot(id, rk), data) else { continue };
        let v: Value = serde_json::from_slice(&plain)?;
        let nk = new.repo_key(v["remote"].as_str().unwrap_or_default());
        let body = json!({ "key": nk, "data": new.seal(&team_slot(id, &nk), &plain), "epoch": epoch + 1 });
        call(Method::PATCH, &format!("/v1/enterprises/{id}/projects/{pid}"), Some(body)).await?;
    }
    // The config (its policies) moves to the new key too.
    for (name, entry) in call(Method::GET, &format!("/v1/enterprises/{id}/config"), None).await?.as_object().cloned().unwrap_or_default() {
        let slot = format!("{id}/config/{name}");
        let Some(old) = entry["epoch"].as_u64().and_then(|e| keys.get(&e)).map(|root| DataKey::derive(root)) else { continue };
        let Some(Ok(plain)) = entry["data"].as_str().map(|d| old.open(&slot, d)) else { continue };
        let body = json!({ "data": new.seal(&slot, &plain), "epoch": epoch + 1, "version": entry["version"] });
        call(Method::PUT, &format!("/v1/enterprises/{id}/config/{name}"), Some(body)).await?;
    }
    Ok(())
}

/// Puts one of this computer's projects on the enterprise's list: its name and origin, nothing else, so no member
/// sets what runs on another's computer.
pub async fn add_team_project(k: &Gitnetix, enterprise: &str, project: &str) -> Result<Value> {
    let id = hex_id(enterprise)?;
    let p = k.store.read(|c| c.projects.iter().find(|p| p.id == project).cloned()).ok_or_else(|| Error::NotFound(format!("project {project}")))?;
    let remote = Git::new(&p.path).remote_url("origin").await?.ok_or_else(|| Error::Invalid(format!("{} has no origin to share", p.name)))?;
    let (_, account) = unlocked().await?;
    let (epoch, keys, _) = team_keys(id, &account).await?;
    let key = DataKey::derive(keys.get(&epoch).ok_or_else(|| Error::NotConnected("this enterprise's key: an admin shares it with you first".into()))?);
    let rk = key.repo_key(&remote);
    let plain = json!({ "name": p.name, "remote": vault::clean_remote(&remote) }).to_string();
    call(Method::POST, &format!("/v1/enterprises/{id}/projects"), Some(json!({ "key": rk, "data": key.seal(&team_slot(id, &rk), plain.as_bytes()), "epoch": epoch }))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policies_are_off_until_set_and_the_stricter_rule_wins() {
        assert!(!Policies::default().any());
        let a = Policies { by: "Acme".into(), branch_types: vec!["feat".into(), "fix".into()], agents: Some(vec!["claude".into(), "codex".into()]), ..Default::default() };
        let b = Policies { by: "Studio".into(), protected_branches: true, branch_types: vec!["fix".into(), "chore".into()], agents: Some(vec!["claude".into()]), ..Default::default() };
        let both = a.clone().and(&b);
        assert_eq!(both.by, "Acme and Studio");
        assert!(both.protected_branches && !both.signed_commits);
        assert_eq!(both.branch_types, ["fix"]);
        assert_eq!(both.agents, Some(vec!["claude".to_string()]));
        let disjoint = a.clone().and(&Policies { branch_types: vec!["docs".into()], ..Default::default() });
        assert_eq!(disjoint.branch_types, ["feat", "fix"]);
        assert_eq!(Policies::default().and(&a).agents, a.agents);
    }

    #[test]
    fn the_checks_refuse_what_the_policies_rule_out_and_name_who_asked() {
        let p = Policies { by: "Acme".into(), branch_types: vec!["feat".into(), "fix".into()], agents: Some(vec!["claude".into(), "copilot".into()]), agents_ask: true, ..Default::default() };
        assert!(check_branch_type(&p, "feat").is_ok() && check_branch_type(&p, "release").is_ok() && check_branch_type(&p, "").is_ok());
        assert!(check_branch_type(&p, "poc").unwrap_err().to_string().contains("Acme's policy: new branches are feat, fix"));
        assert!(check_agent(&p, "codex", "acceptEdits").unwrap_err().to_string().contains("agents on this project: claude, copilot"));
        assert!(check_agent(&p, "claude", "").is_err(), "Bypass");
        assert!(check_agent(&p, "claude", "acceptEdits").is_ok() && check_agent(&p, "copilot", "auto").is_ok());
        let none = Policies { agents: Some(vec![]), ..Default::default() };
        assert!(check_agent(&none, "claude", "cli").unwrap_err().to_string().contains("none"));
        assert!(check_agent(&Policies::default(), "ollama", "").is_ok());
        let ask_only = Policies { agents_ask: true, ..Default::default() };
        assert!(check_agent(&ask_only, "ollama", "cli").is_err(), "the other CLIs can't ask");
    }

    #[test]
    fn a_worktree_belongs_to_its_main_checkout() {
        let dir = std::env::temp_dir().join(format!("gnx-main-checkout-{}", std::process::id()));
        let (main, wt) = (dir.join("repo"), dir.join("repo.feat-x"));
        std::fs::create_dir_all(main.join(".git")).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}/.git/worktrees/repo.feat-x\n", main.display())).unwrap();
        assert_eq!(main_checkout(&wt), main);
        assert_eq!(main_checkout(&main), main);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_server_never_gets_who_set_the_policies() {
        let p = Policies { by: "Acme".into(), protected_branches: true, ..Default::default() };
        let mut cleared = p.clone();
        cleared.by.clear();
        assert!(!serde_json::to_string(&cleared).unwrap().contains("by"));
        assert!(serde_json::to_string(&p).unwrap().contains("\"by\":\"Acme\""));
    }

    #[test]
    fn only_portable_project_settings_travel() {
        let p = Project { id: "local-id".into(), name: "api".into(), path: "/home/me/api".into(), hidden: true, ..Default::default() };
        let v = project_payload(&p, "https://x:ghp_token@github.com/acme/api.git");
        assert_eq!(v["remote"], "https://github.com/acme/api.git");
        assert_eq!(v["name"], "api");
        for k in LOCAL_ONLY {
            assert!(v["settings"].get(*k).is_none(), "{k} must stay on this computer");
        }
        assert!(v["settings"].get("branchTypes").is_some());

        let mut here = Project { id: "mine".into(), name: "my-api".into(), path: "/work/api".into(), ..Default::default() };
        let mut theirs = v["settings"].clone();
        theirs["commit"]["autoPush"] = json!(true);
        theirs["path"] = json!("/somewhere/else");
        apply_project(&mut here, &theirs).unwrap();
        assert!(here.commit.auto_push);
        assert_eq!((here.id.as_str(), here.name.as_str(), here.path.as_str()), ("mine", "my-api", "/work/api"));
    }

    #[test]
    fn settings_carry_look_and_ai_routing_but_not_this_computers_state_or_secrets() {
        let mut c = Config::default();
        c.ui.theme = "nord".into();
        c.ui.last_project = Some("local".into());
        c.server.token = "pairing-secret".into();
        let v = settings_payload(&c);
        assert_eq!(v["ui"]["theme"], "nord");
        let text = v.to_string();
        assert!(!text.contains("pairing-secret") && !text.contains("lastProject"));

        let mut other = Config::default();
        other.ui.last_project = Some("theirs".into());
        apply_settings(&mut other, &v).unwrap();
        assert_eq!(other.ui.theme, "nord");
        assert_eq!(other.ui.last_project.as_deref(), Some("theirs"));
    }
}
