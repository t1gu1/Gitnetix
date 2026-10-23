//! Azure DevOps REST: what the host knows that git does not, such as which pull request
//! took a commit in. A squash merge leaves no trace of the branch in git when its title
//! was edited, or the branch was rebased first.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::github::{Check, Comment, PrDetail, PrSummary, Reaction, Reviewer, Thread};
use super::RepoRef;
use crate::error::{Error, Result};

/// organization/project/repository of an Azure DevOps remote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AzureRepo {
    pub org: String,
    pub project: String,
    pub repo: String,
}

/// A completed pull request: where it went, and the commit it landed as there.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MergedPr {
    pub id: u64,
    /// Branch it merged into (`release/9.0.0`).
    pub target: String,
    pub merge_commit: String,
}

/// Accepts `git@ssh.dev.azure.com:v3/org/project/repo`, `org@vs-ssh.visualstudio.com:v3/org/project/repo`,
/// `https://(org@)dev.azure.com/org/project/_git/repo` and `https://org.visualstudio.com/(DefaultCollection/)project/_git/repo`.
pub fn parse_remote(url: &str) -> Option<AzureRepo> {
    let url = url.trim().trim_end_matches('/');
    let repo = |org: &str, project: &str, repo: &str| {
        let repo = repo.trim_end_matches(".git");
        (!org.is_empty() && !project.is_empty() && !repo.is_empty()).then(|| AzureRepo { org: org.into(), project: project.into(), repo: repo.into() })
    };
    if let Some((_, path)) = url.split_once(":v3/") {
        let parts: Vec<&str> = path.split('/').collect();
        return match parts[..] {
            [org, project, name] => repo(org, project, name),
            _ => None,
        };
    }
    let rest = url.split_once("://")?.1;
    let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
    let (host, path) = rest.split_once('/')?;
    let parts: Vec<&str> = path.split('/').collect();
    if host == "dev.azure.com" {
        return match parts[..] {
            [org, project, "_git", name] => repo(org, project, name),
            _ => None,
        };
    }
    let org = host.strip_suffix(".visualstudio.com")?;
    match parts[..] {
        ["DefaultCollection", project, "_git", name] | [project, "_git", name] => repo(org, project, name),
        _ => None,
    }
}

/// Azure DevOps pull requests, with the same methods as `GitHub` so `PrHost` can hand
/// either to the pull request screens. Thread ids are `pr/thread` and comment ids
/// `pr/thread/comment`, since Azure only addresses them under their pull request.
pub struct Azure {
    http: reqwest::Client,
    auth: String,
    pub repo: AzureRepo,
}

/// Azure's only reaction is a like; it stands in for GitHub's thumbs up.
const LIKE: &str = "THUMBS_UP";

/// Policy type "Require a merge strategy".
const MERGE_STRATEGY_POLICY: &str = "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab";

fn branch(r: &Value) -> String {
    let r = r.as_str().unwrap_or("");
    r.strip_prefix("refs/heads/").unwrap_or(r).into()
}

/// approve | changes | pending, from Azure's 10 / 5 / 0 / -5 / -10 votes.
fn vote(v: &Value) -> &'static str {
    match v["vote"].as_i64().unwrap_or(0) {
        n if n > 0 => "approve",
        n if n < 0 => "changes",
        _ => "pending",
    }
}

fn split_id(id: &str) -> Result<Vec<u64>> {
    id.split('/').map(|p| p.parse().map_err(|_| Error::Invalid(format!("bad Azure DevOps id {id}")))).collect()
}

/// pass | fail | run, or None for a policy or status that does not apply.
fn check_status(s: &str) -> Option<&'static str> {
    match s {
        "approved" | "succeeded" => Some("pass"),
        "rejected" | "broken" | "failed" | "error" => Some("fail"),
        "queued" | "running" | "pending" => Some("run"),
        _ => None,
    }
}

/// The strategy to complete with: `wanted` when the target's policy allows it, else the first it allows.
fn merge_strategy(wanted: &str, policies: &Value) -> String {
    let wanted = match wanted {
        "squash" => "squash",
        "rebase" => "rebase",
        _ => "noFastForward",
    };
    let Some(s) = policies["value"].as_array().into_iter().flatten().find(|p| p["isEnabled"] != false).map(|p| &p["settings"]) else {
        return wanted.into();
    };
    let allowed = [("squash", "allowSquash"), ("noFastForward", "allowNoFastForward"), ("rebase", "allowRebase"), ("rebaseMerge", "allowRebaseMerge")];
    let ok: Vec<&str> = allowed.iter().filter(|(_, k)| s[*k] == true).map(|(m, _)| *m).collect();
    if ok.is_empty() || ok.contains(&wanted) { wanted.into() } else { ok[0].into() }
}

impl Azure {
    pub fn new(repo: AzureRepo, auth: String) -> Self {
        let http = crate::net::client();
        Azure { http, auth, repo }
    }

    /// owner = org/project, so screens can show it like a GitHub repo.
    pub fn repo_ref(&self) -> RepoRef {
        RepoRef { host: "dev.azure.com".into(), owner: format!("{}/{}", self.repo.org, self.repo.project), repo: self.repo.repo.clone() }
    }

    fn git_url(&self, path: &str) -> String {
        let sep = if path.contains('?') { '&' } else { '?' };
        format!("https://dev.azure.com/{}/{}/_apis/git/repositories/{}{path}{sep}api-version=7.1", self.repo.org, self.repo.project, self.repo.repo)
    }

    async fn req(&self, method: reqwest::Method, url: &str, body: Option<Value>) -> Result<Value> {
        let mut r = self.http.request(method, url).header("authorization", &self.auth).header("accept", "application/json");
        if let Some(b) = body {
            r = r.json(&b);
        }
        let res = r.send().await?;
        let status = res.status();
        let text = res.text().await?;
        let v: Value = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) };
        if !status.is_success() {
            let msg = v["message"].as_str().map(String::from).unwrap_or_else(|| v.to_string());
            return Err(Error::Http(format!("Azure DevOps {status}: {msg}")));
        }
        Ok(v)
    }

    async fn get(&self, path: &str) -> Result<Value> {
        self.req(reqwest::Method::GET, &self.git_url(path), None).await
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Value) -> Result<Value> {
        self.req(method, &self.git_url(path), Some(body)).await
    }

    /// Completed pull requests that took each of `commits` in, by commit. Commits no
    /// completed pull request took are left out.
    pub async fn merged_prs(&self, commits: &[String]) -> Result<HashMap<String, Vec<MergedPr>>> {
        let mut out = HashMap::new();
        for chunk in commits.chunks(100) {
            // "commit": the pull requests that merged these commits.
            let body = json!({ "queries": [{ "type": "commit", "items": chunk }] });
            out.extend(read_query(&self.send(reqwest::Method::POST, "/pullrequestquery", body).await?));
        }
        Ok(out)
    }

    /// Id of the signed-in identity.
    pub async fn me(&self) -> Result<String> {
        let v = self.req(reqwest::Method::GET, &format!("https://dev.azure.com/{}/_apis/connectionData", self.repo.org), None).await?;
        Ok(v["authenticatedUser"]["id"].as_str().unwrap_or("").into())
    }

    fn summary(&self, v: &Value, me: &str) -> PrSummary {
        let number = v["pullRequestId"].as_u64().unwrap_or(0);
        let state = match v["status"].as_str() {
            Some("completed") => "merged",
            Some("abandoned") => "closed",
            _ if v["isDraft"] == true => "draft",
            _ => "open",
        };
        let reviewers = v["reviewers"].as_array().into_iter().flatten();
        PrSummary {
            number,
            title: v["title"].as_str().unwrap_or("").into(),
            head: branch(&v["sourceRefName"]),
            base: branch(&v["targetRefName"]),
            state: state.into(),
            author: v["createdBy"]["displayName"].as_str().unwrap_or("").into(),
            mine: v["createdBy"]["id"].as_str() == Some(me),
            review_requested: reviewers.clone().any(|r| r["id"].as_str() == Some(me) && vote(r) == "pending"),
            updated_at: v["closedDate"].as_str().or(v["creationDate"].as_str()).unwrap_or("").into(),
            url: format!("https://dev.azure.com/{}/{}/_git/{}/pullrequest/{number}", self.repo.org, self.repo.project, self.repo.repo),
        }
    }

    pub async fn list(&self) -> Result<Vec<PrSummary>> {
        let (me, v) = futures_util::try_join!(self.me(), self.get("/pullrequests?searchCriteria.status=all&$top=60"))?;
        Ok(v["value"].as_array().into_iter().flatten().map(|p| self.summary(p, &me)).collect())
    }

    pub async fn detail(&self, number: u64) -> Result<PrDetail> {
        let (pr_path, threads_path) = (format!("/pullrequests/{number}"), format!("/pullRequests/{number}/threads"));
        let (me, p, t) = futures_util::try_join!(self.me(), self.get(&pr_path), self.get(&threads_path))?;
        let summary = self.summary(&p, &me);
        let project = p["repository"]["project"]["id"].as_str().unwrap_or("");
        let evals = format!(
            "https://dev.azure.com/{}/{}/_apis/policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/{project}/{number}&api-version=7.1-preview.1",
            self.repo.org, self.repo.project
        );
        // Checks are a bonus: a token without the policy scope still shows the rest.
        let statuses_path = format!("/pullRequests/{number}/statuses");
        let (evals, statuses) = futures_util::join!(self.req(reqwest::Method::GET, &evals, None), self.get(&statuses_path));
        let mut checks: Vec<Check> = Vec::new();
        for e in evals.ok().as_ref().and_then(|v| v["value"].as_array()).into_iter().flatten() {
            let c = &e["configuration"];
            // Only met on completion, and merge() picks an allowed strategy then.
            if c["type"]["id"] == MERGE_STRATEGY_POLICY {
                continue;
            }
            let name = c["settings"]["displayName"].as_str().or(c["type"]["displayName"].as_str()).unwrap_or("Policy");
            if let Some(status) = check_status(e["status"].as_str().unwrap_or("")) {
                // Build policies point at their pipeline run.
                let url = e["context"]["buildId"].as_u64().map(|id| format!("https://dev.azure.com/{}/{}/_build/results?buildId={id}", self.repo.org, self.repo.project));
                checks.push(Check { name: name.into(), status: status.into(), url });
            }
        }
        // Statuses are posted again on each push; the last one per name counts.
        for st in statuses.ok().as_ref().and_then(|v| v["value"].as_array()).into_iter().flatten() {
            let name = st["context"]["name"].as_str().or(st["description"].as_str()).unwrap_or("Status").to_string();
            let Some(status) = check_status(st["state"].as_str().unwrap_or("")) else { continue };
            checks.retain(|c| c.name != name);
            let url = st["targetUrl"].as_str().filter(|u| u.starts_with("http")).map(Into::into);
            checks.push(Check { name, status: status.into(), url });
        }

        let reviewers = p["reviewers"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| Reviewer { login: r["displayName"].as_str().unwrap_or("").into(), vote: vote(r).into() })
            .collect();

        let sha = p["lastMergeSourceCommit"]["commitId"].as_str().unwrap_or("");
        let mut files: HashMap<String, Vec<String>> = HashMap::new();
        let mut threads = Vec::new();
        for t in t["value"].as_array().into_iter().flatten().filter(|t| t["isDeleted"] != true) {
            let tid = t["id"].as_u64().unwrap_or(0);
            let comments: Vec<Comment> = t["comments"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|c| c["commentType"] != "system" && c["isDeleted"] != true)
                .map(|c| {
                    let liked = c["usersLiked"].as_array().map(Vec::as_slice).unwrap_or_default();
                    Comment {
                        id: format!("{number}/{tid}/{}", c["id"].as_u64().unwrap_or(0)),
                        database_id: Some(tid),
                        author: c["author"]["displayName"].as_str().unwrap_or("").into(),
                        body: c["content"].as_str().unwrap_or("").into(),
                        created_at: c["publishedDate"].as_str().unwrap_or("").into(),
                        can_edit: c["author"]["id"].as_str() == Some(me.as_str()),
                        reactions: if liked.is_empty() {
                            vec![]
                        } else {
                            vec![Reaction { content: LIKE.into(), emoji: "👍".into(), count: liked.len() as u64, mine: liked.iter().any(|u| u["id"].as_str() == Some(me.as_str())) }]
                        },
                    }
                })
                .collect();
            if comments.is_empty() {
                continue;
            }
            let ctx = &t["threadContext"];
            let path = ctx["filePath"].as_str().map(|f| f.trim_start_matches('/').to_string());
            let line = ctx["rightFileEnd"]["line"].as_u64();
            // Azure keeps no diff hunk with a thread: the lines it points at, read from the PR's head.
            let mut snippet = Vec::new();
            if let (Some(path), Some(line)) = (&path, line) {
                if !files.contains_key(path) {
                    let url = format!("/items?path={}&versionDescriptor.versionType=commit&versionDescriptor.version={sha}&includeContent=true", urlencoding(path));
                    let text = self.get(&url).await.ok().and_then(|v| v["content"].as_str().map(String::from)).unwrap_or_default();
                    files.insert(path.clone(), text.lines().map(String::from).collect());
                }
                let lines = &files[path];
                let end = (line as usize).min(lines.len());
                snippet = lines[end.saturating_sub(3)..end].iter().map(|l| format!(" {l}")).collect();
            }
            let status = t["status"].as_str().unwrap_or("unknown");
            threads.push(Thread {
                id: format!("{number}/{tid}"),
                path,
                line,
                resolved: matches!(status, "fixed" | "wontFix" | "closed" | "byDesign"),
                resolvable: status != "unknown",
                snippet,
                comments,
                review: None,
            });
        }
        threads.sort_by(|a, b| a.comments[0].created_at.cmp(&b.comments[0].created_at));

        let merge_status = p["mergeStatus"].as_str();
        let mergeable = match merge_status {
            Some("succeeded") => Some(true),
            Some("conflicts" | "failure" | "rejectedByPolicy") => Some(false),
            _ => None,
        };
        Ok(PrDetail { body: p["description"].as_str().unwrap_or("").into(), conflict: merge_status == Some("conflicts"), mergeable, checks, reviewers, threads, summary })
    }

    pub async fn create(&self, head: &str, base: &str, title: &str, body: &str, draft: bool) -> Result<PrSummary> {
        let b = json!({ "sourceRefName": format!("refs/heads/{head}"), "targetRefName": format!("refs/heads/{base}"), "title": title, "description": body, "isDraft": draft });
        let (me, v) = futures_util::try_join!(self.me(), self.send(reqwest::Method::POST, "/pullrequests", b))?;
        Ok(self.summary(&v, &me))
    }

    pub async fn update(&self, number: u64, title: &str, body: &str) -> Result<()> {
        self.send(reqwest::Method::PATCH, &format!("/pullrequests/{number}"), json!({ "title": title, "description": body })).await.map(|_| ())
    }

    /// method: merge | squash | rebase, swapped for one the target branch's policy allows.
    pub async fn merge(&self, number: u64, method: &str) -> Result<()> {
        let p = self.get(&format!("/pullrequests/{number}")).await?;
        let policies = format!(
            "https://dev.azure.com/{}/{}/_apis/git/policy/configurations?repositoryId={}&refName={}&policyType={MERGE_STRATEGY_POLICY}&api-version=7.1",
            self.repo.org,
            self.repo.project,
            p["repository"]["id"].as_str().unwrap_or(""),
            p["targetRefName"].as_str().unwrap_or("")
        );
        let policies = self.req(reqwest::Method::GET, &policies, None).await.unwrap_or(Value::Null);
        let b = json!({
            "status": "completed",
            "lastMergeSourceCommit": p["lastMergeSourceCommit"],
            "completionOptions": { "mergeStrategy": merge_strategy(method, &policies) },
        });
        self.send(reqwest::Method::PATCH, &format!("/pullrequests/{number}"), b).await.map(|_| ())
    }

    /// Abandons a PR, or reactivates an abandoned one.
    pub async fn set_closed(&self, number: u64, closed: bool) -> Result<()> {
        let status = if closed { "abandoned" } else { "active" };
        self.send(reqwest::Method::PATCH, &format!("/pullrequests/{number}"), json!({ "status": status })).await.map(|_| ())
    }

    /// vote: approve | changes | comment; the text goes in a new comment thread.
    pub async fn review(&self, number: u64, vote: &str, body: &str) -> Result<()> {
        let v = match vote {
            "approve" => 10,
            "changes" => -5,
            _ => 0,
        };
        if v != 0 {
            let me = self.me().await?;
            self.send(reqwest::Method::PUT, &format!("/pullRequests/{number}/reviewers/{me}"), json!({ "id": me, "vote": v })).await?;
        }
        if !body.trim().is_empty() {
            self.comment(number, body).await?;
        }
        Ok(())
    }

    pub async fn comment(&self, number: u64, body: &str) -> Result<()> {
        let b = json!({ "comments": [{ "parentCommentId": 0, "content": body, "commentType": "text" }], "status": "active" });
        self.send(reqwest::Method::POST, &format!("/pullRequests/{number}/threads"), b).await.map(|_| ())
    }

    /// `thread` is the thread's number, handed out as each comment's `database_id`.
    pub async fn reply(&self, number: u64, thread: u64, body: &str) -> Result<()> {
        let b = json!({ "parentCommentId": 1, "content": body, "commentType": "text" });
        self.send(reqwest::Method::POST, &format!("/pullRequests/{number}/threads/{thread}/comments"), b).await.map(|_| ())
    }

    pub async fn edit_comment(&self, id: &str, body: &str) -> Result<()> {
        let [pr, t, c] = split_id(id)?[..] else { return Err(Error::NotFound("comment".into())) };
        self.send(reqwest::Method::PATCH, &format!("/pullRequests/{pr}/threads/{t}/comments/{c}"), json!({ "content": body })).await.map(|_| ())
    }

    pub async fn set_resolved(&self, thread_id: &str, resolved: bool) -> Result<()> {
        let [pr, t] = split_id(thread_id)?[..] else { return Err(Error::NotFound("thread".into())) };
        let status = if resolved { "fixed" } else { "active" };
        self.send(reqwest::Method::PATCH, &format!("/pullRequests/{pr}/threads/{t}"), json!({ "status": status })).await.map(|_| ())
    }

    pub async fn react(&self, subject_id: &str, content: &str, add: bool) -> Result<()> {
        if content != LIKE {
            return Err(Error::Unsupported("Azure DevOps only has likes (👍)".into()));
        }
        let [pr, t, c] = split_id(subject_id)?[..] else { return Err(Error::NotFound("comment".into())) };
        let method = if add { reqwest::Method::POST } else { reqwest::Method::DELETE };
        self.req(method, &self.git_url(&format!("/pullRequests/{pr}/threads/{t}/comments/{c}/likes")), None).await.map(|_| ())
    }
}

fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn read_query(v: &Value) -> HashMap<String, Vec<MergedPr>> {
    let mut out: HashMap<String, Vec<MergedPr>> = HashMap::new();
    let results = v["results"].as_array().into_iter().flatten().filter_map(Value::as_object);
    for (commit, prs) in results.flatten() {
        for pr in prs.as_array().into_iter().flatten().filter(|pr| pr["status"] == "completed") {
            let (Some(id), Some(target), Some(merge_commit)) =
                (pr["pullRequestId"].as_u64(), pr["targetRefName"].as_str(), pr["lastMergeCommit"]["commitId"].as_str())
            else {
                continue;
            };
            let target = target.strip_prefix("refs/heads/").unwrap_or(target).to_string();
            out.entry(commit.clone()).or_default().push(MergedPr { id, target, merge_commit: merge_commit.into() });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remotes() {
        let want = Some(AzureRepo { org: "rcmn".into(), project: "Mauril".into(), repo: "mauril-expo".into() });
        for u in [
            "git@ssh.dev.azure.com:v3/rcmn/Mauril/mauril-expo",
            "rcmn@vs-ssh.visualstudio.com:v3/rcmn/Mauril/mauril-expo",
            "https://rcmn@dev.azure.com/rcmn/Mauril/_git/mauril-expo",
            "https://dev.azure.com/rcmn/Mauril/_git/mauril-expo/",
            "https://rcmn.visualstudio.com/Mauril/_git/mauril-expo",
            "https://rcmn.visualstudio.com/DefaultCollection/Mauril/_git/mauril-expo",
        ] {
            assert_eq!(parse_remote(u), want, "{u}");
        }
        assert_eq!(parse_remote("git@github.com:acme/atlas-api.git"), None);
        assert_eq!(parse_remote("https://github.com/acme/atlas-api"), None);
    }

    #[test]
    fn picks_an_allowed_merge_strategy() {
        assert_eq!(merge_strategy("merge", &Value::Null), "noFastForward");
        let squash_only = json!({ "value": [{ "isEnabled": true, "settings": { "allowSquash": true } }] });
        assert_eq!(merge_strategy("merge", &squash_only), "squash");
        assert_eq!(merge_strategy("squash", &squash_only), "squash");
        assert_eq!(split_id("7/42/3").unwrap(), vec![7, 42, 3]);
        assert!(split_id("PRRT_x").is_err());
    }

    #[test]
    fn reads_completed_pull_requests_only() {
        let v = json!({ "results": [{
            "aaa": [
                { "pullRequestId": 120480, "status": "completed", "targetRefName": "refs/heads/release/9.0.0", "lastMergeCommit": { "commitId": "d98" } },
                { "pullRequestId": 120481, "status": "abandoned", "targetRefName": "refs/heads/main", "lastMergeCommit": { "commitId": "e00" } }
            ],
            "bbb": [{ "pullRequestId": 7, "status": "active", "targetRefName": "refs/heads/main", "lastMergeCommit": { "commitId": "f00" } }]
        }] });
        let got = read_query(&v);
        assert_eq!(got.len(), 1);
        assert_eq!(got["aaa"], vec![MergedPr { id: 120480, target: "release/9.0.0".into(), merge_commit: "d98".into() }]);
    }
}
