//! Tickets from Jira, Trello and Asana, normalised to one shape.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::store::{AsanaConf, JiraConf, TrelloConf};

pub mod jira_auth;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub key: String,
    /// The tracker's own id, for changing it: Jira key, Trello card id, Asana task gid.
    #[serde(default)]
    pub id: String,
    /// Id of the connection it comes from.
    #[serde(default)]
    pub conn: String,
    /// jira | trello | asana
    pub source: String,
    pub title: String,
    /// Story, Bug, Task, Card…
    pub kind: String,
    /// todo | progress | review | ready | done
    pub status: String,
    pub status_label: String,
    pub assignee: String,
    pub mine: bool,
    pub description: String,
    /// Jira's description as Atlassian Document Format, to show it formatted as in Jira.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub doc: Value,
    pub criteria: Vec<Criterion>,
    pub comments: u32,
    pub url: String,
    pub where_label: String,
    /// The Jira project, Trello board or Asana project it comes from, for switching between them.
    pub place: String,
    /// Jira fix versions, as named there ("2.4.0", "v2.4.0"), to guess the release from.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fix_versions: Vec<String>,
    /// Jira priority name ("High").
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub priority: String,
    /// Jira time tracking as Jira writes it ("3h", "1d 2h"): time left and the original estimate.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub time_remaining: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub time_estimate: String,
    /// Jira parent (epic or story) key, title and page.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub parent_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub parent_title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub parent_url: String,
}

/// A status a ticket can move to: a Jira transition, Trello list or Asana section.
#[derive(Debug, Clone, Serialize)]
pub struct StatusOption {
    pub id: String,
    pub name: String,
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Criterion {
    pub text: String,
    pub done: bool,
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("Gitnetix/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

async fn check(res: reqwest::Response, who: &str) -> Result<Value> {
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    parse(status, &text, who)
}

fn parse(status: reqwest::StatusCode, text: &str, who: &str) -> Result<Value> {
    let v: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v["errorMessages"][0]
            .as_str()
            .or(v["message"].as_str())
            .or(v["errors"][0]["message"].as_str())
            .map(String::from)
            // Jira answers a bad token with plain text, not JSON.
            .unwrap_or_else(|| text.trim().chars().take(200).collect());
        return Err(Error::Http(format!("{who} {status}: {msg}")));
    }
    // An HTML page (wrong site URL) would otherwise read as "no tickets".
    if v.is_null() {
        return Err(Error::Http(format!("{who}: unexpected response, check the site URL")));
    }
    Ok(v)
}

/// Status from a status / column / section name. `category` is Jira's
/// status category; boards with free-form columns pass "" and fall back to
/// the name alone.
fn status_from_name(name: &str, category: &str) -> &'static str {
    let n = name.to_lowercase();
    if n.contains("review") {
        "review"
    } else if n.contains("ready") || n.contains("merge") {
        "ready"
    } else {
        match category {
            "done" => "done",
            "indeterminate" => "progress",
            _ if n.contains("done") => "done",
            _ if n.contains("progress") || n.contains("doing") => "progress",
            _ => "todo",
        }
    }
}

// ---------- Jira ----------

/// Flatten Atlassian Document Format into text, pulling task items out as
/// acceptance criteria.
fn adf_text(node: &Value, out: &mut String, criteria: &mut Vec<Criterion>) {
    match node["type"].as_str() {
        Some("text") => out.push_str(node["text"].as_str().unwrap_or("")),
        Some("hardBreak") => out.push('\n'),
        Some("taskItem") => {
            let mut t = String::new();
            for c in node["content"].as_array().into_iter().flatten() {
                adf_text(c, &mut t, criteria);
            }
            criteria.push(Criterion { text: t.trim().into(), done: node["attrs"]["state"] == "DONE" });
        }
        _ => {
            for c in node["content"].as_array().into_iter().flatten() {
                adf_text(c, out, criteria);
            }
            if matches!(node["type"].as_str(), Some("paragraph" | "heading" | "listItem")) {
                out.push('\n');
            }
        }
    }
}

/// A Jira REST call: through api.atlassian.com with an OAuth token or a
/// scoped API token, or straight to the site with a classic API token.
fn jira_req(conf: &JiraConf, token: &str, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    let gateway = |id: &str| format!("https://api.atlassian.com/ex/jira/{id}{path}");
    match (&conf.cloud_id, &conf.api_cloud_id) {
        (Some(id), _) => http().request(method, gateway(id)).bearer_auth(token),
        (None, Some(id)) => http().request(method, gateway(id)).basic_auth(&conf.email, Some(token)),
        (None, None) => http().request(method, format!("{}{path}", conf.base_url.trim_end_matches('/'))).basic_auth(&conf.email, Some(token)),
    }
}

/// `jira_me` for a new connection, picking the API token's route: the site
/// for a classic token, else api.atlassian.com, the only one a scoped token works on.
pub async fn jira_connect(conf: &mut JiraConf, token: &str) -> Result<Value> {
    conf.api_cloud_id = None;
    let site = jira_me(conf, token).await;
    if site.is_ok() || conf.cloud_id.is_some() {
        return site;
    }
    let tenant = http().get(format!("{}/_edge/tenant_info", conf.base_url.trim_end_matches('/'))).send().await;
    let Some(id) = (match tenant {
        Ok(res) => check(res, "Jira").await.ok().and_then(|v| v["cloudId"].as_str().map(String::from)),
        Err(_) => None,
    }) else {
        return site;
    };
    conf.api_cloud_id = Some(id);
    jira_me(conf, token).await
}

/// The signed-in Jira user. Checked first: with a bad token, search falls
/// back to anonymous and answers 200 with no issues.
pub async fn jira_me(conf: &JiraConf, token: &str) -> Result<Value> {
    let res = jira_req(conf, token, reqwest::Method::GET, "/rest/api/3/myself").send().await?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Error::Http(if conf.cloud_id.is_some() {
            "Jira session expired or was revoked. Sign in with Atlassian again".into()
        } else {
            "Jira rejected the email and API token. Check the account email and that the token hasn't expired; a scoped token needs the read:jira-user and read:jira-work scopes, and write:jira-work to change a status".into()
        }));
    }
    check(res, "Jira").await
}

/// Most tickets fetched per Jira connection, so a broad JQL can't page on for ever.
const JIRA_CAP: usize = 1000;

/// `mine` adds `assignee = currentUser()`, so the cap can't hide the user's own tickets;
/// `sprint` keeps only tickets in an open sprint.
pub async fn jira(conf: &JiraConf, token: &str, mine: bool, sprint: bool) -> Result<Vec<Ticket>> {
    let base = conf.base_url.trim_end_matches('/');
    // The whole sprint, done tickets included, not just the user's part of it: "Assigned to me" narrows that down.
    let jql = conf.jql.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| {
        if sprint {
            "ORDER BY updated DESC".into()
        } else {
            "(assignee = currentUser() OR reporter = currentUser() OR assignee is EMPTY) AND statusCategory != Done ORDER BY updated DESC".into()
        }
    });
    let mut jql = scope_jql(&jql, &conf.projects);
    if mine {
        jql = and_jql(&jql, "assignee = currentUser()");
    }
    if sprint {
        jql = and_jql(&jql, "sprint in openSprints()");
    }
    let me = jira_me(conf, token).await?;
    let my_id = me["accountId"].as_str().unwrap_or("").to_string();
    let mut issues = Vec::new();
    let mut page: Option<String> = None;
    loop {
        let mut body = json!({ "jql": jql, "maxResults": 100, "fields": ["summary", "status", "issuetype", "assignee", "description", "comment", "project", "fixVersions", "priority", "timetracking", "parent"] });
        if let Some(t) = &page {
            body["nextPageToken"] = t.as_str().into();
        }
        let v = check(jira_req(conf, token, reqwest::Method::POST, "/rest/api/3/search/jql").json(&body).send().await?, "Jira").await?;
        issues.extend(v["issues"].as_array().cloned().unwrap_or_default());
        page = v["nextPageToken"].as_str().map(String::from);
        if page.is_none() || issues.len() >= JIRA_CAP {
            break;
        }
    }
    issues.truncate(JIRA_CAP);
    Ok(issues
        .iter()
        .map(|i| {
            let f = &i["fields"];
            let key = i["key"].as_str().unwrap_or("").to_string();
            let mut desc = String::new();
            let mut criteria = Vec::new();
            adf_text(&f["description"], &mut desc, &mut criteria);
            let st_name = f["status"]["name"].as_str().unwrap_or("");
            let cat = f["status"]["statusCategory"]["key"].as_str().unwrap_or("new");
            Ticket {
                url: format!("{base}/browse/{key}"),
                where_label: format!("Jira · {}", f["project"]["name"].as_str().unwrap_or("")),
                place: format!("Jira · {}", f["project"]["name"].as_str().unwrap_or("")),
                id: key.clone(),
                conn: conf.id.clone(),
                key,
                source: "jira".into(),
                title: f["summary"].as_str().unwrap_or("").into(),
                kind: f["issuetype"]["name"].as_str().unwrap_or("Task").into(),
                status: status_from_name(st_name, cat).into(),
                status_label: st_name.into(),
                assignee: f["assignee"]["displayName"].as_str().unwrap_or("Unassigned").into(),
                mine: f["assignee"]["accountId"].as_str() == Some(my_id.as_str()),
                description: desc.trim().into(),
                doc: f["description"].clone(),
                criteria,
                comments: f["comment"]["total"].as_u64().unwrap_or(0) as u32,
                fix_versions: f["fixVersions"].as_array().into_iter().flatten().filter_map(|v| v["name"].as_str().map(String::from)).collect(),
                priority: f["priority"]["name"].as_str().unwrap_or("").into(),
                time_remaining: f["timetracking"]["remainingEstimate"].as_str().unwrap_or("").into(),
                time_estimate: f["timetracking"]["originalEstimate"].as_str().unwrap_or("").into(),
                parent_key: f["parent"]["key"].as_str().unwrap_or("").into(),
                parent_title: f["parent"]["fields"]["summary"].as_str().unwrap_or("").into(),
                parent_url: f["parent"]["key"].as_str().map(|k| format!("{base}/browse/{k}")).unwrap_or_default(),
            }
        })
        .collect())
}

/// Where Jira lets ticket `key` go from its current status.
pub async fn jira_statuses(conf: &JiraConf, token: &str, key: &str) -> Result<Vec<StatusOption>> {
    let v = check(jira_req(conf, token, reqwest::Method::GET, &format!("/rest/api/3/issue/{key}/transitions")).send().await?, "Jira").await?;
    Ok(v["transitions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| {
            let name = t["to"]["name"].as_str().or(t["name"].as_str()).unwrap_or("");
            StatusOption { id: t["id"].as_str().unwrap_or("").into(), name: name.into(), status: status_from_name(name, t["to"]["statusCategory"]["key"].as_str().unwrap_or("")) }
        })
        .collect())
}

pub async fn jira_set_status(conf: &JiraConf, token: &str, key: &str, transition: &str) -> Result<()> {
    jira_write(jira_req(conf, token, reqwest::Method::POST, &format!("/rest/api/3/issue/{key}/transitions")).json(&json!({ "transition": { "id": transition } }))).await
}

/// The versions of ticket `key`'s project, unreleased first and archived last; archived ones
/// are kept so a ticket's current fix versions can be found by name.
pub async fn jira_versions(conf: &JiraConf, token: &str, key: &str) -> Result<Vec<Value>> {
    let project = key.split('-').next().unwrap_or(key);
    let v = check(jira_req(conf, token, reqwest::Method::GET, &format!("/rest/api/3/project/{project}/versions")).send().await?, "Jira").await?;
    let mut out: Vec<&Value> = v.as_array().into_iter().flatten().collect();
    out.sort_by_key(|v| (v["archived"] == true, v["released"] == true));
    Ok(out
        .into_iter()
        .map(|v| json!({ "id": v["id"], "name": v["name"], "released": v["released"] == true, "archived": v["archived"] == true }))
        .collect())
}

/// Sets the ticket's fix versions to exactly `versions` (ids); empty clears them.
pub async fn jira_set_fix_versions(conf: &JiraConf, token: &str, key: &str, versions: &[String]) -> Result<()> {
    let ids: Vec<Value> = versions.iter().map(|id| json!({ "id": id })).collect();
    jira_write(jira_req(conf, token, reqwest::Method::PUT, &format!("/rest/api/3/issue/{key}")).json(&json!({ "fields": { "fixVersions": ids } }))).await
}

async fn jira_write(req: reqwest::RequestBuilder) -> Result<()> {
    let res = req.send().await?;
    // Success is an empty 204, which `check` would read as a wrong site.
    if !res.status().is_success() {
        check(res, "Jira").await?;
    }
    Ok(())
}

/// `jql` limited to the given project keys, keeping its ORDER BY last.
fn scope_jql(jql: &str, projects: &[String]) -> String {
    if projects.is_empty() {
        return jql.into();
    }
    let keys = projects.iter().map(|k| format!("\"{}\"", k.replace('"', ""))).collect::<Vec<_>>().join(", ");
    and_jql(jql, &format!("project in ({keys})"))
}

/// `clause AND (jql)`, keeping jql's ORDER BY last.
fn and_jql(jql: &str, clause: &str) -> String {
    let at = jql.to_ascii_uppercase().rfind("ORDER BY").unwrap_or(jql.len());
    let (filter, order) = (jql[..at].trim(), &jql[at..]);
    let filter = if filter.is_empty() { String::new() } else { format!(" AND ({filter})") };
    format!("{clause}{filter} {order}").trim_end().into()
}

/// The Jira projects `token` can see, for picking which ones to show.
pub async fn jira_projects(conf: &JiraConf, token: &str) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    loop {
        let path = format!("/rest/api/3/project/search?maxResults=100&orderBy=name&startAt={}", out.len());
        let v = check(jira_req(conf, token, reqwest::Method::GET, &path).send().await?, "Jira").await?;
        let page = v["values"].as_array().cloned().unwrap_or_default();
        let done = page.is_empty() || v["isLast"].as_bool().unwrap_or(true);
        out.extend(page.into_iter().map(|p| json!({ "key": p["key"], "name": p["name"] })));
        if done {
            return Ok(out);
        }
    }
}

// ---------- Trello ----------

pub async fn trello(conf: &TrelloConf, token: &str) -> Result<Vec<Ticket>> {
    let auth = format!("key={}&token={}", conf.api_key, token);
    let url = match &conf.board_id {
        Some(b) if !b.is_empty() => format!("https://api.trello.com/1/boards/{b}/cards?list=true&checklists=all&members=true&{auth}"),
        _ => format!("https://api.trello.com/1/members/me/cards?list=true&checklists=all&members=true&{auth}"),
    };
    let v = check(http().get(url).send().await?, "Trello").await?;
    let place = match &conf.board_id {
        Some(b) if !b.is_empty() => {
            let board = check(http().get(format!("https://api.trello.com/1/boards/{b}?fields=name&{auth}")).send().await?, "Trello").await;
            format!("Trello · {}", board.ok().and_then(|v| v["name"].as_str().map(String::from)).unwrap_or_else(|| b.clone()))
        }
        _ => "Trello · My cards".into(),
    };
    Ok(v.as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["closed"] != true)
        .map(|c| {
            let list = c["list"]["name"].as_str().unwrap_or("");
            let status = status_from_name(list, "");
            let criteria = c["checklists"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|cl| cl["checkItems"].as_array().cloned().unwrap_or_default())
                .map(|it| Criterion { text: it["name"].as_str().unwrap_or("").into(), done: it["state"] == "complete" })
                .collect();
            Ticket {
                fix_versions: Vec::new(),
                priority: String::new(),
                time_remaining: String::new(),
                time_estimate: String::new(),
                parent_key: String::new(),
                parent_title: String::new(),
                parent_url: String::new(),
                key: format!("#{}", c["idShort"].as_u64().unwrap_or(0)),
                id: c["id"].as_str().unwrap_or("").into(),
                conn: conf.id.clone(),
                source: "trello".into(),
                title: c["name"].as_str().unwrap_or("").into(),
                kind: "Card".into(),
                status: status.into(),
                status_label: list.into(),
                assignee: c["members"][0]["fullName"].as_str().unwrap_or("Unassigned").into(),
                mine: true,
                description: c["desc"].as_str().unwrap_or("").into(),
                doc: Value::Null,
                criteria,
                comments: c["badges"]["comments"].as_u64().unwrap_or(0) as u32,
                url: c["url"].as_str().unwrap_or("").into(),
                where_label: format!("Trello · {list}"),
                place: place.clone(),
            }
        })
        .collect())
}

/// The open lists of the card's board.
pub async fn trello_statuses(conf: &TrelloConf, token: &str, card: &str) -> Result<Vec<StatusOption>> {
    let auth = format!("key={}&token={}", conf.api_key, token);
    let c = check(http().get(format!("https://api.trello.com/1/cards/{card}?fields=idBoard&{auth}")).send().await?, "Trello").await?;
    let board = c["idBoard"].as_str().unwrap_or("");
    let v = check(http().get(format!("https://api.trello.com/1/boards/{board}/lists?filter=open&fields=name&{auth}")).send().await?, "Trello").await?;
    Ok(v.as_array()
        .into_iter()
        .flatten()
        .map(|l| {
            let name = l["name"].as_str().unwrap_or("");
            StatusOption { id: l["id"].as_str().unwrap_or("").into(), name: name.into(), status: status_from_name(name, "") }
        })
        .collect())
}

pub async fn trello_set_status(conf: &TrelloConf, token: &str, card: &str, list: &str) -> Result<()> {
    let auth = format!("key={}&token={}", conf.api_key, token);
    check(http().put(format!("https://api.trello.com/1/cards/{card}?idList={list}&{auth}")).send().await?, "Trello").await?;
    Ok(())
}

// ---------- Asana ----------

/// The option completing an Asana task, next to its project's sections.
const ASANA_DONE: &str = "completed";

pub async fn asana(conf: &AsanaConf, token: &str) -> Result<Vec<Ticket>> {
    let fields = "name,notes,completed,permalink_url,assignee.name,memberships.section.name,num_likes";
    let url = match &conf.project_gid {
        Some(p) if !p.is_empty() => format!("https://app.asana.com/api/1.0/projects/{p}/tasks?completed_since=now&opt_fields={fields}"),
        _ => format!(
            "https://app.asana.com/api/1.0/tasks?assignee=me&workspace={}&completed_since=now&opt_fields={fields}",
            conf.workspace_gid
        ),
    };
    let v = check(http().get(url).bearer_auth(token).send().await?, "Asana").await?;
    let place = match &conf.project_gid {
        Some(p) if !p.is_empty() => {
            let project = check(http().get(format!("https://app.asana.com/api/1.0/projects/{p}?opt_fields=name")).bearer_auth(token).send().await?, "Asana").await;
            format!("Asana · {}", project.ok().and_then(|v| v["data"]["name"].as_str().map(String::from)).unwrap_or_else(|| p.clone()))
        }
        _ => "Asana · My tasks".into(),
    };
    Ok(v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| {
            let section = t["memberships"][0]["section"]["name"].as_str().unwrap_or("");
            let status = if t["completed"] == true { "done" } else { status_from_name(section, "") };
            Ticket {
                fix_versions: Vec::new(),
                priority: String::new(),
                time_remaining: String::new(),
                time_estimate: String::new(),
                parent_key: String::new(),
                parent_title: String::new(),
                parent_url: String::new(),
                // Full gid: a suffix collides across tasks, and the prefix
                // keeps it apart from Trello's `#idShort` keys.
                key: format!("AS-{}", t["gid"].as_str().unwrap_or("")),
                id: t["gid"].as_str().unwrap_or("").into(),
                conn: conf.id.clone(),
                source: "asana".into(),
                title: t["name"].as_str().unwrap_or("").into(),
                kind: "Task".into(),
                status: status.into(),
                status_label: if section.is_empty() { "Open".into() } else { section.into() },
                assignee: t["assignee"]["name"].as_str().unwrap_or("Unassigned").into(),
                mine: true,
                description: t["notes"].as_str().unwrap_or("").into(),
                doc: Value::Null,
                criteria: vec![],
                comments: 0,
                url: t["permalink_url"].as_str().unwrap_or("").into(),
                where_label: "Asana".into(),
                place: place.clone(),
            }
        })
        .collect())
}

/// The sections of the task's first project, the one its status is read from, and completing it.
pub async fn asana_statuses(token: &str, task: &str) -> Result<Vec<StatusOption>> {
    let t = check(http().get(format!("https://app.asana.com/api/1.0/tasks/{task}?opt_fields=memberships.project.gid")).bearer_auth(token).send().await?, "Asana").await?;
    let mut out = Vec::new();
    if let Some(p) = t["data"]["memberships"][0]["project"]["gid"].as_str() {
        let v = check(http().get(format!("https://app.asana.com/api/1.0/projects/{p}/sections?opt_fields=name")).bearer_auth(token).send().await?, "Asana").await?;
        out.extend(v["data"].as_array().into_iter().flatten().map(|s| {
            let name = s["name"].as_str().unwrap_or("");
            StatusOption { id: s["gid"].as_str().unwrap_or("").into(), name: name.into(), status: status_from_name(name, "") }
        }));
    }
    out.push(StatusOption { id: ASANA_DONE.into(), name: "Completed".into(), status: "done" });
    Ok(out)
}

/// Moves the task to section `to`, reopening it, or completes it.
pub async fn asana_set_status(token: &str, task: &str, to: &str) -> Result<()> {
    if to != ASANA_DONE {
        check(http().post(format!("https://app.asana.com/api/1.0/sections/{to}/addTask")).bearer_auth(token).json(&json!({ "data": { "task": task } })).send().await?, "Asana").await?;
    }
    check(http().put(format!("https://app.asana.com/api/1.0/tasks/{task}")).bearer_auth(token).json(&json!({ "data": { "completed": to == ASANA_DONE } })).send().await?, "Asana").await?;
    Ok(())
}

/// Ticket keys mentioned in text ("ATL-212", "Refs ATL-212").
pub fn extract_keys(text: &str) -> Vec<String> {
    // Branch names put an underscore after the key (`feat/ATL-212_login`), and `_` is a word character.
    let re = regex::Regex::new(r"\b([A-Z][A-Z0-9]{1,9}-\d+)(?:_|\b)").expect("regex");
    const NOT_TICKETS: &[&str] = &["UTF", "ISO", "SHA", "RFC", "HTTP", "TLS", "AES", "CVE", "MD", "X"];
    let mut v: Vec<String> = Vec::new();
    for c in re.captures_iter(text) {
        let k = &c[1];
        let prefix = k.split('-').next().unwrap_or("");
        if !NOT_TICKETS.contains(&prefix) && !v.iter().any(|x| x == k) {
            v.push(k.to_string());
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_jql_to_projects() {
        let p = vec!["ATL".to_string(), "WEB".to_string()];
        assert_eq!(scope_jql("a = 1 ORDER BY updated DESC", &[]), "a = 1 ORDER BY updated DESC");
        assert_eq!(scope_jql("a = 1 order by updated DESC", &p), r#"project in ("ATL", "WEB") AND (a = 1) order by updated DESC"#);
        assert_eq!(scope_jql("a = 1", &p), r#"project in ("ATL", "WEB") AND (a = 1)"#);
        assert_eq!(scope_jql("ORDER BY rank", &p[..1]), r#"project in ("ATL") ORDER BY rank"#);
        assert_eq!(and_jql("a = 1 ORDER BY rank", "b = 2"), "b = 2 AND (a = 1) ORDER BY rank");
    }

    #[test]
    fn finds_keys() {
        assert_eq!(extract_keys("feat: x\n\nRefs ATL-212, see UTF-8"), vec!["ATL-212"]);
        assert_eq!(extract_keys("Merge branch 'feat/ATL-212_login'"), vec!["ATL-212"]);
    }

    #[test]
    fn column_statuses() {
        assert_eq!(status_from_name("Ready to merge", ""), "ready");
        assert_eq!(status_from_name("Done", ""), "done");
        assert_eq!(status_from_name("Doing", ""), "progress");
        assert_eq!(status_from_name("Code review", ""), "review");
        assert_eq!(status_from_name("Backlog", ""), "todo");
        assert_eq!(status_from_name("In Progress", "indeterminate"), "progress");
    }

    #[test]
    fn parse_bodies() {
        use reqwest::StatusCode;
        let e = parse(StatusCode::UNAUTHORIZED, "Client must be authenticated to access this resource.", "Jira").unwrap_err();
        assert!(e.to_string().contains("Client must be authenticated"));
        assert!(parse(StatusCode::OK, "<html></html>", "Jira").is_err());
        assert_eq!(parse(StatusCode::OK, r#"{"issues":[]}"#, "Jira").unwrap()["issues"], json!([]));
    }

    #[test]
    fn adf_flatten() {
        let doc = json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"Hello"}]},
            {"type":"taskList","content":[{"type":"taskItem","attrs":{"state":"DONE"},"content":[{"type":"text","text":"A"}]}]}
        ]});
        let mut s = String::new();
        let mut c = Vec::new();
        adf_text(&doc, &mut s, &mut c);
        assert_eq!(s.trim(), "Hello");
        assert_eq!(c.len(), 1);
        assert!(c[0].done);
    }
}
