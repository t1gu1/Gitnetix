//! `projects.clone` clones into a new folder (making its missing parents) and adds it as a project.

use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::json;

fn sh(dir: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

#[tokio::test]
async fn clones_and_adds_the_project() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path();
    let (origin, seed) = (tmp.join("origin.git"), tmp.join("seed"));
    sh(tmp, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(tmp, &["clone", "-q", "-c", "core.autocrlf=false", origin.to_str().unwrap(), seed.to_str().unwrap()]);
    std::fs::write(seed.join("README.md"), "hi\n").unwrap();
    sh(&seed, &["add", "README.md"]);
    sh(&seed, &["-c", "user.email=t@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    sh(&seed, &["push", "-q", "origin", "main"]);

    let k = Gitnetix::open(&tmp.join("home")).unwrap();
    let dest = tmp.join("code").join("nested").join("app");
    let added = rpc::call(&k, "projects.clone", json!({ "url": origin.to_string_lossy(), "path": dest.to_string_lossy() })).await.unwrap();
    assert_eq!(added[0]["name"], "app");
    assert!(dest.join("README.md").exists(), "the files are checked out");
    let listed = rpc::call(&k, "projects.list", json!({})).await.unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);

    let again = rpc::call(&k, "projects.clone", json!({ "url": origin.to_string_lossy(), "path": dest.to_string_lossy() })).await;
    assert!(again.unwrap_err().to_string().contains("already exists"), "a folder in use is not overwritten");
    let relative = rpc::call(&k, "projects.clone", json!({ "url": origin.to_string_lossy(), "path": "app" })).await;
    assert!(relative.is_err(), "a relative path is refused");
}
