//! `workspace.rebase` with `onto` rebases the branch onto any branch, its target left as it was.

use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

fn sh(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn commit_file(repo: &Path, file: &str, body: &str) {
    std::fs::write(repo.join(file), body).unwrap();
    sh(repo, &["add", file]);
    sh(repo, &["commit", "-qm", body.trim()]);
}

fn is_ancestor(repo: &Path, a: &str, b: &str) -> bool {
    Command::new("git").current_dir(repo).args(["merge-base", "--is-ancestor", a, b]).status().unwrap().success()
}

/// A repo on `main` with one commit, pushed to a bare origin.
fn repo(tmp: &Path) -> std::path::PathBuf {
    let origin = tmp.join("origin.git");
    sh(tmp, &["init", "-q", "--bare", "-b", "main", &origin.to_string_lossy()]);
    let repo = tmp.join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    sh(&repo, &["remote", "add", "origin", &origin.to_string_lossy()]);
    commit_file(&repo, "README.md", "# a\n");
    sh(&repo, &["push", "-q", "-u", "origin", "main"]);
    repo
}

async fn open(tmp: &Path, repo: &Path) -> (std::sync::Arc<Gitnetix>, String) {
    let k = Gitnetix::open(&tmp.join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap().to_string();
    (k, pid)
}

async fn parent_of(k: &Gitnetix, pid: &str, branch: &str) -> Value {
    let ov = rpc::call(k, "workspace.overview", json!({ "projectId": pid })).await.unwrap();
    ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == branch).unwrap_or_else(|| panic!("no {branch} in {ov:#}"))["parent"].clone()
}

#[tokio::test]
async fn rebases_onto_another_branch_and_keeps_the_target() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo(tmp.path());
    sh(&repo, &["switch", "-qc", "dev"]);
    commit_file(&repo, "dev.txt", "dev\n");
    sh(&repo, &["switch", "-qc", "feat/b", "main"]);
    commit_file(&repo, "b.txt", "b\n");
    let (k, pid) = open(tmp.path(), &repo).await;
    assert_eq!(parent_of(&k, &pid, "feat/b").await, "main");

    let r = rpc::call(&k, "workspace.rebase", json!({ "projectId": pid, "branch": "feat/b", "onto": "dev" })).await.unwrap();
    assert_eq!(r["conflicts"], json!([]), "{r:#}");
    assert!(is_ancestor(&repo, "dev", "feat/b"));
    // By history alone it would now target dev.
    assert_eq!(parent_of(&k, &pid, "feat/b").await, "main");
}

#[tokio::test]
async fn rebases_onto_a_branch_only_on_origin() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo(tmp.path());
    sh(&repo, &["switch", "-qc", "feat/o"]);
    commit_file(&repo, "o.txt", "o\n");
    sh(&repo, &["push", "-q", "origin", "feat/o"]);
    sh(&repo, &["switch", "-qc", "feat/b", "main"]);
    sh(&repo, &["branch", "-qD", "feat/o"]);
    commit_file(&repo, "b.txt", "b\n");
    let (k, pid) = open(tmp.path(), &repo).await;

    let r = rpc::call(&k, "workspace.rebase", json!({ "projectId": pid, "branch": "feat/b", "onto": "feat/o" })).await.unwrap();
    assert_eq!(r["conflicts"], json!([]), "{r:#}");
    assert!(is_ancestor(&repo, "origin/feat/o", "feat/b"));
}

/// feat/b stopped while rebasing onto feat/a, README.md in conflict and left to the user.
/// Its commit, by Ada, has a message git would take for a comment.
async fn stopped(tmp: &Path) -> (std::path::PathBuf, std::sync::Arc<Gitnetix>, String) {
    let repo = repo(tmp);
    sh(&repo, &["switch", "-qc", "feat/a"]);
    commit_file(&repo, "README.md", "# from a\n");
    sh(&repo, &["switch", "-qc", "feat/b", "main"]);
    std::fs::write(repo.join("README.md"), "# from b\n").unwrap();
    sh(&repo, &["commit", "-qa", "--author", "Ada <ada@example.com>", "-m", "#42 fix login"]);
    let (k, pid) = open(tmp, &repo).await;
    // Whatever AI the machine has.
    rpc::call(&k, "projects.setPrefs", json!({ "projectId": pid, "merge": { "resolveConflicts": false } })).await.unwrap();
    let r = rpc::call(&k, "workspace.rebase", json!({ "projectId": pid, "branch": "feat/b", "onto": "feat/a" })).await.unwrap();
    assert_eq!(r["conflicts"], json!(["README.md"]), "{r:#}");
    (repo, k, pid)
}

fn head(repo: &Path) -> String {
    let out = Command::new("git").current_dir(repo).args(["symbolic-ref", "--short", "-q", "HEAD"]).output().unwrap().stdout;
    String::from_utf8(out).unwrap().trim().to_string()
}

#[tokio::test]
async fn a_stopped_rebase_stays_on_its_branch_and_aborts() {
    let tmp = tempfile::tempdir().unwrap();
    let (repo, k, pid) = stopped(tmp.path()).await;

    // HEAD is detached meanwhile, yet the checkout is still feat/b's, going onto feat/a (not its target).
    let ov = rpc::call(&k, "workspace.overview", json!({ "projectId": pid })).await.unwrap();
    assert_eq!(ov["inProgress"], "rebase", "{ov:#}");
    assert_eq!(ov["currentBranch"], "feat/b");
    assert_eq!(ov["rebaseOnto"], "feat/a");
    assert_eq!(ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == "feat/b").unwrap()["checkedOut"], true);

    rpc::call(&k, "workspace.rebaseAbort", json!({ "projectId": pid, "branch": "feat/b" })).await.unwrap();
    assert_eq!(head(&repo), "feat/b");
    assert!(!is_ancestor(&repo, "feat/a", "feat/b"));
    let ov = rpc::call(&k, "workspace.overview", json!({ "projectId": pid })).await.unwrap();
    assert!(ov["rebaseOnto"].is_null(), "{ov:#}");
}

#[tokio::test]
async fn continues_a_stopped_rebase_once_resolved() {
    let tmp = tempfile::tempdir().unwrap();
    let (repo, k, pid) = stopped(tmp.path()).await;

    // Resolved to feat/a's side: feat/b's commit has nothing left to replay.
    std::fs::write(repo.join("README.md"), "# from a\n").unwrap();
    sh(&repo, &["add", "README.md"]);
    let r = rpc::call(&k, "workspace.rebaseContinue", json!({ "projectId": pid, "branch": "feat/b" })).await.unwrap();
    assert_eq!(r["conflicts"], json!([]), "{r:#}");
    assert_eq!(head(&repo), "feat/b");
    let rev = |r: &str| String::from_utf8(Command::new("git").current_dir(&repo).args(["rev-parse", r]).output().unwrap().stdout).unwrap();
    assert_eq!(rev("feat/b"), rev("feat/a"));
}

#[tokio::test]
async fn continuing_keeps_a_message_that_looks_like_a_comment() {
    let tmp = tempfile::tempdir().unwrap();
    let (repo, k, pid) = stopped(tmp.path()).await;

    std::fs::write(repo.join("README.md"), "# from a and b\n").unwrap();
    sh(&repo, &["add", "README.md"]);
    let r = rpc::call(&k, "workspace.rebaseContinue", json!({ "projectId": pid, "branch": "feat/b" })).await.unwrap();
    assert_eq!(r["conflicts"], json!([]), "{r:#}");
    assert_eq!(head(&repo), "feat/b");
    let log = String::from_utf8(Command::new("git").current_dir(&repo).args(["log", "-1", "--format=%B%x00%an <%ae>%x00%P", "feat/b"]).output().unwrap().stdout).unwrap();
    let parent = String::from_utf8(Command::new("git").current_dir(&repo).args(["rev-parse", "feat/a"]).output().unwrap().stdout).unwrap();
    assert_eq!(log.trim().split('\0').collect::<Vec<_>>(), ["#42 fix login\n", "Ada <ada@example.com>", parent.trim()]);
}
