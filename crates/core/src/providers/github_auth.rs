//! "Sign in with GitHub" through the OAuth device flow: the app shows a short
//! code, the user enters it on github.com, and the app polls until GitHub
//! hands over a token. No client secret and no local redirect server needed.
//! GitHub gives OAuth apps registered since 2026-08-14, Gitnetix's among them, an access token
//! lasting 8 hours and a refresh token lasting 6 months: [`token`] renews the pair.

use serde::Serialize;
use serde_json::{json, Value};

use super::oauth;
use crate::error::{Error, Result};
use crate::secrets;

/// Client ID of the Gitnetix OAuth App (Device Flow enabled). Public, not a secret.
const CLIENT_ID: &str = "Ov23liwKERI7iyaZzzMf";

/// The keychain key: [`oauth::Tokens`] as JSON after a sign-in, a pasted token as plain text.
const KEY: &str = "github";

const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

/// PRs, reviews, checks, contents and releases on public and private repos;
/// read:org for team names in a PR's review requests; workflow to merge PRs
/// that change `.github/workflows`; project to read and move an issue's card on a project board.
const SCOPE: &str = "repo read:org workflow project";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// Seconds to wait between polls.
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Poll {
    /// The user has not entered the code yet.
    Pending,
    /// Polling too fast; wait this many seconds from now on.
    SlowDown(u64),
    Token(String),
}

async fn post(path: &str, body: Value) -> Result<Value> {
    let res = crate::net::client()
        .post(format!("https://github.com{path}"))
        .header("accept", "application/json")
        .json(&body)
        .send()
        .await?;
    let status = res.status();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(Error::Http(format!("GitHub {status}: {}", v["error_description"].as_str().unwrap_or("sign-in failed"))));
    }
    Ok(v)
}

pub async fn start() -> Result<DeviceCode> {
    let v = post("/login/device/code", json!({ "client_id": CLIENT_ID, "scope": SCOPE })).await?;
    if let Some(e) = v["error"].as_str() {
        return Err(Error::Http(format!("GitHub sign-in: {}", v["error_description"].as_str().unwrap_or(e))));
    }
    Ok(DeviceCode {
        device_code: v["device_code"].as_str().unwrap_or("").into(),
        user_code: v["user_code"].as_str().unwrap_or("").into(),
        verification_uri: v["verification_uri"].as_str().unwrap_or("https://github.com/login/device").into(),
        interval: v["interval"].as_u64().unwrap_or(5),
        expires_in: v["expires_in"].as_u64().unwrap_or(900),
    })
}

/// On success the tokens are stored, the refresh token with them.
pub async fn poll(device_code: &str) -> Result<Poll> {
    let v = post(
        "/login/oauth/access_token",
        json!({ "client_id": CLIENT_ID, "device_code": device_code, "grant_type": "urn:ietf:params:oauth:grant-type:device_code" }),
    )
    .await?;
    let p = parse_poll(&v)?;
    if let Poll::Token(_) = &p {
        oauth::save(KEY, &v, None)?;
    }
    Ok(p)
}

/// The GitHub token: a sign-in's, renewed first when it is about to run out or is `stale` (api.github.com just
/// refused it); a pasted one as it is.
pub async fn token(stale: Option<&str>) -> Result<String> {
    token_from(TOKEN_URL, stale).await
}

async fn token_from(url: &str, stale: Option<&str>) -> Result<String> {
    let raw = secrets::require(KEY, "Connect GitHub in the menu, under Git providers")?;
    // Pasted, or saved by a sign-in from before refresh tokens were kept: nothing to renew it with.
    if !raw.starts_with('{') {
        return Ok(raw);
    }
    let refresh = || Ok(oauth::Refresh { url: url.into(), client_id: CLIENT_ID.into(), secret: None });
    let t = oauth::access(KEY, "GitHub", stale, refresh).await;
    // The refresh token was turned down too (removed on GitHub, or unused for 6 months): only a new sign-in helps.
    if let Err(Error::NotConnected(_)) = &t {
        crate::log::emit(crate::events::Event::GithubSignedOut);
    }
    t.map(|t| t.access_token)
}

/// The GitHub token as saved, for git signing in to github.com; [`token`] renews it first.
pub fn saved() -> Option<String> {
    let raw = secrets::get(KEY).ok().flatten().filter(|t| !t.is_empty())?;
    if !raw.starts_with('{') {
        return Some(raw);
    }
    serde_json::from_str::<oauth::Tokens>(&raw).ok().map(|t| t.access_token)
}

/// Login of the account a token belongs to.
pub async fn login(token: &str) -> Result<String> {
    let res = crate::net::client()
        .get("https://api.github.com/user")
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json")
        .send()
        .await?;
    let status = res.status();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(Error::Http(format!("GitHub {status}: {}", v["message"].as_str().unwrap_or("token rejected"))));
    }
    Ok(v["login"].as_str().unwrap_or("").into())
}

fn parse_poll(v: &Value) -> Result<Poll> {
    if let Some(t) = v["access_token"].as_str().filter(|t| !t.is_empty()) {
        return Ok(Poll::Token(t.into()));
    }
    match v["error"].as_str() {
        Some("authorization_pending") => Ok(Poll::Pending),
        Some("slow_down") => Ok(Poll::SlowDown(v["interval"].as_u64().unwrap_or(10))),
        Some("expired_token") => Err(Error::Invalid("the sign-in code expired — start again".into())),
        Some("access_denied") => Err(Error::Invalid("sign-in was cancelled on GitHub".into())),
        Some(e) => Err(Error::Http(format!("GitHub sign-in: {}", v["error_description"].as_str().unwrap_or(e)))),
        None => Err(Error::Http("GitHub sign-in: unexpected response".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_poll_responses() {
        assert_eq!(parse_poll(&json!({ "error": "authorization_pending" })).unwrap(), Poll::Pending);
        assert_eq!(parse_poll(&json!({ "error": "slow_down", "interval": 15 })).unwrap(), Poll::SlowDown(15));
        assert_eq!(parse_poll(&json!({ "access_token": "gho_x", "token_type": "bearer" })).unwrap(), Poll::Token("gho_x".into()));
        assert!(parse_poll(&json!({ "error": "expired_token" })).is_err());
        assert!(parse_poll(&json!({ "error": "access_denied" })).is_err());
    }

    /// A sign-in past its 8 hours: the next use renews it once at the token endpoint, the uses after take the new one.
    #[tokio::test]
    async fn renews_a_sign_in_that_ran_out() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let _turn = secrets::test_turn();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/login/oauth/access_token", listener.local_addr().unwrap());
        // Answers one request: a second renewal would find nobody listening.
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let (mut req, mut buf) = (Vec::new(), [0; 4096]);
            // client_id comes last in the form.
            while !String::from_utf8_lossy(&req).contains(CLIENT_ID) {
                let n = sock.read(&mut buf).await.unwrap();
                assert!(n > 0, "request cut short");
                req.extend_from_slice(&buf[..n]);
            }
            let body = json!({ "access_token": "new", "expires_in": 28800, "refresh_token": "r2", "token_type": "bearer" }).to_string();
            let res = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            sock.write_all(res.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&req).into_owned()
        });

        // Stored as a sign-in stores them, already out of time.
        oauth::save(KEY, &json!({ "access_token": "old", "expires_in": -10, "refresh_token": "r1" }), None).unwrap();
        assert_eq!(saved().as_deref(), Some("old"));
        assert_eq!(token_from(&url, None).await.unwrap(), "new");
        let req = server.await.unwrap();
        assert!(req.contains("grant_type=refresh_token&refresh_token=r1&client_id="), "{req}");
        assert_eq!(token_from(&url, None).await.unwrap(), "new", "good for 8 hours: no second renewal");
        assert_eq!(saved().as_deref(), Some("new"), "what git signs in with");

        // A pasted token has nothing to renew it with: it goes as it is.
        secrets::set(KEY, "ghp_pasted").unwrap();
        assert_eq!(token_from(&url, Some("ghp_pasted")).await.unwrap(), "ghp_pasted");
        assert_eq!(saved().as_deref(), Some("ghp_pasted"));
        secrets::delete(KEY).unwrap();
    }
}
