//! Live updates: this computer stays on the Gitnetix relay, and GitHub webhooks for its projects reach it there, so pull
//! requests, checks and pushes show without waiting for the next poll. The server only passes on "hook X fired event
//! Y": Gitnetix reads what changed itself, with its own GitHub sign-in.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, Message};

use crate::error::{Error, Result};
use crate::events::Event;
use crate::providers::github::GitHub;
use crate::providers::RepoRef;
use crate::{account, secrets, Gitnetix};

/// Keychain item: this computer as a host of the account, `{id, token}`. The token opens the relay and nothing else.
const DEVICE: &str = "gitnetix.device";

/// GitHub events that change what Gitnetix shows: pull requests, their reviews and comments, checks, pushes.
const EVENTS: &[&str] = &["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "check_run", "check_suite", "status", "workflow_run", "push"];

/// A project's webhook: the server's (`id`) and GitHub's on `repo` (owner/repo). Or why it has none.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Hook {
    pub id: String,
    pub github: u64,
    pub repo: String,
    pub error: Option<String>,
}

/// What the relay task works from: it lives past the call that started it, so it can't hold the store.
struct Live {
    on: bool,
    connected: bool,
    /// The server removed this computer (revoked elsewhere): the next sync turns live updates off for good.
    revoked: bool,
    /// Server hook id → project id.
    hooks: BTreeMap<String, String>,
}

static LIVE: Mutex<Live> = Mutex::new(Live { on: false, connected: false, revoked: false, hooks: BTreeMap::new() });
static RUNNING: AtomicBool = AtomicBool::new(false);

fn stored_host() -> Option<(String, String)> {
    let v: Value = serde_json::from_str(&secrets::get(DEVICE).ok()??).ok()?;
    Some((v["id"].as_str()?.into(), v["token"].as_str()?.into()))
}

/// This computer as a host of the account, made once.
async fn host() -> Result<String> {
    if let Some((id, _)) = stored_host() {
        return Ok(id);
    }
    let body = json!({ "name": account::computer_name(), "platform": std::env::consts::OS, "publicKey": account::install()?.public() });
    let v = account::api(Method::POST, "/v1/devices/hosts", Some(body)).await?;
    let (Some(id), Some(token)) = (v["device"]["id"].as_str(), v["token"].as_str()) else { return Err(Error::Http("The Gitnetix server made no device".into())) };
    secrets::set(DEVICE, &json!({ "id": id, "token": token }).to_string())?;
    Ok(id.into())
}

/// One project's webhook: the server makes the URL, GitHub gets it. On a refusal, the reason, and nothing left behind.
async fn add(k: &Gitnetix, host: &str, project: &str) -> Hook {
    let failed = |e: Error| Hook { error: Some(e.to_string()), ..Default::default() };
    let gh = match k.github(project).await {
        Ok(gh) => gh,
        Err(e) => return failed(e),
    };
    let made = match account::api(Method::POST, &format!("/v1/devices/{host}/webhooks"), None).await {
        Ok(v) => v,
        Err(e) => return failed(e),
    };
    let (id, url) = (made["id"].as_str().unwrap_or_default().to_string(), made["url"].as_str().unwrap_or_default());
    match gh.create_hook(url, EVENTS).await {
        Ok(github) => Hook { id, github, repo: format!("{}/{}", gh.repo.owner, gh.repo.repo), error: None },
        Err(e) => {
            let _ = account::api(Method::DELETE, &format!("/v1/devices/{host}/webhooks/{id}"), None).await;
            // GitHub answers 404 rather than say the repository exists but isn't the user's to change.
            let text = e.to_string();
            failed(if text.contains(" 404") || text.contains(" 403") { Error::Other("Needs admin rights on the GitHub repository".into()) } else { e })
        }
    }
}

/// Deletes a webhook on GitHub and on the server; one already gone is fine.
async fn remove(k: &Gitnetix, host: &str, h: &Hook) {
    if let (true, Some((owner, repo))) = (h.github != 0, h.repo.split_once('/')) {
        let api = k.store.read(|c| c.integrations.github_api.clone()).filter(|s| !s.is_empty());
        if let Ok(token) = crate::providers::github_auth::token(None).await {
            let _ = GitHub::new(RepoRef { owner: owner.into(), repo: repo.into(), ..Default::default() }, token, api).delete_hook(h.github).await;
        }
    }
    if !h.id.is_empty() {
        let _ = account::api(Method::DELETE, &format!("/v1/devices/{host}/webhooks/{}", h.id), None).await;
    }
}

/// A webhook for each project that has none yet, none for projects removed since, and the relay task told which is which.
async fn reconcile(k: &Gitnetix, host: &str) -> Result<()> {
    let projects = k.store.read(|c| c.projects.clone());
    let before = k.store.read(|c| c.account.hooks.clone());
    let mut hooks = before.clone();
    for p in &projects {
        if !hooks.contains_key(&p.id) {
            hooks.insert(p.id.clone(), add(k, host, &p.id).await);
        }
    }
    for (project, h) in &before {
        if !projects.iter().any(|p| p.id == *project) {
            remove(k, host, h).await;
            hooks.remove(project);
        }
    }
    if hooks != before {
        k.store.write(|c| {
            c.account.hooks = hooks.clone();
            Ok(())
        })?;
    }
    LIVE.lock().unwrap().hooks = hooks.iter().filter(|(_, h)| !h.id.is_empty()).map(|(project, h)| (h.id.clone(), project.clone())).collect();
    Ok(())
}

/// Turns live updates on (webhooks on GitHub, this computer on the relay) or off (both gone).
pub async fn set(k: &Gitnetix, on: bool) -> Result<Value> {
    if on {
        let host = host().await?;
        k.store.write(|c| {
            c.account.live = true;
            Ok(())
        })?;
        reconcile(k, &host).await?;
        start(k);
    } else {
        // Never made a device just to turn off.
        stop(k, &stored_host().map(|(id, _)| id).unwrap_or_default()).await?;
    }
    Ok(status(k))
}

async fn stop(k: &Gitnetix, host: &str) -> Result<()> {
    for h in k.store.read(|c| c.account.hooks.values().cloned().collect::<Vec<_>>()) {
        remove(k, host, &h).await;
    }
    k.store.write(|c| {
        c.account.live = false;
        c.account.hooks.clear();
        Ok(())
    })?;
    LIVE.lock().unwrap().on = false;
    Ok(())
}

/// At sign-out, while the session still opens the server: every profile's webhooks gone from GitHub, this computer
/// gone from the account (the server drops its webhooks and phones with it), and the relay task stopped.
pub async fn forget(k: &Gitnetix) {
    if let Some((host, _)) = stored_host() {
        let active = k.store.active();
        let mut hooks: Vec<Hook> = k.store.read(|c| c.account.hooks.values().cloned().collect());
        for p in k.store.profiles().list.iter().filter(|p| p.id != active) {
            if let Ok(c) = k.store.profile_config(&p.id) {
                hooks.extend(c.account.hooks.into_values());
            }
        }
        for h in &hooks {
            remove(k, &host, h).await;
        }
        let _ = account::api(Method::DELETE, &format!("/v1/devices/{host}"), None).await;
        let _ = secrets::delete(DEVICE);
    }
    // shortcut: an open relay socket lasts until the server's sweep drops the deleted device (30 s at most), so a sign-in
    // within that time waits for it; end the session here if that wait ever shows.
    let mut l = LIVE.lock().unwrap();
    l.on = false;
    l.hooks.clear();
}

/// With each account sync: the relay socket up, and the webhooks in step with the project list. A computer removed from
/// the account elsewhere stops here instead of making itself a new device.
pub async fn ensure(k: &Gitnetix) -> Result<()> {
    if !k.store.read(|c| c.account.live) {
        LIVE.lock().unwrap().on = false;
        return Ok(());
    }
    if std::mem::take(&mut LIVE.lock().unwrap().revoked) {
        let _ = secrets::delete(DEVICE);
        return stop(k, "").await;
    }
    reconcile(k, &host().await?).await?;
    start(k);
    Ok(())
}

pub fn status(k: &Gitnetix) -> Value {
    let (on, hooks, projects) = k.store.read(|c| (c.account.live, c.account.hooks.clone(), c.projects.clone()));
    let list: Vec<Value> = projects.iter().filter_map(|p| hooks.get(&p.id).map(|h| json!({ "id": p.id, "name": p.name, "live": h.error.is_none(), "error": h.error }))).collect();
    json!({ "on": on, "connected": on && LIVE.lock().unwrap().connected, "projects": list })
}

fn connected(events: &broadcast::Sender<Event>, now: bool) {
    let mut l = LIVE.lock().unwrap();
    if l.connected != now {
        l.connected = now;
        let _ = events.send(Event::LiveChanged {});
    }
}

/// Keeps this computer on the relay while live updates are on, coming back after a drop with waits up to a minute.
fn start(k: &Gitnetix) {
    LIVE.lock().unwrap().on = true;
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let events = k.events.clone();
    tokio::spawn(async move {
        let mut wait = 1;
        let mut said = false;
        while LIVE.lock().unwrap().on {
            let res = session(&events).await;
            connected(&events, false);
            match res {
                Ok(()) => wait = 1,
                Err(Error::NotConnected(_)) => {
                    let mut l = LIVE.lock().unwrap();
                    l.revoked = true;
                    l.on = false;
                    break;
                }
                // Once per outage in the log, not once per try.
                Err(e) if !said => {
                    crate::log::error(format!("Live updates: {e}"));
                    said = true;
                }
                Err(_) => {}
            }
            tokio::time::sleep(Duration::from_secs(wait)).await;
            wait = (wait * 2).min(60);
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}

/// One relay connection, until it closes: each webhook notice becomes an event for the UIs.
async fn session(events: &broadcast::Sender<Event>) -> Result<()> {
    let (_, token) = stored_host().ok_or_else(|| Error::NotConnected("this computer as a host".into()))?;
    let url = format!("{}/v1/relay", account::server().replacen("http", "ws", 1));
    let mut req = url.into_client_request().map_err(|e| Error::Invalid(e.to_string()))?;
    req.headers_mut().insert("authorization", format!("Bearer {token}").parse().map_err(|_| Error::Invalid("device token".into()))?);
    let (mut ws, _) = match tokio_tungstenite::connect_async(req).await {
        Ok(c) => c,
        Err(tungstenite::Error::Http(r)) if r.status() == 401 => return Err(Error::NotConnected("this computer was removed from the account".into())),
        Err(e) => return Err(Error::Http(format!("the relay: {e}"))),
    };
    connected(events, true);
    while let Some(msg) = ws.next().await {
        if let Message::Text(text) = msg.map_err(|e| Error::Http(format!("the relay: {e}")))? {
            if let Some((project_id, event)) = notice(text.as_str()) {
                let _ = events.send(Event::RemoteChanged { project_id, event });
            }
        }
        if !LIVE.lock().unwrap().on {
            break;
        }
    }
    Ok(())
}

/// A relay notice that a webhook fired: its project, and GitHub's event name.
fn notice(text: &str) -> Option<(String, String)> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v["type"] != "hook" {
        return None;
    }
    let project = LIVE.lock().unwrap().hooks.get(v["hook"].as_str()?).cloned()?;
    Some((project, v["event"].as_str().unwrap_or_default().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notice_names_the_project_of_its_hook_and_nothing_else_does() {
        LIVE.lock().unwrap().hooks = BTreeMap::from([("hook1".to_string(), "project1".to_string())]);
        assert_eq!(notice(r#"{"type":"hook","hook":"hook1","event":"pull_request"}"#), Some(("project1".into(), "pull_request".into())));
        assert_eq!(notice(r#"{"type":"hook","hook":"unknown","event":"push"}"#), None);
        assert_eq!(notice(r#"{"type":"online","peer":{}}"#), None);
        assert_eq!(notice("not json"), None);
    }
}
