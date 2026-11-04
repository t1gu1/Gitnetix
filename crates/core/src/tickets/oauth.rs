//! Browser sign-in through OAuth 2.0 for Jira, Trello and Asana. None of them has
//! a device code flow, so the browser redirects back to a one-shot listener on
//! localhost. Access tokens last an hour; the refresh token is kept and
//! `access_token()` renews it when needed.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::{AbortHandle, JoinHandle};

use crate::error::{Error, Result};
use crate::net::client as http;
use crate::secrets;

const PORT: u16 = 47821;
/// Each provider's app must list exactly this callback URL.
const REDIRECT: &str = "http://localhost:47821/callback";

/// An app Gitnetix signs in with. Its id and secret are baked in at build time, so the secret stays out of the repo.
pub struct Provider {
    /// The tracker, for messages.
    pub name: &'static str,
    /// Who the user signs in with.
    pub site: &'static str,
    authorize: &'static str,
    token: &'static str,
    client_id: Option<&'static str>,
    client_secret: Option<&'static str>,
    /// Scope and the other authorize parameters the provider wants.
    params: &'static [(&'static str, &'static str)],
    /// The token endpoint takes a form body (Asana), else JSON (Atlassian).
    form: bool,
    /// PKCE (S256): Trello asks for it, Asana for any localhost redirect.
    pkce: bool,
}

/// The Gitnetix app in developer.atlassian.com.
pub static JIRA: Provider = Provider {
    name: "Jira",
    site: "Atlassian",
    authorize: "https://auth.atlassian.com/authorize",
    token: "https://auth.atlassian.com/oauth/token",
    client_id: option_env!("GITNETIX_JIRA_CLIENT_ID"),
    client_secret: option_env!("GITNETIX_JIRA_CLIENT_SECRET"),
    params: &[("audience", "api.atlassian.com"), ("scope", "read:jira-work write:jira-work read:jira-user offline_access"), ("prompt", "consent")],
    form: false,
    pkce: false,
};

/// The OAuth 2.0 client of the Gitnetix app at trello.com/apps/admin, with these scopes enabled.
/// Trello signs in through Atlassian's servers.
pub static TRELLO: Provider = Provider {
    name: "Trello",
    site: "Trello",
    authorize: "https://auth.atlassian.com/authorize",
    token: "https://auth.atlassian.com/oauth/token",
    client_id: option_env!("GITNETIX_TRELLO_CLIENT_ID"),
    client_secret: option_env!("GITNETIX_TRELLO_CLIENT_SECRET"),
    params: &[("scope", "read:member:trello read:board:trello write:board:trello offline_access"), ("prompt", "consent")],
    form: false,
    pkce: true,
};

/// The Gitnetix app at app.asana.com/0/my-apps, registered with these permission scopes.
pub static ASANA: Provider = Provider {
    name: "Asana",
    site: "Asana",
    authorize: "https://app.asana.com/-/oauth_authorize",
    token: "https://app.asana.com/-/oauth_token",
    client_id: option_env!("GITNETIX_ASANA_CLIENT_ID"),
    client_secret: option_env!("GITNETIX_ASANA_CLIENT_SECRET"),
    params: &[("scope", "tasks:read tasks:write projects:read users:read")],
    form: true,
    pkce: true,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    /// Unix seconds.
    expires_at: i64,
}

/// The sign-in waiting for its browser redirect, if any, with its provider's name: one at a time, as they share the port.
type Pending = (&'static str, AbortHandle, Option<JoinHandle<Result<Value>>>);
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

/// One refresh at a time: Trello's refresh tokens work once, so a second refresh racing the first would sign the user out.
static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

impl Provider {
    fn client(&self) -> Result<(&'static str, Option<&'static str>)> {
        match self.client_id {
            Some(id) if !id.is_empty() => Ok((id, self.client_secret.filter(|s| !s.is_empty()))),
            _ => Err(Error::Unsupported(format!("{} sign-in is not set up in this build; connect with a token instead", self.site))),
        }
    }

    /// A call to the token endpoint, with the app's credentials added.
    async fn token_request(&self, mut body: BTreeMap<&'static str, String>) -> Result<Value> {
        let (id, secret) = self.client()?;
        body.insert("client_id", id.into());
        if let Some(s) = secret {
            body.insert("client_secret", s.into());
        }
        // Bounded: other token reads wait behind a refresh.
        let req = http().post(self.token).timeout(Duration::from_secs(30));
        let req = if self.form { req.form(&body) } else { req.json(&body) };
        let res = req.send().await?;
        let status = res.status();
        let v: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() || v["access_token"].as_str().is_none() {
            let why = v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("sign-in failed");
            return Err(Error::NotConnected(format!("{} (sign in again: {why})", self.name)));
        }
        Ok(v)
    }
}

/// Listen for the redirect and return the URL to open in the browser.
/// Starting again cancels a sign-in still waiting, whichever provider it was for.
pub async fn start(p: &'static Provider) -> Result<String> {
    let (id, _) = p.client()?;
    let prev = PENDING.lock().unwrap().take();
    if let Some((_, abort, _)) = prev {
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
    let verifier = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let challenge = pkce_challenge(&verifier);
    let mut params = vec![("client_id", id), ("redirect_uri", REDIRECT), ("state", state.as_str()), ("response_type", "code")];
    params.extend(p.params);
    if p.pkce {
        params.extend([("code_challenge", challenge.as_str()), ("code_challenge_method", "S256")]);
    }
    let url = reqwest::Url::parse_with_params(p.authorize, &params).map_err(|e| Error::Other(e.to_string()))?;
    let task = tokio::spawn(async move {
        let code = tokio::time::timeout(Duration::from_secs(300), wait_for_code(p, listener, &state))
            .await
            .map_err(|_| Error::Invalid("sign-in timed out — start again".into()))??;
        let mut body = BTreeMap::from([("grant_type", "authorization_code".to_string()), ("code", code), ("redirect_uri", REDIRECT.into())]);
        if p.pkce {
            body.insert("code_verifier", verifier);
        }
        p.token_request(body).await
    });
    *PENDING.lock().unwrap() = Some((p.name, task.abort_handle(), Some(task)));
    Ok(url.into())
}

/// Wait until the user approves in the browser: the token response, to `save` where the connection keeps its tokens.
pub async fn finish(p: &Provider) -> Result<Value> {
    let task = PENDING
        .lock()
        .unwrap()
        .as_mut()
        .filter(|(name, _, _)| *name == p.name)
        .and_then(|(_, _, t)| t.take())
        .ok_or_else(|| Error::Invalid(format!("no {} sign-in in progress", p.site)))?;
    task.await.map_err(|_| Error::Invalid("sign-in was cancelled".into()))?
}

async fn wait_for_code(p: &Provider, listener: TcpListener, state: &str) -> Result<String> {
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = sock.read(&mut buf).await.unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let line = req.lines().next().unwrap_or("");
        let res = callback_code(line, state, p.site);
        let (status, body) = match &res {
            Ok(Some(_)) => ("200 OK", format!("Signed in to {}. You can close this tab and go back to Gitnetix.", p.name)),
            Ok(None) => ("404 Not Found", "Not found".into()),
            Err(_) => ("400 Bad Request", "Sign-in failed. Go back to Gitnetix and try again.".into()),
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
fn callback_code(request_line: &str, state: &str, site: &str) -> Result<Option<String>> {
    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    let url = reqwest::Url::parse(&format!("http://localhost{path}")).map_err(|_| Error::Invalid("bad redirect".into()))?;
    if url.path() != "/callback" {
        return Ok(None);
    }
    let get = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    if let Some(e) = get("error") {
        return Err(Error::Invalid(match e.as_str() {
            "access_denied" => format!("sign-in was cancelled on {site}"),
            _ => format!("{site} sign-in: {}", get("error_description").unwrap_or(e)),
        }));
    }
    if get("state").as_deref() != Some(state) {
        return Err(Error::Invalid("sign-in answer did not match; start again".into()));
    }
    get("code").map(Some).ok_or_else(|| Error::Invalid(format!("{site} sent no code")))
}

/// RFC 7636 S256: the verifier's SHA-256, base64url without padding.
fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Store a token response under keychain `key`; a refresh token not sent again stays `prev`.
pub fn save(key: &str, v: &Value, prev: Option<String>) -> Result<String> {
    let t = Tokens {
        access_token: v["access_token"].as_str().unwrap_or("").into(),
        refresh_token: v["refresh_token"].as_str().map(String::from).or(prev),
        expires_at: chrono::Utc::now().timestamp() + v["expires_in"].as_i64().unwrap_or(3600),
    };
    secrets::set(key, &serde_json::to_string(&t)?)?;
    Ok(t.access_token)
}

/// A valid access token from the tokens under keychain `key`, refreshed when it is about to expire.
pub async fn access_token(p: &Provider, key: &str) -> Result<String> {
    let _one = REFRESH.lock().await;
    let raw = secrets::require(key, p.name)?;
    let t: Tokens = serde_json::from_str(&raw).map_err(|_| Error::NotConnected(p.name.into()))?;
    if t.expires_at - chrono::Utc::now().timestamp() > 120 {
        return Ok(t.access_token);
    }
    let refresh = t.refresh_token.ok_or_else(|| Error::NotConnected(p.name.into()))?;
    let v = p.token_request(BTreeMap::from([("grant_type", "refresh_token".to_string()), ("refresh_token", refresh.clone())])).await?;
    save(key, &v, Some(refresh))
}

/// The token of a Trello or Asana connection, kept under keychain `key`: renewed first when it came from signing in.
pub async fn token(p: &Provider, key: &str, signed_in: bool) -> Result<String> {
    if signed_in {
        access_token(p, key).await
    } else {
        secrets::require(key, &format!("{} token", p.name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_callback() {
        assert_eq!(callback_code("GET /callback?code=abc%2B1&state=s1 HTTP/1.1", "s1", "Asana").unwrap(), Some("abc+1".into()));
        assert_eq!(callback_code("GET /favicon.ico HTTP/1.1", "s1", "Asana").unwrap(), None);
        assert!(callback_code("GET /callback?code=abc&state=other HTTP/1.1", "s1", "Asana").is_err());
        let denied = callback_code("GET /callback?error=access_denied&state=s1 HTTP/1.1", "s1", "Trello").unwrap_err();
        assert!(denied.to_string().contains("cancelled on Trello"));
    }

    #[test]
    fn pkce_matches_rfc_7636() {
        // RFC 7636, appendix B.
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
