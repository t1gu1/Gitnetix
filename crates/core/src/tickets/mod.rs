//! Tickets from Jira, Trello and Asana, normalised to one shape.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::net::client as http;
use crate::store::{AsanaConf, Connection, JiraConf, TrelloConf};

pub mod jira_auth;
pub mod oauth;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    /// Jira key, `#` and a Trello card's short link (the id in its URL), `AS-` and an Asana task gid.
    pub key: String,
    /// The key a Trello card had before short links (`#idShort`, which repeats across boards), to move saved links from.
    #[serde(skip)]
    pub old_key: Option<String>,
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
const JIRA_FIELDS: [&str; 11] = ["summary", "status", "issuetype", "assignee", "description", "comment", "project", "fixVersions", "priority", "timetracking", "parent"];

pub async fn jira(conf: &JiraConf, token: &str, mine: bool, sprint: bool) -> Result<Vec<Ticket>> {
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
        let mut body = json!({ "jql": jql, "maxResults": 100, "fields": JIRA_FIELDS });
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
    Ok(issues.iter().map(|i| jira_ticket(conf, i, &my_id)).collect())
}

/// A Jira issue as returned by search or by `/issue/{key}`, as a `Ticket`.
fn jira_ticket(conf: &JiraConf, i: &Value, my_id: &str) -> Ticket {
    let base = conf.base_url.trim_end_matches('/');
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
        old_key: None,
        source: "jira".into(),
        title: f["summary"].as_str().unwrap_or("").into(),
        kind: f["issuetype"]["name"].as_str().unwrap_or("Task").into(),
        status: status_from_name(st_name, cat).into(),
        status_label: st_name.into(),
        assignee: f["assignee"]["displayName"].as_str().unwrap_or("Unassigned").into(),
        mine: f["assignee"]["accountId"].as_str() == Some(my_id),
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
}

/// One Jira ticket by key, whatever its status or assignee. `mine` is left false: it would cost a `myself` call.
/// None when Jira has no such issue: branch names hold key-like words (`fix/utf-8-…`).
pub async fn jira_issue(conf: &JiraConf, token: &str, key: &str) -> Result<Option<Ticket>> {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(Error::Invalid(format!("“{key}” is not a Jira key")));
    }
    let path = format!("/rest/api/3/issue/{key}?fields={}", JIRA_FIELDS.join(","));
    let res = jira_req(conf, token, reqwest::Method::GET, &path).send().await?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    Ok(Some(jira_ticket(conf, &check(res, "Jira").await?, "")))
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

/// The token of a Trello connection, renewed first when it came from "Sign in with Trello".
pub async fn trello_token(conf: &TrelloConf) -> Result<String> {
    oauth::token(&oauth::TRELLO, &conf.secret(), conf.oauth).await
}

/// A Trello REST call: with the OAuth 2.0 token when signed in, else with the API key and its token.
/// Both go in a header, not in the URL, which request errors quote.
fn trello_req(conf: &TrelloConf, token: &str, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    if conf.oauth {
        // The host Trello's OAuth 2.0 guide calls with the bearer token.
        http().request(method, format!("https://trello.com/1{path}")).bearer_auth(token)
    } else {
        let auth = format!("OAuth oauth_consumer_key=\"{}\", oauth_token=\"{token}\"", conf.api_key);
        http().request(method, format!("https://api.trello.com/1{path}")).header(reqwest::header::AUTHORIZATION, auth)
    }
}

/// The member's name and open boards, by name. Also how a connection checks its token.
pub async fn trello_account(conf: &TrelloConf, token: &str) -> Result<Value> {
    let res = trello_req(conf, token, reqwest::Method::GET, "/members/me?fields=fullName,username&boards=open&board_fields=name").send().await?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Error::Http(if conf.oauth {
            "Trello session expired or was revoked. Sign in with Trello again".into()
        } else {
            "Trello rejected the API key and token. Check both, and that the token was made for this API key".into()
        }));
    }
    let me = check(res, "Trello").await?;
    let mut boards: Vec<Value> = me["boards"].as_array().into_iter().flatten().map(|b| json!({ "id": b["id"], "name": b["name"] })).collect();
    boards.sort_by_key(|b| b["name"].as_str().unwrap_or("").to_lowercase());
    Ok(json!({ "user": me["fullName"].as_str().filter(|n| !n.is_empty()).or(me["username"].as_str()), "boards": boards }))
}

pub async fn trello(conf: &TrelloConf, token: &str) -> Result<Vec<Ticket>> {
    let get = |path: String| trello_req(conf, token, reqwest::Method::GET, &path).send();
    let cards = "cards?list=true&checklists=all&members=true";
    // Each picked board's cards, or the cards assigned to the user when none is picked.
    let mut lists = Vec::new();
    for b in conf.boards.iter().filter(|b| !b.is_empty()) {
        let board = check(get(format!("/boards/{b}?fields=name")).await?, "Trello").await;
        let name = board.ok().and_then(|v| v["name"].as_str().map(String::from)).unwrap_or_else(|| b.clone());
        lists.push((format!("/boards/{b}/{cards}"), format!("Trello · {name}")));
    }
    if lists.is_empty() {
        lists.push((format!("/members/me/{cards}"), "Trello · My cards".into()));
    }
    let mut out = Vec::new();
    for (path, place) in lists {
        let v = check(get(path).await?, "Trello").await?;
        out.extend(v.as_array().into_iter().flatten().filter(|c| c["closed"] != true).map(|c| trello_card(conf, c, &place)));
    }
    Ok(out)
}

/// A Trello card, as listed by `/cards` with its list, checklists and members, as a ticket of `place`.
fn trello_card(conf: &TrelloConf, c: &Value, place: &str) -> Ticket {
    let old_key = format!("#{}", c["idShort"].as_u64().unwrap_or(0));
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
        // The card number repeats on every board; the short link doesn't.
        key: c["shortLink"].as_str().filter(|l| !l.is_empty()).map_or_else(|| old_key.clone(), |l| format!("#{l}")),
        old_key: Some(old_key),
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
        place: place.into(),
    }
}

/// The open lists of the card's board.
pub async fn trello_statuses(conf: &TrelloConf, token: &str, card: &str) -> Result<Vec<StatusOption>> {
    let get = |path: String| trello_req(conf, token, reqwest::Method::GET, &path).send();
    let c = check(get(format!("/cards/{card}?fields=idBoard")).await?, "Trello").await?;
    let board = c["idBoard"].as_str().unwrap_or("");
    let v = check(get(format!("/boards/{board}/lists?filter=open&fields=name")).await?, "Trello").await?;
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
    check(trello_req(conf, token, reqwest::Method::PUT, &format!("/cards/{card}?idList={list}")).send().await?, "Trello").await?;
    Ok(())
}

// ---------- Asana ----------

/// The option completing an Asana task, next to its project's sections.
const ASANA_DONE: &str = "completed";

/// The token of an Asana connection, renewed first when it came from "Sign in with Asana".
pub async fn asana_token(conf: &AsanaConf) -> Result<String> {
    oauth::token(&oauth::ASANA, &conf.secret(), conf.oauth).await
}

/// The user's name and workspaces. Also how a connection checks its token.
pub async fn asana_me(token: &str) -> Result<Value> {
    let res = http().get("https://app.asana.com/api/1.0/users/me?opt_fields=name,workspaces.name").bearer_auth(token).send().await?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Error::Http("Asana rejected the token, or the session expired. Sign in with Asana again or paste a new personal access token".into()));
    }
    let v = check(res, "Asana").await?;
    let workspaces: Vec<Value> = v["data"]["workspaces"].as_array().into_iter().flatten().map(|w| json!({ "id": w["gid"], "name": w["name"] })).collect();
    Ok(json!({ "user": v["data"]["name"], "workspaces": workspaces }))
}

/// The workspace's active projects, by name, for picking one.
pub async fn asana_projects(token: &str, workspace: &str) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut offset: Option<String> = None;
    // shortcut: stops at 1000 projects, page further if someone's project is missing from the list.
    while out.len() < 1000 {
        let mut q = vec![("workspace", workspace), ("archived", "false"), ("opt_fields", "name"), ("limit", "100")];
        q.extend(offset.as_deref().map(|o| ("offset", o)));
        let v = check(http().get("https://app.asana.com/api/1.0/projects").query(&q).bearer_auth(token).send().await?, "Asana").await?;
        out.extend(v["data"].as_array().into_iter().flatten().map(|p| json!({ "id": p["gid"], "name": p["name"] })));
        offset = v["next_page"]["offset"].as_str().map(String::from);
        if offset.is_none() {
            break;
        }
    }
    out.sort_by_key(|p| p["name"].as_str().unwrap_or("").to_lowercase());
    Ok(out)
}

pub async fn asana(conf: &AsanaConf, token: &str) -> Result<Vec<Ticket>> {
    let api = "https://app.asana.com/api/1.0";
    let fields = "name,notes,completed,permalink_url,assignee.name,memberships.section.name,num_likes";
    // Each picked project's open tasks, or the user's own in the workspace when none is picked.
    let mut urls = Vec::new();
    for p in conf.projects.iter().filter(|p| !p.is_empty()) {
        let project = check(http().get(format!("{api}/projects/{p}?opt_fields=name")).bearer_auth(token).send().await?, "Asana").await;
        let name = project.ok().and_then(|v| v["data"]["name"].as_str().map(String::from)).unwrap_or_else(|| p.clone());
        urls.push((format!("{api}/projects/{p}/tasks?completed_since=now&opt_fields={fields}"), format!("Asana · {name}")));
    }
    if urls.is_empty() {
        urls.push((format!("{api}/tasks?assignee=me&workspace={}&completed_since=now&opt_fields={fields}", conf.workspace_gid), "Asana · My tasks".into()));
    }
    let mut lists = Vec::new();
    for (url, place) in urls {
        lists.push((check(http().get(url).bearer_auth(token).send().await?, "Asana").await?, place));
    }
    Ok(asana_tickets(conf, &lists))
}

/// Task lists from Asana, each with the place it was read from, as tickets. A task in several of
/// the picked projects is listed once, under the first.
fn asana_tickets(conf: &AsanaConf, lists: &[(Value, String)]) -> Vec<Ticket> {
    let mut out: Vec<Ticket> = Vec::new();
    for (v, place) in lists {
        for t in v["data"].as_array().into_iter().flatten() {
            if out.iter().any(|x| Some(x.id.as_str()) == t["gid"].as_str()) {
                continue;
            }
            let section = t["memberships"][0]["section"]["name"].as_str().unwrap_or("");
            let status = if t["completed"] == true { "done" } else { status_from_name(section, "") };
            out.push(Ticket {
                fix_versions: Vec::new(),
                priority: String::new(),
                time_remaining: String::new(),
                time_estimate: String::new(),
                parent_key: String::new(),
                parent_title: String::new(),
                parent_url: String::new(),
                // Full gid: a suffix collides across tasks, and the prefix
                // keeps it apart from Trello's `#` keys.
                key: format!("AS-{}", t["gid"].as_str().unwrap_or("")),
                old_key: None,
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
            });
        }
    }
    out
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
    fn jira_issue_as_ticket() {
        let conf: JiraConf = serde_json::from_value(json!({ "id": "c1", "baseUrl": "https://x.atlassian.net/", "email": "a@b.c" })).unwrap();
        let issue = json!({ "key": "ATL-212", "fields": {
            "summary": "Login", "issuetype": { "name": "Story" }, "project": { "name": "Atlas" },
            "status": { "name": "Done", "statusCategory": { "key": "done" } },
            "assignee": { "accountId": "me", "displayName": "Ana" },
            "description": { "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Users sign in." }] }] },
            "parent": { "key": "ATL-1", "fields": { "summary": "Auth" } }
        }});
        let t = jira_ticket(&conf, &issue, "me");
        assert_eq!((t.key.as_str(), t.id.as_str(), t.conn.as_str()), ("ATL-212", "ATL-212", "c1"));
        assert_eq!(t.url, "https://x.atlassian.net/browse/ATL-212");
        assert_eq!((t.status.as_str(), t.description.as_str(), t.parent_title.as_str()), ("done", "Users sign in.", "Auth"));
        assert!(t.mine);
        assert!(!jira_ticket(&conf, &issue, "").mine);
    }

    #[test]
    fn trello_cards_are_keyed_by_short_link() {
        let conf = TrelloConf { id: "c1".into(), ..Default::default() };
        let card = json!({ "id": "5f0a", "idShort": 12, "shortLink": "aB3dE9fG", "name": "Login", "list": { "name": "Doing" }, "url": "https://trello.com/c/aB3dE9fG/12-login" });
        let t = trello_card(&conf, &card, "Trello · Web");
        assert_eq!((t.key.as_str(), t.old_key.as_deref(), t.status.as_str(), t.place.as_str()), ("#aB3dE9fG", Some("#12"), "progress", "Trello · Web"));
        // Without a short link, the number stays the key: nothing to move.
        let t = trello_card(&conf, &json!({ "idShort": 3 }), "Trello · Web");
        assert_eq!((t.key.as_str(), t.old_key.as_deref()), ("#3", Some("#3")));
    }

    #[test]
    fn asana_task_in_two_projects_is_listed_once() {
        let conf = AsanaConf { id: "c1".into(), ..Default::default() };
        let web = json!({ "data": [{ "gid": "1", "name": "Login" }, { "gid": "2", "name": "Logout", "completed": true }] });
        let mobile = json!({ "data": [{ "gid": "1", "name": "Login" }, { "gid": "3", "name": "Sign up" }] });
        let t = asana_tickets(&conf, &[(web, "Asana · Web".into()), (mobile, "Asana · Mobile".into())]);
        let got: Vec<_> = t.iter().map(|t| (t.key.as_str(), t.place.as_str(), t.status.as_str())).collect();
        assert_eq!(got, [("AS-1", "Asana · Web", "todo"), ("AS-2", "Asana · Web", "done"), ("AS-3", "Asana · Mobile", "todo")]);
    }

    #[test]
    fn trello_auth_stays_out_of_urls() {
        let mut conf = TrelloConf { api_key: "k1".into(), ..Default::default() };
        let r = trello_req(&conf, "t1", reqwest::Method::GET, "/members/me?fields=fullName").build().unwrap();
        assert_eq!(r.url().as_str(), "https://api.trello.com/1/members/me?fields=fullName");
        assert_eq!(r.headers()["authorization"], r#"OAuth oauth_consumer_key="k1", oauth_token="t1""#);
        conf.oauth = true;
        let r = trello_req(&conf, "t2", reqwest::Method::GET, "/members/me").build().unwrap();
        assert_eq!(r.url().as_str(), "https://trello.com/1/members/me");
        assert_eq!(r.headers()["authorization"], "Bearer t2");
    }

    #[tokio::test]
    async fn jira_issue_refuses_odd_keys() {
        let conf: JiraConf = serde_json::from_value(json!({ "baseUrl": "https://x.atlassian.net", "email": "a@b.c" })).unwrap();
        assert!(matches!(jira_issue(&conf, "t", "ATL-1/../../x").await, Err(Error::Invalid(_))));
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
