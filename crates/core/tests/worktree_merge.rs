//! Merging a worktree's branch with delete, through the RPC surface, on a throwaway repo.

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

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
async fn merge_deletes_the_branch_while_a_build_still_writes_in_its_worktree() {
    let tmp = tempfile::tempdir().unwrap();
    let app = tmp.path().join("app");
    std::fs::create_dir_all(&app).unwrap();
    sh(&app, &["init", "-q", "-b", "main"]);
    sh(&app, &["config", "user.email", "t@example.com"]);
    sh(&app, &["config", "user.name", "Test"]);
    sh(&app, &["config", "commit.gpgsign", "false"]);
    std::fs::write(app.join(".gitignore"), "target/\n").unwrap();
    sh(&app, &["add", "."]);
    sh(&app, &["commit", "-qm", "init"]);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let pid = call(&k, "projects.add", json!({ "paths": [app.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string();
    let wt = call(&k, "worktrees.create", json!({ "projectId": pid, "branch": "feat/x" })).await["path"].as_str().unwrap().to_string();
    std::fs::write(Path::new(&wt).join("x.txt"), "x\n").unwrap();
    sh(Path::new(&wt), &["add", "."]);
    sh(Path::new(&wt), &["commit", "-qm", "x"]);

    // A build the worktree's shell or agent started, killed but not gone yet: still filling target/ while git deletes the folder.
    let target = Path::new(&wt).join("target");
    std::fs::create_dir_all(&target).unwrap();
    for i in 0..2000 {
        std::fs::write(target.join(format!("f{i}")), "x").unwrap();
    }
    let writer = std::thread::spawn(move || {
        let end = Instant::now() + Duration::from_millis(1500);
        let mut i = 0;
        while Instant::now() < end {
            let _ = std::fs::create_dir_all(target.join(format!("d{i}")));
            i += 1;
        }
    });

    let r = call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/x", "into": "main", "deleteBranch": true, "stay": true })).await;
    writer.join().unwrap();
    assert_eq!(r["deleteError"], Value::Null, "{r}");
    assert_eq!(r["deleted"], true);
    assert!(!Path::new(&wt).exists());
    let left = Command::new("git").current_dir(&app).args(["branch", "--list", "feat/x"]).output().unwrap();
    assert!(left.stdout.is_empty());
}
