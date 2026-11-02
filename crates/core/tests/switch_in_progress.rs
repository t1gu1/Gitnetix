//! A checkout stopped in the middle of a rebase or merge: `switch` with `abort`, or `workspace.abort`, puts it back.

use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::json;

fn sh(dir: &std::path::Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn commit_file(repo: &std::path::Path, body: &str) {
    std::fs::write(repo.join("README.md"), body).unwrap();
    sh(repo, &["commit", "-qam", body.trim()]);
}

#[tokio::test]
async fn switch_aborts_a_stuck_rebase_when_asked() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    std::fs::write(repo.join("README.md"), "# a\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "init"]);
    sh(&repo, &["switch", "-qc", "feat/b"]);
    commit_file(&repo, "# b\n");
    sh(&repo, &["switch", "-q", "main"]);
    commit_file(&repo, "# main\n");
    sh(&repo, &["switch", "-q", "feat/b"]);
    // Stops on the conflict, as a crash mid-rebase would leave it.
    assert!(!Command::new("git").current_dir(&repo).args(["rebase", "main"]).output().unwrap().status.success());

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let ov = rpc::call(&k, "workspace.overview", json!({ "projectId": pid })).await.unwrap();
    assert_eq!(ov["inProgress"], "rebase", "{ov:#}");

    assert!(rpc::call(&k, "workspace.switch", json!({ "projectId": pid, "branch": "main" })).await.is_err());
    rpc::call(&k, "workspace.switch", json!({ "projectId": pid, "branch": "main", "abort": true })).await.unwrap();
    let head = Command::new("git").current_dir(&repo).args(["symbolic-ref", "--short", "HEAD"]).output().unwrap().stdout;
    assert_eq!(String::from_utf8(head).unwrap().trim(), "main");
    let ov = rpc::call(&k, "workspace.overview", json!({ "projectId": pid })).await.unwrap();
    assert!(ov["inProgress"].is_null());
}

#[tokio::test]
async fn abort_puts_a_stuck_merge_back_to_before_it() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    std::fs::write(repo.join("README.md"), "# a\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "init"]);
    sh(&repo, &["switch", "-qc", "feat/b"]);
    commit_file(&repo, "# b\n");
    sh(&repo, &["switch", "-q", "main"]);
    commit_file(&repo, "# main\n");
    let before = Command::new("git").current_dir(&repo).args(["rev-parse", "HEAD"]).output().unwrap().stdout;
    // Stops on the conflict, as a merge started in a terminal would leave it.
    assert!(!Command::new("git").current_dir(&repo).args(["merge", "feat/b"]).output().unwrap().status.success());

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let ov = rpc::call(&k, "workspace.overview", json!({ "projectId": pid })).await.unwrap();
    let main = |ov: &serde_json::Value| ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == "main").unwrap().clone();
    assert_eq!(main(&ov)["inProgress"], "merge", "{ov:#}");
    assert_eq!(main(&ov)["conflict"], true);

    rpc::call(&k, "workspace.abort", json!({ "projectId": pid, "branch": "main" })).await.unwrap();
    let after = Command::new("git").current_dir(&repo).args(["rev-parse", "HEAD"]).output().unwrap().stdout;
    assert_eq!(after, before);
    assert_eq!(std::fs::read_to_string(repo.join("README.md")).unwrap(), "# main\n");
    let ov = rpc::call(&k, "workspace.overview", json!({ "projectId": pid })).await.unwrap();
    assert!(ov["inProgress"].is_null(), "{ov:#}");
    assert!(main(&ov)["inProgress"].is_null());
    assert_eq!(main(&ov)["conflict"], false);

    // Nothing left to abort.
    assert!(rpc::call(&k, "workspace.abort", json!({ "projectId": pid, "branch": "main" })).await.is_err());
}
