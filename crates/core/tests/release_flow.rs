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

fn init_repo(repo: &std::path::Path) {
    std::fs::create_dir(repo).unwrap();
    sh(repo, &["init", "-q", "-b", "main"]);
    sh(repo, &["config", "user.email", "t@example.com"]);
    sh(repo, &["config", "user.name", "Test"]);
    sh(repo, &["config", "commit.gpgsign", "false"]);
    sh(repo, &["config", "tag.gpgsign", "false"]);
    std::fs::write(repo.join("README.md"), "# atlas\n").unwrap();
    sh(repo, &["add", "."]);
    sh(repo, &["commit", "-qm", "chore: init"]);
}

fn rev(repo: &std::path::Path, r: &str) -> String {
    let out = Command::new("git").current_dir(repo).args(["rev-parse", "--verify", "-q", r]).output().unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn commit_file(repo: &std::path::Path, path: &str, body: &str) {
    std::fs::write(repo.join(path), body).unwrap();
    sh(repo, &["add", "."]);
    sh(repo, &["commit", "-qm", &format!("edit {path}")]);
}

#[tokio::test]
async fn release_flow() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);

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

    call(&k, "workspace.commit", json!({ "projectId": pid, "branch": "feat/oauth-login", "message": "feat(auth): add oauth", "all": true })).await;
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
    // The release is not checked out: merged without touching any checkout.
    let merged = call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/oauth-login" })).await;
    assert_eq!(merged["into"], "release/2.4.0");
    assert_eq!(merged["alreadyMerged"], false);
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

#[tokio::test]
async fn merge_and_delete_branches() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    // Unmerged branch: plain delete refuses, force deletes.
    sh(&repo, &["switch", "-qc", "spike"]);
    commit_file(&repo, "spike.txt", "spike\n");
    sh(&repo, &["switch", "-q", "main"]);
    let err = rpc::call(&k, "branches.delete", json!({ "projectId": pid, "branch": "spike" })).await.unwrap_err();
    assert!(err.to_string().contains("not merged into main"), "{err}");
    call(&k, "branches.delete", json!({ "projectId": pid, "branch": "spike", "force": true })).await;
    assert!(rev(&repo, "refs/heads/spike").is_empty());
    assert!(rpc::call(&k, "branches.delete", json!({ "projectId": pid, "branch": "main" })).await.is_err());

    // Base checked out: merge commit in that checkout, then delete.
    sh(&repo, &["switch", "-qc", "feat/a"]);
    commit_file(&repo, "a.txt", "a\n");
    sh(&repo, &["switch", "-q", "main"]);
    let main_before = rev(&repo, "main");
    let m = call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/a", "deleteBranch": true })).await;
    assert_eq!(m["into"], "main");
    assert_eq!(m["deleted"], true);
    assert_eq!(rev(&repo, "main^1"), main_before);
    assert!(repo.join("a.txt").exists(), "working tree updated");
    assert!(rev(&repo, "refs/heads/feat/a").is_empty());

    // Conflicting merge stops before changing anything.
    sh(&repo, &["switch", "-qc", "feat/b"]);
    commit_file(&repo, "README.md", "# b\n");
    sh(&repo, &["switch", "-q", "main"]);
    commit_file(&repo, "README.md", "# main\n");
    let main_before = rev(&repo, "main");
    let err = rpc::call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/b" })).await.unwrap_err();
    assert!(err.to_string().contains("README.md"), "{err}");
    assert_eq!(rev(&repo, "main"), main_before);
    assert!(rev(&repo, "refs/heads/feat/b").len() == 40);
}

#[tokio::test]
async fn pull_and_tracking() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
    sh(&repo, &["push", "-q", "-u", "origin", "main"]);
    sh(&repo, &["switch", "-qc", "feat/x"]);
    sh(&repo, &["push", "-q", "-u", "origin", "feat/x"]);
    sh(&repo, &["switch", "-q", "main"]);

    // Someone else pushes to both branches.
    let other = tmp.path().join("other");
    sh(tmp.path(), &["clone", "-q", origin.to_str().unwrap(), other.to_str().unwrap()]);
    sh(&other, &["config", "user.email", "o@example.com"]);
    sh(&other, &["config", "user.name", "Other"]);
    sh(&other, &["config", "commit.gpgsign", "false"]);
    commit_file(&other, "m.txt", "m\n");
    sh(&other, &["switch", "-q", "feat/x"]);
    commit_file(&other, "x.txt", "x\n");
    sh(&other, &["push", "-q", "origin", "main", "feat/x"]);
    sh(&repo, &["fetch", "-q", "origin"]);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let x = &ov["otherBranches"][0];
    assert_eq!(x["name"], "feat/x");
    assert_eq!(x["upstream"], "origin/feat/x");
    assert_eq!(x["upstreamBehind"], 1);
    assert_eq!(x["upstreamAhead"], 0);

    // Not checked out: fetched straight into the ref.
    call(&k, "branches.pull", json!({ "projectId": pid, "branch": "feat/x" })).await;
    assert_eq!(rev(&repo, "feat/x"), rev(&repo, "origin/feat/x"));
    // Checked out: pulled into the working tree.
    call(&k, "branches.pull", json!({ "projectId": pid, "branch": "main" })).await;
    assert!(repo.join("m.txt").exists());

    // feat/x is now behind main by the commit pushed there.
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert_eq!(ov["otherBranches"][0]["behind"], 1);
    assert_eq!(ov["otherBranches"][0]["upstreamBehind"], 0);

    // Diverged both ways: reset drops the local commit and lands on origin's.
    sh(&repo, &["switch", "-q", "feat/x"]);
    commit_file(&repo, "local.txt", "l\n");
    sh(&repo, &["switch", "-q", "main"]);
    commit_file(&other, "x2.txt", "x2\n");
    sh(&other, &["push", "-q", "origin", "feat/x"]);
    sh(&repo, &["fetch", "-q", "origin"]);
    call(&k, "branches.reset", json!({ "projectId": pid, "branch": "feat/x" })).await;
    assert_eq!(rev(&repo, "feat/x"), rev(&repo, "origin/feat/x"));
    // Checked out: the working tree follows, local commit and edits gone.
    commit_file(&repo, "mine.txt", "m\n");
    std::fs::write(repo.join("m.txt"), "edited\n").unwrap();
    call(&k, "branches.reset", json!({ "projectId": pid, "branch": "main" })).await;
    assert_eq!(rev(&repo, "main"), rev(&repo, "origin/main"));
    assert!(!repo.join("mine.txt").exists());
    assert_eq!(std::fs::read_to_string(repo.join("m.txt")).unwrap(), "m\n");
}

#[tokio::test]
async fn release_branch_created_after_add_is_picked_up() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("late");
    init_repo(&repo);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    sh(&repo, &["branch", "release/1.2.0"]);
    sh(&repo, &["branch", "feat/loose"]);
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let open: Vec<&str> = ov["releases"].as_array().unwrap().iter().filter(|r| r["open"] == true).map(|r| r["version"].as_str().unwrap()).collect();
    assert_eq!(open, ["1.2.0"]);
    let others: Vec<&str> = ov["otherBranches"].as_array().unwrap().iter().map(|b| b["name"].as_str().unwrap()).collect();
    assert_eq!(others, ["feat/loose"]);

    // Forgotten releases stay forgotten; their branch shows up as a plain branch.
    call(&k, "releases.delete", json!({ "projectId": pid, "version": "1.2.0" })).await;
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert!(ov["releases"].as_array().unwrap().iter().all(|r| r["open"] == false));
    let others: Vec<&str> = ov["otherBranches"].as_array().unwrap().iter().map(|b| b["name"].as_str().unwrap()).collect();
    assert_eq!(others, ["feat/loose", "release/1.2.0"]);
}

#[tokio::test]
async fn stage_unstage_discard() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    commit_file(&repo, "a.txt", "one\n");

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let side = |v: &Value, staged: bool| -> Vec<String> {
        v.as_array().unwrap().iter().filter(|f| f["staged"] == staged).map(|f| f["path"].as_str().unwrap().to_string()).collect()
    };
    let wip = || call(&k, "workspace.files", json!({ "projectId": pid, "branch": "main", "mode": "wip" }));

    std::fs::write(repo.join("a.txt"), "two\n").unwrap();
    std::fs::write(repo.join("new.txt"), "fresh\n").unwrap();
    let w = wip().await;
    assert_eq!(side(&w, false), vec!["a.txt", "new.txt"]);
    assert!(side(&w, true).is_empty());

    // Nothing staged: committing is refused.
    assert!(rpc::call(&k, "workspace.commit", json!({ "projectId": pid, "branch": "main", "message": "x" })).await.is_err());

    call(&k, "workspace.stage", json!({ "projectId": pid, "branch": "main", "paths": ["a.txt"] })).await;
    std::fs::write(repo.join("a.txt"), "three\n").unwrap();
    let w = wip().await;
    assert_eq!(side(&w, true), vec!["a.txt"]);
    assert_eq!(side(&w, false), vec!["a.txt", "new.txt"]);
    let d = call(&k, "workspace.diff", json!({ "projectId": pid, "branch": "main", "mode": "wip", "path": "a.txt", "staged": true })).await;
    assert!(d[0]["lines"].as_array().unwrap().iter().any(|l| l["text"] == "two"));

    // Discarding the unstaged side keeps what is staged.
    call(&k, "workspace.discard", json!({ "projectId": pid, "branch": "main", "staged": false })).await;
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "two\n");
    assert!(!repo.join("new.txt").exists());

    call(&k, "workspace.unstage", json!({ "projectId": pid, "branch": "main" })).await;
    let w = wip().await;
    assert!(side(&w, true).is_empty());
    assert_eq!(side(&w, false), vec!["a.txt"]);

    // Discarding staged work returns the file to HEAD.
    std::fs::write(repo.join("b.txt"), "bee\n").unwrap();
    call(&k, "workspace.stage", json!({ "projectId": pid, "branch": "main" })).await;
    call(&k, "workspace.discard", json!({ "projectId": pid, "branch": "main", "staged": true, "paths": ["a.txt", "b.txt"] })).await;
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\n");
    assert!(!repo.join("b.txt").exists());
    assert!(wip().await.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn merged_branches_are_flagged() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    // Fresh branch (no commits), unmerged branch, merge-commit and fast-forward merges.
    sh(&repo, &["branch", "fresh"]);
    for b in ["open", "via-merge", "via-ff"] {
        sh(&repo, &["switch", "-qc", b]);
        commit_file(&repo, &format!("{b}.txt"), "x\n");
        sh(&repo, &["switch", "-q", "main"]);
    }
    sh(&repo, &["merge", "-q", "--ff-only", "via-ff"]);
    call(&k, "branches.merge", json!({ "projectId": pid, "branch": "via-merge" })).await;
    sh(&repo, &["branch", "-qf", "fresh", "main"]);

    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let merged = |n: &str| ov["otherBranches"].as_array().unwrap().iter().find(|b| b["name"] == n).unwrap()["merged"].as_bool().unwrap();
    assert!(!merged("fresh"));
    assert!(!merged("open"));
    assert!(merged("via-merge"));
    assert!(merged("via-ff"));
}

#[tokio::test]
async fn branch_tree_parents_remote_and_sync() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("tree");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);

    // dev with its own commit, a feature off dev, a branch that only exists on origin.
    sh(&repo, &["switch", "-qc", "dev"]);
    commit_file(&repo, "dev.txt", "d\n");
    sh(&repo, &["switch", "-qc", "feat/on-dev"]);
    commit_file(&repo, "x.txt", "x\n");
    sh(&repo, &["switch", "-qc", "feat/remote", "main"]);
    commit_file(&repo, "r.txt", "r\n");
    sh(&repo, &["push", "-q", "origin", "main", "feat/remote"]);
    sh(&repo, &["switch", "-q", "main"]);
    sh(&repo, &["branch", "-qD", "feat/remote"]);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    call(&k, "releases.create", json!({ "projectId": pid, "version": "1.0.0", "kind": "next" })).await;

    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let get = |ov: &Value, n: &str| ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == n).cloned().unwrap_or_else(|| panic!("no {n}"));
    assert!(get(&ov, "main")["parent"].is_null());
    assert_eq!(get(&ov, "main")["role"], "trunk");
    assert_eq!(get(&ov, "dev")["parent"], "main");
    assert_eq!(get(&ov, "dev")["role"], "trunk");
    assert_eq!(get(&ov, "release/1.0.0")["role"], "release");
    assert_eq!(get(&ov, "feat/on-dev")["parent"], "dev");
    assert_eq!(get(&ov, "feat/on-dev")["kind"], "feat");
    let r = get(&ov, "feat/remote");
    assert_eq!((r["local"].as_bool(), r["remote"].as_bool(), r["ahead"].as_u64()), (Some(false), Some(true), Some(1)));

    // An origin-only branch can be switched to; git creates the tracking branch.
    call(&k, "workspace.switch", json!({ "projectId": pid, "branch": "feat/remote" })).await;
    sh(&repo, &["switch", "-q", "main"]);

    // Re-target a branch: onto the release attaches it, onto dev makes dev its parent.
    call(&k, "branches.setParent", json!({ "projectId": pid, "branch": "feat/remote", "parent": "release/1.0.0" })).await;
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert_eq!(get(&ov, "feat/remote")["parent"], "release/1.0.0");
    assert_eq!(get(&ov, "feat/remote")["release"], "1.0.0");
    call(&k, "branches.setParent", json!({ "projectId": pid, "branch": "feat/remote", "parent": "dev" })).await;
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert_eq!(get(&ov, "feat/remote")["parent"], "dev");
    assert!(get(&ov, "feat/remote")["release"].is_null());

    // main moves on: the release falls behind, and sync merges main into it.
    commit_file(&repo, "hotfix.txt", "h\n");
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert_eq!(get(&ov, "release/1.0.0")["behind"], 1);
    call(&k, "branches.sync", json!({ "projectId": pid, "branch": "release/1.0.0" })).await;
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert_eq!(get(&ov, "release/1.0.0")["behind"], 0);
    // A fresh branch on main's tip (now a merge parent in the release) is not that merge's work.
    sh(&repo, &["branch", "fix/empty", "main"]);
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert_eq!(get(&ov, "fix/empty")["parent"], "main");
    assert_eq!(get(&ov, "fix/empty")["merged"], false);

    // New branch off dev, no release: dev is where it merges back.
    call(&k, "items.create", json!({ "projectId": pid, "from": "dev", "kind": "fix", "description": "", "branchName": "fix/typo", "where": "switch" })).await;
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert_eq!(get(&ov, "fix/typo")["parent"], "dev");
    assert_eq!(rev(&repo, "fix/typo"), rev(&repo, "dev"));
}

#[tokio::test]
async fn shipped_release_goes_back_under_main() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("ship");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    call(&k, "releases.create", json!({ "projectId": pid, "version": "0.0.1", "kind": "next" })).await;
    // One feature through Gitnetix, one merged by hand with git.
    call(&k, "items.create", json!({ "projectId": pid, "release": "0.0.1", "kind": "feat", "description": "", "branchName": "feat/item", "where": "switch" })).await;
    commit_file(&repo, "item.txt", "i\n");
    call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/item" })).await;
    sh(&repo, &["switch", "-qc", "feat/by-hand", "release/0.0.1"]);
    commit_file(&repo, "hand.txt", "h\n");
    sh(&repo, &["switch", "-q", "release/0.0.1"]);
    sh(&repo, &["merge", "-q", "--no-ff", "--no-edit", "feat/by-hand"]);
    commit_file(&repo, "one.txt", "1\n");
    sh(&repo, &["switch", "-q", "main"]);
    call(&k, "releases.ship", json!({ "projectId": pid, "version": "0.0.1" })).await;
    // A feature that landed in 0.0.1 without being attached through Gitnetix.
    sh(&repo, &["branch", "feat/landed", "release/0.0.1"]);
    call(&k, "releases.create", json!({ "projectId": pid, "version": "0.0.2", "kind": "next" })).await;

    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let get = |n: &str| ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == n).cloned().unwrap();
    assert_eq!(get("release/0.0.1")["parent"], "main");
    assert_eq!(get("release/0.0.1")["role"], "branch");
    assert_eq!(get("release/0.0.1")["shipped"], "0.0.1");
    assert!(get("release/0.0.2")["shipped"].is_null());
    assert_eq!(get("feat/landed")["parent"], "main");
    // What shipped in 0.0.1 stays under it while its branch exists.
    for f in ["feat/item", "feat/by-hand"] {
        assert_eq!(get(f)["parent"], "release/0.0.1", "{f}");
        assert_eq!(get(f)["merged"], true, "{f}");
    }
    assert_eq!(get("release/0.0.2")["role"], "release");
}

#[tokio::test]
async fn merge_and_delete_the_checked_out_branch_switches_to_its_base() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("md");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    sh(&repo, &["switch", "-qc", "feat/here"]);
    commit_file(&repo, "here.txt", "h\n");
    let r = call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/here", "deleteBranch": true })).await;
    assert_eq!((r["into"].as_str(), r["deleted"].as_bool(), r["switched"].as_bool()), (Some("main"), Some(true), Some(true)));
    let head = Command::new("git").current_dir(&repo).args(["branch", "--show-current"]).output().unwrap();
    assert_eq!(String::from_utf8(head.stdout).unwrap().trim(), "main");
    assert!(rev(&repo, "refs/heads/feat/here").is_empty());
    assert!(repo.join("here.txt").exists());
}

#[tokio::test]
async fn origin_only_branches_and_gitflow() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("flow");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);

    // develop and a teammate's feature exist only on origin; develop is the default.
    sh(&repo, &["switch", "-qc", "develop"]);
    commit_file(&repo, "dev.txt", "d\n");
    sh(&repo, &["switch", "-qc", "feat/remote"]);
    commit_file(&repo, "r.txt", "r\n");
    sh(&repo, &["push", "-q", "origin", "main", "develop", "feat/remote"]);
    sh(&repo, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    // A local branch tracking an origin branch of another name.
    sh(&repo, &["switch", "-qc", "myfix", "--track", "origin/feat/remote"]);
    sh(&repo, &["switch", "-q", "main"]);
    sh(&repo, &["branch", "-qD", "develop", "feat/remote"]);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let get = |ov: &Value, n: &str| ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == n).cloned();
    assert_eq!(ov["defaultBranch"], "develop");
    // main is a trunk under develop, never work that can be "merged" and deleted.
    let main = get(&ov, "main").unwrap();
    assert_eq!((main["role"].as_str(), main["merged"].as_bool()), (Some("trunk"), Some(false)));
    // origin/feat/remote is myfix's upstream: listed once, as myfix.
    assert!(get(&ov, "feat/remote").is_none());
    assert!(get(&ov, "myfix").is_some());

    // A branch off origin-only develop: no tracking of develop, and its diff reads origin/develop.
    call(&k, "items.create", json!({ "projectId": pid, "from": "develop", "kind": "feat", "description": "", "branchName": "feat/new", "where": "switch" })).await;
    assert_eq!(rev(&repo, "feat/new@{upstream}"), "");
    commit_file(&repo, "n.txt", "n\n");
    let files = call(&k, "workspace.files", json!({ "projectId": pid, "branch": "feat/new", "mode": "branch" })).await;
    assert_eq!(files.as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect::<Vec<_>>(), ["n.txt"]);
    let diff = call(&k, "workspace.diff", json!({ "projectId": pid, "branch": "feat/new", "mode": "branch", "path": "n.txt" })).await;
    assert_eq!(diff[0]["lines"][0]["kind"], "+");
}

#[tokio::test]
async fn commit_actions() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let root = rev(&repo, "HEAD");

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    sh(&repo, &["switch", "-q", "-c", "feat/a"]);
    commit_file(&repo, "a.txt", "a\n");
    commit_file(&repo, "b.txt", "b\n");
    let a = rev(&repo, "HEAD~1");

    let commits = call(&k, "workspace.commits", json!({ "projectId": pid, "branch": "feat/a" })).await;
    let subjects: Vec<&str> = commits.as_array().unwrap().iter().map(|c| c["subject"].as_str().unwrap()).collect();
    assert_eq!(subjects, ["edit b.txt", "edit a.txt"]);

    // Per-commit files, including the root commit (no parent).
    let files = call(&k, "workspace.files", json!({ "projectId": pid, "branch": "feat/a", "mode": "branch", "commit": a })).await;
    assert_eq!(files[0]["path"], "a.txt");
    let files = call(&k, "workspace.files", json!({ "projectId": pid, "branch": "main", "mode": "branch", "commit": root })).await;
    assert_eq!(files[0]["path"], "README.md");
    assert!(rpc::call(&k, "workspace.files", json!({ "projectId": pid, "branch": "main", "commit": "--output=x" })).await.is_err());

    call(&k, "commits.revert", json!({ "projectId": pid, "branch": "feat/a", "sha": a })).await;
    assert!(!repo.join("a.txt").exists());

    // Cherry-pick onto the checked-out branch.
    sh(&repo, &["switch", "-q", "main"]);
    call(&k, "commits.cherryPick", json!({ "projectId": pid, "onto": "main", "sha": a })).await;
    assert!(repo.join("a.txt").exists());

    call(&k, "commits.reset", json!({ "projectId": pid, "branch": "main", "sha": root, "mode": "soft" })).await;
    assert_eq!(rev(&repo, "HEAD"), root);
    assert!(repo.join("a.txt").exists(), "soft keeps the changes");
    call(&k, "commits.reset", json!({ "projectId": pid, "branch": "main", "sha": root, "mode": "hard" })).await;
    assert!(!repo.join("a.txt").exists(), "hard drops them");
    assert!(rpc::call(&k, "commits.reset", json!({ "projectId": pid, "branch": "main", "sha": root, "mode": "keep" })).await.is_err());
}

#[tokio::test]
async fn delete_on_origin_and_release_branches() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
    sh(&repo, &["push", "-q", "-u", "origin", "main"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    // Local and on origin: the local branch goes, origin keeps it unless asked.
    sh(&repo, &["switch", "-qc", "feat/both"]);
    sh(&repo, &["push", "-q", "-u", "origin", "feat/both"]);
    sh(&repo, &["switch", "-q", "main"]);
    call(&k, "branches.delete", json!({ "projectId": pid, "branch": "feat/both" })).await;
    assert!(rev(&repo, "refs/heads/feat/both").is_empty());
    assert_eq!(rev(&repo, "refs/remotes/origin/feat/both").len(), 40);
    call(&k, "branches.delete", json!({ "projectId": pid, "branch": "feat/both", "remote": true })).await;
    assert!(rev(&repo, "refs/remotes/origin/feat/both").is_empty());
    assert!(rev(&origin, "refs/heads/feat/both").is_empty());

    // Origin only, unmerged: refused without force.
    sh(&repo, &["switch", "-qc", "feat/far"]);
    commit_file(&repo, "far.txt", "far\n");
    sh(&repo, &["push", "-q", "origin", "feat/far"]);
    sh(&repo, &["switch", "-q", "main"]);
    sh(&repo, &["branch", "-qD", "feat/far"]);
    let err = rpc::call(&k, "branches.delete", json!({ "projectId": pid, "branch": "feat/far", "remote": true })).await.unwrap_err();
    assert!(err.to_string().contains("not merged into main"), "{err}");
    call(&k, "branches.delete", json!({ "projectId": pid, "branch": "feat/far", "remote": true, "force": true })).await;
    assert!(rev(&origin, "refs/heads/feat/far").is_empty());

    // The branch of an open release can go too.
    sh(&repo, &["switch", "-qc", "release/9.0.0"]);
    sh(&repo, &["switch", "-q", "main"]);
    let o = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert!(o["releases"].as_array().unwrap().iter().any(|r| r["branch"] == "release/9.0.0" && r["open"] == true), "{o}");
    call(&k, "branches.delete", json!({ "projectId": pid, "branch": "release/9.0.0" })).await;
    assert!(rev(&repo, "refs/heads/release/9.0.0").is_empty());
}

#[tokio::test]
async fn merge_by_squash_rebase_and_push() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
    sh(&repo, &["push", "-q", "-u", "origin", "main"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let count = |r: &str| {
        let out = Command::new("git").current_dir(&repo).args(["rev-list", "--count", r]).output().unwrap();
        String::from_utf8(out.stdout).unwrap().trim().parse::<u32>().unwrap()
    };

    // Rebase + fast-forward, branch not checked out, main moved on meanwhile: linear history.
    sh(&repo, &["switch", "-qc", "feat/r"]);
    commit_file(&repo, "r1.txt", "1\n");
    commit_file(&repo, "r2.txt", "2\n");
    sh(&repo, &["switch", "-q", "main"]);
    commit_file(&repo, "m.txt", "m\n");
    let m = call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/r", "rebase": true })).await;
    assert_eq!(m["alreadyMerged"], false);
    assert_eq!(rev(&repo, "main"), rev(&repo, "feat/r"));
    assert_eq!(count("main"), 4, "init, m, r1, r2: no merge commit");
    assert!(repo.join("r2.txt").exists(), "checked-out main fast-forwarded");

    // Squash, then a merge commit: one commit on the branch, listing what it replaced.
    sh(&repo, &["switch", "-qc", "feat/s"]);
    commit_file(&repo, "s1.txt", "1\n");
    commit_file(&repo, "s2.txt", "2\n");
    sh(&repo, &["switch", "-q", "main"]);
    let before = count("main");
    call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/s", "squash": true })).await;
    assert_eq!(count("main"), before + 2, "squashed commit + merge commit");
    let msg = Command::new("git").current_dir(&repo).args(["log", "-1", "--format=%B", "main^2"]).output().unwrap();
    let msg = String::from_utf8(msg.stdout).unwrap();
    assert!(msg.starts_with("squash | feat/s\n") && msg.contains("* edit s1.txt\n* edit s2.txt"), "{msg}");

    // Squash + rebase + push + delete: one new commit on main, on origin too.
    sh(&repo, &["switch", "-qc", "feat/p"]);
    commit_file(&repo, "p1.txt", "1\n");
    commit_file(&repo, "p2.txt", "2\n");
    sh(&repo, &["switch", "-q", "main"]);
    let before = count("main");
    let m = call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/p", "squash": true, "rebase": true, "push": true, "deleteBranch": true })).await;
    assert_eq!(m["pushed"], true, "{m}");
    assert_eq!(count("main"), before + 1);
    assert_eq!(rev(&origin, "main"), rev(&repo, "main"));
    assert!(rev(&repo, "refs/heads/feat/p").is_empty());

    // A conflicting squash refuses before rewriting anything.
    sh(&repo, &["switch", "-qc", "feat/c"]);
    commit_file(&repo, "README.md", "# c\n");
    commit_file(&repo, "c.txt", "c\n");
    sh(&repo, &["switch", "-q", "main"]);
    commit_file(&repo, "README.md", "# main\n");
    let tip = rev(&repo, "feat/c");
    let err = rpc::call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/c", "squash": true, "rebase": true })).await.unwrap_err();
    assert!(err.to_string().contains("README.md"), "{err}");
    assert_eq!(rev(&repo, "feat/c"), tip);
}

#[tokio::test]
async fn outside_git_changes_refresh_the_project() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let mut rx = k.subscribe();

    // A commit made in a terminal, not through Gitnetix.
    commit_file(&repo, "outside.txt", "x\n");
    let seen = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Ok(gitnetix_core::Event::ProjectChanged { project_id }) = rx.recv().await {
                if project_id == pid {
                    return;
                }
            }
        }
    })
    .await;
    assert!(seen.is_ok(), "no ProjectChanged after an outside commit");
}
