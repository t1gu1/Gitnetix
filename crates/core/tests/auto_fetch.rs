//! `branches.autoFetch` fetches the first time, then only once origin's tips moved: a push from
//! another clone, a new tag.

use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::json;

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

fn commit(dir: &Path, msg: &str) {
    sh(dir, &["-c", "user.email=t@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
}

#[tokio::test]
async fn fetches_only_when_origin_moved() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path();
    let (origin, repo, other) = (tmp.join("origin.git"), tmp.join("repo"), tmp.join("other"));
    sh(tmp, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    for dir in [&repo, &other] {
        sh(tmp, &["clone", "-q", "-c", "core.autocrlf=false", "-c", "core.longpaths=true", origin.to_str().unwrap(), dir.to_str().unwrap()]);
    }
    commit(&other, "init");
    sh(&other, &["push", "-q", "origin", "main"]);

    let k = Gitnetix::open(&tmp.join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let auto = || async { rpc::call(&k, "branches.autoFetch", json!({ "projectId": pid })).await.unwrap() };
    let tip = |dir: &Path, rev: &str| sh(dir, &["rev-parse", rev]);

    assert_eq!(auto().await, json!(true), "the first look fetches");
    assert_eq!(tip(&repo, "origin/main"), tip(&other, "main"));
    assert_eq!(auto().await, json!(false), "nothing moved: no fetch");

    commit(&other, "second");
    sh(&other, &["push", "-q", "origin", "main"]);
    assert_eq!(auto().await, json!(true), "a push elsewhere fetches");
    assert_eq!(tip(&repo, "origin/main"), tip(&other, "main"));
    assert_eq!(auto().await, json!(false));

    sh(&other, &["tag", "v1"]);
    sh(&other, &["push", "-q", "origin", "v1"]);
    assert_eq!(auto().await, json!(true), "a new tag fetches");
    assert_eq!(tip(&repo, "v1"), tip(&other, "v1"));
}
