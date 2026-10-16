//! GitHub pull requests, reviews, conversations and releases (REST + GraphQL).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::RepoRef;
use crate::error::{Error, Result};

pub struct GitHub {
    http: reqwest::Client,
    api: String,
    token: String,
    pub repo: RepoRef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub head: String,
    pub base: String,
    /// open | draft | merged | closed
    pub state: String,
    pub author: String,
    pub mine: bool,
    pub review_requested: bool,
    pub updated_at: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    /// pass | fail | run
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewer {
    pub login: String,
    /// approve | changes | comment | pending
    pub vote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub content: String,
    pub emoji: String,
    pub count: u64,
    pub mine: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub database_id: Option<u64>,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub reactions: Vec<Reaction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub path: Option<String>,
    pub line: Option<u64>,
    pub resolved: bool,
    /// Review threads can be resolved; plain PR comments cannot.
    pub resolvable: bool,
    pub snippet: Vec<String>,
    pub comments: Vec<Comment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    #[serde(flatten)]
    pub summary: PrSummary,
    pub body: String,
    pub conflict: bool,
    pub mergeable: Option<bool>,
    pub checks: Vec<Check>,
    pub reviewers: Vec<Reviewer>,
    pub threads: Vec<Thread>,
}

pub const EMOJI: &[(&str, &str)] = &[
    ("THUMBS_UP", "👍"),
    ("THUMBS_DOWN", "👎"),
    ("LAUGH", "😄"),
    ("HOORAY", "🎉"),
    ("HEART", "❤️"),
    ("ROCKET", "🚀"),
    ("EYES", "👀"),
    ("CONFUSED", "😕"),
];

fn emoji(content: &str) -> String {
    EMOJI.iter().find(|(c, _)| *c == content).map(|(_, e)| e.to_string()).unwrap_or_else(|| content.into())
}

impl GitHub {
    pub fn new(repo: RepoRef, token: String, api: Option<String>) -> Self {
        let api = api.filter(|s| !s.is_empty()).unwrap_or_else(|| {
            if repo.host == "github.com" {
                "https://api.github.com".into()
            } else {
                format!("https://{}/api/v3", repo.host)
            }
        });
        let http = reqwest::Client::builder()
            .user_agent(concat!("Gitnetix/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        GitHub { http, api: api.trim_end_matches('/').into(), token, repo }
    }

    fn graphql_url(&self) -> String {
        if self.api.ends_with("/api/v3") {
            self.api.trim_end_matches("/v3").to_string() + "/graphql"
        } else {
            format!("{}/graphql", self.api)
        }
    }

    async fn req(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        let url = if path.starts_with("http") { path.to_string() } else { format!("{}{}", self.api, path) };
        let mut r = self
            .http
            .request(method, url)
            .bearer_auth(&self.token)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28");
        if let Some(b) = body {
            r = r.json(&b);
        }
        let res = r.send().await?;
        let status = res.status();
        let text = res.text().await?;
        let v: Value = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) };
        if !status.is_success() {
            let msg = v["message"].as_str().map(String::from).unwrap_or_else(|| v.to_string());
            return Err(Error::Http(format!("GitHub {status}: {msg}")));
        }
        Ok(v)
    }

    async fn get(&self, path: &str) -> Result<Value> {
        self.req(reqwest::Method::GET, path, None).await
    }

    async fn gql(&self, query: &str, vars: Value) -> Result<Value> {
        let v = self.req(reqwest::Method::POST, &self.graphql_url(), Some(json!({ "query": query, "variables": vars }))).await?;
        if let Some(errs) = v["errors"].as_array() {
            if !errs.is_empty() {
                return Err(Error::Http(format!("GitHub GraphQL: {}", errs[0]["message"].as_str().unwrap_or("error"))));
            }
        }
        Ok(v["data"].clone())
    }

    fn rp(&self) -> String {
        format!("/repos/{}/{}", self.repo.owner, self.repo.repo)
    }

    pub async fn me(&self) -> Result<String> {
        Ok(self.get("/user").await?["login"].as_str().unwrap_or("").to_string())
    }

    fn summary(v: &Value, me: &str) -> PrSummary {
        let author = v["user"]["login"].as_str().unwrap_or("").to_string();
        let state = if !v["merged_at"].is_null() {
            "merged"
        } else if v["state"] == "closed" {
            "closed"
        } else if v["draft"] == true {
            "draft"
        } else {
            "open"
        };
        let review_requested = v["requested_reviewers"]
            .as_array()
            .map(|a| a.iter().any(|r| r["login"].as_str() == Some(me)))
            .unwrap_or(false);
        PrSummary {
            number: v["number"].as_u64().unwrap_or(0),
            title: v["title"].as_str().unwrap_or("").into(),
            head: v["head"]["ref"].as_str().unwrap_or("").into(),
            base: v["base"]["ref"].as_str().unwrap_or("").into(),
            state: state.into(),
            mine: author == me,
            author,
            review_requested,
            updated_at: v["updated_at"].as_str().unwrap_or("").into(),
            url: v["html_url"].as_str().unwrap_or("").into(),
        }
    }

    pub async fn list(&self) -> Result<Vec<PrSummary>> {
        let me = self.me().await?;
        let v = self.get(&format!("{}/pulls?state=all&per_page=60&sort=updated&direction=desc", self.rp())).await?;
        Ok(v.as_array().into_iter().flatten().map(|p| Self::summary(p, &me)).collect())
    }

    pub async fn find_for_branch(&self, head: &str) -> Result<Option<PrSummary>> {
        let me = self.me().await?;
        let v = self
            .get(&format!("{}/pulls?state=all&head={}:{}", self.rp(), self.repo.owner, head))
            .await?;
        Ok(v.as_array().and_then(|a| a.first()).map(|p| Self::summary(p, &me)))
    }

    pub async fn detail(&self, number: u64) -> Result<PrDetail> {
        let me = self.me().await?;
        let p = self.get(&format!("{}/pulls/{number}", self.rp())).await?;
        let summary = Self::summary(&p, &me);
        let sha = p["head"]["sha"].as_str().unwrap_or("").to_string();

        let checks = match self.get(&format!("{}/commits/{sha}/check-runs?per_page=50", self.rp())).await {
            Ok(c) => c["check_runs"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| Check {
                    name: r["name"].as_str().unwrap_or("").into(),
                    status: match (r["status"].as_str(), r["conclusion"].as_str()) {
                        (Some("completed"), Some("success" | "neutral" | "skipped")) => "pass",
                        (Some("completed"), _) => "fail",
                        _ => "run",
                    }
                    .into(),
                })
                .collect(),
            Err(_) => Vec::new(),
        };

        let q = r#"query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
          reviewThreads(first:60){nodes{id isResolved path line comments(first:60){nodes{id databaseId author{login} body createdAt diffHunk reactionGroups{content viewerHasReacted reactors{totalCount}}}}}}
          comments(first:60){nodes{id databaseId author{login} body createdAt reactionGroups{content viewerHasReacted reactors{totalCount}}}}
          reviews(last:60){nodes{author{login} state}}
          reviewRequests(first:20){nodes{requestedReviewer{... on User{login} ... on Team{name}}}}
        }}}"#;
        let d = self
            .gql(q, json!({ "o": self.repo.owner, "r": self.repo.repo, "n": number }))
            .await?;
        let pr = &d["repository"]["pullRequest"];

        let comment = |c: &Value| Comment {
            id: c["id"].as_str().unwrap_or("").into(),
            database_id: c["databaseId"].as_u64(),
            author: c["author"]["login"].as_str().unwrap_or("ghost").into(),
            body: c["body"].as_str().unwrap_or("").into(),
            created_at: c["createdAt"].as_str().unwrap_or("").into(),
            reactions: c["reactionGroups"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|g| g["reactors"]["totalCount"].as_u64().unwrap_or(0) > 0)
                .map(|g| {
                    let content = g["content"].as_str().unwrap_or("").to_string();
                    Reaction {
                        emoji: emoji(&content),
                        content,
                        count: g["reactors"]["totalCount"].as_u64().unwrap_or(0),
                        mine: g["viewerHasReacted"] == true,
                    }
                })
                .collect(),
        };

        let mut threads: Vec<Thread> = pr["reviewThreads"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|t| {
                let comments: Vec<Comment> = t["comments"]["nodes"].as_array().into_iter().flatten().map(comment).collect();
                let hunk = t["comments"]["nodes"][0]["diffHunk"].as_str().unwrap_or("");
                let snippet: Vec<String> = hunk.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().map(String::from).collect();
                Thread {
                    id: t["id"].as_str().unwrap_or("").into(),
                    path: t["path"].as_str().map(String::from),
                    line: t["line"].as_u64(),
                    resolved: t["isResolved"] == true,
                    resolvable: true,
                    snippet,
                    comments,
                }
            })
            .collect();
        for c in pr["comments"]["nodes"].as_array().into_iter().flatten() {
            let cm = comment(c);
            threads.push(Thread { id: cm.id.clone(), path: None, line: None, resolved: false, resolvable: false, snippet: vec![], comments: vec![cm] });
        }
        threads.sort_by(|a, b| {
            let da = a.comments.first().map(|c| c.created_at.as_str()).unwrap_or("");
            let db = b.comments.first().map(|c| c.created_at.as_str()).unwrap_or("");
            da.cmp(db)
        });

        // Latest meaningful review per reviewer, plus pending requests.
        let mut reviewers: Vec<Reviewer> = Vec::new();
        for r in pr["reviews"]["nodes"].as_array().into_iter().flatten() {
            let login = r["author"]["login"].as_str().unwrap_or("").to_string();
            let vote = match r["state"].as_str() {
                Some("APPROVED") => "approve",
                Some("CHANGES_REQUESTED") => "changes",
                Some("COMMENTED") => "comment",
                _ => continue,
            };
            if login == summary.author && vote == "comment" {
                continue;
            }
            match reviewers.iter_mut().find(|x| x.login == login) {
                Some(x) if vote != "comment" || x.vote == "comment" => x.vote = vote.into(),
                Some(_) => {}
                None => reviewers.push(Reviewer { login, vote: vote.into() }),
            }
        }
        for rr in pr["reviewRequests"]["nodes"].as_array().into_iter().flatten() {
            let rv = &rr["requestedReviewer"];
            let login = rv["login"].as_str().or(rv["name"].as_str()).unwrap_or("").to_string();
            if !login.is_empty() && !reviewers.iter().any(|x| x.login == login) {
                reviewers.push(Reviewer { login, vote: "pending".into() });
            }
        }

        let mergeable = p["mergeable"].as_bool();
        Ok(PrDetail {
            body: p["body"].as_str().unwrap_or("").into(),
            conflict: p["mergeable_state"] == "dirty" || mergeable == Some(false),
            mergeable,
            checks,
            reviewers,
            threads,
            summary,
        })
    }

    pub async fn create(&self, head: &str, base: &str, title: &str, body: &str, draft: bool) -> Result<PrSummary> {
        let me = self.me().await?;
        let v = self
            .req(
                reqwest::Method::POST,
                &format!("{}/pulls", self.rp()),
                Some(json!({ "head": head, "base": base, "title": title, "body": body, "draft": draft })),
            )
            .await?;
        Ok(Self::summary(&v, &me))
    }

    pub async fn update(&self, number: u64, title: &str, body: &str) -> Result<()> {
        self.req(reqwest::Method::PATCH, &format!("{}/pulls/{number}", self.rp()), Some(json!({ "title": title, "body": body })))
            .await
            .map(|_| ())
    }

    pub async fn merge(&self, number: u64, method: &str) -> Result<()> {
        self.req(reqwest::Method::PUT, &format!("{}/pulls/{number}/merge", self.rp()), Some(json!({ "merge_method": method })))
            .await
            .map(|_| ())
    }

    /// vote: approve | changes | comment
    pub async fn review(&self, number: u64, vote: &str, body: &str) -> Result<()> {
        let event = match vote {
            "approve" => "APPROVE",
            "changes" => "REQUEST_CHANGES",
            _ => "COMMENT",
        };
        let mut b = json!({ "event": event });
        if !body.is_empty() {
            b["body"] = json!(body);
        }
        self.req(reqwest::Method::POST, &format!("{}/pulls/{number}/reviews", self.rp()), Some(b)).await.map(|_| ())
    }

    pub async fn comment(&self, number: u64, body: &str) -> Result<()> {
        self.req(reqwest::Method::POST, &format!("{}/issues/{number}/comments", self.rp()), Some(json!({ "body": body })))
            .await
            .map(|_| ())
    }

    pub async fn reply(&self, number: u64, comment_db_id: u64, body: &str) -> Result<()> {
        self.req(
            reqwest::Method::POST,
            &format!("{}/pulls/{number}/comments/{comment_db_id}/replies", self.rp()),
            Some(json!({ "body": body })),
        )
        .await
        .map(|_| ())
    }

    pub async fn set_resolved(&self, thread_id: &str, resolved: bool) -> Result<()> {
        let m = if resolved {
            "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}"
        } else {
            "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id}}}"
        };
        self.gql(m, json!({ "id": thread_id })).await.map(|_| ())
    }

    pub async fn react(&self, subject_id: &str, content: &str, add: bool) -> Result<()> {
        let m = if add {
            "mutation($id:ID!,$c:ReactionContent!){addReaction(input:{subjectId:$id,content:$c}){reaction{content}}}"
        } else {
            "mutation($id:ID!,$c:ReactionContent!){removeReaction(input:{subjectId:$id,content:$c}){reaction{content}}}"
        };
        self.gql(m, json!({ "id": subject_id, "c": content })).await.map(|_| ())
    }

    pub async fn create_release(&self, tag: &str, target: &str, name: &str, body: &str) -> Result<String> {
        let v = self
            .req(
                reqwest::Method::POST,
                &format!("{}/releases", self.rp()),
                Some(json!({ "tag_name": tag, "target_commitish": target, "name": name, "body": body })),
            )
            .await?;
        Ok(v["html_url"].as_str().unwrap_or("").into())
    }
}
