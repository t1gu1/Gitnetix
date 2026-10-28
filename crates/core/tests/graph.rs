//! `workspace.graph` returns a few branches' commits with their parents, tips, tags and HEAD,
//! and says how much history it left out when a branch has more commits than it reads.

use std::path::{Path, PathBuf};
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

fn sh(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn rev(dir: &Path, r: &str) -> String {
    let out = Command::new("git").current_dir(dir).args(["rev-parse", r]).output().unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn commit(repo: &Path, msg: &str) {
    sh(repo, &["commit", "-q", "--allow-empty", "-m", msg]);
}

/// A repo on `main` with one commit, pushed to a bare origin.
fn repo(tmp: &Path) -> PathBuf {
    let origin = tmp.join("origin.git");
    sh(tmp, &["init", "-q", "--bare", "-b", "main", &origin.to_string_lossy()]);
    let repo = tmp.join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    sh(&repo, &["remote", "add", "origin", &origin.to_string_lossy()]);
    commit(&repo, "first");
    sh(&repo, &["push", "-q", "-u", "origin", "main"]);
    repo
}

async fn graph(tmp: &Path, repo: &Path, branches: &[&str]) -> Value {
    let k = Gitnetix::open(&tmp.join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap().to_string();
    rpc::call(&k, "workspace.graph", json!({ "projectId": pid, "branches": branches })).await.unwrap()
}

fn find<'a>(g: &'a Value, sha: &str) -> &'a Value {
    g["commits"].as_array().unwrap().iter().find(|c| c["sha"] == sha).unwrap_or_else(|| panic!("no {sha} in {g:#}"))
}

#[tokio::test]
async fn lists_both_branches_with_parents_tips_tags_and_head() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo(tmp.path());
    let first = rev(&repo, "HEAD");
    sh(&repo, &["tag", "v1.0.0"]);
    sh(&repo, &["switch", "-qc", "feat/x"]);
    commit(&repo, "f1");
    commit(&repo, "f2");
    sh(&repo, &["switch", "-q", "main"]);
    commit(&repo, "m1");
    let g = graph(tmp.path(), &repo, &["feat/x", "main"]).await;

    let (f2, f1, m1) = (rev(&repo, "feat/x"), rev(&repo, "feat/x~1"), rev(&repo, "main"));
    assert_eq!(find(&g, &f2)["parents"], json!([f1]));
    assert_eq!(find(&g, &f1)["parents"], json!([first]));
    assert_eq!(find(&g, &m1)["subject"], "m1");
    assert_eq!(find(&g, &first)["tags"], json!(["v1.0.0"]));
    let refs = g["refs"].as_array().unwrap();
    let tip = |name: &str, remote: bool| refs.iter().find(|r| r["name"] == name && r["remote"] == remote).map(|r| r["sha"].as_str().unwrap().to_string());
    assert_eq!(tip("feat/x", false), Some(f2));
    assert_eq!(tip("feat/x", true), None, "feat/x was never pushed");
    assert_eq!(tip("main", false), Some(m1.clone()));
    assert_eq!(tip("main", true), Some(first), "origin/main stayed on the pushed commit");
    assert_eq!(g["head"], "main");
    assert_eq!(g["headSha"], m1.as_str());
    assert_eq!(g["gaps"], json!([]));
}

#[tokio::test]
async fn leaves_out_a_long_run_and_says_where_it_leads() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo(tmp.path());
    let first = rev(&repo, "HEAD");
    sh(&repo, &["switch", "-qc", "feat/y"]);
    commit(&repo, "y");
    sh(&repo, &["switch", "-q", "main"]);
    for i in 0..70 {
        commit(&repo, &format!("m{i}"));
    }
    let g = graph(tmp.path(), &repo, &["main", "feat/y"]).await;

    // main reads its 60 newest commits; the 10 under them lead down to where both branches meet.
    let gaps = g["gaps"].as_array().unwrap();
    assert_eq!(gaps.len(), 1, "{g:#}");
    assert_eq!(gaps[0]["parent"], rev(&repo, "main~60").as_str());
    assert_eq!(gaps[0]["count"], 10);
    assert_eq!(gaps[0]["join"], first.as_str());
    assert_eq!(find(&g, &rev(&repo, "feat/y"))["parents"], json!([first]));
}
