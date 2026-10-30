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

fn git_out(repo: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(repo).args(args).output().unwrap();
    String::from_utf8(out.stdout).unwrap()
}

fn rev(repo: &std::path::Path, r: &str) -> String {
    git_out(repo, &["rev-parse", "--verify", "-q", r]).trim().to_string()
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

    // A fix on the shipped release, merged into main again once main moved on.
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
    sh(&repo, &["push", "-q", "-u", "origin", "main", "v2.4.0"]);
    let tag_date = || {
        let out = Command::new("git").current_dir(&repo).args(["for-each-ref", "--format=%(creatordate:unix)", "refs/tags/v2.4.0"]).output().unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    };
    let shipped_date = tag_date();
    sh(&repo, &["switch", "-q", "release/2.4.0"]);
    commit_file(&repo, "oauth.ts", "export const x = 2;\n");
    let fix = rev(&repo, "release/2.4.0");
    sh(&repo, &["switch", "-q", "main"]);
    commit_file(&repo, "next.txt", "2.5 work\n");
    // Pushed: the tag moves to the release's own tip (not main's, which has 2.5 work), on origin too, keeping its date.
    let remerged = call(&k, "branches.merge", json!({ "projectId": pid, "branch": "release/2.4.0", "into": "main", "push": true })).await;
    assert_eq!(remerged["retagged"], "v2.4.0", "{remerged}");
    assert_eq!(rev(&repo, "v2.4.0^{commit}"), fix);
    assert_eq!(rev(&origin, "v2.4.0^{commit}"), fix);
    assert_eq!(tag_date(), shipped_date, "keeps its place among the tags");
    // Nothing new to merge: the tag stays.
    let again = call(&k, "branches.merge", json!({ "projectId": pid, "branch": "release/2.4.0", "into": "main", "push": true })).await;
    assert_eq!(again["alreadyMerged"], true);
    assert!(again["retagged"].is_null(), "{again}");
    // Not pushed: the tag stays too, so it never differs from origin's.
    sh(&repo, &["switch", "-q", "release/2.4.0"]);
    commit_file(&repo, "oauth.ts", "export const x = 3;\n");
    sh(&repo, &["switch", "-q", "main"]);
    let local = call(&k, "branches.merge", json!({ "projectId": pid, "branch": "release/2.4.0", "into": "main" })).await;
    assert!(local["retagged"].is_null(), "{local}");
    assert_eq!(rev(&repo, "v2.4.0^{commit}"), fix);

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
    assert!(call(&k, "worktrees.list", json!({ "cached": true })).await.is_null());
    let list = call(&k, "worktrees.list", json!({})).await;
    assert!(list.as_array().unwrap().iter().any(|w| w["path"] == path.as_str()));
    // Saved for the next look, even after a restart: the same worktrees at once, agents left out.
    let saved = call(&k, "worktrees.list", json!({ "cached": true })).await;
    let paths = |v: &serde_json::Value| v.as_array().unwrap().iter().map(|w| w["path"].clone()).collect::<Vec<_>>();
    assert_eq!(paths(&saved), paths(&list));
    assert!(saved.as_array().unwrap().iter().all(|w| w["agent"].is_null()), "{saved}");
    // Dirty: refused, and its terminal keeps running (writing to a closed one fails).
    call(&k, "shell.open", json!({ "projectId": pid, "path": path, "cols": 80, "rows": 24 })).await;
    std::fs::write(std::path::Path::new(&path).join("scratch.txt"), "wip\n").unwrap();
    assert!(rpc::call(&k, "worktrees.remove", json!({ "projectId": pid, "path": path })).await.is_err());
    call(&k, "shell.write", json!({ "path": path, "data": "" })).await;
    std::fs::remove_file(std::path::Path::new(&path).join("scratch.txt")).unwrap();
    call(&k, "worktrees.remove", json!({ "projectId": pid, "path": path })).await;

    let a = call(&k, "analytics.get", json!({ "projectId": pid, "days": 30 })).await;
    assert_eq!(a["releases"][0]["version"], "v2.4.0");
    assert_eq!(a["releases"][0]["project"], "atlas-api");
    assert_eq!(a["releases"][0]["featureTitles"], json!(["feat(auth): add oauth"]));
    assert_eq!(a["releases"][0]["branches"], json!(["feat/oauth-login"]), "{}", a["releases"][0]);
    let today = a["days"].as_array().unwrap().last().unwrap()["date"].clone();
    let day = call(&k, "analytics.day", json!({ "projectId": pid, "date": today })).await;
    let oauth = day.as_array().unwrap().iter().find(|c| c["subject"] == "feat(auth): add oauth").expect("today's commit");
    assert_eq!(oauth["project"], "atlas-api");
    assert!(!oauth["branch"].as_str().unwrap().is_empty(), "{oauth}");
}

#[tokio::test]
async fn merge_and_delete_branches() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    // Its conflicts must stop the operation, not go to an AI found on this computer.
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "merge": { "resolveConflicts": false } })).await;

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
async fn cleanup_branch_named_like_a_tag() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
    sh(&repo, &["tag", "2.13.0"]);
    sh(&repo, &["switch", "-qc", "2.13.0"]);
    commit_file(&repo, "old.txt", "old\n");
    sh(&repo, &["switch", "-q", "main"]);
    sh(&repo, &["push", "-q", "origin", "main", "refs/heads/2.13.0", "refs/tags/2.13.0"]);
    sh(&repo, &["fetch", "-q", "origin"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    // Listed by its own name, not git's disambiguated "heads/2.13.0".
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert!(ov["branches"].as_array().unwrap().iter().any(|b| b["name"] == "2.13.0"), "{}", ov["branches"]);

    let r = call(&k, "branches.cleanup", json!({ "projectId": pid, "branches": ["2.13.0", "nope"], "force": true, "remote": true })).await;
    assert_eq!(r["deleted"], json!(["2.13.0"]), "{r}");
    assert_eq!(r["skipped"][0]["branch"], "nope");
    assert!(rev(&repo, "refs/heads/2.13.0").is_empty());
    assert!(git_out(&origin, &["for-each-ref", "refs/heads/2.13.0"]).is_empty());
    assert!(!rev(&repo, "refs/tags/2.13.0").is_empty(), "tag kept");
}

#[tokio::test]
async fn delete_release_branch_before_its_items() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    call(&k, "releases.create", json!({ "projectId": pid, "version": "0.10.0", "kind": "next" })).await;
    call(
        &k,
        "items.create",
        json!({ "projectId": pid, "release": "0.10.0", "kind": "feat", "description": "child", "branchName": "feat/child", "where": "switch" }),
    )
    .await;
    commit_file(&repo, "child.txt", "child\n");
    sh(&repo, &["switch", "-q", "main"]);

    // The release goes with its branch; the item falls back to main.
    call(&k, "branches.delete", json!({ "projectId": pid, "branch": "release/0.10.0", "force": true })).await;
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert!(ov["releases"].as_array().unwrap().iter().all(|r| r["version"] != "0.10.0"), "{}", ov["releases"]);
    let diff = call(&k, "workspace.diff", json!({ "projectId": pid, "branch": "feat/child", "mode": "branch", "path": "child.txt" })).await;
    assert_eq!(diff[0]["lines"][0]["kind"], "+");
}

#[tokio::test]
async fn forget_release_branch_deleted_outside() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    call(&k, "releases.create", json!({ "projectId": pid, "version": "0.10.0", "kind": "next" })).await;
    sh(&repo, &["switch", "-q", "main"]);
    sh(&repo, &["branch", "-qD", "release/0.10.0"]);

    // Gone everywhere: forgetting it drops the release instead of failing with "not found".
    call(&k, "branches.delete", json!({ "projectId": pid, "branch": "release/0.10.0", "remote": true })).await;
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert!(ov["releases"].as_array().unwrap().iter().all(|r| r["version"] != "0.10.0"), "{}", ov["releases"]);
}

#[tokio::test]
async fn diverged_pull_and_merge_past_uncommitted_work() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
    sh(&repo, &["push", "-q", "-u", "origin", "main"]);
    let other = tmp.path().join("other");
    sh(tmp.path(), &["clone", "-q", origin.to_str().unwrap(), other.to_str().unwrap()]);
    sh(&other, &["config", "user.email", "o@example.com"]);
    sh(&other, &["config", "user.name", "Other"]);
    sh(&other, &["config", "commit.gpgsign", "false"]);
    let push_other = |name: &str| {
        sh(&other, &["pull", "-q", "--ff-only"]);
        commit_file(&other, name, "o\n");
        sh(&other, &["push", "-q", "origin", "main"]);
        sh(&repo, &["fetch", "-q", "origin"]);
    };
    let is_ancestor = |a: &str, b: &str| std::process::Command::new("git").current_dir(&repo).args(["merge-base", "--is-ancestor", a, b]).status().unwrap().success();
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let pid = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string();

    // Diverged with a plain local commit: replayed on top of origin's.
    commit_file(&repo, "l1.txt", "l\n");
    push_other("o1.txt");
    call(&k, "branches.pull", json!({ "projectId": pid, "branch": "main" })).await;
    assert_eq!(rev(&repo, "main^"), rev(&repo, "origin/main"));
    assert!(repo.join("l1.txt").exists() && repo.join("o1.txt").exists());

    // Diverged with a local merge: origin's merged in instead, so the merged branch stays merged.
    sh(&repo, &["switch", "-qc", "feat/z"]);
    commit_file(&repo, "z.txt", "z\n");
    sh(&repo, &["switch", "-q", "main"]);
    sh(&repo, &["merge", "-q", "--no-ff", "-m", "Merge branch 'feat/z'", "feat/z"]);
    push_other("o2.txt");
    call(&k, "branches.pull", json!({ "projectId": pid, "branch": "main" })).await;
    assert!(is_ancestor("feat/z", "main") && is_ancestor("origin/main", "main"));
    sh(&repo, &["push", "-q", "origin", "main"]);

    // Merging into main while its checkout has unrelated uncommitted work and origin moved on:
    // main catches up first, the work stays, the push goes through.
    let wt = tmp.path().join("wt");
    sh(&repo, &["worktree", "add", "-q", "-b", "feat/y", wt.to_str().unwrap()]);
    commit_file(&wt, "y.txt", "y\n");
    push_other("o3.txt");
    std::fs::write(repo.join("notes.txt"), "wip\n").unwrap();
    let r = call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/y", "into": "main", "push": true, "stay": true })).await;
    assert_eq!(r["pushed"], true, "{r}");
    assert!(repo.join("y.txt").exists() && repo.join("o3.txt").exists());
    assert_eq!(std::fs::read_to_string(repo.join("notes.txt")).unwrap(), "wip\n");

    // Uncommitted work in a file the branch changes still stops the merge, nothing moved.
    commit_file(&wt, "notes.txt", "theirs\n");
    let before = rev(&repo, "main");
    let err = rpc::call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/y", "into": "main", "stay": true })).await.unwrap_err();
    assert!(err.to_string().contains("notes.txt"), "{err}");
    assert_eq!(rev(&repo, "main"), before);
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

    // Tag a branch's tip, pushed to origin too; the same name again is refused.
    call(&k, "branches.tag", json!({ "projectId": pid, "branch": "feat/x", "name": "snap-1" })).await;
    assert_eq!(rev(&repo, "snap-1^{commit}"), rev(&repo, "feat/x"));
    assert_eq!(rev(&origin, "snap-1^{commit}"), rev(&repo, "feat/x"));
    let err = rpc::call(&k, "branches.tag", json!({ "projectId": pid, "branch": "main", "name": "snap-1" })).await.unwrap_err();
    assert!(err.to_string().contains("already exists"), "{err}");
    // Tag any commit by its sha, pushed too.
    let main = rev(&repo, "main");
    call(&k, "commits.tag", json!({ "projectId": pid, "sha": main, "name": "snap-0", "message": "on main" })).await;
    assert_eq!(rev(&repo, "snap-0^{commit}"), main);
    assert_eq!(rev(&origin, "snap-0^{commit}"), main);
    // Checking it out detaches HEAD on its commit.
    call(&k, "tags.checkout", json!({ "projectId": pid, "name": "snap-1" })).await;
    assert_eq!(rev(&repo, "HEAD"), rev(&repo, "feat/x"));
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let snap = ov["releases"].as_array().unwrap().iter().find(|r| r["tagName"] == "snap-1").unwrap().clone();
    assert_eq!(snap["checkedOut"], true, "{snap}");
    sh(&repo, &["switch", "-q", "main"]);
    // A branch started from it merges into the default branch.
    call(&k, "items.create", json!({ "projectId": pid, "from": "snap-1", "kind": "fix", "description": "", "branchName": "fix/from-snap", "where": "switch" })).await;
    assert_eq!(rev(&repo, "fix/from-snap"), rev(&repo, "feat/x"));
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let b = ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == "fix/from-snap").unwrap().clone();
    assert_eq!(b["parent"], "main", "{b}");
    sh(&repo, &["switch", "-q", "main"]);
    // Deleting it removes it on origin too.
    call(&k, "tags.delete", json!({ "projectId": pid, "name": "snap-1" })).await;
    let gone = |dir: &std::path::Path| !std::process::Command::new("git").current_dir(dir).args(["rev-parse", "-q", "--verify", "refs/tags/snap-1"]).status().unwrap().success();
    assert!(gone(&repo) && gone(&origin));

    // Rebased after it was pushed: flagged as rewritten, and a force push replaces origin's copy.
    sh(&repo, &["switch", "-q", "feat/x"]);
    let r = call(&k, "workspace.rebase", json!({ "projectId": pid, "branch": "feat/x" })).await;
    assert_eq!(r["forcePushTo"], "origin/feat/x", "{r}");
    let feat_x = |ov: &Value| ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == "feat/x").unwrap().clone();
    let x = feat_x(&call(&k, "workspace.overview", json!({ "projectId": pid })).await);
    assert_eq!(x["rewritten"], true, "{x}");
    let err = rpc::call(&k, "workspace.push", json!({ "projectId": pid, "branch": "feat/x" })).await.unwrap_err();
    assert!(err.to_string().contains("rejected"), "{err}");
    call(&k, "workspace.push", json!({ "projectId": pid, "branch": "feat/x", "force": true })).await;
    assert_eq!(rev(&origin, "feat/x"), rev(&repo, "feat/x"));
    let r = call(&k, "workspace.rebase", json!({ "projectId": pid, "branch": "feat/x" })).await;
    assert!(r["forcePushTo"].is_null(), "nothing rewritten: {r}");

    // A teammate pushed, and a fetch saw it, but it was never on the local branch: not rewritten, force refused.
    commit_file(&repo, "l2.txt", "l2\n");
    sh(&other, &["fetch", "-q", "origin"]);
    sh(&other, &["reset", "-q", "--hard", "origin/feat/x"]);
    commit_file(&other, "y.txt", "y\n");
    sh(&other, &["push", "-q", "origin", "feat/x"]);
    call(&k, "branches.fetch", json!({ "projectId": pid })).await;
    let x = feat_x(&call(&k, "workspace.overview", json!({ "projectId": pid })).await);
    assert_eq!((x["upstreamAhead"].as_u64(), x["upstreamBehind"].as_u64(), x["rewritten"].as_bool()), (Some(1), Some(1), Some(false)), "{x}");
    let theirs = rev(&origin, "feat/x");
    assert!(rpc::call(&k, "workspace.push", json!({ "projectId": pid, "branch": "feat/x", "force": true })).await.is_err());
    assert_eq!(rev(&origin, "feat/x"), theirs, "teammate's commit kept");
}

#[tokio::test]
async fn reset_back_after_push_force_pushes() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("rewind");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
    sh(&repo, &["push", "-q", "-u", "origin", "main"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    // Only behind origin, but the dropped commit was on main: rewritten, so a plain push is refused and a force push goes.
    commit_file(&repo, "back.txt", "b\n");
    call(&k, "workspace.push", json!({ "projectId": pid, "branch": "main" })).await;
    sh(&repo, &["reset", "-q", "--hard", "HEAD~1"]);
    let main = |ov: &Value| ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == "main").unwrap().clone();
    let m = main(&call(&k, "workspace.overview", json!({ "projectId": pid })).await);
    assert_eq!((m["upstreamAhead"].as_u64(), m["upstreamBehind"].as_u64(), m["rewritten"].as_bool()), (Some(0), Some(1), Some(true)), "{m}");
    assert!(rpc::call(&k, "workspace.push", json!({ "projectId": pid, "branch": "main" })).await.is_err());
    call(&k, "workspace.push", json!({ "projectId": pid, "branch": "main", "force": true })).await;
    assert_eq!(rev(&origin, "main"), rev(&repo, "main"));
}

#[tokio::test]
async fn reset_forward_onto_pushed_commits() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("forward");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
    commit_file(&repo, "a.txt", "a\n");
    commit_file(&repo, "b.txt", "b\n");
    sh(&repo, &["push", "-q", "-u", "origin", "main"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    // Hard reset back past pushed commits: they stay listed as origin's, and a hard reset brings main forward onto them.
    let (mid, tip) = (rev(&repo, "main~1"), rev(&repo, "main"));
    sh(&repo, &["reset", "-q", "--hard", "HEAD~2"]);
    let commits = call(&k, "workspace.commits", json!({ "projectId": pid, "branch": "main" })).await;
    let unpulled: Vec<&str> = commits.as_array().unwrap().iter().filter(|c| c["unpulled"] == true).map(|c| c["sha"].as_str().unwrap()).collect();
    assert_eq!(unpulled, [tip.as_str(), mid.as_str()]);
    call(&k, "commits.reset", json!({ "projectId": pid, "branch": "main", "sha": mid, "mode": "hard" })).await;
    assert_eq!(rev(&repo, "main"), mid);
    call(&k, "commits.reset", json!({ "projectId": pid, "branch": "main", "sha": tip, "mode": "hard" })).await;
    assert_eq!(rev(&repo, "main"), tip);
    assert!(repo.join("b.txt").exists());
}

#[tokio::test]
async fn commits_flag_unpushed() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("unpushed");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
    commit_file(&repo, "a.txt", "a\n");
    sh(&repo, &["push", "-q", "-u", "origin", "main"]);
    commit_file(&repo, "b.txt", "b\n");
    sh(&repo, &["switch", "-q", "-c", "feat/x"]);
    commit_file(&repo, "x.txt", "x\n");
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let unpushed = |v: &Value| -> Vec<String> { v.as_array().unwrap().iter().filter(|c| c["unpushed"] == true).map(|c| c["sha"].as_str().unwrap().to_string()).collect() };

    // Only main's commit after the push; a branch never pushed has all its own commits unpushed.
    let main = call(&k, "workspace.commits", json!({ "projectId": pid, "branch": "main" })).await;
    assert_eq!(unpushed(&main), [rev(&repo, "main")]);
    let feat = call(&k, "workspace.commits", json!({ "projectId": pid, "branch": "feat/x" })).await;
    assert_eq!(unpushed(&feat), [rev(&repo, "feat/x")]);
}

#[tokio::test]
async fn commits_limit_reaches_older_history() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("long");
    init_repo(&repo);
    commit_file(&repo, "a.txt", "a\n");
    commit_file(&repo, "b.txt", "b\n");
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let shas = |v: &Value| -> Vec<String> { v.as_array().unwrap().iter().map(|c| c["sha"].as_str().unwrap().to_string()).collect() };

    // A limit keeps the newest; a bigger one adds the older ones below them.
    let first = call(&k, "workspace.commits", json!({ "projectId": pid, "branch": "main", "limit": 2 })).await;
    assert_eq!(shas(&first), [rev(&repo, "main"), rev(&repo, "main~1")]);
    let more = call(&k, "workspace.commits", json!({ "projectId": pid, "branch": "main", "limit": 4 })).await;
    assert_eq!(shas(&more)[..2], shas(&first)[..]);
    assert_eq!(shas(&more).len(), 3, "all of main, init included");
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
async fn discard_unstaged_refuses_conflicts() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    commit_file(&repo, "c.txt", "base\n");
    commit_file(&repo, "a.txt", "one\n");
    sh(&repo, &["switch", "-qc", "other"]);
    commit_file(&repo, "c.txt", "theirs\n");
    sh(&repo, &["switch", "-q", "main"]);
    commit_file(&repo, "c.txt", "ours\n");
    git_out(&repo, &["merge", "-q", "other"]);
    std::fs::write(repo.join("a.txt"), "two\n").unwrap();
    std::fs::write(repo.join("new.txt"), "fresh\n").unwrap();

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    // Discarding everything unstaged while a file is in conflict changes nothing.
    let err = rpc::call(&k, "workspace.discard", json!({ "projectId": pid, "branch": "main", "staged": false })).await.unwrap_err();
    assert!(err.to_string().contains("c.txt has conflicts"), "{err}");
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "two\n");
    assert!(repo.join("new.txt").exists());
}

#[tokio::test]
async fn merged_branches_are_flagged() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    // Fresh branch (no commits), unmerged branch, merge-commit, fast-forward, squash and rebase merges.
    sh(&repo, &["branch", "fresh"]);
    for b in ["open", "via-merge", "via-ff", "via-squash", "via-rebase"] {
        sh(&repo, &["switch", "-qc", b]);
        commit_file(&repo, &format!("{b}.txt"), "x\n");
        commit_file(&repo, &format!("{b}-2.txt"), "y\n");
        sh(&repo, &["switch", "-q", "main"]);
    }
    sh(&repo, &["merge", "-q", "--ff-only", "via-ff"]);
    call(&k, "branches.merge", json!({ "projectId": pid, "branch": "via-merge" })).await;
    sh(&repo, &["merge", "-q", "--squash", "via-squash"]);
    sh(&repo, &["commit", "-qm", "squash via-squash"]);
    sh(&repo, &["cherry-pick", "main..via-rebase"]);
    sh(&repo, &["branch", "-qf", "fresh", "main"]);

    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let merged = |n: &str| ov["otherBranches"].as_array().unwrap().iter().find(|b| b["name"] == n).unwrap()["merged"].as_bool().unwrap();
    assert!(!merged("fresh"));
    assert!(!merged("open"));
    assert!(merged("via-merge"));
    assert!(merged("via-ff"));
    assert!(merged("via-squash"));
    assert!(merged("via-rebase"));
    // Squash-merged branches go without forcing.
    call(&k, "branches.cleanup", json!({ "projectId": pid, "branches": ["via-squash", "via-rebase"] })).await;
    assert!(!repo.join(".git/refs/heads/via-squash").exists());
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

    // Deleting its tag takes 0.0.1 back to an open release.
    call(&k, "tags.delete", json!({ "projectId": pid, "name": "v0.0.1" })).await;
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let b = ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == "release/0.0.1").cloned().unwrap();
    assert!(b["shipped"].is_null());
    assert_eq!(b["role"], "release");
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
async fn shipped_release_left_only_on_origin_files_under_shipped() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("ff");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);

    // Shipped outside Gitnetix: fast-forwarded into main, tagged, local branch deleted.
    sh(&repo, &["switch", "-qc", "release/1.4.0"]);
    commit_file(&repo, "r.txt", "r\n");
    sh(&repo, &["switch", "-q", "main"]);
    sh(&repo, &["merge", "-q", "--ff-only", "release/1.4.0"]);
    sh(&repo, &["tag", "-a", "v1.4.0", "-m", "v1.4.0"]);
    sh(&repo, &["push", "-q", "origin", "main", "release/1.4.0", "v1.4.0"]);
    sh(&repo, &["branch", "-qD", "release/1.4.0"]);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let r = ov["releases"].as_array().unwrap().iter().find(|r| r["version"] == "1.4.0").cloned().unwrap();
    assert_eq!((r["open"].as_bool(), r["branch"].as_str()), (Some(false), Some("release/1.4.0")));
    let b = ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == "release/1.4.0").cloned().unwrap();
    assert_eq!(b["shipped"], "1.4.0");
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

    // Already gone from origin (deleted on PR merge) but not fetched yet: only the stale tracking ref goes.
    sh(&repo, &["push", "-q", "origin", "main:refs/heads/feat/gone"]);
    sh(&repo, &["fetch", "-q", "origin"]);
    sh(&origin, &["branch", "-qD", "feat/gone"]);
    call(&k, "branches.delete", json!({ "projectId": pid, "branch": "feat/gone", "remote": true })).await;
    assert!(rev(&repo, "refs/remotes/origin/feat/gone").is_empty());

    // Moved on origin since the last fetch: the lease still refuses.
    sh(&repo, &["switch", "-qc", "feat/moved"]);
    commit_file(&repo, "moved.txt", "moved\n");
    sh(&repo, &["push", "-q", "origin", "feat/moved"]);
    sh(&repo, &["switch", "-q", "main"]);
    sh(&repo, &["branch", "-qD", "feat/moved"]);
    sh(&repo, &["update-ref", "refs/remotes/origin/feat/moved", "main"]);
    let err = rpc::call(&k, "branches.delete", json!({ "projectId": pid, "branch": "feat/moved", "remote": true, "force": true })).await.unwrap_err();
    assert!(err.to_string().contains("stale info"), "{err}");

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
    // Its conflicts must stop the operation, not go to an AI found on this computer.
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "merge": { "resolveConflicts": false } })).await;
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

#[tokio::test]
async fn ignore_untracks_committed_files() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    std::fs::create_dir(repo.join("build")).unwrap();
    commit_file(&repo, "build/out.js", "x\n");
    std::fs::write(repo.join("build/out.js"), "y\n").unwrap();
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    call(&k, "workspace.ignore", json!({ "projectId": pid, "branch": "main", "path": "build", "dir": true })).await;
    sh(&repo, &["add", ".gitignore"]);
    sh(&repo, &["commit", "-qm", "ignore build"]);
    let wip = call(&k, "workspace.files", json!({ "projectId": pid, "branch": "main", "mode": "wip" })).await;
    assert_eq!(wip, json!([]), "ignored folder still in WIP");
    assert!(repo.join("build/out.js").exists(), "untracking deleted the file");
}

#[tokio::test]
async fn suggest_version() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let suggest = |kind: &'static str| {
        let (k, pid) = (&k, pid.clone());
        async move { call(k, "releases.suggestVersion", json!({ "projectId": pid, "kind": kind })).await["version"].as_str().unwrap().to_string() }
    };

    assert_eq!(suggest("next").await, "0.1.0");
    sh(&repo, &["tag", "v1.2.0"]);
    sh(&repo, &["tag", "v1.10.3"]);
    assert_eq!(suggest("next").await, "1.11.0");
    assert_eq!(suggest("hotfix").await, "1.10.4");
    // A release branch past the tags wins for next; a hotfix already cut is skipped.
    sh(&repo, &["branch", "release/1.11.0"]);
    sh(&repo, &["branch", "release/1.10.4"]);
    assert_eq!(suggest("next").await, "1.12.0");
    assert_eq!(suggest("hotfix").await, "1.10.5");
}

#[tokio::test]
async fn squash_and_rebase_merges_delete_the_branch_last() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "origin.git"]);
    sh(&repo, &["remote", "add", "origin", &origin.to_string_lossy()]);
    sh(&repo, &["push", "-qu", "origin", "main"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    // Each branch open in its own worktree, main moved on meanwhile.
    let branch = |b: &str| {
        sh(&repo, &["switch", "-qc", b]);
        commit_file(&repo, &format!("{}-1.txt", &b[5..]), "x\n");
        commit_file(&repo, &format!("{}-2.txt", &b[5..]), "y\n");
        sh(&repo, &["push", "-qu", "origin", b]);
        sh(&repo, &["switch", "-q", "main"]);
        commit_file(&repo, &format!("main-{}.txt", &b[5..]), "m\n");
        let wt = tmp.path().join(&b[5..]);
        sh(&repo, &["worktree", "add", "-q", &wt.to_string_lossy(), b]);
        wt
    };
    for (b, squash, rebase) in [("feat/sq", true, false), ("feat/rb", false, true), ("feat/both", true, true)] {
        branch(b);
        let m = call(&k, "branches.merge", json!({ "projectId": pid, "branch": b, "squash": squash, "rebase": rebase, "deleteBranch": true, "push": true })).await;
        assert_eq!((m["deleted"].as_bool(), m["pushed"].as_bool()), (Some(true), Some(true)), "{b}: {m}");
        assert!(rev(&repo, &format!("refs/heads/{b}")).is_empty(), "{b} still there");
        assert!(rev(&origin, &format!("refs/heads/{b}")).is_empty(), "{b} still on origin");
    }

    // Origin got a commit the local branch never had: the merge lands, the branch stays everywhere.
    branch("feat/theirs");
    sh(tmp.path(), &["clone", "-q", "-b", "feat/theirs", &origin.to_string_lossy(), "other"]);
    let other = tmp.path().join("other");
    sh(&other, &["config", "user.email", "o@example.com"]);
    sh(&other, &["config", "user.name", "Other"]);
    commit_file(&other, "theirs.txt", "t\n");
    sh(&other, &["push", "-q", "origin", "feat/theirs"]);
    sh(&repo, &["fetch", "-q", "origin"]);
    let m = call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/theirs", "deleteBranch": true, "push": true })).await;
    assert_eq!(m["deleted"], false, "{m}");
    assert!(m["deleteError"].as_str().unwrap().contains("origin/feat/theirs"), "{m}");
    assert_eq!(rev(&repo, "refs/heads/feat/theirs").len(), 40);
    assert_eq!(rev(&origin, "refs/heads/feat/theirs").len(), 40);

    // A branch that can't go (its worktree has untracked work) still gets merged and pushed.
    let wt = branch("feat/kept");
    std::fs::write(wt.join("scratch.txt"), "wip\n").unwrap();
    let m = call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/kept", "squash": true, "deleteBranch": true, "push": true })).await;
    assert_eq!(m["deleted"], false, "{m}");
    assert!(m["deleteError"].is_string(), "{m}");
    assert_eq!(m["pushed"], true, "{m}");
    assert_eq!(rev(&repo, "origin/main"), rev(&repo, "main"));
}

#[tokio::test]
async fn publish_sets_upstream_even_if_already_on_origin() {
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
    call(&k, "items.create", json!({ "projectId": pid, "from": "main", "kind": "feat", "description": "", "branchName": "feat/pub", "where": "switch" })).await;
    // Pushed by hand without -u: on origin, but not tracked.
    sh(&repo, &["push", "-q", "origin", "feat/pub"]);
    let upstream = |ov: &Value| ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == "feat/pub").unwrap()["upstream"].clone();
    assert!(upstream(&call(&k, "workspace.overview", json!({ "projectId": pid })).await).is_null());
    call(&k, "workspace.push", json!({ "projectId": pid, "branch": "feat/pub" })).await;
    assert_eq!(upstream(&call(&k, "workspace.overview", json!({ "projectId": pid })).await), "origin/feat/pub");
}

#[tokio::test]
async fn stash_flow() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    // Its conflicts must stop the operation, not go to an AI found on this computer.
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "merge": { "resolveConflicts": false } })).await;

    std::fs::write(repo.join("README.md"), "# atlas\nmore\n").unwrap();
    std::fs::write(repo.join("new.ts"), "x\n").unwrap();
    call(&k, "branches.stash", json!({ "projectId": pid, "branch": "main" })).await;

    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let s = &ov["stashes"][0];
    assert_eq!(s["branch"], "main");
    assert_eq!(s["message"], "2 files: README.md, new.ts");
    assert_eq!(s["untracked"], true);
    assert_eq!(ov["defaultView"]["stashes"], 1);
    assert_eq!(ov["defaultView"]["wip"], 0);
    let sha = s["sha"].as_str().unwrap().to_string();

    // Tracked changes and untracked files both show, each with its diff.
    let files = call(&k, "stashes.files", json!({ "projectId": pid, "sha": sha })).await;
    let st: Vec<(&str, &str)> = files.as_array().unwrap().iter().map(|f| (f["path"].as_str().unwrap(), f["status"].as_str().unwrap())).collect();
    assert_eq!(st, vec![("README.md", "M"), ("new.ts", "A")]);
    let diff = call(&k, "stashes.diff", json!({ "projectId": pid, "sha": sha, "path": "new.ts" })).await;
    assert_eq!(diff[0]["lines"][0]["text"], "x");

    // Apply keeps it; pop then drops it.
    let r = call(&k, "stashes.apply", json!({ "projectId": pid, "branch": "main", "sha": sha })).await;
    assert_eq!(r["dropped"], false);
    assert_eq!(call(&k, "stashes.list", json!({ "projectId": pid })).await.as_array().unwrap().len(), 1);
    sh(&repo, &["checkout", "--", "README.md"]);
    std::fs::remove_file(repo.join("new.ts")).unwrap();
    let r = call(&k, "stashes.apply", json!({ "projectId": pid, "branch": "main", "sha": sha, "pop": true })).await;
    assert_eq!(r["dropped"], true);
    assert_eq!(std::fs::read_to_string(repo.join("new.ts")).unwrap(), "x\n");
    assert!(call(&k, "stashes.list", json!({ "projectId": pid })).await.as_array().unwrap().is_empty());

    // A conflicting pop keeps the stash and reports the file.
    call(&k, "branches.stash", json!({ "projectId": pid, "branch": "main" })).await;
    commit_file(&repo, "README.md", "# other\n");
    let sha = call(&k, "stashes.list", json!({ "projectId": pid })).await[0]["sha"].as_str().unwrap().to_string();
    let r = call(&k, "stashes.apply", json!({ "projectId": pid, "branch": "main", "sha": sha, "pop": true })).await;
    assert_eq!(r["conflicts"], json!(["README.md"]));
    assert_eq!(r["dropped"], false);
    sh(&repo, &["reset", "-q", "--hard"]);
    sh(&repo, &["clean", "-qfd"]);

    call(&k, "stashes.drop", json!({ "projectId": pid, "sha": sha })).await;
    assert!(call(&k, "stashes.list", json!({ "projectId": pid })).await.as_array().unwrap().is_empty());
    assert!(rpc::call(&k, "stashes.drop", json!({ "projectId": pid, "sha": sha })).await.is_err());
}

#[tokio::test]
async fn ship_dates_the_changelog() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("changelog");
    init_repo(&repo);
    commit_file(&repo, "CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n- First.\n");
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let show = |r: &str| git_out(&repo, &["show", &format!("{r}:CHANGELOG.md")]);

    // Release branch not checked out: committed without touching a checkout.
    call(&k, "releases.create", json!({ "projectId": pid, "version": "0.1.0", "kind": "next" })).await;
    call(&k, "releases.ship", json!({ "projectId": pid, "version": "0.1.0" })).await;
    let shipped = show("v0.1.0");
    assert!(shipped.starts_with("# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - "), "{shipped}");
    assert!(shipped.ends_with("\n\n- First.\n"), "{shipped}");
    assert_eq!(rev(&repo, "main"), rev(&repo, "v0.1.0^{commit}"));
    assert_eq!(std::fs::read_to_string(repo.join("CHANGELOG.md")).unwrap(), shipped, "main checkout fast-forwarded");

    // Release branch checked out: committed there, other staged work left alone.
    call(&k, "releases.create", json!({ "projectId": pid, "version": "0.2.0", "kind": "next" })).await;
    sh(&repo, &["switch", "-q", "release/0.2.0"]);
    let next = shipped.replacen("## [Unreleased]\n", "## [Unreleased]\n\n- Second.\n", 1);
    commit_file(&repo, "CHANGELOG.md", &next);
    std::fs::write(repo.join("wip.txt"), "w\n").unwrap();
    sh(&repo, &["add", "wip.txt"]);
    let main_dir = tmp.path().join("main-wt");
    sh(&repo, &["worktree", "add", "-q", &main_dir.to_string_lossy(), "main"]);
    call(&k, "releases.ship", json!({ "projectId": pid, "version": "0.2.0" })).await;
    let shipped = show("v0.2.0");
    assert!(shipped.contains("## [Unreleased]\n\n## [0.2.0] - "), "{shipped}");
    assert!(shipped.contains("- Second.\n\n## [0.1.0] - "), "{shipped}");
    assert_eq!(std::fs::read_to_string(repo.join("CHANGELOG.md")).unwrap(), shipped);
    assert_eq!(show(":0"), shipped, "index matches");
    assert_eq!(git_out(&repo, &["diff", "--cached", "--name-only"]), "wip.txt\n");

    // Nothing unreleased: no extra commit.
    call(&k, "releases.create", json!({ "projectId": pid, "version": "0.3.0", "kind": "next" })).await;
    let before = rev(&repo, "release/0.3.0");
    call(&k, "releases.ship", json!({ "projectId": pid, "version": "0.3.0" })).await;
    assert_eq!(rev(&repo, "v0.3.0^{commit}"), before);

    // Release checked out, main nowhere: the checkout lands on main, staged work kept.
    sh(&repo, &["worktree", "remove", "--force", &main_dir.to_string_lossy()]);
    call(&k, "releases.create", json!({ "projectId": pid, "version": "0.4.0", "kind": "next" })).await;
    sh(&repo, &["switch", "-q", "release/0.4.0"]);
    call(&k, "releases.ship", json!({ "projectId": pid, "version": "0.4.0" })).await;
    assert_eq!(git_out(&repo, &["branch", "--show-current"]), "main\n");
    assert_eq!(rev(&repo, "main"), rev(&repo, "v0.4.0^{commit}"));
    assert_eq!(git_out(&repo, &["diff", "--cached", "--name-only"]), "wip.txt\n");
}

#[tokio::test]
async fn merged_on_origin_while_local_base_lags() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("lag");
    init_repo(&repo);
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
    for b in ["via-pr", "via-squash"] {
        sh(&repo, &["switch", "-qc", &format!("feat/{b}"), "main"]);
        commit_file(&repo, &format!("{b}.txt"), "x\n");
        commit_file(&repo, &format!("{b}-2.txt"), "y\n");
    }
    sh(&repo, &["switch", "-q", "main"]);
    sh(&repo, &["push", "-q", "origin", "main", "feat/via-pr", "feat/via-squash"]);

    // The host merges both PRs; the local main never pulls them.
    let other = tmp.path().join("other");
    sh(tmp.path(), &["clone", "-q", origin.to_str().unwrap(), other.to_str().unwrap()]);
    sh(&other, &["config", "user.email", "o@x"]);
    sh(&other, &["config", "user.name", "o"]);
    sh(&other, &["merge", "-q", "--no-ff", "origin/feat/via-pr", "-m", "Merge pull request #1"]);
    sh(&other, &["merge", "-q", "--squash", "origin/feat/via-squash"]);
    sh(&other, &["commit", "-qm", "squash via-squash"]);
    sh(&other, &["push", "-q", "origin", "main"]);
    sh(&repo, &["fetch", "-q", "origin"]);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let merged = |n: &str| ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == n).unwrap()["merged"].as_bool().unwrap();
    assert!(merged("feat/via-pr"));
    assert!(merged("feat/via-squash"));
    // They go without forcing, though the local main lacks them.
    call(&k, "branches.cleanup", json!({ "projectId": pid, "branches": ["feat/via-pr", "feat/via-squash"] })).await;
    assert!(!repo.join(".git/refs/heads/feat/via-pr").exists());
    assert!(!repo.join(".git/refs/heads/feat/via-squash").exists());
}

#[tokio::test]
async fn blobs_pick_both_versions_of_a_file() {
    use base64::Engine;
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let png = |b: u8| vec![0x89, b'P', b'N', b'G', 0, 0xff, b];
    std::fs::write(repo.join("logo.png"), png(1)).unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "add logo"]);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let dec = |v: &Value| v.as_str().map(|s| base64::engine::general_purpose::STANDARD.decode(s).unwrap());
    let blobs = |p: Value| {
        let k = &k;
        async move {
            let v = call(k, "workspace.blobs", p).await;
            (dec(&v["old"]), dec(&v["new"]))
        }
    };

    // A commit that added it: nothing before.
    let sha = rev(&repo, "HEAD");
    assert_eq!(blobs(json!({ "projectId": pid, "branch": "main", "mode": "branch", "path": "logo.png", "commit": sha })).await, (None, Some(png(1))));

    // Staged and unstaged sides of uncommitted work.
    std::fs::write(repo.join("logo.png"), png(2)).unwrap();
    sh(&repo, &["add", "."]);
    std::fs::write(repo.join("logo.png"), png(3)).unwrap();
    let wip = |staged: bool| json!({ "projectId": pid, "branch": "main", "mode": "wip", "path": "logo.png", "staged": staged });
    assert_eq!(blobs(wip(true)).await, (Some(png(1)), Some(png(2))));
    assert_eq!(blobs(wip(false)).await, (Some(png(2)), Some(png(3))));
    assert_eq!(blobs(json!({ "projectId": pid, "branch": "main", "mode": "project", "path": "logo.png" })).await, (Some(png(1)), Some(png(3))));
}

#[tokio::test]
async fn squash_merged_branch_that_pulled_in_upstream_work_reads_as_merged() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    // The branch carries a fix that reached main on its own, then its own work.
    sh(&repo, &["switch", "-qc", "feat/button"]);
    commit_file(&repo, "fix.txt", "fix\n");
    commit_file(&repo, "f1.txt", "1\n");
    commit_file(&repo, "f2.txt", "2\n");
    sh(&repo, &["switch", "-q", "main"]);
    std::fs::write(repo.join("fix.txt"), "fix\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "Merged PR 0: fix"]);
    // Squashed on the host: only the branch's own work, on top of the fix.
    sh(&repo, &["merge", "-q", "--squash", "feat/button"]);
    sh(&repo, &["commit", "-qm", "Merged PR 1: Feat/button"]);

    let o = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let b = o["branches"].as_array().unwrap().iter().find(|b| b["name"] == "feat/button").cloned().unwrap();
    assert_eq!(b["merged"], true, "{b}");
}

#[tokio::test]
async fn branch_squashed_into_a_shipped_release_sits_under_it() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    sh(&repo, &["switch", "-qc", "release/1.0.0"]);
    commit_file(&repo, "r.txt", "r\n");
    sh(&repo, &["switch", "-qc", "feat/x", "main"]);
    commit_file(&repo, "x1.txt", "1\n");
    commit_file(&repo, "x2.txt", "2\n");
    // Squashed into the release by a PR, then shipped; main never got it.
    sh(&repo, &["switch", "-q", "release/1.0.0"]);
    sh(&repo, &["merge", "-q", "--squash", "feat/x"]);
    sh(&repo, &["commit", "-qm", "Merged PR 2: Feat/x"]);
    sh(&repo, &["tag", "1.0.0"]);
    sh(&repo, &["switch", "-q", "main"]);

    let o = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let b = o["branches"].as_array().unwrap().iter().find(|b| b["name"] == "feat/x").cloned().unwrap();
    assert_eq!(b["parent"], "release/1.0.0", "{b}");
    assert_eq!(b["merged"], true, "{b}");
}

#[tokio::test]
async fn pull_request_squash_naming_the_branch_counts_as_merged() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    sh(&repo, &["switch", "-qc", "release/2.0.0"]);
    commit_file(&repo, "r.txt", "r\n");
    sh(&repo, &["switch", "-qc", "feat/t", "main"]);
    commit_file(&repo, "t.txt", "t\n");
    // The pull request landed with a conflict fixed on the way: not the branch's exact change.
    sh(&repo, &["switch", "-q", "release/2.0.0"]);
    std::fs::write(repo.join("t.txt"), "t, resolved\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "Merged PR 7: feat/t"]);
    sh(&repo, &["switch", "-q", "main"]);

    let o = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let b = o["branches"].as_array().unwrap().iter().find(|b| b["name"] == "feat/t").cloned().unwrap();
    assert_eq!(b["parent"], "release/2.0.0", "{b}");
    assert_eq!(b["merged"], true, "{b}");
    call(&k, "branches.delete", json!({ "projectId": pid, "branch": "feat/t" })).await;
    assert!(rev(&repo, "refs/heads/feat/t").is_empty());
}

#[tokio::test]
async fn squash_carrying_the_ticket_reads_as_likely_merged() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    sh(&repo, &["switch", "-qc", "release/3.0.0"]);
    commit_file(&repo, "r.txt", "r\n");
    sh(&repo, &["switch", "-qc", "feature/ABC-12-new-path", "main"]);
    commit_file(&repo, "path.txt", "draft\n");
    // The work went on elsewhere; that pull request's title names the ticket, not this branch.
    sh(&repo, &["switch", "-q", "release/3.0.0"]);
    std::fs::write(repo.join("path.txt"), "final\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "Merged PR 9: ABC-12_&_ABC-13 new path"]);
    sh(&repo, &["switch", "-q", "main"]);

    let o = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let b = o["branches"].as_array().unwrap().iter().find(|b| b["name"] == "feature/ABC-12-new-path").cloned().unwrap();
    assert_eq!(b["parent"], "release/3.0.0", "{b}");
    assert_eq!((b["merged"].clone(), b["likelyMerged"].clone()), (json!(true), json!(true)), "{b}");
    // A guess is not proof: the branch is not deleted as merged.
    let err = rpc::call(&k, "branches.delete", json!({ "projectId": pid, "branch": "feature/ABC-12-new-path" })).await.unwrap_err();
    assert!(err.to_string().contains("not merged"), "{err}");
}

#[tokio::test]
async fn a_branch_can_target_any_branch() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    sh(&repo, &["switch", "-qc", "feature/base"]);
    commit_file(&repo, "a.txt", "a\n");
    sh(&repo, &["switch", "-qc", "feature/on-top"]);
    commit_file(&repo, "b.txt", "b\n");
    sh(&repo, &["switch", "-q", "main"]);

    call(&k, "branches.setParent", json!({ "projectId": pid, "branch": "feature/on-top", "parent": "feature/base" })).await;
    let o = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let b = o["branches"].as_array().unwrap().iter().find(|b| b["name"] == "feature/on-top").cloned().unwrap();
    assert_eq!((b["parent"].clone(), b["ahead"].clone(), b["merged"].clone()), (json!("feature/base"), json!(1), json!(false)), "{b}");

    // Release branches and trunks can be re-targeted too.
    sh(&repo, &["branch", "release/5.0.0"]);
    sh(&repo, &["branch", "dev"]);
    call(&k, "branches.setParent", json!({ "projectId": pid, "branch": "release/5.0.0", "parent": "feature/base" })).await;
    call(&k, "branches.setParent", json!({ "projectId": pid, "branch": "dev", "parent": "release/5.0.0" })).await;
    let o = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let parent = |n: &str| o["branches"].as_array().unwrap().iter().find(|b| b["name"] == n).map(|b| b["parent"].clone()).unwrap();
    assert_eq!((parent("release/5.0.0"), parent("dev")), (json!("feature/base"), json!("release/5.0.0")));
    let rel = o["releases"].as_array().unwrap().iter().find(|r| r["version"] == "5.0.0").cloned().unwrap();
    assert_eq!(rel["open"], true, "still an open release: {rel}");
}

#[tokio::test]
async fn overview_after_a_commit_matches_a_fresh_build() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    for b in ["feature/a", "feature/b"] {
        sh(&repo, &["checkout", "-qb", b, "main"]);
        commit_file(&repo, &format!("{}.txt", &b[8..]), "1\n");
    }
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let pid = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string();
    call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let fresh = |home: &str| {
        let (repo, home) = (repo.clone(), tmp.path().join(home));
        async move {
            let k = Gitnetix::open(&home).unwrap();
            let pid = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string();
            call(&k, "workspace.overview", json!({ "projectId": pid })).await["branches"].clone()
        }
    };

    // Only feature/b moved: the rest comes from the last build.
    commit_file(&repo, "b.txt", "2\n");
    let o = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert_eq!(o["branches"], fresh("home2").await);
    let b = o["branches"].as_array().unwrap().iter().find(|b| b["name"] == "feature/b").cloned().unwrap();
    assert_eq!(b["ahead"], 2);

    // The base moved: every branch is weighed again.
    sh(&repo, &["checkout", "-q", "main"]);
    commit_file(&repo, "main.txt", "1\n");
    let o = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert_eq!(o["branches"], fresh("home3").await);
    let a = o["branches"].as_array().unwrap().iter().find(|b| b["name"] == "feature/a").cloned().unwrap();
    assert_eq!(a["behind"], 1);
}

#[tokio::test]
async fn untagged_release_ahead_of_main_reopens() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("reopen");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    call(&k, "releases.create", json!({ "projectId": pid, "version": "0.0.1", "kind": "next" })).await;
    sh(&repo, &["switch", "-q", "release/0.0.1"]);
    commit_file(&repo, "one.txt", "1\n");
    sh(&repo, &["switch", "-q", "main"]);
    call(&k, "releases.ship", json!({ "projectId": pid, "version": "0.0.1" })).await;
    let release = |ov: &Value| ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == "release/0.0.1").cloned().unwrap();

    // Tag deleted outside Gitnetix, branch still level with main: it did go out.
    sh(&repo, &["tag", "-d", "v0.0.1"]);
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert_eq!(release(&ov)["shipped"], "0.0.1");

    // New work on it that main lacks: back to an open release.
    sh(&repo, &["switch", "-q", "release/0.0.1"]);
    commit_file(&repo, "two.txt", "2\n");
    sh(&repo, &["switch", "-q", "main"]);
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert!(release(&ov)["shipped"].is_null());
    assert_eq!(release(&ov)["role"], "release");
    assert!(ov["releases"].as_array().unwrap().iter().any(|r| r["version"] == "0.0.1" && r["open"] == true && r["tag"] == "next"));
}

#[tokio::test]
async fn ship_and_push_waits_for_origin_then_pushes_branch_and_tag_together() {
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
    call(&k, "releases.create", json!({ "projectId": pid, "version": "0.2.0", "kind": "next" })).await;
    sh(&repo, &["switch", "-q", "release/0.2.0"]);
    commit_file(&repo, "a.txt", "a\n");
    sh(&repo, &["switch", "-q", "main"]);

    // A teammate lands work on origin's main meanwhile.
    let other = tmp.path().join("other");
    sh(tmp.path(), &["clone", "-q", origin.to_str().unwrap(), other.to_str().unwrap()]);
    sh(&other, &["config", "user.email", "o@example.com"]);
    sh(&other, &["config", "user.name", "Other"]);
    sh(&other, &["config", "commit.gpgsign", "false"]);
    commit_file(&other, "b.txt", "b\n");
    sh(&other, &["push", "-q", "origin", "main"]);

    // Refused before anything moves: no local main move, no tag.
    let main = rev(&repo, "main");
    let ship = json!({ "projectId": pid, "version": "0.2.0", "push": true });
    assert!(rpc::call(&k, "releases.ship", ship.clone()).await.is_err());
    assert_eq!(rev(&repo, "main"), main);
    assert_eq!(rev(&repo, "v0.2.0"), "");

    // Once the release has origin's work, main and the tag reach origin together.
    sh(&repo, &["switch", "-q", "release/0.2.0"]);
    sh(&repo, &["merge", "-q", "--no-edit", "origin/main"]);
    sh(&repo, &["switch", "-q", "main"]);
    // Uncommitted work in main's checkout to a file the release changes: refused, nothing moved.
    std::fs::write(repo.join("a.txt"), "mine\n").unwrap();
    let err = rpc::call(&k, "releases.ship", ship.clone()).await.unwrap_err();
    assert!(err.to_string().contains("a.txt"), "{err}");
    assert_eq!(rev(&repo, "main"), main);
    std::fs::remove_file(repo.join("a.txt")).unwrap();
    // Unrelated work, staged or not, stays through the ship.
    std::fs::write(repo.join("notes.txt"), "wip\n").unwrap();
    std::fs::write(repo.join("staged.txt"), "s\n").unwrap();
    sh(&repo, &["add", "staged.txt"]);
    call(&k, "releases.ship", ship).await;
    let tip = rev(&repo, "release/0.2.0");
    assert_eq!(rev(&origin, "main"), tip);
    assert_eq!(rev(&origin, "v0.2.0^{commit}"), tip);
    assert_eq!(std::fs::read_to_string(repo.join("notes.txt")).unwrap(), "wip\n");
    assert!(git_out(&repo, &["diff", "--cached", "--name-only"]).contains("staged.txt"));
}

#[tokio::test]
async fn dialog_prefs_default_and_save() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    // Finishing a worktree session merges unless the project's settings say otherwise.
    let cfg = call(&k, "config.get", json!({})).await;
    assert_eq!(cfg["projects"][0]["dialogs"]["finish"], "merge");

    call(&k, "projects.setPrefs", json!({ "projectId": pid, "dialogs": { "finish": "continue", "deleteOrigin": true } })).await;
    let d = call(&k, "config.get", json!({})).await["projects"][0]["dialogs"].clone();
    assert_eq!(
        (d["finish"].as_str(), d["deleteOrigin"].as_bool(), d["shipPush"].as_bool(), d["shipChangelog"].as_bool()),
        (Some("continue"), Some(true), Some(true), Some(true))
    );
    let err = rpc::call(&k, "projects.setPrefs", json!({ "projectId": pid, "dialogs": { "finish": "later" } })).await.unwrap_err();
    assert!(err.to_string().contains("unknown variant"), "{err}");
}

#[tokio::test]
async fn rename_on_origin_and_follow_it_elsewhere() {
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

    // A work branch: renamed on origin in one push, tracking the new name.
    sh(&repo, &["switch", "-qc", "feat/a"]);
    commit_file(&repo, "a.txt", "a\n");
    sh(&repo, &["push", "-q", "-u", "origin", "feat/a"]);
    let tip = rev(&repo, "feat/a");
    std::fs::write(repo.join("wip.txt"), "wip\n").unwrap();
    sh(&repo, &["stash", "push", "-q", "-u", "-m", "half done"]);
    call(&k, "branches.rename", json!({ "projectId": pid, "branch": "feat/a", "name": "feat/b", "remote": true })).await;
    assert_eq!(rev(&origin, "refs/heads/feat/b"), tip);
    assert!(rev(&origin, "refs/heads/feat/a").is_empty());
    assert!(rev(&repo, "refs/remotes/origin/feat/a").is_empty());
    assert_eq!(git_out(&repo, &["rev-parse", "--abbrev-ref", "feat/b@{upstream}"]).trim(), "origin/feat/b");
    assert_eq!(git_out(&repo, &["branch", "--show-current"]).trim(), "feat/b");
    // The stash made before still names feat/a: it shows under feat/b.
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    assert_eq!(ov["stashes"][0]["branch"], "feat/b");
    assert_eq!(ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == "feat/b").unwrap()["stashes"], 1);

    // A name origin already has is refused, and nothing moves.
    sh(&repo, &["push", "-q", "origin", "main:refs/heads/feat/taken"]);
    let err = rpc::call(&k, "branches.rename", json!({ "projectId": pid, "branch": "feat/b", "name": "feat/taken", "remote": true })).await.unwrap_err();
    assert!(err.to_string().contains("origin already has feat/taken"), "{err}");
    assert_eq!(rev(&origin, "refs/heads/feat/b"), tip);
    // A detached worktree deleted outside git (still listed, prunable) is skipped, not an error.
    let gone = tmp.path().join("gone");
    sh(&repo, &["worktree", "add", "-q", "--detach", gone.to_str().unwrap(), "main"]);
    std::fs::remove_dir_all(&gone).unwrap();
    // Mid-rebase, HEAD detached: refused before origin moves, as git would refuse the local rename.
    // Output captured: git's "execution failed" warning stays out of the test log.
    let stopped = Command::new("git").current_dir(&repo).args(["rebase", "-q", "-f", "-x", "false", "main"]).output().unwrap();
    assert!(!stopped.status.success());
    let err = rpc::call(&k, "branches.rename", json!({ "projectId": pid, "branch": "feat/b", "name": "feat/r", "remote": true })).await.unwrap_err();
    assert!(err.to_string().contains("middle of a rebase"), "{err}");
    assert_eq!(rev(&origin, "refs/heads/feat/b"), tip);
    sh(&repo, &["rebase", "--abort"]);
    sh(&repo, &["switch", "-q", "main"]);

    // An open release takes its new version along, with its branches and planned tickets.
    call(&k, "releases.create", json!({ "projectId": pid, "version": "2.4.0", "kind": "next" })).await;
    sh(&repo, &["switch", "-q", "release/2.4.0"]);
    commit_file(&repo, "CHANGELOG.md", "## [Unreleased]\n\n## [2.4.0] - 2026-10-20\n- Login.\n\n## [2.3.0]\n- Old.\n");
    sh(&repo, &["switch", "-q", "main"]);
    sh(&repo, &["push", "-q", "-u", "origin", "release/2.4.0"]);
    call(&k, "items.attach", json!({ "projectId": pid, "branch": "feat/b", "release": "2.4.0", "kind": "feat" })).await;
    call(&k, "tickets.setRelease", json!({ "projectId": pid, "key": "ATL-1", "release": "2.4.0" })).await;
    let err = rpc::call(&k, "branches.rename", json!({ "projectId": pid, "branch": "release/2.4.0", "name": "feat/x", "remote": true })).await.unwrap_err();
    assert!(err.to_string().contains("release/<version>"), "{err}");
    let r = call(&k, "branches.rename", json!({ "projectId": pid, "branch": "release/2.4.0", "name": "release/2.5.0", "remote": true })).await;
    assert!(rev(&origin, "refs/heads/release/2.4.0").is_empty());
    // Its changelog section follows, in a commit on the branch left for the user to push.
    assert_eq!(r["changelog"], true);
    assert_eq!(git_out(&repo, &["show", "release/2.5.0:CHANGELOG.md"]), "## [Unreleased]\n\n## [2.5.0] - 2026-10-20\n- Login.\n\n## [2.3.0]\n- Old.\n");
    assert_eq!(git_out(&repo, &["log", "-1", "--format=%s", "release/2.5.0"]).trim(), "docs(changelog): v2.4.0 is now v2.5.0");
    let ov = call(&k, "workspace.overview", json!({ "projectId": pid })).await;
    let open: Vec<&Value> = ov["releases"].as_array().unwrap().iter().filter(|r| r["open"] == true).collect();
    assert_eq!(open.len(), 1, "{ov}");
    assert_eq!((open[0]["version"].as_str(), open[0]["branch"].as_str()), (Some("2.5.0"), Some("release/2.5.0")));
    assert_eq!(open[0]["items"][0]["name"], "feat/b");
    assert_eq!(ov["project"]["ticketReleases"]["ATL-1"], "2.5.0");

    // A teammate's copy: its upstream is gone after a fetch, and it follows the rename.
    let mate = tmp.path().join("mate");
    sh(tmp.path(), &["clone", "-q", origin.to_str().unwrap(), mate.to_str().unwrap()]);
    sh(&mate, &["switch", "-q", "feat/b"]);
    sh(&mate, &["switch", "-q", "main"]);
    let added = call(&k, "projects.add", json!({ "paths": [mate.to_string_lossy()] })).await;
    let mid = added[0]["id"].as_str().unwrap().to_string();
    call(&k, "branches.rename", json!({ "projectId": pid, "branch": "feat/b", "name": "feat/c", "remote": true })).await;
    sh(&mate, &["fetch", "-q", "--prune", "origin"]);
    let ov = call(&k, "workspace.overview", json!({ "projectId": mid })).await;
    let b = ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == "feat/b").unwrap().clone();
    assert_eq!(b["renamedTo"], "feat/c", "{b}");
    call(&k, "branches.rename", json!({ "projectId": mid, "branch": "feat/b", "name": "feat/c" })).await;
    assert_eq!(git_out(&mate, &["rev-parse", "--abbrev-ref", "feat/c@{upstream}"]).trim(), "origin/feat/c");
    assert!(rev(&mate, "refs/heads/feat/b").is_empty());

    // Renamed here only: origin keeps feat/c, which feat/d no longer tracks.
    sh(&mate, &["switch", "-q", "feat/c"]);
    std::fs::write(mate.join("wip.txt"), "wip\n").unwrap();
    sh(&mate, &["-c", "user.name=T", "-c", "user.email=t@example.com", "stash", "push", "-q", "-u"]);
    sh(&mate, &["switch", "-q", "main"]);
    call(&k, "branches.rename", json!({ "projectId": mid, "branch": "feat/c", "name": "feat/d" })).await;
    assert!(git_out(&mate, &["for-each-ref", "--format=%(upstream)", "refs/heads/feat/d"]).trim().is_empty());
    assert!(!rev(&origin, "refs/heads/feat/c").is_empty());
    // Its stash follows, though origin still has a feat/c.
    let ov = call(&k, "workspace.overview", json!({ "projectId": mid })).await;
    assert_eq!(ov["stashes"][0]["branch"], "feat/d", "{}", ov["stashes"]);
    // A branch still tracking another name (renamed before this fix) tracks what it pushed.
    sh(&mate, &["branch", "-q", "-u", "origin/feat/c", "feat/d"]);
    call(&k, "workspace.push", json!({ "projectId": mid, "branch": "feat/d" })).await;
    assert_eq!(git_out(&mate, &["rev-parse", "--abbrev-ref", "feat/d@{upstream}"]).trim(), "origin/feat/d");
}

#[tokio::test]
async fn stage_nested_repo_and_discard_staged_rename() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("atlas-api");
    init_repo(&repo);
    commit_file(&repo, "a.txt", "one\n");
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let wip = || call(&k, "workspace.files", json!({ "projectId": pid, "branch": "main", "mode": "wip" }));

    // A nested repository is listed as `sub/` and staged as a gitlink; unstaging drops it again.
    let sub = repo.join("sub");
    std::fs::create_dir(&sub).unwrap();
    sh(&sub, &["init", "-q"]);
    std::fs::write(sub.join("z"), "z\n").unwrap();
    sh(&sub, &["add", "."]);
    sh(&sub, &["-c", "user.email=t@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", "commit", "-qm", "z"]);
    assert_eq!(wip().await[0]["path"], "sub/");
    call(&k, "workspace.stage", json!({ "projectId": pid, "branch": "main", "paths": ["sub/"] })).await;
    assert!(git_out(&repo, &["ls-files", "-s", "sub"]).starts_with("160000 "));
    call(&k, "workspace.unstage", json!({ "projectId": pid, "branch": "main", "paths": ["sub"] })).await;
    assert!(git_out(&repo, &["ls-files", "sub"]).is_empty());
    std::fs::remove_dir_all(&sub).unwrap();

    // Discarding a staged rename brings its old path back.
    sh(&repo, &["mv", "a.txt", "b.txt"]);
    call(&k, "workspace.discard", json!({ "projectId": pid, "branch": "main", "staged": true, "paths": ["b.txt"] })).await;
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\n");
    assert!(!repo.join("b.txt").exists());
    assert!(wip().await.as_array().unwrap().is_empty());
}
