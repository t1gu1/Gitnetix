//! Submodule manager through the RPC surface, on throwaway repos.

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

fn init_repo(repo: &Path, file: &str) {
    std::fs::create_dir_all(repo).unwrap();
    sh(repo, &["init", "-q", "-b", "main"]);
    sh(repo, &["config", "user.email", "t@example.com"]);
    sh(repo, &["config", "user.name", "Test"]);
    sh(repo, &["config", "commit.gpgsign", "false"]);
    commit_file(repo, file, "1\n");
}

fn commit_file(repo: &Path, path: &str, body: &str) {
    std::fs::write(repo.join(path), body).unwrap();
    sh(repo, &["add", "."]);
    sh(repo, &["commit", "-qm", &format!("edit {path}")]);
}

#[tokio::test]
async fn submodule_manager() {
    // Local paths as submodule URLs: git refuses the file transport for submodules by default.
    std::env::set_var("GIT_CONFIG_COUNT", "1");
    std::env::set_var("GIT_CONFIG_KEY_0", "protocol.file.allow");
    std::env::set_var("GIT_CONFIG_VALUE_0", "always");

    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("ui-kit");
    let app = tmp.path().join("app");
    init_repo(&lib, "kit.txt");
    init_repo(&app, "README.md");

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [app.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    assert_eq!(call(&k, "submodules.list", json!({ "projectId": pid })).await, json!([]));

    // Added under the URL's name, cloned, pin staged.
    call(&k, "submodules.add", json!({ "projectId": pid, "url": lib.to_string_lossy() })).await;
    let list = call(&k, "submodules.list", json!({ "projectId": pid })).await;
    let s = &list[0];
    assert_eq!(s["path"], "ui-kit");
    assert_eq!(s["state"], "clean");
    assert_eq!(s["staged"], true);
    assert_eq!(s["recorded"], s["head"]);
    assert_eq!(s["upstream"], "origin/main");
    assert_eq!(s["urlDrift"], false);
    assert_eq!(s["webUrl"], Value::Null);
    sh(&app, &["commit", "-qm", "add ui-kit"]);

    // Same folder twice is refused before git runs.
    assert!(rpc::call(&k, "submodules.add", json!({ "projectId": pid, "url": lib.to_string_lossy() })).await.is_err());
    // Paths must stay inside the project.
    assert!(rpc::call(&k, "submodules.update", json!({ "projectId": pid, "path": "../ui-kit" })).await.is_err());

    // New work upstream shows once fetched, and `remote` moves onto it.
    commit_file(&lib, "kit.txt", "2\n");
    call(&k, "submodules.fetch", json!({ "projectId": pid })).await;
    let s = call(&k, "submodules.list", json!({ "projectId": pid })).await[0].clone();
    assert_eq!(s["staged"], false);
    assert_eq!(s["upstreamBehind"], 1);

    call(&k, "submodules.update", json!({ "projectId": pid, "path": "ui-kit", "remote": true })).await;
    let s = call(&k, "submodules.list", json!({ "projectId": pid })).await[0].clone();
    assert_eq!(s["state"], "moved");
    assert_eq!(s["ahead"], 1);
    assert_eq!(s["upstreamBehind"], 0);

    // Pin it: clean again, the new pointer staged.
    call(&k, "submodules.stage", json!({ "projectId": pid, "path": "ui-kit" })).await;
    let s = call(&k, "submodules.list", json!({ "projectId": pid })).await[0].clone();
    assert_eq!(s["state"], "clean");
    assert_eq!(s["staged"], true);
    sh(&app, &["commit", "-qm", "bump ui-kit"]);

    // Uncommitted work inside is counted.
    std::fs::write(app.join("ui-kit/new.txt"), "x").unwrap();
    assert_eq!(call(&k, "submodules.list", json!({ "projectId": pid })).await[0]["dirty"], 1);
    std::fs::remove_file(app.join("ui-kit/new.txt")).unwrap();

    // Tracked branch lands in .gitmodules; empty goes back to the remote's default.
    call(&k, "submodules.set", json!({ "projectId": pid, "path": "ui-kit", "branch": "main" })).await;
    assert_eq!(call(&k, "submodules.list", json!({ "projectId": pid })).await[0]["branch"], "main");
    call(&k, "submodules.set", json!({ "projectId": pid, "path": "ui-kit", "branch": "" })).await;
    assert_eq!(call(&k, "submodules.list", json!({ "projectId": pid })).await[0]["branch"], Value::Null);
    sh(&app, &["checkout", "-q", "--", ".gitmodules"]);

    // A fresh clone has it declared but empty until "update all".
    let clone = tmp.path().join("clone");
    sh(tmp.path(), &["clone", "-q", &app.to_string_lossy(), &clone.to_string_lossy()]);
    let added = call(&k, "projects.add", json!({ "paths": [clone.to_string_lossy()] })).await;
    let cid = added.as_array().unwrap().iter().find(|p| p["path"].as_str().unwrap().ends_with("clone")).unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(call(&k, "submodules.list", json!({ "projectId": cid })).await[0]["state"], "uninitialized");
    call(&k, "submodules.update", json!({ "projectId": cid })).await;
    let s = call(&k, "submodules.list", json!({ "projectId": cid })).await[0].clone();
    assert_eq!(s["state"], "clean");
    assert!(clone.join("ui-kit/kit.txt").exists());

    // Removal leaves nothing behind but a staged change.
    call(&k, "submodules.remove", json!({ "projectId": pid, "path": "ui-kit" })).await;
    assert_eq!(call(&k, "submodules.list", json!({ "projectId": pid })).await, json!([]));
    assert!(!app.join("ui-kit").exists());
    assert!(!app.join(".git/modules/ui-kit").exists());
}

#[tokio::test]
async fn worktree_gets_submodules() {
    std::env::set_var("GIT_CONFIG_COUNT", "1");
    std::env::set_var("GIT_CONFIG_KEY_0", "protocol.file.allow");
    std::env::set_var("GIT_CONFIG_VALUE_0", "always");

    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("ui-kit");
    let app = tmp.path().join("app");
    init_repo(&lib, "kit.txt");
    init_repo(&app, "README.md");
    sh(&app, &["submodule", "add", "-q", &lib.to_string_lossy(), "ui-kit"]);
    sh(&app, &["commit", "-qm", "add ui-kit"]);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let pid = call(&k, "projects.add", json!({ "paths": [app.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string();

    // A worktree gets its submodules cloned, and a clean one still removes without force.
    let wt = call(&k, "worktrees.create", json!({ "projectId": pid, "branch": "feat/sub" })).await["path"].as_str().unwrap().to_string();
    assert!(Path::new(&wt).join("ui-kit/kit.txt").exists());
    call(&k, "worktrees.remove", json!({ "projectId": pid, "path": wt })).await;
    assert!(!Path::new(&wt).exists());

    // Commits only in the worktree's submodule clone would be lost: refused unless forced.
    let wt = call(&k, "worktrees.create", json!({ "projectId": pid, "branch": "feat/sub2" })).await["path"].as_str().unwrap().to_string();
    let id = ["-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
    std::fs::write(Path::new(&wt).join("ui-kit/kit.txt"), "3\n").unwrap();
    sh(&Path::new(&wt).join("ui-kit"), &[&id[..], &["commit", "-qam", "local"]].concat());
    sh(Path::new(&wt), &[&id[..], &["commit", "-qam", "bump"]].concat());
    let err = rpc::call(&k, "worktrees.remove", json!({ "projectId": pid, "path": wt })).await.unwrap_err().to_string();
    assert!(err.contains("not pushed"), "{err}");
    call(&k, "worktrees.remove", json!({ "projectId": pid, "path": wt, "force": true })).await;
    assert!(!Path::new(&wt).exists());
}
