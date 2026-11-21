//! The release notes page lists a range's changes: each merged branch with its commits, and each commit
//! made on the range's own line.

use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::json;

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

fn commit(dir: &Path, file: &str, msg: &str) {
    std::fs::write(dir.join(file), msg).unwrap();
    sh(dir, &["add", "."]);
    sh(dir, &["commit", "-qm", msg]);
}

#[tokio::test]
async fn merged_branches_and_direct_commits_are_one_change_each() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    sh(&repo, &["init", "-q", "-b", "main"]);
    for args in [&["config", "user.email", "t@example.com"][..], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    commit(&repo, "a.txt", "init");
    sh(&repo, &["tag", "v1.0.0"]);
    sh(&repo, &["checkout", "-qb", "reader"]);
    commit(&repo, "b.txt", "feat(tickets): add the reader ACME-142");
    commit(&repo, "c.txt", "chore: tidy the reader");
    sh(&repo, &["checkout", "-q", "main"]);
    sh(&repo, &["merge", "-q", "--no-ff", "reader", "-m", "Merge branch 'reader'"]);
    commit(&repo, "d.txt", "fix: retry a dropped push");
    commit(&repo, "e.txt", "Bump the toolchain (#42)");

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let r = rpc::call(&k, "notes.range", json!({ "projectId": pid, "from": "v1.0.0", "to": "main" })).await.unwrap();

    assert_eq!(r["commits"], 5);
    let items = r["items"].as_array().unwrap();
    let rows: Vec<(String, String, Option<String>, u64)> = items
        .iter()
        .map(|i| (i["kind"].as_str().unwrap().into(), i["title"].as_str().unwrap().into(), i["pr"].as_str().map(String::from), i["commits"].as_u64().unwrap()))
        .collect();
    assert_eq!(
        rows,
        vec![
            ("internal".into(), "Bump the toolchain".into(), Some("#42".into()), 1),
            ("fix".into(), "fix: retry a dropped push".into(), None, 1),
            // An untyped merge takes the strongest type of what it merged, and all its commits.
            ("feat".into(), "reader".into(), None, 3),
        ]
    );
    assert_eq!(items[2]["tickets"], json!(["ACME-142"]));
    assert_eq!(items[0]["id"].as_str().unwrap().len(), 40);
}
