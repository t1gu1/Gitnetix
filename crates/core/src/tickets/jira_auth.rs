//! "Sign in with Atlassian" through OAuth 2.0 (3LO). Atlassian has no device
//! code flow, so the browser redirects back to a one-shot listener on
//! localhost. Access tokens last an hour; the rotating refresh token is kept
//! and `access_token()` renews it when needed.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::task::{AbortHandle, JoinHandle};

use crate::error::{Error, Result};
use crate::providers::oauth;
use crate::secrets;
use crate::net::client as http;
use crate::store::JiraConf;

/// The Gitnetix app in developer.atlassian.com, baked in at build time so the
/// secret stays out of the repo. Its callback URL must be exactly `REDIRECT`.
const CLIENT_ID: Option<&str> = option_env!("GITNETIX_JIRA_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("GITNETIX_JIRA_CLIENT_SECRET");

const PORT: u16 = 47821;
const REDIRECT: &str = "http://localhost:47821/callback";
const SCOPE: &str = "read:jira-work write:jira-work read:jira-user offline_access";

/// Keychain key holding the stored `Tokens` as JSON. API tokens stay under "jira".
pub const KEY: &str = "jira_oauth";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    /// Unix seconds.
    expires_at: i64,
}

/// The Jira site the user picked on Atlassian's consent screen.
pub struct Site {
    pub cloud_id: String,
    pub url: String,
}

/// The sign-in waiting for its browser redirect, if any.
static PENDING: Mutex<Option<(AbortHandle, Option<JoinHandle<Result<Site>>>)>> = Mutex::new(None);

fn client() -> Result<(&'static str, &'static str)> {
    match (CLIENT_ID, CLIENT_SECRET) {
        (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => Ok((id, secret)),
        _ => Err(Error::Unsupported("Atlassian sign-in is not set up in this build; use an API token".into())),
    }
}

/// Listen for the redirect and return the URL to open in the browser.
/// Starting again cancels a sign-in still waiting.
pub async fn start() -> Result<String> {
    let (id, _) = client()?;
    let prev = PENDING.lock().unwrap().take();
    if let Some((abort, _)) = prev {
        abort.abort();
    }
    let listener = oauth::listen(PORT).await?;
    let state = crate::store::new_id();
    let url = reqwest::Url::parse_with_params(
        "https://auth.atlassian.com/authorize",
        &[
            ("audience", "api.atlassian.com"),
            ("client_id", id),
            ("scope", SCOPE),
            ("redirect_uri", REDIRECT),
            ("state", &state),
            ("response_type", "code"),
            ("prompt", "consent"),
        ],
    )
    .map_err(|e| Error::Other(e.to_string()))?;
    let task = tokio::spawn(async move {
        let code = tokio::time::timeout(Duration::from_secs(300), oauth::wait_for_code(listener, &state, "Atlassian"))
            .await
            .map_err(|_| Error::Invalid("sign-in timed out — start again".into()))??;
        exchange(&code).await
    });
    *PENDING.lock().unwrap() = Some((task.abort_handle(), Some(task)));
    Ok(url.into())
}

/// Wait until the user approves in the browser; tokens are then stored.
pub async fn finish() -> Result<Site> {
    let task = PENDING
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|(_, t)| t.take())
        .ok_or_else(|| Error::Invalid("no Atlassian sign-in in progress".into()))?;
    task.await.map_err(|_| Error::Invalid("sign-in was cancelled".into()))?
}

async fn token_request(body: Value) -> Result<Value> {
    let res = http().post("https://auth.atlassian.com/oauth/token").json(&body).send().await?;
    let status = res.status();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() || v["access_token"].as_str().is_none() {
        let why = v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("sign-in failed");
        return Err(Error::NotConnected(format!("Jira (sign in again: {why})")));
    }
    Ok(v)
}

async fn exchange(code: &str) -> Result<Site> {
    let (id, secret) = client()?;
    let v = token_request(json!({
        "grant_type": "authorization_code",
        "client_id": id,
        "client_secret": secret,
        "code": code,
        "redirect_uri": REDIRECT,
    }))
    .await?;
    let token = save(&v, None)?;
    let res = http().get("https://api.atlassian.com/oauth/token/accessible-resources").bearer_auth(&token).send().await?;
    let sites: Value = res.json().await.unwrap_or(Value::Null);
    // shortcut: takes the first Jira site granted, add a picker if users with several sites ask.
    let site = sites
        .as_array()
        .into_iter()
        .flatten()
        .find(|s| s["scopes"].as_array().is_some_and(|sc| sc.iter().any(|x| x.as_str().is_some_and(|x| x.contains("jira")))))
        .ok_or_else(|| Error::Invalid("this Atlassian account has no Jira site".into()))?;
    Ok(Site { cloud_id: site["id"].as_str().unwrap_or("").into(), url: site["url"].as_str().unwrap_or("").into() })
}

/// A valid access token, refreshed with the stored refresh token when it is about to expire.
pub async fn access_token() -> Result<String> {
    let raw = secrets::require(KEY, "Jira")?;
    let t: Tokens = serde_json::from_str(&raw).map_err(|_| Error::NotConnected("Jira".into()))?;
    if t.expires_at - chrono::Utc::now().timestamp() > 120 {
        return Ok(t.access_token);
    }
    let (id, secret) = client()?;
    let refresh = t.refresh_token.ok_or_else(|| Error::NotConnected("Jira".into()))?;
    let v = token_request(json!({ "grant_type": "refresh_token", "client_id": id, "client_secret": secret, "refresh_token": refresh })).await?;
    save(&v, Some(refresh))
}

/// Store a token response; Atlassian rotates the refresh token, else `prev` is kept.
fn save(v: &Value, prev: Option<String>) -> Result<String> {
    let t = Tokens {
        access_token: v["access_token"].as_str().unwrap_or("").into(),
        refresh_token: v["refresh_token"].as_str().map(String::from).or(prev),
        expires_at: chrono::Utc::now().timestamp() + v["expires_in"].as_i64().unwrap_or(3600),
    };
    secrets::set(KEY, &serde_json::to_string(&t)?)?;
    Ok(t.access_token)
}

/// The token for `conf`: OAuth when signed in with Atlassian, else the saved API token.
pub async fn token(conf: &JiraConf) -> Result<String> {
    if conf.cloud_id.is_some() {
        access_token().await
    } else {
        secrets::require(&crate::store::Connection::secret(conf), "Jira API token")
    }
}
