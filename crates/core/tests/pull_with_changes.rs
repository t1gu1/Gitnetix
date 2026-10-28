//! Uncommitted changes a pull would overwrite refuse it; `wip` stashes them or carries them along.
//! The checkout has `pull.rebase` set, which makes git refuse any uncommitted change on its own.

use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::json;

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

fn configure(dir: &Path) {
    for args in [&["config", "user.email", "t@example.com"][..], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(dir, args);
    }
}

const BASE: &str = "one\ntwo\nthree\nfour\nfive\n";

/// `main` checked out with `pull.rebase` set, one commit behind origin, which changed eas.json's first line.
async fn setup(tmp: &Path) -> (std::sync::Arc<Gitnetix>, String, std::path::PathBuf) {
    let origin = tmp.join("origin.git");
    let repo = tmp.join("repo");
    let other = tmp.join("other");
    sh(tmp, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(tmp, &["clone", "-q", origin.to_str().unwrap(), repo.to_str().unwrap()]);
    configure(&repo);
    sh(&repo, &["config", "pull.rebase", "true"]);
    std::fs::write(repo.join("eas.json"), BASE).unwrap();
    std::fs::write(repo.join("notes.txt"), "notes\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "init"]);
    sh(&repo, &["push", "-q", "-u", "origin", "main"]);

    sh(tmp, &["clone", "-q", origin.to_str().unwrap(), other.to_str().unwrap()]);
    configure(&other);
    std::fs::write(other.join("eas.json"), BASE.replace("one", "ONE")).unwrap();
    sh(&other, &["commit", "-qam", "upstream"]);
    sh(&other, &["push", "-q", "origin", "main"]);

    let k = Gitnetix::open(&tmp.join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap().to_string();
    // Conflicts stay for the user, whatever AI this machine has.
    rpc::call(&k, "projects.setPrefs", json!({ "projectId": pid, "merge": { "resolveConflicts": false } })).await.unwrap();
    (k, pid, repo)
}

fn eas(repo: &Path) -> String {
    std::fs::read_to_string(repo.join("eas.json")).unwrap()
}

#[tokio::test]
async fn changes_the_pull_leaves_alone_stay() {
    let tmp = tempfile::tempdir().unwrap();
    let (k, pid, repo) = setup(tmp.path()).await;
    std::fs::write(repo.join("notes.txt"), "mine\n").unwrap();

    let r = rpc::call(&k, "branches.pull", json!({ "projectId": pid, "branch": "main" })).await.unwrap();
    assert_eq!(r["conflicts"], json!([]));
    assert_eq!(eas(&repo), BASE.replace("one", "ONE"));
    assert_eq!(std::fs::read_to_string(repo.join("notes.txt")).unwrap(), "mine\n");
    assert_eq!(sh(&repo, &["stash", "list"]), "");
}

#[tokio::test]
async fn pull_refuses_then_stashes_or_carries_the_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let (k, pid, repo) = setup(tmp.path()).await;
    let before = sh(&repo, &["rev-parse", "HEAD"]);
    std::fs::write(repo.join("eas.json"), BASE.replace("five", "FIVE")).unwrap();

    let e = rpc::call(&k, "branches.pull", json!({ "projectId": pid, "branch": "main" })).await.unwrap_err();
    assert_eq!(e.code(), "would_overwrite", "{e}");
    assert_eq!(sh(&repo, &["rev-parse", "HEAD"]), before);

    // Stashed: main is pulled clean, the changes wait in a stash.
    std::fs::write(repo.join("new.txt"), "new\n").unwrap();
    let r = rpc::call(&k, "branches.pull", json!({ "projectId": pid, "branch": "main", "wip": "stash" })).await.unwrap();
    assert_eq!(r["conflicts"], json!([]));
    assert_eq!(sh(&repo, &["rev-parse", "HEAD"]), sh(&repo, &["rev-parse", "origin/main"]));
    assert_eq!(sh(&repo, &["status", "--porcelain"]), "");
    assert!(sh(&repo, &["stash", "list"]).contains("On main: 2 files"));
}

#[tokio::test]
async fn carried_changes_come_back_on_the_pulled_branch() {
    let tmp = tempfile::tempdir().unwrap();
    let (k, pid, repo) = setup(tmp.path()).await;
    std::fs::write(repo.join("eas.json"), BASE.replace("five", "FIVE")).unwrap();

    let r = rpc::call(&k, "branches.pull", json!({ "projectId": pid, "branch": "main", "wip": "carry" })).await.unwrap();
    assert_eq!(r["conflicts"], json!([]));
    assert_eq!(sh(&repo, &["rev-parse", "HEAD"]), sh(&repo, &["rev-parse", "origin/main"]));
    assert_eq!(eas(&repo), BASE.replace("one", "ONE").replace("five", "FIVE"));
    assert_eq!(sh(&repo, &["stash", "list"]), "");
}

#[tokio::test]
async fn diverged_pull_refuses_then_carries_the_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let (k, pid, repo) = setup(tmp.path()).await;
    std::fs::write(repo.join("notes.txt"), "local commit\n").unwrap();
    sh(&repo, &["commit", "-qam", "local"]);
    std::fs::write(repo.join("eas.json"), BASE.replace("five", "FIVE")).unwrap();

    let e = rpc::call(&k, "branches.pull", json!({ "projectId": pid, "branch": "main" })).await.unwrap_err();
    assert_eq!(e.code(), "would_overwrite", "{e}");

    // Rebased onto origin's commit, the changes back on top.
    let r = rpc::call(&k, "branches.pull", json!({ "projectId": pid, "branch": "main", "wip": "carry" })).await.unwrap();
    assert_eq!(r["conflicts"], json!([]));
    assert_eq!(sh(&repo, &["rev-parse", "HEAD~1"]), sh(&repo, &["rev-parse", "origin/main"]));
    assert_eq!(eas(&repo), BASE.replace("one", "ONE").replace("five", "FIVE"));
    assert_eq!(sh(&repo, &["stash", "list"]), "");
}

#[tokio::test]
async fn carrying_conflicting_changes_keeps_the_stash() {
    let tmp = tempfile::tempdir().unwrap();
    let (k, pid, repo) = setup(tmp.path()).await;
    std::fs::write(repo.join("eas.json"), BASE.replace("one", "uno")).unwrap();

    let r = rpc::call(&k, "branches.pull", json!({ "projectId": pid, "branch": "main", "wip": "carry" })).await.unwrap();
    assert_eq!(r["conflicts"], json!(["eas.json"]));
    assert_eq!(sh(&repo, &["rev-parse", "HEAD"]), sh(&repo, &["rev-parse", "origin/main"]));
    assert_eq!(sh(&repo, &["stash", "list"]).lines().count(), 1);
}
