//! Worktree files: ignored files copied from the main checkout into each new worktree, set for every project and per project.

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
async fn new_worktrees_get_the_listed_ignored_files_only() {
    let tmp = tempfile::tempdir().unwrap();
    let app = tmp.path().join("app");
    std::fs::create_dir_all(&app).unwrap();
    sh(&app, &["init", "-q", "-b", "main"]);
    sh(&app, &["config", "user.email", "t@example.com"]);
    sh(&app, &["config", "user.name", "Test"]);
    sh(&app, &["config", "commit.gpgsign", "false"]);
    std::fs::write(app.join(".gitignore"), "graph/\n.env\ntarget/\n").unwrap();
    std::fs::write(app.join("README.md"), "tracked\n").unwrap();
    sh(&app, &["add", "."]);
    sh(&app, &["commit", "-qm", "init"]);
    std::fs::create_dir_all(app.join("graph/cache")).unwrap();
    std::fs::write(app.join("graph/graph.json"), "{}").unwrap();
    std::fs::write(app.join("graph/cache/a.json"), "a").unwrap();
    std::fs::write(app.join(".env"), "KEY=1\n").unwrap();
    std::fs::create_dir_all(app.join("target")).unwrap();
    std::fs::write(app.join("target/big"), "x").unwrap();
    std::fs::write(app.join("README.md"), "edited in main\n").unwrap();

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    assert_eq!(call(&k, "config.get", json!({})).await["worktreeFiles"], json!(["graphify-out/", ".claude/settings.local.json", ".env", ".env.local", ".env.example", ".env.example.local"]), "new profile defaults");
    let pid = call(&k, "projects.add", json!({ "paths": [app.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string();
    for bad in ["../outside", "/etc"] {
        let err = rpc::call(&k, "projects.setPrefs", json!({ "projectId": pid, "worktreeFiles": [bad] })).await.unwrap_err();
        assert!(err.to_string().contains("not a path inside the project"), "{err}");
        let err = rpc::call(&k, "worktrees.setFiles", json!({ "files": [bad] })).await.unwrap_err();
        assert!(err.to_string().contains("not a path inside the project"), "{err}");
    }
    // Both lists apply; a path in both is copied once.
    call(&k, "worktrees.setFiles", json!({ "files": ["graph/", ".env"] })).await;
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "worktreeFiles": [".env", "README.md", "missing"] })).await;

    let opened = call(&k, "worktrees.create", json!({ "projectId": pid, "branch": "feat/x" })).await["path"].as_str().unwrap().to_string();
    let new_item = call(&k, "items.create", json!({ "projectId": pid, "release": "", "kind": "feat", "description": "y", "branchName": "feat/y", "where": "worktree" })).await["worktree"]
        .as_str()
        .unwrap()
        .to_string();
    for wt in [opened, new_item] {
        let wt = Path::new(&wt);
        assert_eq!(std::fs::read_to_string(wt.join("graph/graph.json")).unwrap(), "{}");
        assert_eq!(std::fs::read_to_string(wt.join("graph/cache/a.json")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "KEY=1\n");
        assert!(!wt.join("target").exists(), "not listed");
        // Tracked: the branch's own version, not the main checkout's edit.
        assert_eq!(std::fs::read_to_string(wt.join("README.md")).unwrap(), "tracked\n");
    }
}
