//! Blame and file history: one file's commits across a rename, and who last changed each of its lines.

use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

async fn call(k: &Gitnetix, m: &str, p: Value) -> Value {
    match rpc::call(k, m, p).await {
        Ok(v) => v,
        Err(e) => panic!("{m}: {e}"),
    }
}

fn strs(v: &Value, key: &str) -> Vec<String> {
    v.as_array().unwrap().iter().map(|x| x[key].as_str().unwrap_or_default().to_string()).collect()
}

/// Each line's commit, from a blame's runs.
fn line_shas(b: &Value) -> Vec<String> {
    b["runs"].as_array().unwrap().iter().flat_map(|r| std::iter::repeat_n(r[0].as_str().unwrap().to_string(), r[1].as_u64().unwrap() as usize)).collect()
}

#[tokio::test]
async fn history_follows_renames_and_blame_names_each_line() {
    let tmp = tempfile::tempdir().unwrap();
    let app = tmp.path().join("app");
    std::fs::create_dir_all(&app).unwrap();
    sh(&app, &["init", "-q", "-b", "main"]);
    sh(&app, &["config", "user.email", "ann@example.com"]);
    sh(&app, &["config", "user.name", "Ann"]);
    sh(&app, &["config", "commit.gpgsign", "false"]);
    sh(&app, &["config", "core.autocrlf", "false"]);
    std::fs::write(app.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    sh(&app, &["add", "."]);
    sh(&app, &["commit", "-qm", "Add a"]);
    let c1 = sh(&app, &["rev-parse", "HEAD"]);
    std::fs::write(app.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
    sh(&app, &["-c", "user.name=Bob", "-c", "user.email=bob@example.com", "commit", "-qam", "Shout two"]);
    let c2 = sh(&app, &["rev-parse", "HEAD"]);
    sh(&app, &["mv", "a.txt", "b.txt"]);
    sh(&app, &["commit", "-qm", "Rename a to b"]);
    let c3 = sh(&app, &["rev-parse", "HEAD"]);
    std::fs::write(app.join("b.txt"), "one\nTWO\nthree\nfour\nfive\n").unwrap();
    std::fs::write(app.join("other.txt"), "x\n").unwrap();
    sh(&app, &["add", "."]);
    sh(&app, &["commit", "-qm", "Add five"]);
    let c4 = sh(&app, &["rev-parse", "HEAD"]);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let pid = call(&k, "projects.add", json!({ "paths": [app.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string();

    let log = call(&k, "workspace.fileHistory", json!({ "projectId": pid, "branch": "main", "path": "b.txt" })).await;
    assert_eq!(strs(&log, "sha"), [&*c4, &*c3, &*c2, &*c1]);
    assert_eq!(strs(&log, "path"), ["b.txt", "b.txt", "a.txt", "a.txt"], "older commits knew it as a.txt");
    assert_eq!(strs(&log, "status"), ["M", "R", "M", "A"]);
    assert_eq!(strs(&log, "from"), ["", "a.txt", "", ""]);
    assert_eq!((log[0]["additions"].as_u64(), log[0]["deletions"].as_u64()), (Some(1), Some(0)), "this file's lines only");
    assert_eq!((log[2]["author"].as_str(), log[2]["subject"].as_str()), (Some("Bob"), Some("Shout two")));
    // The rename's diff pairs both names: nothing changed but the name. Without the old one, all of it reads as added.
    let renamed = call(&k, "workspace.diff", json!({ "projectId": pid, "branch": "main", "path": "b.txt", "commit": c3, "from": "a.txt" })).await;
    assert_eq!(renamed, json!([]));
    let added = call(&k, "workspace.diff", json!({ "projectId": pid, "branch": "main", "path": "b.txt", "commit": c3 })).await;
    assert_eq!(added[0]["lines"].as_array().unwrap().len(), 4);
    let first = call(&k, "workspace.fileHistory", json!({ "projectId": pid, "branch": "main", "path": "b.txt", "limit": 2 })).await;
    assert_eq!(strs(&first, "sha"), [&*c4, &*c3]);

    let tip = call(&k, "workspace.blame", json!({ "projectId": pid, "branch": "main", "mode": "branch", "path": "b.txt" })).await;
    assert_eq!(tip["lines"], json!(["one", "TWO", "three", "four", "five"]));
    assert_eq!(line_shas(&tip), [&*c1, &*c2, &*c1, &*c2, &*c4], "lines from before the rename keep their commits");
    let bob = tip["commits"].as_array().unwrap().iter().find(|c| c["sha"] == c2.as_str()).unwrap();
    assert_eq!((bob["author"].as_str(), bob["email"].as_str(), bob["subject"].as_str()), (Some("Bob"), Some("bob@example.com"), Some("Shout two")));
    assert!(bob["date"].as_str().unwrap().contains('T'), "ISO date");

    let then = call(&k, "workspace.blame", json!({ "projectId": pid, "branch": "main", "mode": "branch", "path": "a.txt", "commit": c2 })).await;
    assert_eq!(then["lines"], json!(["one", "TWO", "three", "four"]));

    // The checkout's file, uncommitted lines too; the branch view still blames the tip.
    std::fs::write(app.join("b.txt"), "one\nTWO\nthree\nfour\nfive\nsix\n").unwrap();
    std::fs::write(app.join("new.txt"), "fresh\nfile\n").unwrap();
    let zero = "0".repeat(40);
    let wip = call(&k, "workspace.blame", json!({ "projectId": pid, "branch": "main", "mode": "wip", "path": "b.txt" })).await;
    assert_eq!(line_shas(&wip).last(), Some(&zero));
    let branch = call(&k, "workspace.blame", json!({ "projectId": pid, "branch": "main", "mode": "branch", "path": "b.txt" })).await;
    assert_eq!(branch["lines"].as_array().unwrap().len(), 5);
    let fresh = call(&k, "workspace.blame", json!({ "projectId": pid, "branch": "main", "mode": "project", "path": "new.txt" })).await;
    assert_eq!((fresh["lines"].clone(), line_shas(&fresh)), (json!(["fresh", "file"]), vec![zero.clone(), zero.clone()]), "untracked: all uncommitted");

    // Old sides, for removed lines: the commit's parent (none for a root commit), the branch's merge base with its base,
    // HEAD for the staged side, the index for the unstaged one.
    let blame = |p: Value| call(&k, "workspace.blame", p);
    let parent = blame(json!({ "projectId": pid, "branch": "main", "mode": "branch", "path": "a.txt", "commit": c2, "old": true })).await;
    assert_eq!((parent["lines"].clone(), line_shas(&parent)), (json!(["one", "two", "three"]), vec![c1.clone(); 3]));
    let root = blame(json!({ "projectId": pid, "branch": "main", "mode": "branch", "path": "a.txt", "commit": c1, "old": true })).await;
    assert_eq!(root["lines"], json!([]));
    sh(&app, &["branch", "behind", &c3]);
    let base = blame(json!({ "projectId": pid, "branch": "behind", "mode": "branch", "path": "b.txt", "old": true })).await;
    assert_eq!(base["lines"], json!(["one", "TWO", "three", "four"]), "merge base with main: c3");
    sh(&app, &["add", "b.txt"]);
    std::fs::write(app.join("b.txt"), "one\nTWO\nthree\nfour\nfive\nsix\nseven\n").unwrap();
    let side = |staged: bool, old: bool| json!({ "projectId": pid, "branch": "main", "mode": "wip", "path": "b.txt", "staged": staged, "old": old });
    let index = blame(side(true, false)).await;
    assert_eq!(index["lines"].as_array().unwrap().len(), 6, "the staged side's new lines are the index's");
    assert_eq!(line_shas(&index).last(), Some(&zero), "staged, not committed");
    assert_eq!(line_shas(&blame(side(true, true)).await), [&*c1, &*c2, &*c1, &*c2, &*c4], "HEAD");
    assert_eq!(blame(side(false, true)).await, index, "the unstaged side's old lines are the index's");

    for (m, p, err) in [
        ("workspace.blame", json!({ "projectId": pid, "branch": "--output=x", "mode": "branch", "path": "b.txt" }), "not a branch"),
        ("workspace.fileHistory", json!({ "projectId": pid, "branch": "--output=x", "path": "b.txt" }), "not a branch"),
        ("workspace.blame", json!({ "projectId": pid, "branch": "main", "path": "b.txt", "commit": "--all" }), "not a commit id"),
    ] {
        let e = rpc::call(&k, m, p).await.unwrap_err().to_string();
        assert!(e.contains(err), "{m}: {e}");
    }
    assert!(!app.join("x").exists());
}
