//! "Sign in with Atlassian" through OAuth 2.0 (3LO). Atlassian has no device
//! code flow, so the browser redirects back to a one-shot listener on
//! localhost. Access tokens last an hour; the rotating refresh token is kept
//! and `access_token()` renews it when needed.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::{AbortHandle, JoinHandle};

use crate::error::{Error, Result};
use crate::secrets;
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

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("Gitnetix/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

/// Listen for the redirect and return the URL to open in the browser.
/// Starting again cancels a sign-in still waiting.
pub async fn start() -> Result<String> {
    let (id, _) = client()?;
    let prev = PENDING.lock().unwrap().take();
    if let Some((abort, _)) = prev {
        abort.abort();
    }
    // The aborted listener is dropped on its next poll, so the port frees up shortly after.
    let mut listener = None;
    for _ in 0..20 {
        match TcpListener::bind(("127.0.0.1", PORT)).await {
            Ok(l) => {
                listener = Some(l);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
    let listener = listener.ok_or_else(|| Error::Other(format!("port {PORT} is in use; close the app using it and try again")))?;
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
        let code = tokio::time::timeout(Duration::from_secs(300), wait_for_code(listener, &state))
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

async fn wait_for_code(listener: TcpListener, state: &str) -> Result<String> {
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = sock.read(&mut buf).await.unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let line = req.lines().next().unwrap_or("");
        let res = callback_code(line, state);
        let (status, body) = match &res {
            Ok(Some(_)) => ("200 OK", "Signed in to Jira. You can close this tab and go back to Gitnetix."),
            Ok(None) => ("404 Not Found", "Not found"),
            Err(_) => ("400 Bad Request", "Sign-in failed. Go back to Gitnetix and try again."),
        };
        let page = format!("<!doctype html><meta charset=utf-8><title>Gitnetix</title><p style=\"font:16px system-ui;margin:3em\">{body}</p>");
        let _ = sock
            .write_all(format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len()).as_bytes())
            .await;
        // Browsers also ask for /favicon.ico; keep waiting for the real redirect.
        if let Some(code) = res? {
            return Ok(code);
        }
    }
}

/// The `code` from a "GET /callback?…" request line; None for any other path.
fn callback_code(request_line: &str, state: &str) -> Result<Option<String>> {
    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    let url = reqwest::Url::parse(&format!("http://localhost{path}")).map_err(|_| Error::Invalid("bad redirect".into()))?;
    if url.path() != "/callback" {
        return Ok(None);
    }
    let get = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    if let Some(e) = get("error") {
        return Err(Error::Invalid(match e.as_str() {
            "access_denied" => "sign-in was cancelled on Atlassian".into(),
            _ => format!("Atlassian sign-in: {}", get("error_description").unwrap_or(e)),
        }));
    }
    if get("state").as_deref() != Some(state) {
        return Err(Error::Invalid("sign-in answer did not match; start again".into()));
    }
    get("code").map(Some).ok_or_else(|| Error::Invalid("Atlassian sent no code".into()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_callback() {
        assert_eq!(callback_code("GET /callback?code=abc%2B1&state=s1 HTTP/1.1", "s1").unwrap(), Some("abc+1".into()));
        assert_eq!(callback_code("GET /favicon.ico HTTP/1.1", "s1").unwrap(), None);
        assert!(callback_code("GET /callback?code=abc&state=other HTTP/1.1", "s1").is_err());
        assert!(callback_code("GET /callback?error=access_denied&state=s1 HTTP/1.1", "s1").is_err());
    }
}
