//! Thousands of untracked files (an unignored node_modules) all get listed, without their lines counted.

use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

fn sh(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

async fn call(k: &Gitnetix, m: &str, p: Value) -> Value {
    match rpc::call(k, m, p).await {
        Ok(v) => v,
        Err(e) => panic!("{m}: {e}"),
    }
}

#[tokio::test]
async fn many_untracked_files_list_uncounted() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "init"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let wip = || call(&k, "workspace.files", json!({ "projectId": pid, "branch": "main", "mode": "wip" }));
    let additions = |v: &Value| v.as_array().unwrap().iter().map(|f| f["additions"].as_u64().unwrap()).collect::<Vec<_>>();

    // A few new files: their lines are counted.
    std::fs::create_dir_all(repo.join("node_modules/pkg")).unwrap();
    for i in 0..3 {
        std::fs::write(repo.join(format!("node_modules/pkg/f{i}.js")), "x\ny\n").unwrap();
    }
    assert_eq!(additions(&wip().await), [2, 2, 2]);

    // Past the limit every file is still listed, none counted.
    for i in 3..2001 {
        std::fs::write(repo.join(format!("node_modules/pkg/f{i}.js")), "x\ny\n").unwrap();
    }
    let files = wip().await;
    assert_eq!(files.as_array().unwrap().len(), 2001);
    assert!(additions(&files).iter().all(|&a| a == 0));
}
