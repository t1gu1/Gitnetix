//! Uncommitted changes a checkout would overwrite refuse the switch; `wip` stashes them or carries them along.

use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::json;

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap()
}

const BASE: &str = "one\ntwo\nthree\nfour\nfive\n";

/// `main` with uncommitted changes to eas.json, which `feat` changed on its first line.
async fn setup(tmp: &Path, local: &str) -> (std::sync::Arc<Gitnetix>, String, std::path::PathBuf) {
    let repo = tmp.join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    std::fs::write(repo.join("eas.json"), BASE).unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "init"]);
    sh(&repo, &["switch", "-qc", "feat"]);
    std::fs::write(repo.join("eas.json"), BASE.replace("one", "ONE")).unwrap();
    sh(&repo, &["commit", "-qam", "feat"]);
    sh(&repo, &["switch", "-q", "main"]);
    std::fs::write(repo.join("eas.json"), local).unwrap();

    let k = Gitnetix::open(&tmp.join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap().to_string();
    // Conflicts stay for the user, whatever AI this machine has.
    rpc::call(&k, "projects.setPrefs", json!({ "projectId": pid, "merge": { "resolveConflicts": false } })).await.unwrap();
    (k, pid, repo)
}

#[tokio::test]
async fn switch_refuses_then_stashes_or_carries_the_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let (k, pid, repo) = setup(tmp.path(), &BASE.replace("five", "FIVE")).await;

    let e = rpc::call(&k, "workspace.switch", json!({ "projectId": pid, "branch": "feat" })).await.unwrap_err();
    assert_eq!(e.code(), "would_overwrite", "{e}");
    assert_eq!(sh(&repo, &["symbolic-ref", "--short", "HEAD"]).trim(), "main");

    // Carried: both changes land on feat, the stash is gone.
    let r = rpc::call(&k, "workspace.switch", json!({ "projectId": pid, "branch": "feat", "wip": "carry" })).await.unwrap();
    assert_eq!(r["conflicts"], json!([]));
    assert_eq!(sh(&repo, &["symbolic-ref", "--short", "HEAD"]).trim(), "feat");
    assert_eq!(std::fs::read_to_string(repo.join("eas.json")).unwrap(), BASE.replace("one", "ONE").replace("five", "FIVE"));
    assert_eq!(sh(&repo, &["stash", "list"]), "");

    // Stashed: feat is clean, the changes wait in a stash.
    sh(&repo, &["checkout", "-q", "--", "eas.json"]);
    sh(&repo, &["switch", "-q", "main"]);
    std::fs::write(repo.join("eas.json"), BASE.replace("five", "FIVE")).unwrap();
    std::fs::write(repo.join("new.txt"), "new\n").unwrap();
    let r = rpc::call(&k, "workspace.switch", json!({ "projectId": pid, "branch": "feat", "wip": "stash" })).await.unwrap();
    assert_eq!(r["conflicts"], json!([]));
    assert_eq!(sh(&repo, &["symbolic-ref", "--short", "HEAD"]).trim(), "feat");
    assert_eq!(sh(&repo, &["status", "--porcelain"]), "");
    assert!(sh(&repo, &["stash", "list"]).contains("On main: 2 files"));
}

#[tokio::test]
async fn carrying_conflicting_changes_keeps_the_stash() {
    let tmp = tempfile::tempdir().unwrap();
    let (k, pid, repo) = setup(tmp.path(), &BASE.replace("one", "uno")).await;

    let r = rpc::call(&k, "workspace.switch", json!({ "projectId": pid, "branch": "feat", "wip": "carry" })).await.unwrap();
    assert_eq!(r["conflicts"], json!(["eas.json"]));
    assert_eq!(sh(&repo, &["symbolic-ref", "--short", "HEAD"]).trim(), "feat");
    assert_eq!(sh(&repo, &["stash", "list"]).lines().count(), 1);
}
