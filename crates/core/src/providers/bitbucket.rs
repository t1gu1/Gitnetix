//! Bitbucket Cloud pull requests, reviews and comments (REST 2.0). Bitbucket has no reactions
//! and no releases, and a declined pull request stays declined. A thread id is `pr/comment`
//! and so is a comment id, since Bitbucket only addresses them under their pull request.

use serde_json::{json, Value};

use super::github::{Check, Comment, PrDetail, PrSummary, Reviewer, Thread, UserRepo};
use super::RepoRef;
use crate::error::{Error, Result};

/// The Gitnetix OAuth consumer in a Bitbucket workspace, baked in at build time so the secret
/// stays out of the repo, as for Jira. Its callback URL must be exactly `REDIRECT`; permissions:
/// Account read, Repositories read, Pull requests write.
const CLIENT_ID: Option<&str> = option_env!("GITNETIX_BITBUCKET_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("GITNETIX_BITBUCKET_CLIENT_SECRET");

/// Bitbucket checks the redirect against the consumer's callback URL, so the port is fixed.
pub const PORT: u16 = 47822;
pub const REDIRECT: &str = "http://127.0.0.1:47822/callback";
pub const AUTHORIZE_URL: &str = "https://bitbucket.org/site/oauth2/authorize";
pub const TOKEN_URL: &str = "https://bitbucket.org/site/oauth2/access_token";
const API: &str = "https://api.bitbucket.org/2.0";

pub fn client() -> Result<(&'static str, &'static str)> {
    match (CLIENT_ID, CLIENT_SECRET) {
        (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => Ok((id, secret)),
        _ => Err(Error::Unsupported("Bitbucket sign-in is not set up in this build; use an API token".into())),
    }
}

pub struct Bitbucket {
    http: reqwest::Client,
    auth: String,
    pub repo: RepoRef,
}

/// The signed-in account: `uuid` tells their pull requests and comments apart, `name` is shown.
struct Me {
    uuid: String,
    name: String,
}

fn check_status(s: &str) -> &'static str {
    match s {
        "SUCCESSFUL" => "pass",
        "FAILED" | "STOPPED" => "fail",
        _ => "run",
    }
}

fn split_id(id: &str) -> Result<(u64, u64)> {
    id.split_once('/').and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?))).ok_or_else(|| Error::Invalid(format!("bad Bitbucket id {id}")))
}

/// The comment a reply chain starts from.
fn root_of(id: u64, parents: &std::collections::HashMap<u64, u64>) -> u64 {
    let mut at = id;
    // Bounded, in case the API ever answers with a loop.
    for _ in 0..1000 {
        match parents.get(&at) {
            Some(p) => at = *p,
            None => break,
        }
    }
    at
}

/// Conversations from a pull request's comments: each starts at a comment without a parent and
/// holds every reply under it. `me`: the signed-in account's uuid.
fn threads(number: u64, comments: &[Value], me: &str) -> Vec<Thread> {
    let comments: Vec<&Value> = comments.iter().filter(|c| c["deleted"] != true).collect();
    let parents: std::collections::HashMap<u64, u64> = comments.iter().filter_map(|c| Some((c["id"].as_u64()?, c["parent"]["id"].as_u64()?))).collect();
    let comment = |c: &Value| Comment {
        id: format!("{number}/{}", c["id"]),
        database_id: c["id"].as_u64(),
        author: c["user"]["display_name"].as_str().unwrap_or("ghost").into(),
        body: c["content"]["raw"].as_str().unwrap_or("").into(),
        created_at: c["created_on"].as_str().unwrap_or("").into(),
        reactions: vec![],
        can_edit: c["user"]["uuid"].as_str() == Some(me),
    };
    let mut threads: Vec<Thread> = Vec::new();
    for c in comments.iter().filter(|c| c["parent"].is_null()) {
        let inline = &c["inline"];
        threads.push(Thread {
            id: format!("{number}/{}", c["id"]),
            path: inline["path"].as_str().map(String::from),
            line: inline["to"].as_u64().or(inline["from"].as_u64()),
            resolved: !c["resolution"].is_null(),
            resolvable: inline.is_object(),
            snippet: vec![],
            comments: vec![comment(c)],
            review: None,
        });
    }
    for c in comments.iter().filter(|c| !c["parent"].is_null()) {
        let root = format!("{number}/{}", root_of(c["id"].as_u64().unwrap_or(0), &parents));
        if let Some(t) = threads.iter_mut().find(|t| t.id == root) {
            t.comments.push(comment(c));
        }
    }
    for t in &mut threads {
        t.comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    }
    threads.sort_by(|a, b| {
        let da = a.comments.first().map(|c| c.created_at.as_str()).unwrap_or("");
        let db = b.comments.first().map(|c| c.created_at.as_str()).unwrap_or("");
        da.cmp(db)
    });
    threads
}

/// Votes from a pull request's participants: reviewers who have not voted wait, others count once they approve.
fn reviewers(pr: &Value) -> Vec<Reviewer> {
    pr["participants"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| {
            let vote = match (x["state"].as_str(), x["approved"] == true) {
                (Some("changes_requested"), _) => "changes",
                (_, true) => "approve",
                _ if x["role"] == "REVIEWER" => "pending",
                _ => return None,
            };
            Some(Reviewer { login: x["user"]["display_name"].as_str().unwrap_or("").into(), vote: vote.into() })
        })
        .collect()
}

impl Bitbucket {
    pub fn new(repo: RepoRef, auth: String) -> Self {
        Bitbucket { http: crate::net::client(), auth, repo }
    }

    async fn req(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        let url = if path.starts_with("http") { path.to_string() } else { format!("{API}{path}") };
        let mut r = self.http.request(method, url).header("authorization", &self.auth).header("accept", "application/json");
        if let Some(b) = body {
            r = r.json(&b);
        }
        let res = r.send().await?;
        let status = res.status();
        let text = res.text().await?;
        let v: Value = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) };
        if !status.is_success() {
            let msg = v["error"]["message"].as_str().map(String::from).unwrap_or_else(|| v.to_string());
            return Err(Error::Http(format!("Bitbucket {status}: {msg}")));
        }
        Ok(v)
    }

    async fn get(&self, path: &str) -> Result<Value> {
        self.req(reqwest::Method::GET, path, None).await
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Value) -> Result<()> {
        self.req(method, path, Some(body)).await.map(|_| ())
    }

    /// Every page of a list, following `next`, up to `max` pages.
    async fn all(&self, path: &str, max: usize) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        let mut next = Some(path.to_string());
        for _ in 0..max {
            let Some(url) = next.take() else { break };
            let v = self.get(&url).await?;
            out.extend(v["values"].as_array().into_iter().flatten().cloned());
            next = v["next"].as_str().map(String::from);
        }
        Ok(out)
    }

    fn rp(&self) -> String {
        format!("/repositories/{}/{}", self.repo.owner, self.repo.repo)
    }

    fn pr(&self, id: u64) -> String {
        format!("{}/pullrequests/{id}", self.rp())
    }

    async fn whoami(&self) -> Result<Me> {
        let v = self.get("/user").await?;
        Ok(Me { uuid: v["uuid"].as_str().unwrap_or("").into(), name: v["display_name"].as_str().unwrap_or("").into() })
    }

    pub async fn me(&self) -> Result<String> {
        Ok(self.whoami().await?.name)
    }

    fn summary(v: &Value, me: &Me) -> PrSummary {
        let state = match v["state"].as_str().unwrap_or("") {
            "MERGED" => "merged",
            "DECLINED" | "SUPERSEDED" => "closed",
            _ if v["draft"] == true => "draft",
            _ => "open",
        };
        PrSummary {
            number: v["id"].as_u64().unwrap_or(0),
            title: v["title"].as_str().unwrap_or("").into(),
            head: v["source"]["branch"]["name"].as_str().unwrap_or("").into(),
            base: v["destination"]["branch"]["name"].as_str().unwrap_or("").into(),
            state: state.into(),
            mine: v["author"]["uuid"].as_str() == Some(me.uuid.as_str()),
            author: v["author"]["display_name"].as_str().unwrap_or("").into(),
            review_requested: v["reviewers"].as_array().is_some_and(|a| a.iter().any(|r| r["uuid"].as_str() == Some(me.uuid.as_str()))),
            updated_at: v["updated_on"].as_str().unwrap_or("").into(),
            url: v["links"]["html"]["href"].as_str().unwrap_or("").into(),
        }
    }

    pub async fn list(&self) -> Result<Vec<PrSummary>> {
        let me = self.whoami().await?;
        // Lists leave out reviewers unless asked for them.
        let v = self
            .get(&format!("{}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&pagelen=50&sort=-updated_on&fields=%2Bvalues.reviewers", self.rp()))
            .await?;
        Ok(v["values"].as_array().into_iter().flatten().map(|p| Self::summary(p, &me)).collect())
    }

    pub async fn detail(&self, number: u64) -> Result<PrDetail> {
        let me = self.whoami().await?;
        let p = self.get(&self.pr(number)).await?;
        let summary = Self::summary(&p, &me);
        let (statuses, comments, diffstat) = (
            format!("{}/statuses?pagelen=100", self.pr(number)),
            format!("{}/comments?pagelen=100", self.pr(number)),
            format!("{}/diffstat?pagelen=500", self.pr(number)),
        );
        let (statuses, comments, diffstat) = futures_util::try_join!(
            async { Ok::<_, Error>(self.all(&statuses, 3).await.unwrap_or_default()) },
            self.all(&comments, 20),
            async { Ok::<_, Error>(self.all(&diffstat, 2).await.ok()) },
        )?;
        let checks = statuses
            .iter()
            .map(|s| Check {
                name: s["name"].as_str().or(s["key"].as_str()).unwrap_or("").into(),
                status: check_status(s["state"].as_str().unwrap_or("")).into(),
                url: s["url"].as_str().map(Into::into),
            })
            .collect();

        let threads = threads(number, &comments, &me.uuid);
        let reviewers = reviewers(&p);
        let conflict = diffstat.as_ref().is_some_and(|d| d.iter().any(|f| f["status"].as_str().is_some_and(|s| s.contains("conflict"))));
        Ok(PrDetail {
            body: p["description"].as_str().unwrap_or("").into(),
            conflict,
            mergeable: diffstat.map(|_| !conflict),
            checks,
            reviewers,
            threads,
            summary,
        })
    }

    pub async fn create(&self, head: &str, base: &str, title: &str, body: &str, draft: bool) -> Result<PrSummary> {
        let me = self.whoami().await?;
        let v = self
            .req(
                reqwest::Method::POST,
                &format!("{}/pullrequests", self.rp()),
                Some(json!({ "title": title, "description": body, "source": { "branch": { "name": head } }, "destination": { "branch": { "name": base } }, "draft": draft })),
            )
            .await?;
        Ok(Self::summary(&v, &me))
    }

    pub async fn update(&self, number: u64, title: &str, body: &str) -> Result<()> {
        self.send(reqwest::Method::PUT, &self.pr(number), json!({ "title": title, "description": body })).await
    }

    /// method: merge | squash | rebase (a fast-forward on Bitbucket).
    pub async fn merge(&self, number: u64, method: &str) -> Result<()> {
        let strategy = match method {
            "squash" => "squash",
            "rebase" => "fast_forward",
            _ => "merge_commit",
        };
        self.send(reqwest::Method::POST, &format!("{}/merge", self.pr(number)), json!({ "merge_strategy": strategy })).await
    }

    pub async fn set_closed(&self, number: u64, closed: bool) -> Result<()> {
        if !closed {
            return Err(Error::Unsupported("Bitbucket can't reopen a declined pull request; open a new one".into()));
        }
        self.send(reqwest::Method::POST, &format!("{}/decline", self.pr(number)), json!({})).await
    }

    /// vote: approve | changes | comment; the text goes as a comment.
    pub async fn review(&self, number: u64, vote: &str, body: &str) -> Result<()> {
        match vote {
            "approve" => self.send(reqwest::Method::POST, &format!("{}/approve", self.pr(number)), json!({})).await?,
            "changes" => self.send(reqwest::Method::POST, &format!("{}/request-changes", self.pr(number)), json!({})).await?,
            _ => {}
        }
        if !body.trim().is_empty() {
            self.comment(number, body).await?;
        }
        Ok(())
    }

    pub async fn comment(&self, number: u64, body: &str) -> Result<()> {
        self.send(reqwest::Method::POST, &format!("{}/comments", self.pr(number)), json!({ "content": { "raw": body } })).await
    }

    /// `thread`: `pr/comment` of the conversation's first comment.
    pub async fn reply(&self, number: u64, thread: &str, body: &str) -> Result<()> {
        let (_, parent) = split_id(thread)?;
        self.send(reqwest::Method::POST, &format!("{}/comments", self.pr(number)), json!({ "content": { "raw": body }, "parent": { "id": parent } })).await
    }

    pub async fn edit_comment(&self, id: &str, body: &str) -> Result<()> {
        let (pr, c) = split_id(id)?;
        self.send(reqwest::Method::PUT, &format!("{}/comments/{c}", self.pr(pr)), json!({ "content": { "raw": body } })).await
    }

    pub async fn set_resolved(&self, thread_id: &str, resolved: bool) -> Result<()> {
        let (pr, c) = split_id(thread_id)?;
        let method = if resolved { reqwest::Method::POST } else { reqwest::Method::DELETE };
        self.req(method, &format!("{}/comments/{c}/resolve", self.pr(pr)), None).await.map(|_| ())
    }

    pub async fn react(&self, _subject_id: &str, _content: &str, _add: bool) -> Result<()> {
        Err(Error::Unsupported("Bitbucket comments take no reactions".into()))
    }

    /// Branches whose pushes are restricted, by exact name; patterns like `release/*` are left out.
    /// Bitbucket shows them to repository admins only.
    pub async fn protected_branches(&self) -> Result<Vec<String>> {
        let all = self.all(&format!("{}/branch-restrictions?kind=push&pagelen=100", self.rp()), 1).await?;
        Ok(all
            .iter()
            .filter(|r| r["branch_match_kind"] != "branching_model")
            .filter_map(|r| r["pattern"].as_str().filter(|p| !p.contains('*')).map(String::from))
            .collect())
    }

    /// Repositories the signed-in user is a member of, last updated first; the first 1000.
    pub async fn user_repos(&self) -> Result<Vec<UserRepo>> {
        let all = self.all("/repositories?role=member&sort=-updated_on&pagelen=100", 10).await?;
        let clone = |r: &Value, name: &str| {
            r["links"]["clone"].as_array().into_iter().flatten().find(|l| l["name"] == name).and_then(|l| l["href"].as_str()).unwrap_or("").to_string()
        };
        Ok(all
            .iter()
            .map(|r| UserRepo {
                full_name: r["full_name"].as_str().unwrap_or("").into(),
                description: r["description"].as_str().filter(|d| !d.is_empty()).map(String::from),
                private: r["is_private"] == true,
                clone_url: clone(r, "https"),
                ssh_url: clone(r, "ssh"),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_pull_request_states() {
        let me = Me { uuid: "{u1}".into(), name: "Me".into() };
        let pr = |extra: Value| {
            let mut v = json!({ "id": 9, "title": "T", "state": "OPEN", "author": { "uuid": "{u1}", "display_name": "Me" }, "source": { "branch": { "name": "feat" } }, "destination": { "branch": { "name": "main" } }, "reviewers": [{ "uuid": "{u1}" }], "links": { "html": { "href": "https://bitbucket.org/w/r/pull-requests/9" } } });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            Bitbucket::summary(&v, &me)
        };
        let s = pr(json!({}));
        assert_eq!((s.number, s.state.as_str(), s.mine, s.review_requested, s.head.as_str(), s.base.as_str()), (9, "open", true, true, "feat", "main"));
        assert_eq!(pr(json!({ "draft": true })).state, "draft");
        assert_eq!(pr(json!({ "state": "DECLINED" })).state, "closed");
        assert_eq!(pr(json!({ "state": "MERGED" })).state, "merged");
    }

    #[test]
    fn groups_comments_into_conversations() {
        let comments = vec![
            json!({ "id": 1, "content": { "raw": "Rename this." }, "user": { "uuid": "{rev}", "display_name": "Rev" }, "created_on": "2026-01-01T10:00:00Z", "inline": { "path": "app.rs", "to": 12, "from": null } }),
            json!({ "id": 2, "content": { "raw": "Done." }, "user": { "uuid": "{me}", "display_name": "Me" }, "created_on": "2026-01-01T11:00:00Z", "parent": { "id": 1 }, "inline": { "path": "app.rs", "to": 12 } }),
            json!({ "id": 3, "content": { "raw": "Thanks!" }, "user": { "uuid": "{rev}", "display_name": "Rev" }, "created_on": "2026-01-01T12:00:00Z", "parent": { "id": 2 } }),
            json!({ "id": 4, "content": { "raw": "Looks good overall." }, "user": { "uuid": "{rev}", "display_name": "Rev" }, "created_on": "2026-01-01T09:00:00Z", "resolution": null }),
            json!({ "id": 5, "content": { "raw": "" }, "user": { "uuid": "{me}" }, "created_on": "2026-01-01T09:30:00Z", "deleted": true }),
            json!({ "id": 6, "content": { "raw": "Typo." }, "user": { "uuid": "{rev}", "display_name": "Rev" }, "created_on": "2026-01-01T13:00:00Z", "inline": { "path": "lib.rs", "from": 3, "to": null }, "resolution": { "type": "comment_resolution" } }),
        ];
        let t = threads(7, &comments, "{me}");
        let ids: Vec<&str> = t.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["7/4", "7/1", "7/6"], "oldest first, the deleted comment left out");
        assert_eq!((t[0].resolvable, t[0].path.as_deref()), (false, None));
        let line = &t[1];
        assert_eq!((line.path.as_deref(), line.line, line.resolvable, line.resolved), (Some("app.rs"), Some(12), true, false));
        assert_eq!(line.comments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["7/1", "7/2", "7/3"], "a reply to a reply stays in its conversation");
        assert_eq!((line.comments[1].can_edit, line.comments[0].can_edit), (true, false));
        assert_eq!((t[2].line, t[2].resolved), (Some(3), true), "a comment on a removed line");
    }

    #[test]
    fn reads_votes() {
        let pr = json!({ "participants": [
            { "user": { "display_name": "A" }, "role": "REVIEWER", "approved": true, "state": "approved" },
            { "user": { "display_name": "B" }, "role": "REVIEWER", "approved": false, "state": "changes_requested" },
            { "user": { "display_name": "C" }, "role": "REVIEWER", "approved": false, "state": null },
            { "user": { "display_name": "D" }, "role": "PARTICIPANT", "approved": false, "state": null },
            { "user": { "display_name": "E" }, "role": "PARTICIPANT", "approved": true, "state": "approved" },
        ] });
        let v: Vec<(String, String)> = reviewers(&pr).into_iter().map(|r| (r.login, r.vote)).collect();
        assert_eq!(v, [("A", "approve"), ("B", "changes"), ("C", "pending"), ("E", "approve")].map(|(a, b)| (a.to_string(), b.to_string())));
    }

    #[test]
    fn follows_reply_chains_to_their_first_comment() {
        let parents = [(2, 1), (3, 2)].into_iter().collect();
        assert_eq!(root_of(3, &parents), 1);
        assert_eq!(root_of(1, &parents), 1);
        assert_eq!(split_id("9/3").unwrap(), (9, 3));
        assert!(split_id("9").is_err());
    }
}
