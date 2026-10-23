//! A commit whose staged changes still have conflict markers is refused.

use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::json;

fn sh(dir: &std::path::Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

#[tokio::test]
async fn commit_with_conflict_markers_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    std::fs::write(repo.join("a.rs"), "fn a() {}\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "init"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap().to_string();

    std::fs::write(repo.join("a.rs"), "<<<<<<< HEAD\nfn a() {}\n=======\nfn b() {}\n>>>>>>> b\n").unwrap();
    let err = rpc::call(&k, "workspace.commit", json!({ "projectId": pid, "branch": "main", "message": "x", "all": true })).await.unwrap_err();
    assert!(err.to_string().contains("a.rs"), "{err}");

    std::fs::write(repo.join("a.rs"), "fn b() {}\n").unwrap();
    rpc::call(&k, "workspace.commit", json!({ "projectId": pid, "branch": "main", "message": "x", "all": true })).await.unwrap();
}
