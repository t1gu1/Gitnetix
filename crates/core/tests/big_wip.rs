//! Thousands of untracked files (an unignored node_modules) all get listed, without their lines counted.

use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Event, Gitnetix};
use tokio::sync::broadcast::error::TryRecvError;
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

#[tokio::test]
async fn many_modified_files_list_uncounted() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    let file = |i: usize| repo.join(format!("src/f{i}.js"));
    for i in 0..2001 {
        std::fs::write(file(i), "x\n").unwrap();
    }
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "init"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let wip = || call(&k, "workspace.files", json!({ "projectId": pid, "branch": "main", "mode": "wip" }));
    let additions = |v: &Value| v.as_array().unwrap().iter().map(|f| f["additions"].as_u64().unwrap()).collect::<Vec<_>>();

    // Up to the limit every edit is counted.
    for i in 0..2000 {
        std::fs::write(file(i), "x\ny\n").unwrap();
    }
    assert!(additions(&wip().await).iter().all(|&a| a == 1));

    // One more and that side shows none, whichever side it is.
    std::fs::write(file(2000), "x\ny\n").unwrap();
    let files = wip().await;
    assert_eq!(files.as_array().unwrap().len(), 2001);
    assert!(additions(&files).iter().all(|&a| a == 0));
    call(&k, "workspace.stage", json!({ "projectId": pid, "branch": "main" })).await;
    assert!(additions(&wip().await).iter().all(|&a| a == 0));
}

#[tokio::test]
async fn bulk_actions_take_more_paths_than_a_command_line_holds() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let long = "x".repeat(200);
    std::fs::create_dir_all(repo.join(format!("t/{long}"))).unwrap();
    std::fs::create_dir_all(repo.join(format!("u/{long}"))).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    // ~410-byte paths: 6,000 tracked make 2.5 MB, 7,000 in all 2.9 MB, past macOS's 1 MB and Linux's 2 MB.
    let name = |dir: &str, i: usize| repo.join(format!("{dir}/{long}/{long}{i:05}.txt"));
    for i in 0..6_000 {
        std::fs::write(name("t", i), "one\n").unwrap();
    }
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "init"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let wip = || call(&k, "workspace.files", json!({ "projectId": pid, "branch": "main", "mode": "wip" }));
    let side = |v: &Value, staged: bool| v.as_array().unwrap().iter().filter(|f| f["staged"] == staged).map(|f| f["path"].clone()).collect::<Vec<_>>();
    let edit = || {
        for i in 0..6_000 {
            std::fs::write(name("t", i), "two\n").unwrap();
        }
        for i in 0..1_000 {
            std::fs::write(name("u", i), "new\n").unwrap();
        }
    };
    let clean = || {
        assert!((0..6_000).all(|i| std::fs::read_to_string(name("t", i)).unwrap() == "one\n"));
        assert!((0..1_000).all(|i| !name("u", i).exists()));
    };

    // Stage every file by name, as a folder action does, then unstage the whole side.
    edit();
    let paths = side(&wip().await, false);
    assert_eq!(paths.len(), 7_000);
    call(&k, "workspace.stage", json!({ "projectId": pid, "branch": "main", "paths": paths })).await;
    assert_eq!(side(&wip().await, true), paths);
    call(&k, "workspace.unstage", json!({ "projectId": pid, "branch": "main" })).await;
    let w = wip().await;
    assert!(side(&w, true).is_empty());
    assert_eq!(side(&w, false), paths);

    // Discarding a whole side names every file too, and tells the UI how far it has got.
    let mut rx = k.subscribe();
    call(&k, "workspace.discard", json!({ "projectId": pid, "branch": "main", "staged": false })).await;
    let mut steps = Vec::new();
    loop {
        match rx.try_recv() {
            Ok(Event::FilesProgress { done, total, .. }) => steps.push((done, total)),
            Ok(_) | Err(TryRecvError::Lagged(_)) => {}
            Err(_) => break,
        }
    }
    assert_eq!(steps.len(), 7, "{steps:?}");
    assert_eq!(steps.last(), Some(&(7_000, 7_000)));
    clean();
    assert!(wip().await.as_array().unwrap().is_empty());

    edit();
    call(&k, "workspace.stage", json!({ "projectId": pid, "branch": "main" })).await;
    call(&k, "workspace.discard", json!({ "projectId": pid, "branch": "main", "staged": true })).await;
    clean();
    assert!(wip().await.as_array().unwrap().is_empty());
}
