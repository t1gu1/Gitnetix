//! Picked lines of a file get staged or unstaged from its diff; the rest stay on their side.

use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

fn sh(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    String::from_utf8(Command::new("git").current_dir(dir).args(args).output().unwrap().stdout).unwrap()
}

async fn call(k: &Gitnetix, m: &str, p: Value) -> Value {
    match rpc::call(k, m, p).await {
        Ok(v) => v,
        Err(e) => panic!("{m}: {e}"),
    }
}

#[tokio::test]
async fn picked_lines_move_between_sides() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    let lines = |edit: &[(usize, &str)]| (1..=20).map(|i| edit.iter().find(|e| e.0 == i).map_or(format!("l{i}\n"), |e| format!("{}\n", e.1))).collect::<String>();
    std::fs::write(repo.join("a.txt"), lines(&[])).unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "init"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let lines_call = |method: &'static str, path: &'static str, picks: Value| rpc::call(&k, method, json!({ "projectId": pid, "branch": "main", "path": path, "lines": picks }));
    let sides = |path: &str, v: &Value| -> Vec<(bool, String)> {
        v.as_array().unwrap().iter().filter(|f| f["path"] == path).map(|f| (f["staged"].as_bool().unwrap(), f["status"].as_str().unwrap().to_string())).collect()
    };
    let wip = || call(&k, "workspace.files", json!({ "projectId": pid, "branch": "main", "mode": "wip" }));

    // Two edits far apart: stage the first one only.
    let edited = lines(&[(2, "L2"), (15, "L15")]);
    std::fs::write(repo.join("a.txt"), &edited).unwrap();
    lines_call("workspace.stageLines", "a.txt", json!([{ "kind": "-", "n": 2, "text": "l2" }, { "kind": "+", "n": 2, "text": "L2" }])).await.unwrap();
    assert_eq!(git_out(&repo, &["show", ":a.txt"]), lines(&[(2, "L2")]));
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), edited);
    assert_eq!(sides("a.txt", &wip().await), [(true, "M".to_string()), (false, "M".to_string())]);

    // A pick whose line changed since the diff was shown is refused.
    let err = lines_call("workspace.stageLines", "a.txt", json!([{ "kind": "+", "n": 15, "text": "L15 before an edit" }])).await.unwrap_err();
    assert!(err.to_string().contains("changed since"), "{err}");

    // Unstaging the added line only keeps the removal staged.
    lines_call("workspace.unstageLines", "a.txt", json!([{ "kind": "+", "n": 2, "text": "L2" }])).await.unwrap();
    assert_eq!(git_out(&repo, &["show", ":a.txt"]), lines(&[]).replace("l2\n", ""));

    // Part of an untracked file gets staged as a new file; unstaging all of it leaves it untracked again.
    std::fs::write(repo.join("new.txt"), "x\ny\nz\n").unwrap();
    lines_call("workspace.stageLines", "new.txt", json!([{ "kind": "+", "n": 1, "text": "x" }, { "kind": "+", "n": 3, "text": "z" }])).await.unwrap();
    assert_eq!(git_out(&repo, &["show", ":new.txt"]), "x\nz\n");
    assert_eq!(sides("new.txt", &wip().await), [(true, "A".to_string()), (false, "M".to_string())]);
    lines_call("workspace.unstageLines", "new.txt", json!([{ "kind": "+", "n": 1, "text": "x" }, { "kind": "+", "n": 2, "text": "z" }])).await.unwrap();
    assert_eq!(git_out(&repo, &["status", "--porcelain", "--", "new.txt"]), "?? new.txt\n");
    assert_eq!(std::fs::read_to_string(repo.join("new.txt")).unwrap(), "x\ny\nz\n");

    // Discarding unstaged lines puts them back to their staged version in the working tree; the index stays.
    let index = git_out(&repo, &["show", ":a.txt"]);
    lines_call("workspace.discardLines", "a.txt", json!([{ "kind": "-", "n": 14, "text": "l15" }, { "kind": "+", "n": 15, "text": "L15" }])).await.unwrap();
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), lines(&[(2, "L2")]));
    assert_eq!(git_out(&repo, &["show", ":a.txt"]), index);
    // An untracked file left with none of its lines is deleted.
    lines_call("workspace.discardLines", "new.txt", json!([{ "kind": "+", "n": 2, "text": "y" }])).await.unwrap();
    assert_eq!(std::fs::read_to_string(repo.join("new.txt")).unwrap(), "x\nz\n");
    lines_call("workspace.discardLines", "new.txt", json!([{ "kind": "+", "n": 1, "text": "x" }, { "kind": "+", "n": 2, "text": "z" }])).await.unwrap();
    assert!(!repo.join("new.txt").exists());
}
