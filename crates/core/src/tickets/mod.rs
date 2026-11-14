//! Tickets from Jira, Trello, Asana, Linear and GitHub Issues, normalised to one shape.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::net::client as http;
use crate::providers::github::GitHub;
use crate::store::{AsanaConf, Connection, JiraConf, LinearConf, TrelloConf};

pub mod jira_auth;
pub mod oauth;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    /// Jira key, `#` and a Trello card's short link (the id in its URL), `AS-` and an Asana task gid, Linear identifier (`ENG-123`), `#` and a GitHub issue number.
    pub key: String,
    /// The key a Trello card had before short links (`#idShort`, which repeats across boards), to move saved links from.
    #[serde(skip)]
    pub old_key: Option<String>,
    /// The tracker's own id, for changing it: Jira key, Trello card id, Asana task gid, Linear issue id, GitHub issue number.
    #[serde(default)]
    pub id: String,
    /// Id of the connection it comes from; `owner/repo` for a GitHub issue.
    #[serde(default)]
    pub conn: String,
    /// jira | trello | asana | linear | github
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
    /// The Jira project, Trello board, Asana project or GitHub repository it comes from, for switching between them.
    pub place: String,
    /// Jira and GitHub labels.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    /// Jira fix versions, as named there ("2.4.0", "v2.4.0"), or the GitHub milestone, to guess the release from.
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

/// A status a ticket can move to: a Jira transition, Trello list, Asana section or Linear workflow state.
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

/// Status from a status / column / section name, in English or French. `category` is Jira's
/// status category; boards with free-form columns pass "" and fall back to
/// the name alone.
fn status_from_name(name: &str, category: &str) -> &'static str {
    let n = name.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| n.contains(w));
    if has(&["review", "révision", "revision", "revue", "relecture"]) {
        "review"
    } else if has(&["ready", "merge", "prêt", "fusion"]) {
        "ready"
    } else {
        match category {
            "done" => "done",
            "indeterminate" => "progress",
            // "Fait" and "Terminé", never "À faire".
            _ if has(&["done", "termin", "fait", "complét"]) => "done",
            _ if has(&["progress", "doing", "en cours", "développ"]) => "progress",
            _ => "todo",
        }
    }
}

/// Whether a done ticket's status or resolution says it was dropped, not done ("Annulé", "Won't Do", "Duplicate").
fn dropped(status: &str, resolution: &str) -> bool {
    let words = ["annul", "cancel", "abandon", "rejet", "reject", "won't", "wont", "will not", "ne sera pas", "doublon", "duplicate", "obsol"];
    [status, resolution].iter().any(|s| {
        let s = s.to_lowercase();
        words.iter().any(|w| s.contains(w))
    })
}

/// The stage a status change moves a ticket to: `status_from_name`'s, or waiting for a status that says the work is
/// on hold ("En attente", "Bloqué", "Blocked").
fn stage_of(name: &str, category: &str) -> &'static str {
    let n = name.to_lowercase();
    if category != "done" && ["attente", "waiting", "pending", "hold", "bloqu", "blocked", "pause", "suspen", "parked"].iter().any(|w| n.contains(w)) {
        "waiting"
    } else {
        status_from_name(name, category)
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
const JIRA_FIELDS: [&str; 12] = ["summary", "status", "issuetype", "assignee", "description", "comment", "project", "fixVersions", "priority", "timetracking", "parent", "labels"];

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
    let issues = jira_search(conf, token, &jql, &JIRA_FIELDS, 100, JIRA_CAP).await?;
    Ok(issues.iter().map(|i| jira_ticket(conf, i, &my_id)).collect())
}

/// The issues `jql` finds, with `fields`, read `page` at a time (Jira may send fewer) and at most `cap` of them.
async fn jira_search(conf: &JiraConf, token: &str, jql: &str, fields: &[&str], page: usize, cap: usize) -> Result<Vec<Value>> {
    let mut issues = Vec::new();
    let mut next: Option<String> = None;
    loop {
        let mut body = json!({ "jql": jql, "maxResults": page, "fields": fields });
        if let Some(t) = &next {
            body["nextPageToken"] = t.as_str().into();
        }
        let v = check(jira_req(conf, token, reqwest::Method::POST, "/rest/api/3/search/jql").json(&body).send().await?, "Jira").await?;
        issues.extend(v["issues"].as_array().cloned().unwrap_or_default());
        next = v["nextPageToken"].as_str().map(String::from);
        if next.is_none() || issues.len() >= cap {
            break;
        }
    }
    issues.truncate(cap);
    Ok(issues)
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
        labels: jira_labels(f),
        priority: f["priority"]["name"].as_str().unwrap_or("").into(),
        time_remaining: f["timetracking"]["remainingEstimate"].as_str().unwrap_or("").into(),
        time_estimate: f["timetracking"]["originalEstimate"].as_str().unwrap_or("").into(),
        parent_key: f["parent"]["key"].as_str().unwrap_or("").into(),
        parent_title: f["parent"]["fields"]["summary"].as_str().unwrap_or("").into(),
        parent_url: f["parent"]["key"].as_str().map(|k| format!("{base}/browse/{k}")).unwrap_or_default(),
    }
}

fn jira_labels(fields: &Value) -> Vec<String> {
    fields["labels"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(String::from)).collect()
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

// ---------- Jira sprints ----------

/// A sprint, as the Sprint field of an issue holds it.
#[derive(Debug, Clone)]
pub struct Sprint {
    pub id: u64,
    pub name: String,
    /// active | closed | future
    pub state: String,
    pub board: u64,
    pub goal: String,
    pub start: Option<DateTime<Utc>>,
    pub end: Option<DateTime<Utc>>,
    /// When it was closed.
    pub complete: Option<DateTime<Utc>>,
}

/// A move of a ticket to another status, from its Jira history.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StatusChange {
    pub at: DateTime<Utc>,
    /// todo | progress | review | ready | done, or waiting (on hold, blocked)
    pub to: &'static str,
}

/// A ticket of a sprint, as sprint charts read it. Sub-tasks are left out: their estimates count in their parent's.
#[derive(Debug, Clone, Default)]
pub struct SprintIssue {
    /// Jira's numeric id, which its history is asked by.
    pub id: String,
    pub key: String,
    pub title: String,
    pub url: String,
    /// Story, Bug, Task…
    pub kind: String,
    pub bug: bool,
    pub assignee: String,
    /// todo | progress | review | ready | done
    pub status: &'static str,
    pub status_label: String,
    /// In a status of Jira's done category.
    pub done: bool,
    /// Done by being dropped ("Annulé", resolution "Won't Do"): no work completed, the sprint's scope shrank.
    pub cancelled: bool,
    /// When it was resolved, else when it last moved to a done status.
    pub done_at: Option<DateTime<Utc>>,
    pub created: Option<DateTime<Utc>>,
    pub points: Option<f64>,
    /// Original and remaining estimate in hours, its sub-tasks' included.
    pub estimate: Option<f64>,
    pub remaining: Option<f64>,
    /// The sprints it has been in, oldest first: the last one is where it is now, or was completed.
    pub sprints: Vec<u64>,
    /// Its status changes, oldest first; empty when Jira did not give its history.
    pub history: Vec<StatusChange>,
}

/// A ticket finished in the span the weekly view covers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoneTicket {
    pub key: String,
    pub title: String,
    pub url: String,
    /// jira | trello | asana | linear | github
    pub source: String,
    /// The Jira project, Trello board, Asana project, Linear team or GitHub repository it comes from.
    pub place: String,
    pub kind: String,
    /// Jira and GitHub labels.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    pub assignee: String,
    pub done_at: DateTime<Utc>,
    pub created: Option<DateTime<Utc>>,
    pub points: Option<f64>,
}

/// Most issues read to find the sprints, then in them.
const SPRINT_CAP: usize = 3000;

/// The last `count` started sprints of each board holding tickets of the connection's projects, with
/// those tickets, and the names of the boards Jira tells (the boards API is out of a "Sign in with Atlassian" token's scopes).
pub async fn jira_sprints(conf: &JiraConf, token: &str, count: usize) -> Result<(Vec<Sprint>, Vec<SprintIssue>, HashMap<u64, String>)> {
    let fields = check(jira_req(conf, token, reqwest::Method::GET, "/rest/api/3/field").send().await?, "Jira").await?;
    let (sprint_field, point_fields) = sprint_fields(&fields).ok_or_else(|| Error::Invalid("This Jira site has no sprints: they come with Jira Software".into()))?;
    // A sprint lasts four weeks at most: this reaches `count` of them back, and a little more.
    let weeks = count as i64 * 4 + 2;
    let since = Utc::now() - Duration::weeks(weeks);
    // Only the Sprint field, to find the sprints: a done ticket was last updated in its sprint, so no sprint since then is missed.
    let jql = scope_jql(&format!("(sprint in openSprints() OR sprint in closedSprints()) AND updated >= -{weeks}w ORDER BY updated DESC"), &conf.projects);
    let mut seen: HashMap<u64, Sprint> = HashMap::new();
    for i in jira_search(conf, token, &jql, &[sprint_field.as_str()], 1000, SPRINT_CAP).await? {
        seen.extend(field_sprints(&i["fields"][sprint_field.as_str()]).into_iter().map(|s| (s.id, s)));
    }
    let sprints = pick_sprints(seen.into_values().collect(), count, since);
    if sprints.is_empty() {
        return Ok((sprints, Vec::new(), HashMap::new()));
    }
    let ids = sprints.iter().map(|s| s.id.to_string()).collect::<Vec<_>>().join(", ");
    let mut want = vec!["summary", "status", "issuetype", "assignee", "created", "resolution", "resolutiondate", "statuscategorychangedate", "aggregatetimeoriginalestimate", "aggregatetimeestimate", sprint_field.as_str()];
    want.extend(point_fields.iter().map(String::as_str));
    let jql = scope_jql(&format!("sprint in ({ids}) ORDER BY key ASC"), &conf.projects);
    let issues = jira_search(conf, token, &jql, &want, 100, SPRINT_CAP).await?;
    let mut issues: Vec<SprintIssue> = issues.iter().filter(|i| i["fields"]["issuetype"]["subtask"] != true).map(|i| sprint_issue(conf, i, &sprint_field, &point_fields)).collect();
    let mut history = jira_history(conf, token, &issues.iter().map(|i| i.id.clone()).collect::<Vec<_>>()).await;
    for i in &mut issues {
        i.history = history.remove(&i.id).unwrap_or_default();
    }
    let mut names = HashMap::new();
    for b in sprints.iter().map(|s| s.board).filter(|b| *b != 0).collect::<BTreeSet<_>>() {
        if let Ok(res) = jira_req(conf, token, reqwest::Method::GET, &format!("/rest/agile/1.0/board/{b}")).send().await {
            if let Some(name) = check(res, "Jira").await.ok().and_then(|v| v["name"].as_str().map(String::from)) {
                names.insert(b, name);
            }
        }
    }
    Ok((sprints, issues, names))
}

/// Ids of the Sprint field and of the story point ones, from `/field`.
fn sprint_fields(all: &Value) -> Option<(String, Vec<String>)> {
    let sprint = all.as_array()?.iter().find(|f| f["schema"]["custom"] == "com.pyxis.greenhopper.jira:gh-sprint")?["id"].as_str()?.to_string();
    Some((sprint, point_fields(all)))
}

/// Ids of the story point fields ("Story Points", "Story point estimate"), from `/field`.
fn point_fields(all: &Value) -> Vec<String> {
    all.as_array()
        .into_iter()
        .flatten()
        .filter(|f| f["schema"]["custom"] == "com.pyxis.greenhopper.jira:jsw-story-points" || (f["schema"]["type"] == "number" && f["name"].as_str().is_some_and(|n| n.to_lowercase().contains("story point"))))
        .filter_map(|f| f["id"].as_str().map(String::from))
        .collect()
}

/// Most issues whose history is read one by one, when Jira has no bulk history.
const HISTORY_CAP: usize = 500;

/// Status changes of the issues `ids` (Jira's numeric ids), oldest first, by id: read in bulk, else one issue at a time,
/// a few at once. An issue Jira won't give the history of has none.
async fn jira_history(conf: &JiraConf, token: &str, ids: &[String]) -> HashMap<String, Vec<StatusChange>> {
    if ids.is_empty() {
        return HashMap::new();
    }
    // Each status's name today and its category, by id: a history step names its status as it was then, maybe in
    // another language ("Pending" for « En attente »), and never its category.
    let categories: HashMap<String, (String, String)> = match jira_req(conf, token, reqwest::Method::GET, "/rest/api/3/status").send().await {
        Ok(res) => check(res, "Jira")
            .await
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|s| Some((s["id"].as_str()?.to_string(), (s["name"].as_str().unwrap_or("").to_string(), s["statusCategory"]["key"].as_str()?.to_string()))))
            .collect(),
        Err(_) => HashMap::new(),
    };
    if let Ok(found) = jira_bulk_history(conf, token, ids, &categories).await {
        return found;
    }
    // Eight at a time. A named async fn, not a stream of closures, keeps the request's future `Send`.
    let ids: Vec<&String> = ids.iter().take(HISTORY_CAP).collect();
    let mut out = HashMap::new();
    for batch in ids.chunks(8) {
        out.extend(join_all(batch.iter().map(|id| jira_issue_history(conf, token, id, &categories))).await);
    }
    out
}

/// One issue's status changes, from its own changelog (its first 100 changes).
async fn jira_issue_history(conf: &JiraConf, token: &str, id: &str, categories: &HashMap<String, (String, String)>) -> (String, Vec<StatusChange>) {
    let v = match jira_req(conf, token, reqwest::Method::GET, &format!("/rest/api/3/issue/{id}/changelog?maxResults=100")).send().await {
        Ok(res) => check(res, "Jira").await.ok(),
        Err(_) => None,
    };
    (id.to_string(), v.map(|v| status_changes(v["values"].as_array().map_or(&[][..], Vec::as_slice), categories)).unwrap_or_default())
}

/// `jira_history` through the bulk changelog API, status changes only.
async fn jira_bulk_history(conf: &JiraConf, token: &str, ids: &[String], categories: &HashMap<String, (String, String)>) -> Result<HashMap<String, Vec<StatusChange>>> {
    let mut out: HashMap<String, Vec<StatusChange>> = HashMap::new();
    for chunk in ids.chunks(1000) {
        let mut next: Option<String> = None;
        loop {
            let mut body = json!({ "issueIdsOrKeys": chunk, "fieldIds": ["status"], "maxResults": 1000 });
            if let Some(t) = &next {
                body["nextPageToken"] = t.as_str().into();
            }
            let v = check(jira_req(conf, token, reqwest::Method::POST, "/rest/api/3/changelog/bulkfetch").json(&body).send().await?, "Jira").await?;
            for log in v["issueChangeLogs"].as_array().into_iter().flatten() {
                let id = log["issueId"].as_str().map(String::from).or_else(|| log["issueId"].as_u64().map(|n| n.to_string())).unwrap_or_default();
                out.entry(id).or_default().extend(status_changes(log["changeHistories"].as_array().map_or(&[][..], Vec::as_slice), categories));
            }
            next = v["nextPageToken"].as_str().map(String::from);
            if next.is_none() {
                break;
            }
        }
    }
    for changes in out.values_mut() {
        changes.sort_by_key(|c| c.at);
    }
    Ok(out)
}

/// The status changes among Jira `histories` (each with its `created` time and changed `items`), oldest first.
/// `statuses`: each status's name today and category, by id.
fn status_changes(histories: &[Value], statuses: &HashMap<String, (String, String)>) -> Vec<StatusChange> {
    let mut out: Vec<StatusChange> = histories
        .iter()
        .filter_map(|h| Some((history_date(&h["created"])?, h)))
        .flat_map(|(at, h)| {
            h["items"].as_array().into_iter().flatten().filter(|it| it["fieldId"] == "status" || it["field"] == "status").map(move |it| {
                let then = it["toString"].as_str().unwrap_or("");
                let (name, category) = statuses.get(it["to"].as_str().unwrap_or("")).map_or((then, ""), |(n, c)| (if n.is_empty() { then } else { n.as_str() }, c.as_str()));
                StatusChange { at, to: stage_of(name, category) }
            })
        })
        .collect();
    out.sort_by_key(|c| c.at);
    out
}

/// A history's time: a date string, or milliseconds since 1970 in the bulk API (seconds in some answers).
fn history_date(v: &Value) -> Option<DateTime<Utc>> {
    match v.as_i64() {
        Some(n) => DateTime::from_timestamp_millis(if n < 100_000_000_000 { n * 1000 } else { n }),
        None => jira_date(v),
    }
}

/// Jira's dates: `2024-01-08T14:00:00.000Z` in sprints, `2024-01-15T10:23:45.123+0000` in issue fields.
fn jira_date(v: &Value) -> Option<DateTime<Utc>> {
    let s = v.as_str()?;
    DateTime::parse_from_rfc3339(s).or_else(|_| DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f%z")).ok().map(|d| d.with_timezone(&Utc))
}

/// The sprints in an issue's Sprint field.
fn field_sprints(v: &Value) -> Vec<Sprint> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            Some(Sprint {
                id: s["id"].as_u64()?,
                name: s["name"].as_str().unwrap_or("").into(),
                state: s["state"].as_str().unwrap_or("").to_lowercase(),
                board: s["boardId"].as_u64().unwrap_or(0),
                goal: s["goal"].as_str().unwrap_or("").trim().into(),
                start: jira_date(&s["startDate"]),
                end: jira_date(&s["endDate"]),
                complete: jira_date(&s["completeDate"]),
            })
        })
        .collect()
}

/// Per board, its last `count` sprints started since `since`: active and closed ones, not those still to come.
fn pick_sprints(mut all: Vec<Sprint>, count: usize, since: DateTime<Utc>) -> Vec<Sprint> {
    all.retain(|s| s.state != "future" && s.start.is_some_and(|d| d >= since));
    let mut boards: BTreeMap<u64, Vec<Sprint>> = BTreeMap::new();
    for s in all {
        boards.entry(s.board).or_default().push(s);
    }
    boards
        .into_values()
        .flat_map(|mut list| {
            list.sort_by_key(|s| s.start);
            let skip = list.len().saturating_sub(count);
            list.into_iter().skip(skip)
        })
        .collect()
}

/// A Jira issue from a sprint search as a `SprintIssue`.
fn sprint_issue(conf: &JiraConf, i: &Value, sprint_field: &str, point_fields: &[String]) -> SprintIssue {
    let f = &i["fields"];
    let key = i["key"].as_str().unwrap_or("").to_string();
    let kind = f["issuetype"]["name"].as_str().unwrap_or("Task").to_string();
    let lower = kind.to_lowercase();
    let st = f["status"]["name"].as_str().unwrap_or("");
    let cat = f["status"]["statusCategory"]["key"].as_str().unwrap_or("new");
    let done = cat == "done";
    let mut sprints = field_sprints(&f[sprint_field]);
    // Sprints still to come have no start: they sort last.
    sprints.sort_by_key(|s| (s.start.is_none(), s.start));
    let hours = |field: &str| f[field].as_f64().map(|secs| secs / 3600.0);
    SprintIssue {
        id: i["id"].as_str().unwrap_or("").into(),
        url: format!("{}/browse/{key}", conf.base_url.trim_end_matches('/')),
        title: f["summary"].as_str().unwrap_or("").into(),
        // Bug is "Bogue" on a French site.
        bug: ["bug", "bogue", "défaut", "defect"].iter().any(|b| lower.contains(b)),
        kind,
        assignee: f["assignee"]["displayName"].as_str().unwrap_or("Unassigned").into(),
        status: status_from_name(st, cat),
        status_label: st.into(),
        done,
        cancelled: done && dropped(st, f["resolution"]["name"].as_str().unwrap_or("")),
        done_at: if done { done_date(f) } else { None },
        created: jira_date(&f["created"]),
        points: point_fields.iter().find_map(|p| f[p.as_str()].as_f64()),
        estimate: hours("aggregatetimeoriginalestimate"),
        remaining: hours("aggregatetimeestimate"),
        sprints: sprints.into_iter().map(|s| s.id).collect(),
        history: Vec::new(),
        key,
    }
}

/// When a done issue got there: when it last moved into Jira's done category, else when it was resolved.
fn done_date(fields: &Value) -> Option<DateTime<Utc>> {
    jira_date(&fields["statuscategorychangedate"]).or_else(|| jira_date(&fields["resolutiondate"]))
}

/// Jira issues of the connection's projects moved into a done status since `since`, sub-tasks left out.
pub async fn jira_done(conf: &JiraConf, token: &str, since: DateTime<Utc>) -> Result<Vec<DoneTicket>> {
    let fields = check(jira_req(conf, token, reqwest::Method::GET, "/rest/api/3/field").send().await?, "Jira").await?;
    let points = point_fields(&fields);
    let jql = scope_jql(&format!("statusCategory = Done AND statusCategoryChangedDate >= \"{}\" ORDER BY statusCategoryChangedDate DESC", since.format("%Y-%m-%d %H:%M")), &conf.projects);
    let mut want = vec!["summary", "status", "issuetype", "assignee", "created", "resolution", "resolutiondate", "statuscategorychangedate", "project", "labels"];
    want.extend(points.iter().map(String::as_str));
    let base = conf.base_url.trim_end_matches('/');
    let issues = jira_search(conf, token, &jql, &want, 100, SPRINT_CAP).await?;
    Ok(issues
        .iter()
        .filter(|i| i["fields"]["issuetype"]["subtask"] != true)
        // Epics hold the tickets that are the work, which count on their own.
        .filter(|i| i["fields"]["issuetype"]["hierarchyLevel"].as_i64().unwrap_or(0) < 1)
        // Dropped tickets ("Annulé") are in the done category too, with no work done.
        .filter(|i| !dropped(i["fields"]["status"]["name"].as_str().unwrap_or(""), i["fields"]["resolution"]["name"].as_str().unwrap_or("")))
        .filter_map(|i| {
            let f = &i["fields"];
            let key = i["key"].as_str()?.to_string();
            Some(DoneTicket {
                url: format!("{base}/browse/{key}"),
                title: f["summary"].as_str().unwrap_or("").into(),
                source: "jira".into(),
                place: format!("Jira · {}", f["project"]["name"].as_str().unwrap_or("")),
                kind: f["issuetype"]["name"].as_str().unwrap_or("Task").into(),
                labels: jira_labels(f),
                assignee: f["assignee"]["displayName"].as_str().unwrap_or("Unassigned").into(),
                done_at: done_date(f)?,
                created: jira_date(&f["created"]),
                points: points.iter().find_map(|p| f[p.as_str()].as_f64()),
                key,
            })
        })
        .collect())
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
        labels: Vec::new(),
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

/// Trello cards moved into a done list since `since`: on the picked boards, else the user's own moves.
pub async fn trello_done(conf: &TrelloConf, token: &str, since: DateTime<Utc>) -> Result<Vec<DoneTicket>> {
    let get = |path: String| trello_req(conf, token, reqwest::Method::GET, &path).send();
    let since = since.to_rfc3339_opts(SecondsFormat::Secs, true);
    let moves = |from: &str| format!("{from}/actions?filter=updateCard:idList&since={since}&limit=1000");
    let boards: Vec<&String> = conf.boards.iter().filter(|b| !b.is_empty()).collect();
    if boards.is_empty() {
        let me = check(get("/members/me?fields=fullName".into()).await?, "Trello").await?;
        let acts = check(get(moves("/members/me")).await?, "Trello").await?;
        return Ok(trello_moves(&acts, &HashMap::new(), "Trello · My cards", me["fullName"].as_str()));
    }
    let mut out = Vec::new();
    for b in boards {
        let board = check(get(format!("/boards/{b}?fields=name")).await?, "Trello").await?;
        let place = format!("Trello · {}", board["name"].as_str().unwrap_or(b));
        let cards = check(get(format!("/boards/{b}/cards/all?fields=name,shortLink,url&members=true&member_fields=fullName")).await?, "Trello").await?;
        let by_id: HashMap<&str, &Value> = cards.as_array().into_iter().flatten().filter_map(|c| Some((c["id"].as_str()?, c))).collect();
        let acts = check(get(moves(&format!("/boards/{b}"))).await?, "Trello").await?;
        out.extend(trello_moves(&acts, &by_id, &place, None));
    }
    Ok(out)
}

/// Each card's last move into a done list among Trello `actions`, as a done ticket of `place`. `me`: whose
/// moves these are, the assignee when the card's members are unknown.
fn trello_moves(actions: &Value, cards: &HashMap<&str, &Value>, place: &str, me: Option<&str>) -> Vec<DoneTicket> {
    let mut last: HashMap<String, DoneTicket> = HashMap::new();
    for a in actions.as_array().into_iter().flatten() {
        let d = &a["data"];
        let (Some(id), Some(at)) = (d["card"]["id"].as_str(), jira_date(&a["date"])) else { continue };
        if status_from_name(d["listAfter"]["name"].as_str().unwrap_or(""), "") != "done" || last.get(id).is_some_and(|t| t.done_at >= at) {
            continue;
        }
        let card = cards.get(id);
        let field = |k: &str| d["card"][k].as_str().or_else(|| card.and_then(|c| c[k].as_str())).unwrap_or("").to_string();
        let short = field("shortLink");
        let member = card.and_then(|c| c["members"][0]["fullName"].as_str()).or(me);
        last.insert(
            id.into(),
            DoneTicket {
                key: format!("#{short}"),
                title: field("name"),
                url: card.and_then(|c| c["url"].as_str()).map_or_else(|| format!("https://trello.com/c/{short}"), String::from),
                source: "trello".into(),
                place: place.into(),
                kind: "Card".into(),
                labels: Vec::new(),
                assignee: member.unwrap_or("Unassigned").into(),
                done_at: at,
                // A Trello id starts with the second it was made at, in hex.
                created: id.get(..8).and_then(|h| i64::from_str_radix(h, 16).ok()).and_then(|secs| DateTime::from_timestamp(secs, 0)),
                points: None,
            },
        );
    }
    last.into_values().collect()
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
                labels: Vec::new(),
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

/// Where to read Asana tasks from: the tasks URL, its extra query, and the place they show under.
type TaskList = (String, Vec<(&'static str, String)>, String);

/// Asana tasks completed since `since`: in the picked projects, else the user's own.
pub async fn asana_done(conf: &AsanaConf, token: &str, since: DateTime<Utc>) -> Result<Vec<DoneTicket>> {
    let api = "https://app.asana.com/api/1.0";
    let since_s = since.to_rfc3339_opts(SecondsFormat::Secs, true);
    let mut lists: Vec<TaskList> = Vec::new();
    for p in conf.projects.iter().filter(|p| !p.is_empty()) {
        let project = check(http().get(format!("{api}/projects/{p}?opt_fields=name")).bearer_auth(token).send().await?, "Asana").await;
        let name = project.ok().and_then(|v| v["data"]["name"].as_str().map(String::from)).unwrap_or_else(|| p.clone());
        lists.push((format!("{api}/projects/{p}/tasks"), Vec::new(), format!("Asana · {name}")));
    }
    if lists.is_empty() {
        lists.push((format!("{api}/tasks"), vec![("assignee", "me".into()), ("workspace", conf.workspace_gid.clone())], "Asana · My tasks".into()));
    }
    let mut out: Vec<DoneTicket> = Vec::new();
    for (url, extra, place) in lists {
        let mut offset: Option<String> = None;
        // shortcut: stops at 2000 tasks a list, page further if a busy project's weeks come out short.
        for _ in 0..20 {
            let mut q: Vec<(&str, String)> = vec![("completed_since", since_s.clone()), ("opt_fields", "name,completed,completed_at,created_at,permalink_url,assignee.name".into()), ("limit", "100".into())];
            q.extend(extra.iter().cloned());
            q.extend(offset.take().map(|o| ("offset", o)));
            let v = check(http().get(&url).query(&q).bearer_auth(token).send().await?, "Asana").await?;
            for t in v["data"].as_array().into_iter().flatten() {
                let gid = t["gid"].as_str().unwrap_or("");
                let Some(at) = jira_date(&t["completed_at"]).filter(|at| t["completed"] == true && *at >= since) else { continue };
                if out.iter().any(|x| x.key.strip_prefix("AS-") == Some(gid)) {
                    continue;
                }
                out.push(DoneTicket {
                    key: format!("AS-{gid}"),
                    title: t["name"].as_str().unwrap_or("").into(),
                    url: t["permalink_url"].as_str().unwrap_or("").into(),
                    source: "asana".into(),
                    place: place.clone(),
                    kind: "Task".into(),
                    labels: Vec::new(),
                    assignee: t["assignee"]["name"].as_str().unwrap_or("Unassigned").into(),
                    done_at: at,
                    created: jira_date(&t["created_at"]),
                    points: None,
                });
            }
            offset = v["next_page"]["offset"].as_str().map(String::from);
            if offset.is_none() {
                break;
            }
        }
    }
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

// ---------- Linear ----------

/// The Authorization header of a Linear connection: `Bearer` and the token of "Sign in with Linear", renewed first,
/// else the personal API key alone, which Linear takes without "Bearer".
pub async fn linear_token(conf: &LinearConf) -> Result<String> {
    let t = oauth::token(&oauth::LINEAR, &conf.secret(), conf.oauth).await?;
    Ok(if conf.oauth { format!("Bearer {t}") } else { t })
}

/// A Linear GraphQL call's `data`, `token` being the Authorization header. Linear answers a query it refuses with 200
/// and `errors`, so those fail too.
async fn linear_gql(token: &str, query: &str, variables: Value) -> Result<Value> {
    let res = http().post("https://api.linear.app/graphql").header("Authorization", token).json(&json!({ "query": query, "variables": variables })).send().await?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let mut v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status == reqwest::StatusCode::UNAUTHORIZED || v["errors"][0]["extensions"]["code"] == "AUTHENTICATION_ERROR" {
        return Err(Error::Http("Linear rejected the API key, or the session expired. Sign in with Linear again or create a new key at linear.app/settings/account/security".into()));
    }
    if let Some(msg) = v["errors"][0]["message"].as_str() {
        return Err(Error::Http(format!("Linear: {msg}")));
    }
    parse(status, &text, "Linear")?;
    Ok(v["data"].take())
}

/// The user's name, the workspace's and its teams. Also how a connection checks its key.
pub async fn linear_me(token: &str) -> Result<Value> {
    let v = linear_gql(token, "{ viewer { name } organization { name } teams(first: 250) { nodes { key name } } }", json!({})).await?;
    let mut teams: Vec<Value> = v["teams"]["nodes"].as_array().into_iter().flatten().map(|t| json!({ "id": t["key"], "name": t["name"] })).collect();
    teams.sort_by_key(|t| t["name"].as_str().unwrap_or("").to_lowercase());
    Ok(json!({ "user": v["viewer"]["name"], "org": v["organization"]["name"], "teams": teams }))
}

/// What a Linear issue is read with, for a `Ticket`.
const LINEAR_FIELDS: &str = "id identifier title description url priority priorityLabel state { name type } assignee { name isMe } team { name } labels(first: 10) { nodes { name } } parent { identifier title url }";

/// The issues `filter` finds, last updated first, at most `cap` of them.
async fn linear_issues(token: &str, fields: &str, filter: Value, cap: usize) -> Result<Vec<Value>> {
    let query = format!("query($filter: IssueFilter, $after: String) {{ issues(filter: $filter, first: 100, after: $after, orderBy: updatedAt) {{ nodes {{ {fields} }} pageInfo {{ hasNextPage endCursor }} }} }}");
    let mut out = Vec::new();
    let mut after = Value::Null;
    loop {
        let mut v = linear_gql(token, &query, json!({ "filter": filter, "after": after })).await?;
        out.extend(v["issues"]["nodes"].as_array_mut().map(std::mem::take).unwrap_or_default());
        if v["issues"]["pageInfo"]["hasNextPage"] != true || out.len() >= cap {
            break;
        }
        after = v["issues"]["pageInfo"]["endCursor"].take();
    }
    out.truncate(cap);
    Ok(out)
}

/// `filters` together, in the connection's teams when it picked some.
fn linear_filter(conf: &LinearConf, mut filters: Vec<Value>) -> Value {
    if !conf.teams.is_empty() {
        filters.push(json!({ "team": { "key": { "in": conf.teams } } }));
    }
    json!({ "and": filters })
}

/// Open issues assigned to or created by the user, or unassigned, like Jira's default; `mine` = only assigned to the user.
/// `sprint`: the issues of the teams' active cycles instead, done ones included, like a Jira sprint.
pub async fn linear(conf: &LinearConf, token: &str, mine: bool, sprint: bool) -> Result<Vec<Ticket>> {
    let me = json!({ "assignee": { "isMe": { "eq": true } } });
    let mut filters = vec![if sprint { json!({ "cycle": { "isActive": { "eq": true } } }) } else { json!({ "state": { "type": { "nin": ["completed", "canceled"] } } }) }];
    if mine {
        filters.push(me);
    } else if !sprint {
        filters.push(json!({ "or": [me, { "creator": { "isMe": { "eq": true } } }, { "assignee": { "null": true } }] }));
    }
    let filter = linear_filter(conf, filters);
    Ok(linear_issues(token, LINEAR_FIELDS, filter, JIRA_CAP).await?.iter().map(|i| linear_ticket(conf, i)).collect())
}

/// Whether the connection's teams have an issue in an active cycle. Teams that use no cycles have no sprint:
/// "Active sprint" would show nothing of them.
pub async fn linear_in_sprint(conf: &LinearConf, token: &str) -> Result<bool> {
    let filter = linear_filter(conf, vec![json!({ "cycle": { "isActive": { "eq": true } } })]);
    Ok(!linear_issues(token, "id", filter, 1).await?.is_empty())
}

/// One Linear issue by identifier (`ENG-123`), whatever its state or assignee; None when Linear has none.
pub async fn linear_issue(conf: &LinearConf, token: &str, key: &str) -> Result<Option<Ticket>> {
    let Some((team, number)) = key.split_once('-').and_then(|(t, n)| Some((t, n.parse::<u64>().ok()?))) else {
        return Ok(None);
    };
    let filter = linear_filter(conf, vec![json!({ "team": { "key": { "eqIgnoreCase": team } } }), json!({ "number": { "eq": number } })]);
    Ok(linear_issues(token, LINEAR_FIELDS, filter, 1).await?.first().map(|i| linear_ticket(conf, i)))
}

/// Jira's status category for a Linear workflow state type, for `status_from_name`.
fn linear_category(state_type: &str) -> &'static str {
    match state_type {
        "completed" | "canceled" => "done",
        "started" => "indeterminate",
        _ => "new",
    }
}

fn linear_ticket(conf: &LinearConf, i: &Value) -> Ticket {
    let state = i["state"]["name"].as_str().unwrap_or("");
    let team = format!("Linear · {}", i["team"]["name"].as_str().unwrap_or(""));
    Ticket {
        key: i["identifier"].as_str().unwrap_or("").into(),
        old_key: None,
        id: i["id"].as_str().unwrap_or("").into(),
        conn: conf.id.clone(),
        source: "linear".into(),
        title: i["title"].as_str().unwrap_or("").into(),
        kind: "Issue".into(),
        status: status_from_name(state, linear_category(i["state"]["type"].as_str().unwrap_or(""))).into(),
        status_label: state.into(),
        assignee: i["assignee"]["name"].as_str().unwrap_or("Unassigned").into(),
        mine: i["assignee"]["isMe"] == true,
        description: i["description"].as_str().unwrap_or("").into(),
        doc: Value::Null,
        criteria: Vec::new(),
        comments: 0,
        url: i["url"].as_str().unwrap_or("").into(),
        where_label: team.clone(),
        place: team,
        labels: linear_labels(i),
        fix_versions: Vec::new(),
        // 0 is "No priority".
        priority: if i["priority"].as_f64().unwrap_or(0.0) > 0.0 { i["priorityLabel"].as_str().unwrap_or("").into() } else { String::new() },
        time_remaining: String::new(),
        time_estimate: String::new(),
        parent_key: i["parent"]["identifier"].as_str().unwrap_or("").into(),
        parent_title: i["parent"]["title"].as_str().unwrap_or("").into(),
        parent_url: i["parent"]["url"].as_str().unwrap_or("").into(),
    }
}

fn linear_labels(i: &Value) -> Vec<String> {
    i["labels"]["nodes"].as_array().into_iter().flatten().filter_map(|l| l["name"].as_str().map(String::from)).collect()
}

/// The workflow states of the issue's team, in Linear's order.
pub async fn linear_statuses(token: &str, issue: &str) -> Result<Vec<StatusOption>> {
    let v = linear_gql(token, "query($id: String!) { issue(id: $id) { team { states { nodes { id name type position } } } } }", json!({ "id": issue })).await?;
    let order = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
    let rank = |s: &Value| order.iter().position(|t| s["type"] == *t).unwrap_or(order.len());
    let mut states: Vec<&Value> = v["issue"]["team"]["states"]["nodes"].as_array().into_iter().flatten().collect();
    states.sort_by(|a, b| rank(a).cmp(&rank(b)).then(a["position"].as_f64().unwrap_or(0.0).total_cmp(&b["position"].as_f64().unwrap_or(0.0))));
    Ok(states
        .into_iter()
        .map(|s| {
            let name = s["name"].as_str().unwrap_or("");
            StatusOption { id: s["id"].as_str().unwrap_or("").into(), name: name.into(), status: status_from_name(name, linear_category(s["type"].as_str().unwrap_or(""))) }
        })
        .collect())
}

pub async fn linear_set_status(token: &str, issue: &str, state: &str) -> Result<()> {
    let v = linear_gql(token, "mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }", json!({ "id": issue, "state": state })).await?;
    if v["issueUpdate"]["success"] != true {
        return Err(Error::Http("Linear did not change the status".into()));
    }
    Ok(())
}

/// Linear issues completed since `since`, in the picked teams, else every team. Canceled ones have no completion date.
pub async fn linear_done(conf: &LinearConf, token: &str, since: DateTime<Utc>) -> Result<Vec<DoneTicket>> {
    let filter = linear_filter(conf, vec![json!({ "completedAt": { "gte": since.to_rfc3339_opts(SecondsFormat::Secs, true) } })]);
    let fields = "identifier title url completedAt createdAt estimate assignee { name } team { name } labels(first: 10) { nodes { name } }";
    Ok(linear_issues(token, fields, filter, SPRINT_CAP)
        .await?
        .iter()
        .filter_map(|i| {
            Some(DoneTicket {
                key: i["identifier"].as_str()?.into(),
                title: i["title"].as_str().unwrap_or("").into(),
                url: i["url"].as_str().unwrap_or("").into(),
                source: "linear".into(),
                place: format!("Linear · {}", i["team"]["name"].as_str().unwrap_or("")),
                kind: "Issue".into(),
                labels: linear_labels(i),
                assignee: i["assignee"]["name"].as_str().unwrap_or("Unassigned").into(),
                done_at: jira_date(&i["completedAt"])?,
                created: jira_date(&i["createdAt"]),
                points: i["estimate"].as_f64(),
            })
        })
        .collect())
}

// ---------- GitHub Issues ----------

/// Most open issues listed per repository, last updated first.
const GITHUB_CAP: usize = 500;

/// `owner/repo`: a GitHub ticket's connection.
pub fn github_repo(gh: &GitHub) -> String {
    format!("{}/{}", gh.repo.owner, gh.repo.repo)
}

/// Owner and name of a GitHub ticket's connection (`owner/repo`), which comes from the UI: None unless both are plain
/// names, since `..` would climb out of /repos/ in the API URL.
pub fn github_conn(conn: &str) -> Option<(&str, &str)> {
    let ok = |s: &str| !matches!(s, "" | "." | "..") && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    conn.split_once('/').filter(|(o, r)| ok(o) && ok(r))
}

/// The repository's open issues, only those assigned to the user with `mine`.
pub async fn github(gh: &GitHub, mine: bool) -> Result<Vec<Ticket>> {
    let me = gh.me().await?;
    let mut filter = json!({ "states": ["OPEN"] });
    if mine {
        filter["assignee"] = me.as_str().into();
    }
    let repo = github_repo(gh);
    Ok(gh.issues(filter, GITHUB_CAP).await?.iter().map(|i| github_ticket(i, &repo, &me)).collect())
}

fn github_labels(issue: &Value) -> Vec<String> {
    issue["labels"]["nodes"].as_array().into_iter().flatten().filter_map(|l| l["name"].as_str().map(String::from)).collect()
}

/// The issue's type when the repository uses them, else Bug or Feature by its labels, else Issue.
fn github_kind(issue: &Value, labels: &[String]) -> String {
    if let Some(t) = issue["issueType"]["name"].as_str().filter(|t| !t.is_empty()) {
        return t.into();
    }
    let has = |words: &[&str]| labels.iter().any(|l| words.iter().any(|w| l.to_lowercase().contains(w)));
    if has(&["bug", "bogue", "defect", "regression"]) {
        "Bug".into()
    } else if has(&["enhancement", "feat", "amélior", "fonctionnalit"]) {
        "Feature".into()
    } else {
        "Issue".into()
    }
}

fn github_assignee(issue: &Value) -> String {
    let a = &issue["assignees"]["nodes"][0];
    a["name"].as_str().filter(|n| !n.is_empty()).or(a["login"].as_str()).unwrap_or("Unassigned").into()
}

/// A GitHub issue, as [`GitHub::issues`] reads them, as a ticket of `repo` (`owner/repo`). Its status is its column on
/// a project board, else open or closed.
pub fn github_ticket(i: &Value, repo: &str, me: &str) -> Ticket {
    let number = i["number"].as_u64().unwrap_or(0);
    let labels = github_labels(i);
    let open = i["state"] != "CLOSED";
    let card = i["projectItems"]["nodes"].as_array().into_iter().flatten().find(|c| c["fieldValueByName"]["name"].is_string());
    let column = card.and_then(|c| c["fieldValueByName"]["name"].as_str());
    let (status, label) = match (open, column) {
        (false, _) => ("done", column.unwrap_or("Closed")),
        (true, Some(c)) => (status_from_name(c, ""), c),
        (true, None) => ("todo", "Open"),
    };
    Ticket {
        key: format!("#{number}"),
        old_key: None,
        id: number.to_string(),
        conn: repo.into(),
        source: "github".into(),
        title: i["title"].as_str().unwrap_or("").into(),
        kind: github_kind(i, &labels),
        status: status.into(),
        status_label: label.into(),
        assignee: github_assignee(i),
        mine: !me.is_empty() && i["assignees"]["nodes"].as_array().into_iter().flatten().any(|a| a["login"].as_str() == Some(me)),
        description: i["body"].as_str().unwrap_or("").into(),
        doc: Value::Null,
        criteria: Vec::new(),
        comments: i["comments"]["totalCount"].as_u64().unwrap_or(0) as u32,
        url: i["url"].as_str().unwrap_or("").into(),
        where_label: match card {
            Some(c) => format!("GitHub · {}", c["project"]["title"].as_str().unwrap_or(repo)),
            None => format!("GitHub · {repo}"),
        },
        place: format!("GitHub · {repo}"),
        labels,
        fix_versions: i["milestone"]["title"].as_str().map(String::from).into_iter().collect(),
        priority: String::new(),
        time_remaining: String::new(),
        time_estimate: String::new(),
        parent_key: String::new(),
        parent_title: String::new(),
        parent_url: String::new(),
    }
}

/// The repository's issues closed as completed since `since`; those closed as not planned or duplicate did no work.
pub async fn github_done(gh: &GitHub, since: DateTime<Utc>) -> Result<Vec<DoneTicket>> {
    // `since` is when an issue was last updated, which closing it does.
    let filter = json!({ "states": ["CLOSED"], "since": since.to_rfc3339_opts(SecondsFormat::Secs, true) });
    let repo = github_repo(gh);
    Ok(gh.issues(filter, SPRINT_CAP).await?.iter().filter_map(|i| github_done_ticket(i, &repo, since)).collect())
}

fn github_done_ticket(i: &Value, repo: &str, since: DateTime<Utc>) -> Option<DoneTicket> {
    let done_at = jira_date(&i["closedAt"]).filter(|at| *at >= since)?;
    if matches!(i["stateReason"].as_str(), Some("NOT_PLANNED" | "DUPLICATE")) {
        return None;
    }
    let labels = github_labels(i);
    Some(DoneTicket {
        key: format!("#{}", i["number"].as_u64()?),
        title: i["title"].as_str().unwrap_or("").into(),
        url: i["url"].as_str().unwrap_or("").into(),
        source: "github".into(),
        place: format!("GitHub · {repo}"),
        kind: github_kind(i, &labels),
        labels,
        assignee: github_assignee(i),
        done_at,
        created: jira_date(&i["createdAt"]),
        points: None,
    })
}

/// The GitHub issue a branch is named after: `128-crash` (GitHub's "Create a branch"), `fix/128-crash`, or
/// `feat/128_crash` (a branch started from issue #128 here) → `#128`.
pub fn issue_key(branch: &str) -> Option<String> {
    let last = branch.rsplit('/').next()?;
    let digits = last.bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0 && matches!(last.as_bytes().get(digits), Some(b'-' | b'_'))).then(|| format!("#{}", &last[..digits]))
}

/// Where GitHub issue `number` can go: the columns of the project boards it is on, and closed or open again.
pub async fn github_statuses(gh: &GitHub, number: u64) -> Result<Vec<StatusOption>> {
    let (open, cards) = gh.issue_cards(number).await?;
    let many = cards.len() > 1;
    let mut out: Vec<StatusOption> = Vec::new();
    for c in &cards {
        let p = &c["project"];
        for o in p["field"]["options"].as_array().into_iter().flatten() {
            let name = o["name"].as_str().unwrap_or("");
            let ids = [&p["id"], &c["id"], &p["field"]["id"], &o["id"]].map(|v| v.as_str().unwrap_or(""));
            out.push(StatusOption {
                id: ids.join("|"),
                name: if many { format!("{} · {name}", p["title"].as_str().unwrap_or("")) } else { name.into() },
                status: status_from_name(name, ""),
            });
        }
    }
    out.push(if open { StatusOption { id: "close".into(), name: "Closed".into(), status: "done" } } else { StatusOption { id: "reopen".into(), name: "Open".into(), status: "todo" } });
    Ok(out)
}

/// Moves GitHub issue `number` to `to`, one of [`github_statuses`].
pub async fn github_set_status(gh: &GitHub, number: u64, to: &str) -> Result<()> {
    if to == "close" || to == "reopen" {
        return gh.set_issue_open(number, to == "reopen").await;
    }
    match to.split('|').collect::<Vec<_>>()[..] {
        [project, item, field, option] => gh.set_card_field(project, item, field, option).await,
        _ => Err(Error::Invalid(format!("unknown GitHub status {to}"))),
    }
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
        assert!(dropped("Annulé", "") && dropped("Done", "Won't Do") && dropped("Terminé", "Doublon") && !dropped("Complété", "Terminé"));
        assert_eq!((stage_of("En attente", "indeterminate"), stage_of("Bloqué", ""), stage_of("En cours", "indeterminate")), ("waiting", "waiting", "progress"));
        // French workflows.
        for (name, cat, want) in [("En révision", "indeterminate", "review"), ("Revue de code", "", "review"), ("Prêt à fusionner", "indeterminate", "ready"), ("À fusionner", "", "ready"), ("Terminé", "", "done"), ("Fait", "", "done"), ("En cours", "", "progress"), ("En développement", "", "progress"), ("À faire", "", "todo"), ("Terminé", "done", "done")] {
            assert_eq!(status_from_name(name, cat), want, "{name}");
        }
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
    fn finds_sprint_and_story_point_fields() {
        let fields = json!([
            { "id": "summary", "name": "Summary", "schema": { "type": "string", "system": "summary" } },
            { "id": "customfield_10020", "name": "Sprint", "schema": { "type": "array", "custom": "com.pyxis.greenhopper.jira:gh-sprint" } },
            { "id": "customfield_10016", "name": "Story point estimate", "schema": { "type": "number", "custom": "com.pyxis.greenhopper.jira:jsw-story-points" } },
            { "id": "customfield_10026", "name": "Story Points", "schema": { "type": "number", "custom": "com.atlassian.jira.plugin.system.customfieldtypes:float" } },
            { "id": "customfield_10030", "name": "Story", "schema": { "type": "string" } }
        ]);
        assert_eq!(sprint_fields(&fields), Some(("customfield_10020".into(), vec!["customfield_10016".into(), "customfield_10026".into()])));
        // Jira Work Management alone: no sprints.
        assert_eq!(sprint_fields(&json!([{ "id": "summary", "schema": {} }])), None);
    }

    #[test]
    fn sprint_issue_from_search() {
        let conf: JiraConf = serde_json::from_value(json!({ "baseUrl": "https://x.atlassian.net/" })).unwrap();
        let issue = json!({ "key": "MNC-7", "fields": {
            "summary": "Fix login", "issuetype": { "name": "Bogue", "subtask": false },
            "status": { "name": "Terminé", "statusCategory": { "key": "done" } },
            "assignee": { "displayName": "Ana" },
            "created": "2026-10-01T09:00:00.000-0400",
            "resolutiondate": "2026-10-08T15:30:00.000+0000",
            "aggregatetimeoriginalestimate": 28800, "aggregatetimeestimate": 0,
            "customfield_10026": 3.0,
            "customfield_10020": [
                { "id": 12, "name": "MNC Sprint 12", "state": "active", "boardId": 4, "startDate": "2026-10-06T13:00:00.000Z", "endDate": "2026-10-20T13:00:00.000Z" },
                { "id": 11, "name": "MNC Sprint 11", "state": "closed", "boardId": 4, "goal": " Ship it ", "startDate": "2026-09-22T13:00:00.000Z", "endDate": "2026-10-06T13:00:00.000Z", "completeDate": "2026-10-06T14:00:00.000Z" }
            ]
        }});
        let t = sprint_issue(&conf, &issue, "customfield_10020", &["customfield_10016".into(), "customfield_10026".into()]);
        assert_eq!((t.key.as_str(), t.url.as_str(), t.kind.as_str(), t.assignee.as_str()), ("MNC-7", "https://x.atlassian.net/browse/MNC-7", "Bogue", "Ana"));
        assert!(t.bug && t.done);
        assert_eq!((t.status, t.points, t.estimate, t.remaining), ("done", Some(3.0), Some(8.0), Some(0.0)));
        // Oldest sprint first, whatever order Jira lists them in.
        assert_eq!(t.sprints, [11, 12]);
        assert_eq!(t.done_at.unwrap().to_rfc3339(), "2026-10-08T15:30:00+00:00");
        assert_eq!(t.created.unwrap().to_rfc3339(), "2026-10-01T13:00:00+00:00");
        let s = &field_sprints(&issue["fields"]["customfield_10020"])[1];
        assert_eq!((s.goal.as_str(), s.state.as_str(), s.board), ("Ship it", "closed", 4));
        assert!(s.complete.is_some());
    }

    #[test]
    fn picks_the_last_started_sprints_of_each_board() {
        let ago = |d: i64| Some(Utc::now() - Duration::days(d));
        let s = |id: u64, board: u64, state: &str, start: Option<DateTime<Utc>>| Sprint { id, name: String::new(), state: state.into(), board, goal: String::new(), start, end: None, complete: None };
        let all = vec![s(4, 1, "active", ago(4)), s(1, 1, "closed", ago(60)), s(3, 1, "closed", ago(32)), s(2, 1, "closed", ago(46)), s(5, 1, "future", None), s(6, 2, "closed", ago(10)), s(7, 2, "closed", ago(400))];
        let ids: Vec<u64> = pick_sprints(all, 3, Utc::now() - Duration::days(100)).iter().map(|s| s.id).collect();
        assert_eq!(ids, [2, 3, 4, 6]);
    }

    #[test]
    fn status_history_from_both_apis() {
        let cats = HashMap::from([("3".to_string(), ("En cours".to_string(), "indeterminate".to_string())), ("10001".to_string(), ("Terminé".to_string(), "done".to_string())), ("10200".to_string(), ("En attente".to_string(), "new".to_string()))]);
        // Bulk changelog: times in milliseconds, newest first; the other fields' changes are skipped.
        let bulk = json!([
            { "created": 1_791_000_000_000_i64, "items": [{ "fieldId": "status", "to": "10001", "toString": "Terminé" }] },
            { "created": 1_790_900_000_000_i64, "items": [{ "fieldId": "assignee", "to": "x" }, { "fieldId": "status", "to": "3", "toString": "En cours" }] }
        ]);
        let got = status_changes(bulk.as_array().unwrap(), &cats);
        assert_eq!(got.iter().map(|c| c.to).collect::<Vec<_>>(), ["progress", "done"]);
        // Named in another language back then: today's name says it waits.
        let then = json!([{ "created": 1_791_000_000_000_i64, "items": [{ "fieldId": "status", "to": "10200", "toString": "Old name" }] }]);
        assert_eq!(status_changes(then.as_array().unwrap(), &cats)[0].to, "waiting");
        assert_eq!(got[0].at.timestamp_millis(), 1_790_900_000_000);
        // One issue's changelog: dates as Jira writes them, statuses known by name only.
        let one = json!([{ "created": "2026-10-06T09:00:00.000-0400", "items": [{ "field": "status", "to": "7", "toString": "Code Review" }] }]);
        let got = status_changes(one.as_array().unwrap(), &HashMap::new());
        assert_eq!((got[0].to, got[0].at.to_rfc3339().as_str()), ("review", "2026-10-06T13:00:00+00:00"));
    }

    #[test]
    fn trello_done_is_the_last_move_into_a_done_list() {
        // 5f0a0e80 is 2020-07-11T19:09:52Z, when the card was made.
        let card = json!({ "id": "5f0a0e80aaaaaaaaaaaaaaaa", "shortLink": "aB3dE9fG", "url": "https://trello.com/c/aB3dE9fG/12-login", "members": [{ "fullName": "Ana" }] });
        let cards = HashMap::from([("5f0a0e80aaaaaaaaaaaaaaaa", &card)]);
        let acts = json!([
            { "date": "2026-10-08T10:00:00.000Z", "data": { "card": { "id": "5f0a0e80aaaaaaaaaaaaaaaa", "name": "Login" }, "listAfter": { "name": "Done" } } },
            { "date": "2026-10-02T10:00:00.000Z", "data": { "card": { "id": "5f0a0e80aaaaaaaaaaaaaaaa", "name": "Login" }, "listAfter": { "name": "Done" } } },
            { "date": "2026-10-01T10:00:00.000Z", "data": { "card": { "id": "5f0a0e80aaaaaaaaaaaaaaaa", "name": "Login" }, "listAfter": { "name": "Doing" } } },
            { "date": "2026-10-03T10:00:00.000Z", "data": { "card": { "id": "6a0000000000000000000000", "name": "Other", "shortLink": "zz" }, "listAfter": { "name": "Done" } } }
        ]);
        let mut got = trello_moves(&acts, &cards, "Trello · Web", Some("Me"));
        got.sort_by(|a, b| a.key.cmp(&b.key));
        let row: Vec<(&str, &str, &str, String)> = got.iter().map(|t| (t.key.as_str(), t.title.as_str(), t.assignee.as_str(), t.done_at.to_rfc3339())).collect();
        assert_eq!(row, [("#aB3dE9fG", "Login", "Ana", "2026-10-08T10:00:00+00:00".to_string()), ("#zz", "Other", "Me", "2026-10-03T10:00:00+00:00".to_string())]);
        assert_eq!(got[0].created.unwrap().to_rfc3339(), "2020-07-11T19:09:52+00:00");
        assert_eq!(got[0].url, "https://trello.com/c/aB3dE9fG/12-login");
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
    fn linear_issue_reads_state_type_and_priority() {
        let conf = LinearConf { id: "c1".into(), ..Default::default() };
        let issue = |state: &str, kind: &str, priority: u8| {
            json!({ "identifier": "ENG-7", "state": { "name": state, "type": kind }, "priority": priority, "priorityLabel": "High", "assignee": { "name": "Ana", "isMe": true }, "team": { "name": "Web" } })
        };
        let got: Vec<_> = [issue("In Review", "started", 0), issue("Building", "started", 2), issue("Backlog", "backlog", 0), issue("Shipped", "completed", 0), issue("Duplicate", "canceled", 0)]
            .iter()
            .map(|i| linear_ticket(&conf, i))
            .map(|t| (t.status, t.priority))
            .collect();
        let want = [("review", ""), ("progress", "High"), ("todo", ""), ("done", ""), ("done", "")];
        assert_eq!(got, want.map(|(s, p)| (s.to_string(), p.to_string())));
        let t = linear_ticket(&conf, &issue("Todo", "unstarted", 0));
        assert_eq!((t.key.as_str(), t.place.as_str(), t.mine), ("ENG-7", "Linear · Web", true));
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
    fn github_issue_as_ticket() {
        let issue = json!({
            "number": 42, "title": "Crash on save", "body": "Steps…", "url": "https://github.com/o/r/issues/42", "state": "OPEN",
            "assignees": { "nodes": [{ "login": "ana", "name": "" }] },
            "labels": { "nodes": [{ "name": "type: bug" }, { "name": "ui" }] },
            "comments": { "totalCount": 3 }, "milestone": { "title": "v2.4.0" },
            "projectItems": { "nodes": [{ "project": { "title": "Roadmap" }, "fieldValueByName": null }, { "project": { "title": "Sprint board" }, "fieldValueByName": { "name": "In review" } }] }
        });
        let t = github_ticket(&issue, "o/r", "ana");
        assert_eq!((t.key.as_str(), t.id.as_str(), t.conn.as_str(), t.source.as_str()), ("#42", "42", "o/r", "github"));
        assert_eq!((t.status.as_str(), t.status_label.as_str(), t.where_label.as_str(), t.place.as_str()), ("review", "In review", "GitHub · Sprint board", "GitHub · o/r"));
        assert_eq!((t.kind.as_str(), t.assignee.as_str(), t.comments), ("Bug", "ana", 3));
        assert_eq!((t.labels, t.fix_versions), (vec!["type: bug".to_string(), "ui".into()], vec!["v2.4.0".to_string()]));
        assert!(t.mine && !github_ticket(&issue, "o/r", "bob").mine);
        // Without a board: open or closed; the issue type wins over labels.
        let plain = json!({ "number": 7, "state": "OPEN", "issueType": { "name": "Task" }, "labels": { "nodes": [{ "name": "enhancement" }] } });
        let t = github_ticket(&plain, "o/r", "");
        assert_eq!((t.status.as_str(), t.status_label.as_str(), t.kind.as_str(), t.assignee.as_str()), ("todo", "Open", "Task", "Unassigned"));
        assert_eq!(github_kind(&json!({}), &["Enhancement".into()]), "Feature");
    }

    #[test]
    fn github_conn_takes_plain_names_only() {
        assert_eq!(github_conn("acme/.github"), Some(("acme", ".github")));
        for bad in ["../x", "acme/..", "acme", "acme/r/x", "acme/r?x", "/r", "acme/"] {
            assert_eq!(github_conn(bad), None, "{bad}");
        }
    }

    #[test]
    fn branches_named_after_github_issues() {
        let got: Vec<_> = ["128-checkout-crash", "fix/128-gift-card", "feat/128_gift-card", "release/0.19.1", "feat/2fa-login", "main", "fix/128"].iter().map(|b| issue_key(b)).collect();
        assert_eq!(got, [Some("#128".to_string()), Some("#128".into()), Some("#128".into()), None, None, None, None]);
    }

    #[test]
    fn github_done_skips_dropped_and_old_issues() {
        let since = DateTime::parse_from_rfc3339("2026-10-01T00:00:00Z").unwrap().with_timezone(&Utc);
        let issue = |closed: &str, reason: &str| json!({ "number": 9, "title": "Login", "url": "u", "state": "CLOSED", "stateReason": reason, "createdAt": "2026-09-30T10:00:00Z", "closedAt": closed, "labels": { "nodes": [{ "name": "bug" }] }, "assignees": { "nodes": [{ "login": "ana", "name": "Ana B" }] } });
        let t = github_done_ticket(&issue("2026-10-02T10:00:00Z", "COMPLETED"), "o/r", since).unwrap();
        assert_eq!((t.key.as_str(), t.kind.as_str(), t.assignee.as_str(), t.place.as_str()), ("#9", "Bug", "Ana B", "GitHub · o/r"));
        assert_eq!(t.labels, ["bug"]);
        assert!(github_done_ticket(&issue("2026-10-02T10:00:00Z", "NOT_PLANNED"), "o/r", since).is_none());
        assert!(github_done_ticket(&issue("2026-09-30T12:00:00Z", "COMPLETED"), "o/r", since).is_none());
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
