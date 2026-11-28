//! Worktree files: ignored files copied or linked from the main checkout into each new worktree, set for every project and per project.

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

fn symlink(target: &Path, at: &Path, dir: bool) {
    #[cfg(unix)]
    let _ = dir;
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, at).unwrap();
    #[cfg(windows)]
    if dir { std::os::windows::fs::symlink_dir(target, at).unwrap() } else { std::os::windows::fs::symlink_file(target, at).unwrap() }
}

#[tokio::test]
async fn listed_files_that_are_links_in_the_main_checkout_reach_new_worktrees() {
    let tmp = tempfile::tempdir().unwrap();
    let app = tmp.path().join("app");
    let (outside, out_graph) = (tmp.path().join("claude-shared"), tmp.path().join("graph-shared"));
    for d in [&app, &outside, &out_graph] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(outside.join("settings.json"), "{\"hooks\":{}}").unwrap();
    std::fs::write(out_graph.join("graph.json"), "{}").unwrap();
    sh(&app, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.email", "t@example.com"), ("user.name", "Test"), ("commit.gpgsign", "false"), ("core.autocrlf", "false"), ("core.longpaths", "true")] {
        sh(&app, &["config", k, v]);
    }
    std::fs::write(app.join(".gitignore"), ".claude/settings.local.json\ngraphify-out\ngraph/\n").unwrap();
    sh(&app, &["add", "."]);
    sh(&app, &["commit", "-qm", "init"]);
    // Listed paths that are links themselves (a file, a folder), and a relative link inside a listed folder.
    std::fs::create_dir_all(app.join(".claude")).unwrap();
    symlink(&outside.join("settings.json"), &app.join(".claude/settings.local.json"), false);
    symlink(&out_graph, &app.join("graphify-out"), true);
    std::fs::create_dir_all(app.join("graph")).unwrap();
    std::fs::write(app.join("graph/graph.json"), "main").unwrap();
    symlink(Path::new("graph.json"), &app.join("graph/latest.json"), false);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let pid = call(&k, "projects.add", json!({ "paths": [app.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string();
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "worktreeFiles": ["graph/"] })).await;
    let wt = call(&k, "worktrees.create", json!({ "projectId": pid, "branch": "feat/x" })).await["path"].as_str().unwrap().to_string();
    let wt = Path::new(&wt);
    assert_eq!(std::fs::read_to_string(wt.join(".claude/settings.local.json")).unwrap(), "{\"hooks\":{}}", "the linked settings file");
    assert_eq!(std::fs::read_to_string(wt.join("graphify-out/graph.json")).unwrap(), "{}", "the linked folder");
    // The relative link points into the worktree's copy, not back at the main checkout.
    assert_eq!(std::fs::read_link(wt.join("graph/latest.json")).unwrap(), Path::new("graph.json"));
    std::fs::write(wt.join("graph/graph.json"), "worktree").unwrap();
    assert_eq!(std::fs::read_to_string(wt.join("graph/latest.json")).unwrap(), "worktree");
}

#[cfg(unix)]
#[tokio::test]
async fn files_are_never_copied_through_a_link_the_branch_holds() {
    let tmp = tempfile::tempdir().unwrap();
    let app = tmp.path().join("linked-app");
    let outside = tmp.path().join("outside");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    sh(&app, &["init", "-q", "-b", "main"]);
    sh(&app, &["config", "user.email", "t@example.com"]);
    sh(&app, &["config", "user.name", "Test"]);
    sh(&app, &["config", "commit.gpgsign", "false"]);
    std::fs::write(app.join(".gitignore"), ".env\n.claude/settings.local.json\n").unwrap();
    sh(&app, &["add", "."]);
    sh(&app, &["commit", "-qm", "init"]);
    // A branch tracking `.env` as a link to a file in the checkout, and `.claude` as a link to a folder outside it.
    sh(&app, &["switch", "-q", "-c", "evil"]);
    std::os::unix::fs::symlink("docs/notes.md", app.join(".env")).unwrap();
    std::os::unix::fs::symlink(&outside, app.join(".claude")).unwrap();
    sh(&app, &["add", "-f", ".env", ".claude"]);
    sh(&app, &["commit", "-qm", "links"]);
    sh(&app, &["switch", "-q", "main"]);
    // The main checkout's own, copied into new worktrees by default.
    std::fs::write(app.join(".env"), "SECRET=1\n").unwrap();
    std::fs::create_dir_all(app.join(".claude")).unwrap();
    std::fs::write(app.join(".claude/settings.local.json"), "{}").unwrap();

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let pid = call(&k, "projects.add", json!({ "paths": [app.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string();
    let wt = call(&k, "worktrees.create", json!({ "projectId": pid, "branch": "evil" })).await["path"].as_str().unwrap().to_string();
    let wt = Path::new(&wt);
    assert!(!wt.join("docs/notes.md").exists(), "the secret went through the .env link");
    assert!(!outside.join("settings.local.json").exists(), "a file went through the .claude link");
    assert!(wt.join(".env").symlink_metadata().unwrap().file_type().is_symlink(), "the branch's own link stays as it is");
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
    sh(&app, &["config", "core.autocrlf", "false"]);
    sh(&app, &["config", "core.longpaths", "true"]);
    std::fs::write(app.join(".gitignore"), "graph/\n.env\ntarget/\nshared/\nlocal.json\n").unwrap();
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
    std::fs::create_dir_all(app.join("shared")).unwrap();
    std::fs::write(app.join("shared/s.txt"), "s").unwrap();
    std::fs::write(app.join("local.json"), "1").unwrap();

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    assert_eq!(call(&k, "config.get", json!({})).await["worktreeFiles"], json!(["graphify-out/", ".claude/settings.local.json", ".env", ".env.local", ".env.example", ".env.example.local"]), "new profile defaults");
    assert_eq!(call(&k, "config.get", json!({})).await["worktreeLinks"], json!([]), "no link by default");
    let pid = call(&k, "projects.add", json!({ "paths": [app.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string();
    for bad in ["../outside", "/etc"] {
        let err = rpc::call(&k, "projects.setPrefs", json!({ "projectId": pid, "worktreeFiles": [bad] })).await.unwrap_err();
        assert!(err.to_string().contains("not a path inside the project"), "{err}");
        let err = rpc::call(&k, "worktrees.setFiles", json!({ "files": [bad] })).await.unwrap_err();
        assert!(err.to_string().contains("not a path inside the project"), "{err}");
        let err = rpc::call(&k, "worktrees.setFiles", json!({ "links": [bad] })).await.unwrap_err();
        assert!(err.to_string().contains("not a path inside the project"), "{err}");
        let err = rpc::call(&k, "projects.setPrefs", json!({ "projectId": pid, "worktreeLinks": [bad] })).await.unwrap_err();
        assert!(err.to_string().contains("not a path inside the project"), "{err}");
    }
    // Both lists apply; a path in both is copied once.
    call(&k, "worktrees.setFiles", json!({ "files": ["graph/", ".env"] })).await;
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "worktreeFiles": [".env", "README.md", "missing"] })).await;
    // Links: one for every project, one for this project that is also copied (linked wins).
    call(&k, "worktrees.setFiles", json!({ "links": ["shared", "local.json"] })).await;
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "worktreeLinks": ["graph/"] })).await;
    assert_eq!(call(&k, "config.get", json!({})).await["worktreeFiles"], json!(["graph/", ".env"]), "setting links leaves the copied files");

    let opened = call(&k, "worktrees.create", json!({ "projectId": pid, "branch": "feat/x" })).await["path"].as_str().unwrap().to_string();
    let new_item = call(&k, "items.create", json!({ "projectId": pid, "release": "", "kind": "feat", "description": "y", "branchName": "feat/y", "where": "worktree" })).await["worktree"]
        .as_str()
        .unwrap()
        .to_string();
    for wt in [&opened, &new_item] {
        let wt = Path::new(wt);
        assert_eq!(std::fs::read_to_string(wt.join("graph/graph.json")).unwrap(), "{}");
        assert_eq!(std::fs::read_to_string(wt.join("graph/cache/a.json")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "KEY=1\n");
        assert!(!wt.join("target").exists(), "not listed");
        // Tracked: the branch's own version, not the main checkout's edit.
        assert_eq!(std::fs::read_to_string(wt.join("README.md")).unwrap(), "tracked\n");
        // A symlink, or a hard link on Windows without Developer Mode: either way one file.
        std::fs::write(wt.join("local.json"), wt.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(std::fs::read_to_string(app.join("local.json")).unwrap(), wt.to_string_lossy());
        for linked in ["graph", "shared"] {
            assert!(std::fs::symlink_metadata(wt.join(linked)).unwrap().file_type().is_symlink(), "{linked} is linked");
        }
        assert!(!std::fs::symlink_metadata(wt.join(".env")).unwrap().file_type().is_symlink(), ".env is copied");
        // Git's `graph/` pattern doesn't match a link: excluded, so the worktree has nothing to commit.
        let status = Command::new("git").current_dir(wt).args(["status", "--porcelain"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&status.stdout), "", "links are ignored");
    }
    // Two worktrees linked the same paths: each is in the shared info/exclude once, not once per worktree.
    let exclude = Command::new("git").current_dir(&app).args(["rev-parse", "--git-path", "info/exclude"]).output().unwrap();
    let exclude = std::fs::read_to_string(app.join(String::from_utf8_lossy(&exclude.stdout).trim())).unwrap();
    let mut lines: Vec<&str> = exclude.lines().filter(|l| l.starts_with('/')).collect();
    let all = lines.len();
    lines.sort_unstable();
    lines.dedup();
    assert!(all > 0 && lines.len() == all, "each link once: {exclude}");
    // Written in a worktree, seen in the main checkout.
    std::fs::write(Path::new(&opened).join("shared/new.txt"), "n").unwrap();
    assert_eq!(std::fs::read_to_string(app.join("shared/new.txt")).unwrap(), "n");
    // Removing a worktree removes its links, never what they point to.
    call(&k, "worktrees.remove", json!({ "projectId": pid, "path": opened })).await;
    assert!(!Path::new(&opened).exists());
    assert_eq!(std::fs::read_to_string(app.join("graph/cache/a.json")).unwrap(), "a");
    assert_eq!(std::fs::read_to_string(app.join("shared/s.txt")).unwrap(), "s");
}
