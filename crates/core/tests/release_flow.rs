//! Drives the full release flow through the RPC surface on a throwaway repo.

use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

fn sh(dir: &std::path::Path, args: &[&str]) {
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
async fn release_flow() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    std::fs::create_dir(&repo).unwrap();
    sh(&repo, &["init", "-q", "-b", "main"]);
    sh(&repo, &["config", "user.email", "t@example.com"]);
    sh(&repo, &["config", "user.name", "Test"]);
    sh(&repo, &["config", "commit.gpgsign", "false"]);
    sh(&repo, &["config", "tag.gpgsign", "false"]);
    std::fs::write(repo.join("README.md"), "# atlas\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "chore: init"]);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    call(&k, "releases.create", json!({ "projectId": pid, "version": "2.4.0", "kind": "next" })).await;

    // Explicit branch name: no AI needed.
    let item = call(
        &k,
        "items.create",
        json!({ "projectId": pid, "release": "2.4.0", "kind": "feat", "description": "OAuth login", "branchName": "feat/oauth-login", "where": "switch" }),
    )
    .await;
    assert_eq!(item["branch"], "feat/oauth-login");

    std::fs::write(repo.join("oauth.ts"), "export const x = 1;\n").unwrap();
    let wip = call(&k, "workspace.files", json!({ "projectId": pid, "branch": "feat/oauth-login", "mode": "wip" })).await;
    assert_eq!(wip[0]["path"], "oauth.ts");
    assert_eq!(wip[0]["status"], "A");

    call(&k, "workspace.commit", json!({ "projectId": pid, "branch": "feat/oauth-login", "message": "feat(auth): add oauth" })).await;
    let files = call(&k, "workspace.files", json!({ "projectId": pid, "branch": "feat/oauth-login", "mode": "branch" })).await;
    assert_eq!(files.as_array().unwrap().len(), 1);
    let diff = call(&k, "workspace.diff", json!({ "projectId": pid, "branch": "feat/oauth-login", "mode": "branch", "path": "oauth.ts" })).await;
    assert_eq!(diff[0]["lines"][0]["kind"], "+");

    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let rel = &ov["releases"][0];
    assert_eq!(rel["version"], "2.4.0");
    assert_eq!(rel["items"][0]["name"], "feat/oauth-login");
    assert_eq!(rel["items"][0]["ahead"], 1);

    // Merge the feature into the release, then ship.
    sh(&repo, &["switch", "-q", "release/2.4.0"]);
    sh(&repo, &["merge", "-q", "--no-ff", "-m", "Merge feat/oauth-login", "feat/oauth-login"]);
    sh(&repo, &["switch", "-q", "feat/oauth-login"]);
    let shipped = call(&k, "releases.ship", json!({ "projectId": pid, "version": "2.4.0" })).await;
    assert_eq!(shipped["tag"], "v2.4.0");
    let out = Command::new("git").current_dir(&repo).args(["rev-parse", "main", "release/2.4.0"]).output().unwrap();
    let shas: Vec<&str> = std::str::from_utf8(&out.stdout).unwrap().lines().collect();
    assert_eq!(shas[0], shas[1], "main fast-forwarded to the release");

    // Worktree for a hotfix branch.
    call(&k, "releases.create", json!({ "projectId": pid, "version": "2.4.1", "kind": "hotfix" })).await;
    let wt = call(
        &k,
        "items.create",
        json!({ "projectId": pid, "release": "2.4.1", "kind": "fix", "description": "rate limit", "branchName": "fix/rate-limit", "where": "worktree" }),
    )
    .await;
    let path = wt["worktree"].as_str().unwrap().to_string();
    assert!(std::path::Path::new(&path).exists());
    let list = call(&k, "worktrees.list", json!({})).await;
    assert!(list.as_array().unwrap().iter().any(|w| w["path"] == path.as_str()));
    call(&k, "worktrees.remove", json!({ "projectId": pid, "path": path })).await;

    let a = call(&k, "analytics.get", json!({ "projectId": pid, "days": 30 })).await;
    assert_eq!(a["releases"][0]["version"], "v2.4.0");
}
