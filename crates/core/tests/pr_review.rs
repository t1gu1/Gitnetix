//! A pull request's files and diffs come from the clone, as its host draws them: its commits are fetched from origin
//! when missing (the pull request's own ref, else its branch), renames keep their old path, and the diff has the 3
//! lines of context hosts take comments on, whatever `diff.context` says.

use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn commit(dir: &Path, msg: &str) {
    sh(dir, &["add", "-A"]);
    sh(dir, &["-c", "user.email=t@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg]);
}

fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

#[tokio::test]
async fn reads_a_pull_request_it_has_to_fetch() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path();
    let (origin, repo, other) = (tmp.join("origin.git"), tmp.join("repo"), tmp.join("other"));
    sh(tmp, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(tmp, &["clone", "-q", origin.to_str().unwrap(), other.to_str().unwrap()]);
    std::fs::write(other.join("app.rs"), numbered(30)).unwrap();
    std::fs::write(other.join("notes.txt"), numbered(12)).unwrap();
    commit(&other, "init");
    sh(&other, &["push", "-q", "origin", "main"]);
    sh(tmp, &["clone", "-q", origin.to_str().unwrap(), repo.to_str().unwrap()]);
    // Hosts draw 3 lines of context: this clone's own setting must not widen the diff.
    sh(&repo, &["config", "diff.context", "10"]);
    let base = sh(&repo, &["rev-parse", "main"]);

    // The pull request: on origin under its own ref only (a fork's, or a deleted branch's), unknown to this clone.
    sh(&other, &["switch", "-q", "-c", "feature"]);
    std::fs::write(other.join("app.rs"), numbered(30).replace("line 15\n", "line fifteen\n")).unwrap();
    sh(&other, &["mv", "notes.txt", "docs.txt"]);
    std::fs::write(other.join("docs.txt"), numbered(12).replace("line 2\n", "line two\n")).unwrap();
    commit(&other, "feature");
    sh(&other, &["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
    let head = sh(&other, &["rev-parse", "HEAD"]);
    let refs_before = sh(&repo, &["for-each-ref", "--format=%(refname) %(objectname)"]);

    let k = Gitnetix::open(&tmp.join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let pr = json!({ "projectId": pid, "number": 7, "base": "main", "head": "feature", "baseSha": base, "headSha": head });

    let files = rpc::call(&k, "prs.files", pr.clone()).await.unwrap();
    assert_eq!(
        files,
        json!([
            { "path": "app.rs", "status": "M", "additions": 1, "deletions": 1 },
            { "path": "docs.txt", "status": "R", "additions": 1, "deletions": 1, "from": "notes.txt" },
        ])
    );
    assert_eq!(sh(&repo, &["for-each-ref", "--format=%(refname) %(objectname)"]), refs_before, "fetched without moving a ref");

    let diff = |path: &str, from: Option<&str>| {
        let mut p = pr.clone();
        p["path"] = json!(path);
        if let Some(f) = from {
            p["from"] = json!(f);
        }
        let k = k.clone();
        async move { rpc::call(&k, "prs.diff", p).await.unwrap() }
    };
    let hunks = diff("app.rs", None).await;
    assert_eq!(hunks.as_array().unwrap().len(), 1);
    assert_eq!((&hunks[0]["oldStart"], &hunks[0]["newStart"]), (&json!(12), &json!(12)), "3 lines of context, not 10");
    let kinds: String = hunks[0]["lines"].as_array().unwrap().iter().map(|l| l["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, "   -+   ");
    // A renamed file shows what changed, not a whole new file.
    let renamed = diff("docs.txt", Some("notes.txt")).await;
    let lines: Vec<&Value> = renamed[0]["lines"].as_array().unwrap().iter().collect();
    assert_eq!(lines.iter().filter(|l| l["kind"] != " ").count(), 2);

    // A commit origin doesn't have: a clear error, not a diff of something else.
    let mut gone = pr.clone();
    gone["headSha"] = json!("0123456789abcdef0123456789abcdef01234567");
    gone["number"] = json!(8);
    let err = rpc::call(&k, "prs.files", gone).await.unwrap_err();
    assert_eq!(err.code(), "not_found", "{err}");
}

#[tokio::test]
async fn finds_a_short_head_sha_on_its_branch() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path();
    let (origin, repo, other) = (tmp.join("origin.git"), tmp.join("repo"), tmp.join("other"));
    sh(tmp, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(tmp, &["clone", "-q", origin.to_str().unwrap(), other.to_str().unwrap()]);
    std::fs::write(other.join("a.txt"), "a\n").unwrap();
    commit(&other, "init");
    sh(&other, &["push", "-q", "origin", "main"]);
    sh(tmp, &["clone", "-q", origin.to_str().unwrap(), repo.to_str().unwrap()]);
    sh(&other, &["switch", "-q", "-c", "fix/b"]);
    std::fs::write(other.join("b.txt"), "b\n").unwrap();
    commit(&other, "b");
    sh(&other, &["push", "-q", "origin", "fix/b"]);
    // Bitbucket names commits by their first 12 characters.
    let (head, base) = (sh(&other, &["rev-parse", "--short=12", "HEAD"]), sh(&other, &["rev-parse", "--short=12", "main"]));

    let k = Gitnetix::open(&tmp.join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap();
    let files = rpc::call(&k, "prs.files", json!({ "projectId": pid, "number": 3, "base": "main", "head": "fix/b", "baseSha": base, "headSha": head })).await.unwrap();
    assert_eq!(files, json!([{ "path": "b.txt", "status": "A", "additions": 1, "deletions": 0 }]));
}

/// A clone of the user's GitHub fork whose pull requests go to the repository it was forked from (picked on the pull
/// requests page): a pull request's commits, only on that repository, are fetched from it, through origin's URL with
/// the repository swapped. `insteadOf` points that one at a local bare repository; origin's URL stays as written, since
/// `git remote get-url` would show it rewritten too, and is never reached.
#[tokio::test]
async fn reads_a_forks_pull_request_from_the_repository_it_went_to() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path();
    let (parent, repo, other) = (tmp.join("parent.git"), tmp.join("repo"), tmp.join("other"));
    sh(tmp, &["init", "-q", "--bare", "-b", "main", parent.to_str().unwrap()]);
    sh(tmp, &["clone", "-q", parent.to_str().unwrap(), other.to_str().unwrap()]);
    std::fs::write(other.join("app.rs"), numbered(10)).unwrap();
    commit(&other, "init");
    sh(&other, &["push", "-q", "origin", "main"]);
    sh(tmp, &["clone", "-q", parent.to_str().unwrap(), repo.to_str().unwrap()]);
    sh(&other, &["switch", "-q", "-c", "feature"]);
    std::fs::write(other.join("app.rs"), numbered(10).replace("line 4\n", "line four\n")).unwrap();
    commit(&other, "feature");
    sh(&other, &["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
    let (base, head) = (sh(&other, &["rev-parse", "main"]), sh(&other, &["rev-parse", "HEAD"]));
    sh(&repo, &["remote", "set-url", "origin", "https://github.com/me/app.git"]);
    sh(&repo, &["config", &format!("url.{}.insteadOf", parent.display()), "https://github.com/acme/app.git"]);

    let k = Gitnetix::open(&tmp.join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let pr = json!({ "projectId": pid, "number": 7, "base": "main", "head": "feature", "baseSha": base, "headSha": head });
    let pr_repo = || async { rpc::call(&k, "config.get", json!({})).await.unwrap()["projects"][0]["prRepo"].clone() };

    rpc::call(&k, "projects.setPrefs", json!({ "projectId": pid, "prRepo": { "origin": "me/app", "to": "acme/app" } })).await.unwrap();
    assert_eq!(pr_repo().await, json!({ "origin": "me/app", "to": "acme/app" }));
    let files = rpc::call(&k, "prs.files", pr.clone()).await.unwrap();
    assert_eq!(files[0]["path"], "app.rs", "{files}");
    assert_eq!(sh(&repo, &["cat-file", "-t", &head]), "commit");

    rpc::call(&k, "projects.setPrefs", json!({ "projectId": pid, "prRepo": null })).await.unwrap();
    assert_eq!(pr_repo().await, Value::Null);
}
