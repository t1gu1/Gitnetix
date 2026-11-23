//! Hooks: terminal commands a project runs when Gitnetix creates or removes its worktrees, set on its Hooks page.
#![cfg(unix)]

use std::path::Path;
use std::process::Command;
use std::time::Duration;

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

/// The moment's last run, once there is one: hooks other than a worktree's removal run alongside.
async fn ran(k: &Gitnetix, pid: &str, moment: &str) -> Value {
    for _ in 0..100 {
        let runs = call(k, "hooks.runs", json!({ "projectId": pid })).await;
        if !runs[moment].is_null() {
            return runs[moment].clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the {moment} hook never ran");
}

#[tokio::test]
async fn worktree_hooks_run_in_the_worktree_and_a_failed_removal_hook_keeps_it() {
    let tmp = tempfile::tempdir().unwrap();
    let app = tmp.path().join("app");
    std::fs::create_dir_all(&app).unwrap();
    sh(&app, &["init", "-q", "-b", "main"]);
    sh(&app, &["config", "user.email", "t@example.com"]);
    sh(&app, &["config", "user.name", "Test"]);
    sh(&app, &["config", "commit.gpgsign", "false"]);
    std::fs::write(app.join(".gitignore"), ".env\nout/\n").unwrap();
    sh(&app, &["add", "."]);
    sh(&app, &["commit", "-qm", "init"]);
    sh(&app, &["branch", "feat/x"]);
    std::fs::write(app.join(".env"), "KEY=1\n").unwrap();

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let pid = call(&k, "projects.add", json!({ "paths": [app.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string();
    let hooks = |keep_going: bool| {
        json!({
            // Runs once the worktree files are copied: .env is there.
            "worktreeCreated": { "commands": ["mkdir out && cp .env out/seen.env", "echo \"$GITNETIX_BRANCH|$GITNETIX_WORKTREE\" > out/vars.txt"] },
            // Copies out of the worktree, then fails.
            "worktreeRemoved": { "commands": ["cp out/vars.txt \"$GITNETIX_MAIN/out-vars.txt\"", "echo broken >&2; exit 2"], "keepGoing": keep_going },
        })
    };
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "worktreeFiles": [".env"], "hooks": hooks(false) })).await;

    let wt = call(&k, "worktrees.create", json!({ "projectId": pid, "branch": "feat/x" })).await["path"].as_str().unwrap().to_string();
    let run = ran(&k, &pid, "worktreeCreated").await;
    assert_eq!(run["ok"], true, "{run}");
    assert_eq!(run["branch"], "feat/x");
    let wtp = Path::new(&wt);
    assert_eq!(std::fs::read_to_string(wtp.join("out/seen.env")).unwrap(), "KEY=1\n");
    assert_eq!(std::fs::read_to_string(wtp.join("out/vars.txt")).unwrap(), format!("feat/x|{wt}\n"));

    // Stops on failure: the worktree stays, and what the hook copied first is out.
    let err = rpc::call(&k, "worktrees.remove", json!({ "projectId": pid, "path": wt })).await.unwrap_err().to_string();
    assert!(err.contains("worktree removed hook") && err.contains("broken"), "{err}");
    assert!(wtp.exists(), "a failed removal hook removed the worktree");
    assert!(app.join("out-vars.txt").exists());
    let run = call(&k, "hooks.runs", json!({ "projectId": pid })).await["worktreeRemoved"].clone();
    assert_eq!((run["ok"].as_bool(), run["steps"][1]["code"].as_i64()), (Some(false), Some(2)), "{run}");

    // Keeps going: the failure is logged and the worktree goes.
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "hooks": hooks(true) })).await;
    call(&k, "worktrees.remove", json!({ "projectId": pid, "path": wt })).await;
    assert!(!wtp.exists());
}
