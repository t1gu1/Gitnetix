//! "Sign in with Azure DevOps" through the Microsoft Entra ID device code flow,
//! same shape as `github_auth`: the app shows a short code, the user enters it
//! on microsoft.com/devicelogin, and the app polls until Entra hands over a
//! token. Entra access tokens last about an hour, so the refresh token is kept
//! too and `access_token()` renews it when needed.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::secrets;

pub use super::github_auth::{DeviceCode, Poll};

/// Application (client) ID of the Gitnetix Entra app registration: a public
/// client with "Allow public client flows" on and the Azure DevOps
/// `user_impersonation` delegated permission. Public, not a secret.
const CLIENT_ID: &str = "5ef51510-93af-4c04-8d2d-4c47cbc9a7af";

/// Work and school accounts, where Azure DevOps organizations live.
const TENANT: &str = "organizations";

/// Azure DevOps delegated scope (`499b84ac-…` is its fixed app ID) plus a refresh token; explicit scope allows dynamic consent, unlike `.default`.
const SCOPE: &str = "499b84ac-1321-427f-aa17-267ca6975798/user_impersonation offline_access";

/// Keychain key holding the stored `Tokens` as JSON.
const KEY: &str = "azure";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    /// Unix seconds.
    expires_at: i64,
}

async fn post(path: &str, form: &[(&str, &str)]) -> Result<Value> {
    if CLIENT_ID.is_empty() {
        return Err(Error::Unsupported("Azure DevOps sign-in is not set up in this build".into()));
    }
    let res = reqwest::Client::builder()
        .user_agent(concat!("Gitnetix/", env!("CARGO_PKG_VERSION")))
        .build()?
        .post(format!("https://login.microsoftonline.com/{TENANT}/oauth2/v2.0{path}"))
        .header("accept", "application/json")
        .form(form)
        .send()
        .await?;
    let status = res.status();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    // Entra answers "still waiting" with a 400 and an `error`, so those go to the caller.
    if !status.is_success() && v["error"].is_null() {
        return Err(Error::Http(format!("Microsoft {status}: sign-in failed")));
    }
    Ok(v)
}

pub async fn start() -> Result<DeviceCode> {
    let v = post("/devicecode", &[("client_id", CLIENT_ID), ("scope", SCOPE)]).await?;
    if let Some(e) = v["error"].as_str() {
        return Err(Error::Http(format!("Azure DevOps sign-in: {}", v["error_description"].as_str().unwrap_or(e))));
    }
    Ok(DeviceCode {
        device_code: v["device_code"].as_str().unwrap_or("").into(),
        user_code: v["user_code"].as_str().unwrap_or("").into(),
        verification_uri: v["verification_uri"].as_str().unwrap_or("https://microsoft.com/devicelogin").into(),
        interval: v["interval"].as_u64().unwrap_or(5),
        expires_in: v["expires_in"].as_u64().unwrap_or(900),
    })
}

/// On success the tokens are stored in the keychain and the access token returned.
pub async fn poll(device_code: &str) -> Result<Poll> {
    let v = post(
        "/token",
        &[("client_id", CLIENT_ID), ("device_code", device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")],
    )
    .await?;
    let p = parse_poll(&v)?;
    if let Poll::Token(_) = &p {
        save(&v, None)?;
    }
    Ok(p)
}

/// A valid access token, refreshed with the stored refresh token when it is about to expire.
pub async fn access_token() -> Result<String> {
    let raw = secrets::require(KEY, "Azure DevOps")?;
    let t: Tokens = serde_json::from_str(&raw).map_err(|_| Error::NotConnected("Azure DevOps".into()))?;
    if t.expires_at - chrono::Utc::now().timestamp() > 120 {
        return Ok(t.access_token);
    }
    let refresh = t.refresh_token.ok_or_else(|| Error::NotConnected("Azure DevOps".into()))?;
    let v = post("/token", &[("client_id", CLIENT_ID), ("grant_type", "refresh_token"), ("refresh_token", &refresh), ("scope", SCOPE)]).await?;
    if v["access_token"].as_str().is_none() {
        return Err(Error::NotConnected(format!(
            "Azure DevOps (sign in again: {})",
            v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("session expired")
        )));
    }
    save(&v, Some(refresh))
}

/// Store a token response; Entra may rotate the refresh token, else `prev` is kept.
fn save(v: &Value, prev: Option<String>) -> Result<String> {
    let t = Tokens {
        access_token: v["access_token"].as_str().unwrap_or("").into(),
        refresh_token: v["refresh_token"].as_str().map(String::from).or(prev),
        expires_at: chrono::Utc::now().timestamp() + v["expires_in"].as_i64().unwrap_or(3600),
    };
    secrets::set(KEY, &serde_json::to_string(&t)?)?;
    Ok(t.access_token)
}

/// Display name (or email) of the account a token belongs to.
pub async fn login(token: &str) -> Result<String> {
    let res = reqwest::Client::builder()
        .user_agent(concat!("Gitnetix/", env!("CARGO_PKG_VERSION")))
        .build()?
        .get("https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1")
        .bearer_auth(token)
        .header("accept", "application/json")
        .send()
        .await?;
    let status = res.status();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(Error::Http(format!("Azure DevOps {status}: {}", v["message"].as_str().unwrap_or("token rejected"))));
    }
    Ok(v["emailAddress"].as_str().or(v["displayName"].as_str()).unwrap_or("").into())
}

fn parse_poll(v: &Value) -> Result<Poll> {
    if let Some(t) = v["access_token"].as_str().filter(|t| !t.is_empty()) {
        return Ok(Poll::Token(t.into()));
    }
    match v["error"].as_str() {
        Some("authorization_pending") => Ok(Poll::Pending),
        Some("slow_down") => Ok(Poll::SlowDown(v["interval"].as_u64().unwrap_or(10))),
        Some("expired_token") | Some("code_expired") => Err(Error::Invalid("the sign-in code expired — start again".into())),
        Some("authorization_declined") | Some("access_denied") => Err(Error::Invalid("sign-in was cancelled on Microsoft".into())),
        Some(e) => Err(Error::Http(format!("Azure DevOps sign-in: {}", v["error_description"].as_str().unwrap_or(e)))),
        None => Err(Error::Http("Azure DevOps sign-in: unexpected response".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_poll_responses() {
        assert_eq!(parse_poll(&json!({ "error": "authorization_pending" })).unwrap(), Poll::Pending);
        assert_eq!(parse_poll(&json!({ "access_token": "eyJ0", "refresh_token": "r", "expires_in": 3599 })).unwrap(), Poll::Token("eyJ0".into()));
        assert!(parse_poll(&json!({ "error": "expired_token" })).is_err());
        assert!(parse_poll(&json!({ "error": "authorization_declined" })).is_err());
    }
}
