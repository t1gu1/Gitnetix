//! Gitea (and Forgejo) pull requests, reviews, conversations and releases, through its REST
//! API, which follows GitHub's. It has no call to resolve a conversation or to reply in one:
//! a reply is a new review comment on the same line, which Gitea shows in that conversation.

use futures_util::{stream, StreamExt, TryStreamExt};
use serde_json::{json, Value};

use super::github::{Check, Comment, PrDetail, PrSummary, Reaction, Reviewer, Thread, UserRepo, EMOJI};
use super::RepoRef;
use crate::error::{Error, Result};

pub struct Gitea {
    http: reqwest::Client,
    /// https://gitea.example.com/api/v1
    api: String,
    auth: String,
    pub repo: RepoRef,
}

/// The screens' reaction names (GitHub's) and Gitea's.
const REACTIONS: &[(&str, &str)] =
    &[("THUMBS_UP", "+1"), ("THUMBS_DOWN", "-1"), ("LAUGH", "laugh"), ("HOORAY", "hooray"), ("CONFUSED", "confused"), ("HEART", "heart"), ("ROCKET", "rocket"), ("EYES", "eyes")];

/// Page size; Gitea caps it at 50 by default.
const PAGE: usize = 50;

fn check_status(s: &str) -> &'static str {
    match s {
        "success" | "warning" => "pass",
        "failure" | "error" => "fail",
        _ => "run",
    }
}

/// approve | changes | comment, or None for a review that casts no vote (pending, a review request).
fn vote(state: &str) -> Option<&'static str> {
    match state {
        "APPROVED" => Some("approve"),
        "REQUEST_CHANGES" => Some("changes"),
        "COMMENT" => Some("comment"),
        _ => None,
    }
}

/// Reactions to one comment, as Gitea lists them (one entry per user), grouped per kind.
fn reactions(list: &Value, me: &str) -> Vec<Reaction> {
    let mut out: Vec<Reaction> = Vec::new();
    for r in list.as_array().into_iter().flatten() {
        let gitea = r["content"].as_str().unwrap_or("");
        let content = REACTIONS.iter().find(|(_, g)| *g == gitea).map(|(c, _)| c.to_string()).unwrap_or_else(|| gitea.into());
        let mine = r["user"]["login"].as_str() == Some(me);
        match out.iter_mut().find(|x| x.content == content) {
            Some(x) => {
                x.count += 1;
                x.mine |= mine;
            }
            None => {
                let emoji = EMOJI.iter().find(|(c, _)| *c == content).map(|(_, e)| e.to_string()).unwrap_or_else(|| content.clone());
                out.push(Reaction { content, emoji, count: 1, mine });
            }
        }
    }
    out
}

/// A line conversation's id: `new:old:path`, the position a reply goes to.
fn line_id(c: &Value) -> String {
    format!("{}:{}:{}", c["position"].as_u64().unwrap_or(0), c["original_position"].as_u64().unwrap_or(0), c["path"].as_str().unwrap_or(""))
}

impl Gitea {
    /// `base`: the server, https://gitea.example.com.
    pub fn new(repo: RepoRef, base: &str, auth: String) -> Self {
        Gitea { http: crate::net::client(), api: format!("{}/api/v1", base.trim_end_matches('/')), auth, repo }
    }

    async fn req(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut r = self.http.request(method, format!("{}{path}", self.api)).header("authorization", &self.auth).header("accept", "application/json");
        if let Some(b) = body {
            r = r.json(&b);
        }
        let res = r.send().await?;
        let status = res.status();
        let text = res.text().await?;
        let v: Value = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) };
        if !status.is_success() {
            let msg = v["message"].as_str().map(String::from).unwrap_or_else(|| v.to_string());
            return Err(Error::Http(format!("Gitea {status}: {msg}")));
        }
        Ok(v)
    }

    async fn get(&self, path: &str) -> Result<Value> {
        self.req(reqwest::Method::GET, path, None).await
    }

    /// Every page of a list, up to `max` pages.
    async fn all(&self, path: &str, max: usize) -> Result<Vec<Value>> {
        let sep = if path.contains('?') { '&' } else { '?' };
        let mut out = Vec::new();
        for page in 1..=max {
            let batch = self.get(&format!("{path}{sep}limit={PAGE}&page={page}")).await?;
            let batch = batch.as_array().cloned().unwrap_or_default();
            let last = batch.len() < PAGE;
            out.extend(batch);
            if last {
                break;
            }
        }
        Ok(out)
    }

    fn rp(&self) -> String {
        format!("/repos/{}/{}", self.repo.owner, self.repo.repo)
    }

    pub async fn me(&self) -> Result<String> {
        Ok(self.get("/user").await?["login"].as_str().unwrap_or("").into())
    }

    fn summary(v: &Value, me: &str) -> PrSummary {
        let author = v["user"]["login"].as_str().unwrap_or("").to_string();
        let state = if v["merged"] == true {
            "merged"
        } else if v["state"] == "closed" {
            "closed"
        } else if v["draft"] == true {
            "draft"
        } else {
            "open"
        };
        PrSummary {
            number: v["number"].as_u64().unwrap_or(0),
            title: v["title"].as_str().unwrap_or("").into(),
            head: v["head"]["ref"].as_str().unwrap_or("").into(),
            base: v["base"]["ref"].as_str().unwrap_or("").into(),
            state: state.into(),
            // shortcut: Gitea lists reviewers who already reviewed here too, so their review stays "requested"; read each PR's reviews if that misleads.
            review_requested: author != me && v["requested_reviewers"].as_array().is_some_and(|a| a.iter().any(|r| r["login"].as_str() == Some(me))),
            mine: author == me,
            author,
            updated_at: v["updated_at"].as_str().unwrap_or("").into(),
            url: v["html_url"].as_str().unwrap_or("").into(),
        }
    }

    pub async fn list(&self) -> Result<Vec<PrSummary>> {
        let me = self.me().await?;
        let v = self.get(&format!("{}/pulls?state=all&sort=recentupdate&limit={PAGE}", self.rp())).await?;
        Ok(v.as_array().into_iter().flatten().map(|p| Self::summary(p, &me)).collect())
    }

    pub async fn detail(&self, number: u64) -> Result<PrDetail> {
        let me = self.me().await?;
        let p = self.get(&format!("{}/pulls/{number}", self.rp())).await?;
        let summary = Self::summary(&p, &me);
        let sha = p["head"]["sha"].as_str().unwrap_or("");
        let (status, reviews, notes) =
            (format!("{}/commits/{sha}/status", self.rp()), format!("{}/pulls/{number}/reviews", self.rp()), format!("{}/issues/{number}/comments", self.rp()));
        let (status, reviews, notes) = futures_util::try_join!(
            async { Ok::<_, Error>(self.get(&status).await.unwrap_or(Value::Null)) },
            self.all(&reviews, 20),
            self.all(&notes, 20),
        )?;
        let checks = status["statuses"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| Check {
                name: s["context"].as_str().unwrap_or("").into(),
                status: check_status(s["status"].as_str().unwrap_or("")).into(),
                url: s["target_url"].as_str().filter(|u| u.starts_with("http")).map(Into::into),
            })
            .collect();

        // Line comments come per review.
        let paths: Vec<String> =
            reviews.iter().filter(|r| r["comments_count"].as_u64().unwrap_or(0) > 0).map(|r| format!("{}/pulls/{number}/reviews/{}/comments", self.rp(), r["id"])).collect();
        let line_comments: Vec<Value> = stream::iter(paths).map(|path| self.get_list(path)).buffered(6).try_concat().await?;
        // Reactions come per comment.
        let ids: Vec<u64> = notes.iter().chain(&line_comments).filter_map(|c| c["id"].as_u64()).collect();
        let mut reacted = std::collections::HashMap::new();
        let mut each = stream::iter(ids).map(|id| async move { (id, self.get(&format!("{}/issues/comments/{id}/reactions", self.rp())).await) }).buffer_unordered(8);
        while let Some((id, r)) = each.next().await {
            reacted.insert(id, reactions(&r.unwrap_or(Value::Null), &me));
        }

        let comment = |c: &Value, editable: bool| {
            let author = c["user"]["login"].as_str().unwrap_or("ghost").to_string();
            Comment {
                id: c["id"].to_string(),
                database_id: c["id"].as_u64(),
                can_edit: editable && author == me,
                reactions: c["id"].as_u64().and_then(|id| reacted.get(&id).cloned()).unwrap_or_default(),
                author,
                body: c["body"].as_str().unwrap_or("").into(),
                created_at: c["created_at"].as_str().or(c["submitted_at"].as_str()).unwrap_or("").into(),
            }
        };

        let mut threads: Vec<Thread> = Vec::new();
        for c in &line_comments {
            let id = line_id(c);
            match threads.iter_mut().find(|t| t.id == id) {
                Some(t) => {
                    t.resolved |= !c["resolver"].is_null();
                    t.comments.push(comment(c, true));
                }
                None => {
                    let hunk = c["diff_hunk"].as_str().unwrap_or("");
                    let snippet = hunk.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().map(String::from).collect();
                    let line = c["position"].as_u64().filter(|l| *l > 0).or(c["original_position"].as_u64());
                    threads.push(Thread {
                        id,
                        path: c["path"].as_str().map(String::from),
                        line,
                        resolved: !c["resolver"].is_null(),
                        resolvable: true,
                        snippet,
                        comments: vec![comment(c, true)],
                        review: None,
                    });
                }
            }
        }
        for t in &mut threads {
            t.comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        }
        let plain = |cm: Comment, review: Option<String>| Thread { id: cm.id.clone(), path: None, line: None, resolved: false, resolvable: false, snippet: vec![], comments: vec![cm], review };
        for c in &notes {
            threads.push(plain(comment(c, true), None));
        }
        // A review's summary text: Gitea's API can't edit it or react to it, and its ids are not comment ids.
        for r in reviews.iter().filter(|r| !r["body"].as_str().unwrap_or("").trim().is_empty()) {
            if let Some(v) = vote(r["state"].as_str().unwrap_or("")) {
                let mut cm = comment(r, false);
                cm.id = format!("review/{}", r["id"]);
                cm.database_id = None;
                threads.push(plain(cm, Some(v.into())));
            }
        }
        threads.sort_by(|a, b| {
            let da = a.comments.first().map(|c| c.created_at.as_str()).unwrap_or("");
            let db = b.comments.first().map(|c| c.created_at.as_str()).unwrap_or("");
            da.cmp(db)
        });

        // Latest vote per reviewer, plus pending requests.
        let mut reviewers: Vec<Reviewer> = Vec::new();
        for r in reviews.iter().filter(|r| r["dismissed"] != true) {
            let login = r["user"]["login"].as_str().unwrap_or("").to_string();
            let Some(v) = vote(r["state"].as_str().unwrap_or("")) else { continue };
            if login == summary.author && v == "comment" {
                continue;
            }
            match reviewers.iter_mut().find(|x| x.login == login) {
                Some(x) if v != "comment" || x.vote == "comment" => x.vote = v.into(),
                Some(_) => {}
                None => reviewers.push(Reviewer { login, vote: v.into() }),
            }
        }
        // A request is a review of its own; `requested_reviewers` holds everyone who reviewed.
        for r in reviews.iter().filter(|r| r["state"] == "REQUEST_REVIEW") {
            let login = r["user"]["login"].as_str().unwrap_or("").to_string();
            if !login.is_empty() && !reviewers.iter().any(|x| x.login == login) {
                reviewers.push(Reviewer { login, vote: "pending".into() });
            }
        }

        let mergeable = p["mergeable"].as_bool();
        Ok(PrDetail {
            body: p["body"].as_str().unwrap_or("").into(),
            conflict: summary.state == "open" && mergeable == Some(false),
            mergeable,
            checks,
            reviewers,
            threads,
            summary,
        })
    }

    async fn get_list(&self, path: String) -> Result<Vec<Value>> {
        Ok(self.get(&path).await?.as_array().cloned().unwrap_or_default())
    }

    pub async fn create(&self, head: &str, base: &str, title: &str, body: &str, draft: bool) -> Result<PrSummary> {
        let me = self.me().await?;
        // Gitea keeps a pull request as a draft while its title starts with "WIP:".
        let title = if draft { format!("WIP: {title}") } else { title.into() };
        let v = self.req(reqwest::Method::POST, &format!("{}/pulls", self.rp()), Some(json!({ "head": head, "base": base, "title": title, "body": body }))).await?;
        Ok(Self::summary(&v, &me))
    }

    pub async fn update(&self, number: u64, title: &str, body: &str) -> Result<()> {
        self.req(reqwest::Method::PATCH, &format!("{}/pulls/{number}", self.rp()), Some(json!({ "title": title, "body": body }))).await.map(|_| ())
    }

    /// method: merge | squash | rebase
    pub async fn merge(&self, number: u64, method: &str) -> Result<()> {
        let how = if matches!(method, "squash" | "rebase") { method } else { "merge" };
        self.req(reqwest::Method::POST, &format!("{}/pulls/{number}/merge", self.rp()), Some(json!({ "Do": how }))).await.map(|_| ())
    }

    pub async fn set_closed(&self, number: u64, closed: bool) -> Result<()> {
        let state = if closed { "closed" } else { "open" };
        self.req(reqwest::Method::PATCH, &format!("{}/pulls/{number}", self.rp()), Some(json!({ "state": state }))).await.map(|_| ())
    }

    /// vote: approve | changes | comment
    pub async fn review(&self, number: u64, vote: &str, body: &str) -> Result<()> {
        let event = match vote {
            "approve" => "APPROVED",
            "changes" => "REQUEST_CHANGES",
            _ => "COMMENT",
        };
        self.req(reqwest::Method::POST, &format!("{}/pulls/{number}/reviews", self.rp()), Some(json!({ "event": event, "body": body }))).await.map(|_| ())
    }

    pub async fn comment(&self, number: u64, body: &str) -> Result<()> {
        self.req(reqwest::Method::POST, &format!("{}/issues/{number}/comments", self.rp()), Some(json!({ "body": body }))).await.map(|_| ())
    }

    /// `thread`: a line conversation's id, `new:old:path`.
    pub async fn reply(&self, number: u64, thread: &str, body: &str) -> Result<()> {
        let mut parts = thread.splitn(3, ':');
        let (Some(new), Some(old), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            return Err(Error::Invalid(format!("bad Gitea conversation id {thread}")));
        };
        let at = |n: &str| n.parse::<u64>().unwrap_or(0);
        let c = json!({ "path": path, "body": body, "new_position": at(new), "old_position": at(old) });
        self.req(reqwest::Method::POST, &format!("{}/pulls/{number}/reviews", self.rp()), Some(json!({ "event": "COMMENT", "body": "", "comments": [c] })))
            .await
            .map(|_| ())
    }

    pub async fn edit_comment(&self, id: &str, body: &str) -> Result<()> {
        self.req(reqwest::Method::PATCH, &format!("{}/issues/comments/{id}", self.rp()), Some(json!({ "body": body }))).await.map(|_| ())
    }

    pub async fn set_resolved(&self, _thread_id: &str, _resolved: bool) -> Result<()> {
        Err(Error::Unsupported("Gitea's API can't resolve conversations; resolve it on Gitea".into()))
    }

    pub async fn react(&self, subject_id: &str, content: &str, add: bool) -> Result<()> {
        if subject_id.starts_with("review/") {
            return Err(Error::Unsupported("Gitea takes no reactions on a review's summary".into()));
        }
        let gitea = REACTIONS.iter().find(|(c, _)| *c == content).map(|(_, g)| *g).ok_or_else(|| Error::Invalid(format!("reaction {content}")))?;
        let method = if add { reqwest::Method::POST } else { reqwest::Method::DELETE };
        self.req(method, &format!("{}/issues/comments/{subject_id}/reactions", self.rp()), Some(json!({ "content": gitea }))).await.map(|_| ())
    }

    /// Protected branches among the first 100.
    pub async fn protected_branches(&self) -> Result<Vec<String>> {
        let all = self.all(&format!("{}/branches", self.rp()), 2).await?;
        Ok(all.iter().filter(|b| b["protected"] == true).filter_map(|b| b["name"].as_str().map(String::from)).collect())
    }

    pub async fn create_release(&self, tag: &str, target: &str, name: &str, body: &str) -> Result<String> {
        let v = self
            .req(reqwest::Method::POST, &format!("{}/releases", self.rp()), Some(json!({ "tag_name": tag, "target_commitish": target, "name": name, "body": body })))
            .await?;
        Ok(v["html_url"].as_str().unwrap_or("").into())
    }

    /// Repositories the signed-in user owns or reaches as a member, the first 1000.
    pub async fn user_repos(&self) -> Result<Vec<UserRepo>> {
        Ok(serde_json::from_value(Value::Array(self.all("/user/repos", 20).await?))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_reactions_per_kind() {
        let list = json!([
            { "user": { "login": "rev" }, "content": "+1" },
            { "user": { "login": "me" }, "content": "+1" },
            { "user": { "login": "rev" }, "content": "heart" },
        ]);
        let r = reactions(&list, "me");
        assert_eq!((r[0].content.as_str(), r[0].emoji.as_str(), r[0].count, r[0].mine), ("THUMBS_UP", "👍", 2, true));
        assert_eq!((r[1].content.as_str(), r[1].count, r[1].mine), ("HEART", 1, false));
        assert!(reactions(&Value::Null, "me").is_empty());
    }

    #[test]
    fn reads_pr_states() {
        let pr = |extra: Value| {
            let mut v = json!({ "number": 3, "title": "T", "head": { "ref": "feat" }, "base": { "ref": "main" }, "user": { "login": "me" }, "state": "open", "requested_reviewers": [{ "login": "me" }] });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            Gitea::summary(&v, "me")
        };
        let s = pr(json!({}));
        assert_eq!((s.state.as_str(), s.mine, s.review_requested, s.head.as_str()), ("open", true, false, "feat"));
        assert!(pr(json!({ "user": { "login": "other" } })).review_requested);
        assert_eq!(pr(json!({ "draft": true })).state, "draft");
        assert_eq!(pr(json!({ "state": "closed", "merged": true })).state, "merged");
        assert_eq!(pr(json!({ "state": "closed" })).state, "closed");
    }
}
