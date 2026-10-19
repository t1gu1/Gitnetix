//! Azure DevOps REST: what the host knows that git does not, such as which pull request
//! took a commit in. A squash merge leaves no trace of the branch in git when its title
//! was edited, or the branch was rebased first.

use std::collections::HashMap;

use serde_json::{json, Value};

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

/// Completed pull requests that took each of `commits` in, by commit. Commits no
/// completed pull request took are left out.
pub async fn merged_prs(repo: &AzureRepo, token: &str, commits: &[String]) -> Result<HashMap<String, Vec<MergedPr>>> {
    let client = reqwest::Client::builder().user_agent(concat!("Gitnetix/", env!("CARGO_PKG_VERSION"))).build()?;
    let url = format!("https://dev.azure.com/{}/{}/_apis/git/repositories/{}/pullrequestquery?api-version=7.1", repo.org, repo.project, repo.repo);
    let mut out = HashMap::new();
    for chunk in commits.chunks(100) {
        // "commit": the pull requests that merged these commits.
        let body = json!({ "queries": [{ "type": "commit", "items": chunk }] });
        let res = client.post(&url).bearer_auth(token).header("accept", "application/json").json(&body).send().await?;
        let status = res.status();
        let v: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(Error::Http(format!("Azure DevOps {status}: {}", v["message"].as_str().unwrap_or("pull request lookup failed"))));
        }
        out.extend(read_query(&v));
    }
    Ok(out)
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
