//! "Sign in with Atlassian" for Jira, through `oauth`. Every Jira connection
//! signed in that way shares the tokens kept under `KEY`.

use serde_json::Value;

use super::oauth::{self, JIRA};
use crate::error::{Error, Result};
use crate::net::client as http;
use crate::secrets;
use crate::store::JiraConf;

/// Keychain key holding the stored tokens as JSON. API tokens stay under "jira".
pub const KEY: &str = "jira_oauth";

/// The Jira site the user picked on Atlassian's consent screen.
pub struct Site {
    pub cloud_id: String,
    pub url: String,
}

/// Listen for the redirect and return the URL to open in the browser.
pub async fn start() -> Result<String> {
    oauth::start(&JIRA).await
}

/// Wait until the user approves in the browser; tokens are then stored.
pub async fn finish() -> Result<Site> {
    let token = oauth::save(KEY, &oauth::finish(&JIRA).await?, None)?;
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
    oauth::access_token(&JIRA, KEY).await
}

/// The token for `conf`: OAuth when signed in with Atlassian, else the saved API token.
pub async fn token(conf: &JiraConf) -> Result<String> {
    if conf.cloud_id.is_some() {
        access_token().await
    } else {
        secrets::require(&crate::store::Connection::secret(conf), "Jira API token")
    }
}
