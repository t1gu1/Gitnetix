//! GitLab merge requests, reviews, discussions and releases: REST for the merge requests,
//! GraphQL for the discussions, which brings each note's award emoji in the same call.
//! A thread id is `iid/discussion` and a comment id `iid/note`, since GitLab only
//! addresses them under their merge request.

use serde_json::{json, Value};

use super::github::{Check, Comment, PrDetail, PrSummary, Reaction, Reviewer, Thread, UserRepo, EMOJI};
use super::RepoRef;
use crate::error::{Error, Result};

/// Application ID of the Gitnetix OAuth app on gitlab.com: not confidential (a confidential app refuses
/// the device flow without its secret), "Device authorization grant" ticked, scope `api`. Public, not a secret.
pub const CLIENT_ID: &str = "0b40ff4215ccb85826d0c1f37f63d0f13c6a464842aee87e87cc6359f1542d78";

/// Merge requests, discussions, approvals and releases need the full API.
pub const SCOPE: &str = "api";

pub const CLOUD: &str = "https://gitlab.com";

pub struct GitLab {
    http: reqwest::Client,
    /// https://gitlab.com
    base: String,
    auth: String,
    pub repo: RepoRef,
}

/// The screens' reaction names (GitHub's) and GitLab's emoji names.
const REACTIONS: &[(&str, &str)] =
    &[("THUMBS_UP", "thumbsup"), ("THUMBS_DOWN", "thumbsdown"), ("LAUGH", "smile"), ("HOORAY", "tada"), ("CONFUSED", "confused"), ("HEART", "heart"), ("ROCKET", "rocket"), ("EYES", "eyes")];

/// Discussions of a merge request with their notes, a page at a time.
const DISCUSSIONS: &str = "query($p:ID!,$n:String!,$after:String){project(fullPath:$p){mergeRequest(iid:$n){discussions(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id resolvable resolved notes(first:100){nodes{id body system createdAt author{username} position{newPath newLine oldLine} userPermissions{adminNote} awardEmoji{nodes{name user{username}}}}}}}}}}";

/// The last part of a GraphQL global id, `gid://gitlab/DiffNote/12` → `12`.
fn gid(v: &Value) -> String {
    v.as_str().unwrap_or("").rsplit('/').next().unwrap_or("").into()
}

/// pass | fail | run | wait, or None for a manual job, which waits for someone to start it and blocks nothing.
fn check_status(s: &str) -> Option<&'static str> {
    match s {
        "success" | "skipped" => Some("pass"),
        "failed" | "canceled" | "canceling" => Some("fail"),
        "running" => Some("run"),
        "manual" => None,
        _ => Some("wait"),
    }
}

/// approve | changes | comment | pending, from a reviewer's state on `/reviewers`.
fn reviewer_vote(state: &str) -> &'static str {
    match state {
        "approved" => "approve",
        "requested_changes" => "changes",
        "reviewed" => "comment",
        _ => "pending",
    }
}

fn reactions(awards: &Value, me: &str) -> Vec<Reaction> {
    let mut out: Vec<Reaction> = Vec::new();
    for a in awards["nodes"].as_array().into_iter().flatten() {
        let name = a["name"].as_str().unwrap_or("");
        let content = REACTIONS.iter().find(|(_, g)| *g == name).map(|(c, _)| c.to_string()).unwrap_or_else(|| name.into());
        let mine = a["user"]["username"].as_str() == Some(me);
        match out.iter_mut().find(|x| x.content == content) {
            Some(x) => {
                x.count += 1;
                x.mine |= mine;
            }
            None => {
                let emoji = EMOJI.iter().find(|(c, _)| *c == content).map(|(_, e)| e.to_string()).unwrap_or_else(|| format!(":{name}:"));
                out.push(Reaction { content, emoji, count: 1, mine });
            }
        }
    }
    out
}

/// `iid/rest` → (iid, rest).
fn split_id(id: &str) -> Result<(u64, &str)> {
    id.split_once('/').and_then(|(n, rest)| Some((n.parse().ok()?, rest))).ok_or_else(|| Error::Invalid(format!("bad GitLab id {id}")))
}

impl GitLab {
    /// `base`: the server, https://gitlab.com.
    pub fn new(repo: RepoRef, base: &str, auth: String) -> Self {
        GitLab { http: crate::net::client(), base: base.trim_end_matches('/').into(), auth, repo }
    }

    async fn req(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        let url = if path.starts_with("http") { path.to_string() } else { format!("{}/api/v4{path}", self.base) };
        let mut r = self.http.request(method, url).header("authorization", &self.auth).header("accept", "application/json");
        if let Some(b) = body {
            r = r.json(&b);
        }
        let res = r.send().await?;
        let status = res.status();
        let text = res.text().await?;
        let v: Value = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) };
        if !status.is_success() {
            let msg = v["message"].as_str().or(v["error"].as_str()).map(String::from).unwrap_or_else(|| v["message"].to_string());
            return Err(Error::Http(format!("GitLab {status}: {msg}")));
        }
        Ok(v)
    }

    async fn get(&self, path: &str) -> Result<Value> {
        self.req(reqwest::Method::GET, path, None).await
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Value) -> Result<()> {
        self.req(method, path, Some(body)).await.map(|_| ())
    }

    async fn gql(&self, query: &str, vars: Value) -> Result<Value> {
        let v = self.req(reqwest::Method::POST, &format!("{}/api/graphql", self.base), Some(json!({ "query": query, "variables": vars }))).await?;
        if let Some(e) = v["errors"].as_array().and_then(|e| e.first()) {
            return Err(Error::Http(format!("GitLab GraphQL: {}", e["message"].as_str().unwrap_or("error"))));
        }
        Ok(v["data"].clone())
    }

    /// Every page of a REST list, up to `max` pages of 100.
    async fn all(&self, path: &str, max: usize) -> Result<Vec<Value>> {
        let sep = if path.contains('?') { '&' } else { '?' };
        let mut out = Vec::new();
        for page in 1..=max {
            let batch = self.get(&format!("{path}{sep}per_page=100&page={page}")).await?.as_array().cloned().unwrap_or_default();
            let last = batch.len() < 100;
            out.extend(batch);
            if last {
                break;
            }
        }
        Ok(out)
    }

    /// owner/repo, owner holding any subgroups.
    fn path(&self) -> String {
        format!("{}/{}", self.repo.owner, self.repo.repo)
    }

    fn rp(&self) -> String {
        format!("/projects/{}", self.path().replace('/', "%2F"))
    }

    fn mr(&self, iid: u64) -> String {
        format!("{}/merge_requests/{iid}", self.rp())
    }

    pub async fn me(&self) -> Result<String> {
        Ok(self.get("/user").await?["username"].as_str().unwrap_or("").into())
    }

    fn summary(v: &Value, me: &str) -> PrSummary {
        let author = v["author"]["username"].as_str().unwrap_or("").to_string();
        let state = match v["state"].as_str().unwrap_or("") {
            "merged" => "merged",
            "closed" => "closed",
            _ if v["draft"] == true || v["work_in_progress"] == true => "draft",
            _ => "open",
        };
        PrSummary {
            number: v["iid"].as_u64().unwrap_or(0),
            title: v["title"].as_str().unwrap_or("").into(),
            head: v["source_branch"].as_str().unwrap_or("").into(),
            base: v["target_branch"].as_str().unwrap_or("").into(),
            state: state.into(),
            mine: author == me,
            author,
            review_requested: v["reviewers"].as_array().is_some_and(|a| a.iter().any(|r| r["username"].as_str() == Some(me))),
            updated_at: v["updated_at"].as_str().unwrap_or("").into(),
            url: v["web_url"].as_str().unwrap_or("").into(),
        }
    }

    pub async fn list(&self) -> Result<Vec<PrSummary>> {
        let me = self.me().await?;
        let v = self.get(&format!("{}/merge_requests?state=all&per_page=60&order_by=updated_at&sort=desc", self.rp())).await?;
        Ok(v.as_array().into_iter().flatten().map(|m| Self::summary(m, &me)).collect())
    }

    async fn discussions(&self, iid: u64) -> Result<Vec<Value>> {
        let mut vars = json!({ "p": self.path(), "n": iid.to_string() });
        let mut out = Vec::new();
        loop {
            let d = self.gql(DISCUSSIONS, vars.clone()).await?;
            let conn = &d["project"]["mergeRequest"]["discussions"];
            out.extend(conn["nodes"].as_array().into_iter().flatten().cloned());
            if conn["pageInfo"]["hasNextPage"] != true {
                return Ok(out);
            }
            vars["after"] = conn["pageInfo"]["endCursor"].clone();
        }
    }

    pub async fn detail(&self, number: u64) -> Result<PrDetail> {
        let me = self.me().await?;
        let m = self.get(&self.mr(number)).await?;
        let summary = Self::summary(&m, &me);
        let sha = m["sha"].as_str().unwrap_or("");
        let (statuses, reviewers, approvals) =
            (format!("{}/repository/commits/{sha}/statuses", self.rp()), format!("{}/reviewers", self.mr(number)), format!("{}/approvals", self.mr(number)));
        let (statuses, reviewers, approvals, discussions) = futures_util::try_join!(
            async { Ok::<_, Error>(self.all(&statuses, 3).await.unwrap_or_default()) },
            self.get(&reviewers),
            async { Ok::<_, Error>(self.get(&approvals).await.unwrap_or(Value::Null)) },
            self.discussions(number),
        )?;

        let checks = statuses
            .iter()
            .filter_map(|s| {
                let status = check_status(s["status"].as_str().unwrap_or(""))?;
                // A job allowed to fail does not hold the merge request back.
                let status = if status == "fail" && s["allow_failure"] == true { "pass" } else { status };
                Some(Check { name: s["name"].as_str().unwrap_or("").into(), status: status.into(), url: s["target_url"].as_str().map(Into::into) })
            })
            .collect();

        let mut people: Vec<Reviewer> = reviewers
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| Reviewer { login: r["user"]["username"].as_str().unwrap_or("").into(), vote: reviewer_vote(r["state"].as_str().unwrap_or("")).into() })
            .collect();
        // Approvals by people not asked to review.
        for a in approvals["approved_by"].as_array().into_iter().flatten() {
            let login = a["user"]["username"].as_str().unwrap_or("").to_string();
            match people.iter_mut().find(|r| r.login == login) {
                Some(r) => r.vote = "approve".into(),
                None => people.push(Reviewer { login, vote: "approve".into() }),
            }
        }

        let mut threads: Vec<Thread> = discussions
            .iter()
            .filter_map(|d| {
                let notes: Vec<&Value> = d["notes"]["nodes"].as_array()?.iter().filter(|n| n["system"] != true).collect();
                let first = *notes.first()?;
                let comments = notes
                    .iter()
                    .map(|n| Comment {
                        id: format!("{number}/{}", gid(&n["id"])),
                        database_id: gid(&n["id"]).parse().ok(),
                        author: n["author"]["username"].as_str().unwrap_or("ghost").into(),
                        body: n["body"].as_str().unwrap_or("").into(),
                        created_at: n["createdAt"].as_str().unwrap_or("").into(),
                        reactions: reactions(&n["awardEmoji"], &me),
                        can_edit: n["userPermissions"]["adminNote"] == true,
                    })
                    .collect();
                let pos = &first["position"];
                Some(Thread {
                    id: format!("{number}/{}", gid(&d["id"])),
                    path: pos["newPath"].as_str().map(String::from),
                    line: pos["newLine"].as_u64().or(pos["oldLine"].as_u64()),
                    resolved: d["resolved"] == true,
                    resolvable: d["resolvable"] == true,
                    // shortcut: GitLab's API gives no diff hunk with a note, so line threads show no code; read the file at the MR's head if missed.
                    snippet: vec![],
                    comments,
                    review: None,
                })
            })
            .collect();
        threads.sort_by(|a, b| {
            let da = a.comments.first().map(|c| c.created_at.as_str()).unwrap_or("");
            let db = b.comments.first().map(|c| c.created_at.as_str()).unwrap_or("");
            da.cmp(db)
        });

        let checking = matches!(m["detailed_merge_status"].as_str(), Some("checking" | "unchecked" | "preparing" | "approvals_syncing"));
        let conflict = m["has_conflicts"] == true;
        Ok(PrDetail {
            body: m["description"].as_str().unwrap_or("").into(),
            conflict,
            mergeable: (!checking).then_some(!conflict),
            checks,
            reviewers: people,
            threads,
            summary,
        })
    }

    pub async fn create(&self, head: &str, base: &str, title: &str, body: &str, draft: bool) -> Result<PrSummary> {
        let me = self.me().await?;
        let title = if draft { format!("Draft: {title}") } else { title.into() };
        let v = self
            .req(
                reqwest::Method::POST,
                &format!("{}/merge_requests", self.rp()),
                Some(json!({ "source_branch": head, "target_branch": base, "title": title, "description": body, "remove_source_branch": false })),
            )
            .await?;
        Ok(Self::summary(&v, &me))
    }

    pub async fn update(&self, number: u64, title: &str, body: &str) -> Result<()> {
        self.send(reqwest::Method::PUT, &self.mr(number), json!({ "title": title, "description": body })).await
    }

    /// method: merge | squash; GitLab rebases when the project merges that way.
    pub async fn merge(&self, number: u64, method: &str) -> Result<()> {
        self.send(reqwest::Method::PUT, &format!("{}/merge", self.mr(number)), json!({ "squash": method == "squash" })).await
    }

    pub async fn set_closed(&self, number: u64, closed: bool) -> Result<()> {
        let event = if closed { "close" } else { "reopen" };
        self.send(reqwest::Method::PUT, &self.mr(number), json!({ "state_event": event })).await
    }

    /// vote: approve | changes | comment. The text goes as a comment; "changes" sets the reviewer state
    /// where the server knows it (GitLab 18 and later, for an assigned reviewer).
    pub async fn review(&self, number: u64, vote: &str, body: &str) -> Result<()> {
        // The vote first: when it fails, nothing is posted, so trying again posts the comment once.
        match vote {
            "approve" => self.send(reqwest::Method::POST, &format!("{}/approve", self.mr(number)), json!({})).await?,
            "changes" => self.send(reqwest::Method::POST, &format!("{}/draft_notes/bulk_publish", self.mr(number)), json!({ "reviewer_state": "requested_changes" })).await?,
            _ => {}
        }
        if !body.trim().is_empty() {
            self.comment(number, body).await?;
        }
        Ok(())
    }

    pub async fn comment(&self, number: u64, body: &str) -> Result<()> {
        self.send(reqwest::Method::POST, &format!("{}/notes", self.mr(number)), json!({ "body": body })).await
    }

    /// `thread`: `iid/discussion`.
    pub async fn reply(&self, number: u64, thread: &str, body: &str) -> Result<()> {
        let (_, discussion) = split_id(thread)?;
        self.send(reqwest::Method::POST, &format!("{}/discussions/{discussion}/notes", self.mr(number)), json!({ "body": body })).await
    }

    pub async fn edit_comment(&self, id: &str, body: &str) -> Result<()> {
        let (iid, note) = split_id(id)?;
        self.send(reqwest::Method::PUT, &format!("{}/notes/{note}", self.mr(iid)), json!({ "body": body })).await
    }

    pub async fn set_resolved(&self, thread_id: &str, resolved: bool) -> Result<()> {
        let (iid, discussion) = split_id(thread_id)?;
        self.send(reqwest::Method::PUT, &format!("{}/discussions/{discussion}", self.mr(iid)), json!({ "resolved": resolved })).await
    }

    pub async fn react(&self, subject_id: &str, content: &str, add: bool) -> Result<()> {
        let (iid, note) = split_id(subject_id)?;
        let name = REACTIONS.iter().find(|(c, _)| *c == content).map(|(_, g)| *g).ok_or_else(|| Error::Invalid(format!("reaction {content}")))?;
        let awards = format!("{}/notes/{note}/award_emoji", self.mr(iid));
        if add {
            return self.send(reqwest::Method::POST, &awards, json!({ "name": name })).await;
        }
        let me = self.me().await?;
        let list = self.get(&awards).await?;
        let mine = list.as_array().into_iter().flatten().find(|a| a["name"] == name && a["user"]["username"].as_str() == Some(me.as_str()));
        match mine.and_then(|a| a["id"].as_u64()) {
            Some(id) => self.req(reqwest::Method::DELETE, &format!("{awards}/{id}"), None).await.map(|_| ()),
            None => Ok(()),
        }
    }

    /// Protected branches among the first 100.
    pub async fn protected_branches(&self) -> Result<Vec<String>> {
        let v = self.get(&format!("{}/repository/branches?per_page=100", self.rp())).await?;
        Ok(v.as_array().into_iter().flatten().filter(|b| b["protected"] == true).filter_map(|b| b["name"].as_str().map(String::from)).collect())
    }

    pub async fn create_release(&self, tag: &str, target: &str, name: &str, body: &str) -> Result<String> {
        let v = self
            .req(reqwest::Method::POST, &format!("{}/releases", self.rp()), Some(json!({ "tag_name": tag, "ref": target, "name": name, "description": body })))
            .await?;
        Ok(v["_links"]["self"].as_str().unwrap_or("").into())
    }

    /// Projects the signed-in user is a member of, last active first; the first 1000.
    pub async fn user_repos(&self) -> Result<Vec<UserRepo>> {
        let all = self.all("/projects?membership=true&simple=true&order_by=last_activity_at&sort=desc", 10).await?;
        Ok(all
            .iter()
            .map(|p| UserRepo {
                full_name: p["path_with_namespace"].as_str().unwrap_or("").into(),
                description: p["description"].as_str().filter(|d| !d.is_empty()).map(String::from),
                private: p["visibility"] != "public",
                clone_url: p["http_url_to_repo"].as_str().unwrap_or("").into(),
                ssh_url: p["ssh_url_to_repo"].as_str().unwrap_or("").into(),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_merge_request_states() {
        let mr = |extra: Value| {
            let mut v = json!({ "iid": 4, "title": "T", "source_branch": "feat", "target_branch": "main", "author": { "username": "me" }, "state": "opened", "reviewers": [{ "username": "me" }] });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            GitLab::summary(&v, "me")
        };
        let s = mr(json!({}));
        assert_eq!((s.number, s.state.as_str(), s.mine, s.review_requested, s.head.as_str(), s.base.as_str()), (4, "open", true, true, "feat", "main"));
        assert_eq!(mr(json!({ "draft": true })).state, "draft");
        assert_eq!(mr(json!({ "state": "merged", "draft": true })).state, "merged");
        assert_eq!(mr(json!({ "state": "closed" })).state, "closed");
    }

    #[test]
    fn maps_jobs_votes_and_ids() {
        assert_eq!(check_status("manual"), None);
        assert_eq!(check_status("pending"), Some("wait"));
        assert_eq!(check_status("skipped"), Some("pass"));
        assert_eq!(reviewer_vote("requested_changes"), "changes");
        assert_eq!(reviewer_vote("unreviewed"), "pending");
        assert_eq!(gid(&json!("gid://gitlab/DiffNote/12")), "12");
        assert_eq!(split_id("7/abc").unwrap(), (7, "abc"));
        assert!(split_id("abc").is_err());
        let r = reactions(&json!({ "nodes": [{ "name": "thumbsup", "user": { "username": "me" } }, { "name": "thumbsup", "user": { "username": "x" } }] }), "me");
        assert_eq!((r[0].content.as_str(), r[0].count, r[0].mine), ("THUMBS_UP", 2, true));
    }
}
