//! Sign-in and tokens for the GitLab, Bitbucket and Gitea connections. GitLab has
//! the device flow, like `github_auth`: the app shows a code, the user enters it on
//! the server. Bitbucket and Gitea have none, so the browser redirects back to a
//! one-shot listener on this computer, as for Jira. Their access tokens last an hour
//! or two: the refresh token is kept and `access()` renews them when needed.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::{AbortHandle, JoinHandle};

pub use super::github_auth::{DeviceCode, Poll};
use crate::error::{Error, Result};
use crate::secrets;

/// Stored as JSON in the keychain, under the provider's name.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix seconds; 0 for a pasted token, which does not expire here.
    #[serde(default)]
    pub expires_at: i64,
    /// A Bitbucket API token goes as Basic auth with the account's email.
    #[serde(default)]
    pub email: Option<String>,
}

impl Tokens {
    /// About to run out: renewed on use. A pasted token never does.
    pub fn expiring(&self) -> bool {
        self.expires_at != 0 && self.expires_at - chrono::Utc::now().timestamp() <= 120
    }

    /// `Authorization` header value.
    pub fn header(&self) -> String {
        match &self.email {
            Some(e) => format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{e}:{}", self.access_token))),
            None => format!("Bearer {}", self.access_token),
        }
    }
}

/// Where a host renews its tokens. `secret`: a confidential client (Bitbucket), sent as Basic auth.
pub struct Refresh {
    pub url: String,
    pub client_id: String,
    pub secret: Option<&'static str>,
}

/// Store a pasted token.
pub fn save_pat(key: &str, token: &str, email: Option<String>) -> Result<()> {
    let t = Tokens { access_token: token.into(), email, ..Default::default() };
    secrets::set(key, &serde_json::to_string(&t)?)
}

/// Store a token response; a host that does not rotate the refresh token keeps `prev`.
pub(super) fn save(key: &str, v: &Value, prev: Option<String>) -> Result<Tokens> {
    let t = Tokens {
        access_token: v["access_token"].as_str().unwrap_or("").into(),
        refresh_token: v["refresh_token"].as_str().map(String::from).or(prev),
        expires_at: v["expires_in"].as_i64().map(|s| chrono::Utc::now().timestamp() + s).unwrap_or(0),
        email: None,
    };
    secrets::set(key, &serde_json::to_string(&t)?)?;
    Ok(t)
}

/// One refresh at a time: GitLab voids the refresh token on use, so a second one racing it would fail.
static REFRESHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The refresh token each connection's host turned down for good, with its reason: asking again with it only waits on
/// the host (and, for GitHub, holds up every git call). A new sign-in brings another token, which is asked about.
static REFUSED: LazyLock<Mutex<HashMap<String, (String, String)>>> = LazyLock::new(Default::default);

/// The stored tokens under `key`, renewed first when they are about to expire or hold `stale`, an access token the
/// host just refused. `what` names the connection in errors ("GitLab").
pub async fn access(key: &str, what: &str, stale: Option<&str>, refresh: impl FnOnce() -> Result<Refresh>) -> Result<Tokens> {
    let load = || -> Result<Tokens> {
        let raw = secrets::require(key, &format!("Connect {what} in the menu, under Git providers"))?;
        serde_json::from_str(&raw).map_err(|_| Error::NotConnected(what.into()))
    };
    let fresh = |t: &Tokens| Some(t.access_token.as_str()) != stale && !t.expiring();
    let t = load()?;
    if fresh(&t) {
        return Ok(t);
    }
    let _one = REFRESHING.lock().await;
    // Renewed while this call waited, here or by another copy of the app on the same keychain: a renewal voids the
    // tokens it replaces, so this run's must not be renewed again.
    let _ = secrets::reload();
    let t = load()?;
    if fresh(&t) {
        return Ok(t);
    }
    let again = |why: &str| Error::NotConnected(format!("{what} (sign in again: {why})"));
    let rt = t.refresh_token.clone().ok_or_else(|| again("session expired"))?;
    let refused = REFUSED.lock().unwrap().get(key).filter(|(r, _)| *r == rt).map(|(_, why)| why.clone());
    if let Some(why) = refused {
        return Err(again(&why));
    }
    let r = refresh()?;
    let mut form = vec![("grant_type", "refresh_token"), ("refresh_token", rt.as_str())];
    if r.secret.is_none() {
        form.push(("client_id", &r.client_id));
    }
    let v = token_request(&r.url, &form, r.secret.map(|s| (r.client_id.as_str(), s)), what).await?;
    if v["access_token"].as_str().is_none() {
        // Another copy may have spent the same refresh token a moment earlier: its renewal lands in the keychain.
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _ = secrets::reload();
        return match load() {
            Ok(t) if t.refresh_token.as_ref() != Some(&rt) && fresh(&t) => Ok(t),
            _ => {
                let why = v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("session expired");
                if matches!(v["error"].as_str(), Some("bad_refresh_token" | "invalid_grant")) {
                    REFUSED.lock().unwrap().insert(key.into(), (rt, why.into()));
                }
                Err(again(why))
            }
        };
    }
    save(key, &v, Some(rt))
}

/// POST a form to a token endpoint. "Still waiting" answers (a 400 with an `error`) go back to the caller.
async fn token_request(url: &str, form: &[(&str, &str)], basic: Option<(&str, &str)>, site: &str) -> Result<Value> {
    // A host that never answers must not hold up what waits on the token: git calls wait on a GitHub renewal.
    let mut r = crate::net::client().post(url).header("accept", "application/json").form(form).timeout(Duration::from_secs(15));
    if let Some((id, secret)) = basic {
        r = r.basic_auth(id, Some(secret));
    }
    let res = r.send().await?;
    let status = res.status();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() && v["error"].is_null() {
        return Err(Error::Http(format!("{site} {status}: sign-in failed")));
    }
    Ok(v)
}

// ---------- device flow (GitLab) ----------

pub async fn device_start(url: &str, client_id: &str, scope: &str, site: &str) -> Result<DeviceCode> {
    let v = token_request(url, &[("client_id", client_id), ("scope", scope)], None, site).await?;
    if let Some(e) = v["error"].as_str() {
        return Err(Error::Http(format!("{site} sign-in: {}", start_error(e, v["error_description"].as_str()))));
    }
    Ok(DeviceCode {
        device_code: v["device_code"].as_str().unwrap_or("").into(),
        user_code: v["user_code"].as_str().unwrap_or("").into(),
        // The complete one carries the code: the user only approves.
        verification_uri: v["verification_uri_complete"].as_str().or(v["verification_uri"].as_str()).unwrap_or("").into(),
        interval: v["interval"].as_u64().unwrap_or(5),
        expires_in: v["expires_in"].as_u64().unwrap_or(300),
    })
}

/// On success the tokens are stored under `key`.
pub async fn device_poll(url: &str, client_id: &str, device_code: &str, site: &str, key: &str) -> Result<Poll> {
    let form = [("client_id", client_id), ("device_code", device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")];
    let v = token_request(url, &form, None, site).await?;
    let p = parse_poll(&v, site)?;
    if let Poll::Token(_) = &p {
        save(key, &v, None)?;
    }
    Ok(p)
}

/// What to fix when the server refuses to start: how the OAuth app was registered, usually.
fn start_error(error: &str, description: Option<&str>) -> String {
    match error {
        "invalid_client" => "the OAuth app is unknown, or marked Confidential: untick Confidential on it".into(),
        "access_denied" => "the OAuth app does not allow the device authorization grant: tick it on the app".into(),
        _ => description.unwrap_or(error).into(),
    }
}

fn parse_poll(v: &Value, site: &str) -> Result<Poll> {
    if let Some(t) = v["access_token"].as_str().filter(|t| !t.is_empty()) {
        return Ok(Poll::Token(t.into()));
    }
    match v["error"].as_str() {
        Some("authorization_pending") => Ok(Poll::Pending),
        Some("slow_down") => Ok(Poll::SlowDown(v["interval"].as_u64().unwrap_or(10))),
        Some("expired_token") => Err(Error::Invalid("the sign-in code expired — start again".into())),
        Some("access_denied") => Err(Error::Invalid(format!("sign-in was cancelled on {site}"))),
        Some(e) => Err(Error::Http(format!("{site} sign-in: {}", v["error_description"].as_str().unwrap_or(e)))),
        None => Err(Error::Http(format!("{site} sign-in: unexpected response"))),
    }
}

// ---------- browser flow (Bitbucket, Gitea) ----------

pub struct Browser {
    /// Names the host in messages.
    pub site: &'static str,
    /// The server signed in to, handed back with the tokens.
    pub server: String,
    /// Keychain key the tokens go to.
    pub key: &'static str,
    pub authorize_url: String,
    pub token_url: String,
    pub client_id: String,
    /// A confidential client's secret (Bitbucket); without one the sign-in uses PKCE (Gitea).
    pub secret: Option<&'static str>,
    /// Fixed when the host matches the redirect against the one registered (Bitbucket);
    /// 0 = any free one, which loopback redirects allow (Gitea).
    pub port: u16,
}

/// Sign-ins waiting for their browser redirect, by keychain key.
#[allow(clippy::type_complexity)]
static PENDING: Mutex<Vec<(&'static str, AbortHandle, Option<JoinHandle<Result<(Tokens, Browser)>>>)>> = Mutex::new(Vec::new());

/// Listen for the redirect and return the URL to open in the browser. Starting again cancels a sign-in still waiting.
pub async fn browser_start(b: Browser) -> Result<String> {
    let prev = {
        let mut all = PENDING.lock().unwrap();
        all.iter().position(|p| p.0 == b.key).map(|i| all.remove(i))
    };
    if let Some((_, abort, _)) = prev {
        abort.abort();
    }
    let listener = listen(b.port).await?;
    let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr()?.port());
    let state = crate::store::new_id();
    let verifier = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let challenge = pkce_challenge(&verifier);
    let mut params = vec![("client_id", b.client_id.as_str()), ("response_type", "code"), ("redirect_uri", &redirect), ("state", &state)];
    if b.secret.is_none() {
        params.extend([("code_challenge", challenge.as_str()), ("code_challenge_method", "S256")]);
    }
    let url = reqwest::Url::parse_with_params(&b.authorize_url, &params).map_err(|e| Error::Invalid(format!("{}: {e}", b.authorize_url)))?;
    let key = b.key;
    let task = tokio::spawn(async move {
        let code = tokio::time::timeout(Duration::from_secs(300), wait_for_code(listener, &state, b.site))
            .await
            .map_err(|_| Error::Invalid("sign-in timed out — start again".into()))??;
        let mut form = vec![("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", redirect.as_str())];
        if b.secret.is_none() {
            form.extend([("client_id", b.client_id.as_str()), ("code_verifier", verifier.as_str())]);
        }
        let v = token_request(&b.token_url, &form, b.secret.map(|s| (b.client_id.as_str(), s)), b.site).await?;
        if v["access_token"].as_str().is_none() {
            let why = v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("no token");
            return Err(Error::Http(format!("{} sign-in: {why}", b.site)));
        }
        Ok((save(b.key, &v, None)?, b))
    });
    PENDING.lock().unwrap().push((key, task.abort_handle(), Some(task)));
    Ok(url.into())
}

/// Wait until the user approves in the browser; the tokens are then stored under `key`,
/// and handed back with the sign-in they came from.
pub async fn browser_finish(key: &str) -> Result<(Tokens, Browser)> {
    let task = PENDING
        .lock()
        .unwrap()
        .iter_mut()
        .find(|p| p.0 == key)
        .and_then(|p| p.2.take())
        .ok_or_else(|| Error::Invalid("no sign-in in progress".into()))?;
    task.await.map_err(|_| Error::Invalid("sign-in was cancelled".into()))?
}

/// RFC 7636 S256: base64url of the verifier's SHA-256, without padding.
pub(crate) fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// A listener on 127.0.0.1:`port` (0 = any free port). An aborted sign-in frees a fixed port on its
/// next poll, so binding it is retried for a moment.
pub async fn listen(port: u16) -> Result<TcpListener> {
    for _ in 0..20 {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => return Ok(l),
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
    Err(Error::Other(format!("port {port} is in use; close the app using it and try again")))
}

/// Answer requests until the browser brings the redirect; its `code`.
pub async fn wait_for_code(listener: TcpListener, state: &str, site: &str) -> Result<String> {
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = sock.read(&mut buf).await.unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let line = req.lines().next().unwrap_or("");
        let res = callback_code(line, state, site);
        let (status, body) = match &res {
            Ok(Some(_)) => ("200 OK", "Signed in. You can close this tab and go back to Gitnetix."),
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
fn callback_code(request_line: &str, state: &str, site: &str) -> Result<Option<String>> {
    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    let url = reqwest::Url::parse(&format!("http://localhost{path}")).map_err(|_| Error::Invalid("bad redirect".into()))?;
    if url.path() != "/callback" {
        return Ok(None);
    }
    let get = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    // Any web page can call localhost: only the answer carrying this sign-in's state may end it, even with an error.
    if get("state").as_deref() != Some(state) {
        return Ok(None);
    }
    if let Some(e) = get("error") {
        return Err(Error::Invalid(match e.as_str() {
            "access_denied" => format!("sign-in was cancelled on {site}"),
            _ => format!("{site} sign-in: {}", get("error_description").unwrap_or(e)),
        }));
    }
    get("code").map(Some).ok_or_else(|| Error::Invalid(format!("{site} sent no code")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_callback() {
        assert_eq!(callback_code("GET /callback?code=abc%2B1&state=s1 HTTP/1.1", "s1", "Gitea").unwrap(), Some("abc+1".into()));
        assert_eq!(callback_code("GET /favicon.ico HTTP/1.1", "s1", "Gitea").unwrap(), None);
        // A request without this sign-in's state comes from some other page: ignored, the sign-in keeps waiting.
        assert_eq!(callback_code("GET /callback?code=abc&state=other HTTP/1.1", "s1", "Gitea").unwrap(), None);
        assert_eq!(callback_code("GET /callback?error=access_denied HTTP/1.1", "s1", "Gitea").unwrap(), None);
        let e = callback_code("GET /callback?error=access_denied&state=s1 HTTP/1.1", "s1", "Bitbucket").unwrap_err();
        assert!(e.to_string().contains("cancelled on Bitbucket"));
    }

    #[test]
    fn reads_poll_responses() {
        assert_eq!(parse_poll(&json!({ "error": "authorization_pending" }), "GitLab").unwrap(), Poll::Pending);
        assert_eq!(parse_poll(&json!({ "error": "slow_down" }), "GitLab").unwrap(), Poll::SlowDown(10));
        assert_eq!(parse_poll(&json!({ "access_token": "t", "expires_in": 7200 }), "GitLab").unwrap(), Poll::Token("t".into()));
        assert!(parse_poll(&json!({ "error": "access_denied" }), "GitLab").is_err());
    }

    #[test]
    fn explains_how_to_fix_the_app() {
        assert!(start_error("invalid_client", Some("Client authentication failed")).contains("untick Confidential"));
        assert!(start_error("access_denied", None).contains("device authorization grant"));
        assert_eq!(start_error("invalid_scope", Some("The requested scope is invalid.")), "The requested scope is invalid.");
    }

    #[test]
    fn pkce_matches_rfc_7636_example() {
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn sends_email_tokens_as_basic_auth() {
        let t = Tokens { access_token: "tok".into(), email: Some("a@b.c".into()), ..Default::default() };
        assert_eq!(t.header(), "Basic YUBiLmM6dG9r");
        assert_eq!(Tokens { access_token: "tok".into(), ..Default::default() }.header(), "Bearer tok");
    }
}
