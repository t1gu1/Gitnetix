//! Tickets from Jira, Trello and Asana, normalised to one shape.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::store::{AsanaConf, JiraConf, TrelloConf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub key: String,
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
    pub criteria: Vec<Criterion>,
    pub comments: u32,
    pub url: String,
    pub where_label: String,
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
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v["errorMessages"][0]
            .as_str()
            .or(v["message"].as_str())
            .or(v["errors"][0]["message"].as_str())
            .map(String::from)
            .unwrap_or_else(|| v.to_string());
        return Err(Error::Http(format!("{who} {status}: {msg}")));
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

pub async fn jira(conf: &JiraConf, token: &str) -> Result<Vec<Ticket>> {
    let base = conf.base_url.trim_end_matches('/');
    let jql = conf.jql.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| {
        "(assignee = currentUser() OR reporter = currentUser() OR assignee is EMPTY) AND statusCategory != Done ORDER BY updated DESC".into()
    });
    let me = check(
        http().get(format!("{base}/rest/api/3/myself")).basic_auth(&conf.email, Some(token)).send().await?,
        "Jira",
    )
    .await?;
    let my_id = me["accountId"].as_str().unwrap_or("").to_string();
    let v = check(
        http()
            .post(format!("{base}/rest/api/3/search/jql"))
            .basic_auth(&conf.email, Some(token))
            .json(&json!({ "jql": jql, "maxResults": 100, "fields": ["summary", "status", "issuetype", "assignee", "description", "comment", "project"] }))
            .send()
            .await?,
        "Jira",
    )
    .await?;
    Ok(v["issues"]
        .as_array()
        .into_iter()
        .flatten()
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
                key,
                source: "jira".into(),
                title: f["summary"].as_str().unwrap_or("").into(),
                kind: f["issuetype"]["name"].as_str().unwrap_or("Task").into(),
                status: status_from_name(st_name, cat).into(),
                status_label: st_name.into(),
                assignee: f["assignee"]["displayName"].as_str().unwrap_or("Unassigned").into(),
                mine: f["assignee"]["accountId"].as_str() == Some(my_id.as_str()),
                description: desc.trim().into(),
                criteria,
                comments: f["comment"]["total"].as_u64().unwrap_or(0) as u32,
            }
        })
        .collect())
}

// ---------- Trello ----------

pub async fn trello(conf: &TrelloConf, token: &str) -> Result<Vec<Ticket>> {
    let auth = format!("key={}&token={}", conf.api_key, token);
    let url = match &conf.board_id {
        Some(b) if !b.is_empty() => format!("https://api.trello.com/1/boards/{b}/cards?list=true&checklists=all&members=true&{auth}"),
        _ => format!("https://api.trello.com/1/members/me/cards?list=true&checklists=all&members=true&{auth}"),
    };
    let v = check(http().get(url).send().await?, "Trello").await?;
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
                key: format!("#{}", c["idShort"].as_u64().unwrap_or(0)),
                source: "trello".into(),
                title: c["name"].as_str().unwrap_or("").into(),
                kind: "Card".into(),
                status: status.into(),
                status_label: list.into(),
                assignee: c["members"][0]["fullName"].as_str().unwrap_or("Unassigned").into(),
                mine: true,
                description: c["desc"].as_str().unwrap_or("").into(),
                criteria,
                comments: c["badges"]["comments"].as_u64().unwrap_or(0) as u32,
                url: c["url"].as_str().unwrap_or("").into(),
                where_label: format!("Trello · {list}"),
            }
        })
        .collect())
}

// ---------- Asana ----------

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
    Ok(v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| {
            let section = t["memberships"][0]["section"]["name"].as_str().unwrap_or("");
            let status = if t["completed"] == true { "done" } else { status_from_name(section, "") };
            Ticket {
                // Full gid: a suffix collides across tasks, and the prefix
                // keeps it apart from Trello's `#idShort` keys.
                key: format!("AS-{}", t["gid"].as_str().unwrap_or("")),
                source: "asana".into(),
                title: t["name"].as_str().unwrap_or("").into(),
                kind: "Task".into(),
                status: status.into(),
                status_label: if section.is_empty() { "Open".into() } else { section.into() },
                assignee: t["assignee"]["name"].as_str().unwrap_or("Unassigned").into(),
                mine: true,
                description: t["notes"].as_str().unwrap_or("").into(),
                criteria: vec![],
                comments: 0,
                url: t["permalink_url"].as_str().unwrap_or("").into(),
                where_label: "Asana".into(),
            }
        })
        .collect())
}

/// Ticket keys mentioned in text ("ATL-212", "Refs ATL-212").
pub fn extract_keys(text: &str) -> Vec<String> {
    let re = regex::Regex::new(r"\b[A-Z][A-Z0-9]{1,9}-\d+\b").expect("regex");
    const NOT_TICKETS: &[&str] = &["UTF", "ISO", "SHA", "RFC", "HTTP", "TLS", "AES", "CVE", "MD", "X"];
    let mut v: Vec<String> = Vec::new();
    for m in re.find_iter(text) {
        let k = m.as_str();
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
    fn finds_keys() {
        assert_eq!(extract_keys("feat: x\n\nRefs ATL-212, see UTF-8"), vec!["ATL-212"]);
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
