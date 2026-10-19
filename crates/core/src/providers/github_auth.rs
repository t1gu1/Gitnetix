//! "Sign in with GitHub" through the OAuth device flow: the app shows a short
//! code, the user enters it on github.com, and the app polls until GitHub
//! hands over a token. No client secret and no local redirect server needed.

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{Error, Result};

/// Client ID of the Gitnetix OAuth App (Device Flow enabled). Public, not a secret.
const CLIENT_ID: &str = "Ov23liwKERI7iyaZzzMf";

/// PRs, reviews, checks, contents and releases on public and private repos;
/// read:org for team names in a PR's review requests; workflow to merge PRs
/// that change `.github/workflows`.
const SCOPE: &str = "repo read:org workflow";

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
    let res = reqwest::Client::builder()
        .user_agent(concat!("Gitnetix/", env!("CARGO_PKG_VERSION")))
        .build()?
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

pub async fn poll(device_code: &str) -> Result<Poll> {
    let v = post(
        "/login/oauth/access_token",
        json!({ "client_id": CLIENT_ID, "device_code": device_code, "grant_type": "urn:ietf:params:oauth:grant-type:device_code" }),
    )
    .await?;
    parse_poll(&v)
}

/// Login of the account a token belongs to.
pub async fn login(token: &str) -> Result<String> {
    let res = reqwest::Client::builder()
        .user_agent(concat!("Gitnetix/", env!("CARGO_PKG_VERSION")))
        .build()?
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
}
