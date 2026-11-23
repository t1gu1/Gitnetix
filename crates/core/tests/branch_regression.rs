//! Branch regression suite: the branch, commit and worktree flows the branch map drives, through the RPC calls
//! the UI makes. Each test is a case of `list-of-test.md` at the repo root; its ID starts the name (BR-03 is
//! `br03_…`). One case: `cargo test -p gitnetix-core --test branch_regression br03`.
//!
//! Suggested actions (SA-*) are picked in the UI (`primary` in `src/screens/BranchMenu.tsx`) from the branch view's
//! flags. These tests check the flags each suggestion reads, and the call the suggestion makes.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

fn sh(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap().stdout;
    String::from_utf8(out).unwrap().trim_end().to_string()
}

fn rev(dir: &Path, r: &str) -> String {
    git_out(dir, &["rev-parse", "--verify", "-q", r])
}

fn is_ancestor(dir: &Path, a: &str, b: &str) -> bool {
    Command::new("git").current_dir(dir).args(["merge-base", "--is-ancestor", a, b]).status().unwrap().success()
}

fn commit_file(dir: &Path, file: &str, body: &str) {
    std::fs::write(dir.join(file), body).unwrap();
    sh(dir, &["add", file]);
    sh(dir, &["commit", "-qm", &format!("edit {file}")]);
}

fn config(dir: &Path, email: &str) {
    for (k, v) in [("user.email", email), ("user.name", "Test"), ("commit.gpgsign", "false"), ("tag.gpgsign", "false"), ("core.autocrlf", "false"), ("core.longpaths", "true")] {
        sh(dir, &["config", k, v]);
    }
}

/// A repo on `main` (one commit) pushed to a bare origin, opened in a fresh Gitnetix home.
struct Env {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    repo: PathBuf,
    origin: PathBuf,
    k: Arc<Gitnetix>,
    pid: String,
}

async fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let origin = root.join("origin.git");
    sh(&root, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    let repo = root.join("repo");
    std::fs::create_dir(&repo).unwrap();
    sh(&repo, &["init", "-q", "-b", "main"]);
    config(&repo, "t@example.com");
    sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
    commit_file(&repo, "README.md", "# repo\n");
    sh(&repo, &["push", "-q", "-u", "origin", "main"]);
    let k = Gitnetix::open(&root.join("home")).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap();
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let e = Env { _tmp: tmp, root, repo, origin, k, pid };
    // Whatever AI the machine has stays out: conflicts are left to the test.
    e.call("projects.setPrefs", json!({ "merge": { "resolveConflicts": false } })).await;
    e
}

impl Env {
    fn params(&self, mut p: Value) -> Value {
        p["projectId"] = json!(self.pid);
        p
    }

    async fn call(&self, m: &str, p: Value) -> Value {
        match rpc::call(&self.k, m, self.params(p)).await {
            Ok(v) => v,
            Err(e) => panic!("{m}: {e}"),
        }
    }

    /// The error of a call that has to be refused.
    async fn refused(&self, m: &str, p: Value) -> String {
        match rpc::call(&self.k, m, self.params(p)).await {
            Ok(v) => panic!("{m} went through: {v}"),
            Err(e) => e.to_string(),
        }
    }

    /// The branch as the branch map gets it.
    async fn view(&self, branch: &str) -> Value {
        let ov = self.call("workspace.overview", json!({})).await;
        ov["branches"].as_array().unwrap().iter().find(|b| b["name"] == branch).cloned().unwrap_or_else(|| panic!("no {branch} in {ov:#}"))
    }

    /// A teammate's clone, checked out on `branch`.
    fn teammate(&self, branch: &str) -> PathBuf {
        let other = self.root.join("other");
        sh(&self.root, &["clone", "-q", "-b", branch, self.origin.to_str().unwrap(), other.to_str().unwrap()]);
        config(&other, "o@example.com");
        other
    }

    fn head(&self, dir: &Path) -> String {
        git_out(dir, &["symbolic-ref", "--short", "-q", "HEAD"])
    }
}

fn status(dir: &Path) -> String {
    git_out(dir, &["status", "--porcelain"])
}

// ---------------------------------------------------------------- Branches

/// BR-01: a new branch off main is checked out and filed under main. Deleting it is refused while it holds
/// commits main lacks, forced after; a merged one goes without force, on origin too.
#[tokio::test]
async fn br01_create_switch_and_delete_a_branch() {
    let e = env().await;
    let r = e.call("items.create", json!({ "from": "main", "kind": "feat", "description": "login", "branchName": "feat/login", "where": "switch" })).await;
    assert_eq!(r["branch"], "feat/login", "{r}");
    assert_eq!(e.head(&e.repo), "feat/login");
    let v = e.view("feat/login").await;
    assert_eq!((v["parent"].as_str(), v["checkedOut"].as_bool(), v["local"].as_bool()), (Some("main"), Some(true), Some(true)), "{v}");

    commit_file(&e.repo, "login.txt", "login\n");
    e.call("workspace.switch", json!({ "branch": "main" })).await;
    let why = e.refused("branches.delete", json!({ "branch": "feat/login" })).await;
    assert_eq!(rev(&e.repo, "refs/heads/feat/login").len(), 40, "refused ({why}): the branch stays");
    e.call("branches.delete", json!({ "branch": "feat/login", "force": true })).await;
    assert!(rev(&e.repo, "refs/heads/feat/login").is_empty());

    e.call("items.create", json!({ "from": "main", "kind": "feat", "description": "done", "branchName": "feat/done", "where": "switch" })).await;
    e.call("workspace.push", json!({ "branch": "feat/done" })).await;
    assert_eq!(rev(&e.origin, "refs/heads/feat/done").len(), 40);
    e.call("workspace.switch", json!({ "branch": "main" })).await;
    e.call("branches.delete", json!({ "branch": "feat/done", "remote": true })).await;
    assert!(rev(&e.repo, "refs/heads/feat/done").is_empty());
    assert!(rev(&e.origin, "refs/heads/feat/done").is_empty(), "gone on origin too");
}

/// BR-02: staging picks what the commit takes; Stage & commit takes everything. The first push publishes the
/// branch and sets its upstream; a later commit waits to be pushed, then goes.
#[tokio::test]
async fn br02_stage_commit_and_push_a_new_branch() {
    let e = env().await;
    sh(&e.repo, &["switch", "-qc", "feat/x"]);
    std::fs::write(e.repo.join("a.txt"), "a\n").unwrap();
    std::fs::write(e.repo.join("b.txt"), "b\n").unwrap();
    assert_eq!(e.view("feat/x").await["wip"], 2);

    e.call("workspace.stage", json!({ "branch": "feat/x", "paths": ["a.txt"] })).await;
    e.call("workspace.commit", json!({ "branch": "feat/x", "message": "feat: a" })).await;
    assert_eq!(git_out(&e.repo, &["show", "--name-only", "--format=", "HEAD"]), "a.txt", "only the staged file");
    assert_eq!(git_out(&e.repo, &["log", "-1", "--format=%s"]), "feat: a");
    assert_eq!(status(&e.repo), "?? b.txt");

    e.call("workspace.commit", json!({ "branch": "feat/x", "message": "feat: b", "all": true })).await;
    assert_eq!(status(&e.repo), "", "Stage & commit leaves nothing behind");
    let v = e.view("feat/x").await;
    assert_eq!((v["ahead"].as_u64(), v["wip"].as_u64(), v["upstream"].is_null()), (Some(2), Some(0), true), "{v}");

    e.call("workspace.push", json!({ "branch": "feat/x" })).await;
    assert_eq!(rev(&e.origin, "feat/x"), rev(&e.repo, "feat/x"));
    let v = e.view("feat/x").await;
    assert_eq!((v["upstream"].as_str(), v["upstreamAhead"].as_u64()), (Some("origin/feat/x"), Some(0)), "{v}");

    commit_file(&e.repo, "c.txt", "c\n");
    assert_eq!(e.view("feat/x").await["upstreamAhead"], 1, "the map suggests Push");
    e.call("workspace.push", json!({ "branch": "feat/x" })).await;
    assert_eq!(rev(&e.origin, "feat/x"), rev(&e.repo, "feat/x"));
}

/// BR-03 (+ SA-01, SA-04): main moved on, so the branch is behind its parent and the map suggests Rebase. The
/// rebase (the node line's update button) puts it on main. It was pushed before, so the map now suggests Force
/// push: a plain push is refused, a forced one replaces origin's copy.
#[tokio::test]
async fn br03_rebase_on_parent_from_the_node_button() {
    let e = env().await;
    sh(&e.repo, &["switch", "-qc", "feat/a"]);
    commit_file(&e.repo, "a.txt", "a\n");
    e.call("workspace.push", json!({ "branch": "feat/a" })).await;
    sh(&e.repo, &["switch", "-q", "main"]);
    commit_file(&e.repo, "main.txt", "m\n");
    sh(&e.repo, &["switch", "-q", "feat/a"]);

    let v = e.view("feat/a").await;
    let flags = |v: &Value| (v["behind"].as_u64(), v["ahead"].as_u64(), v["upstreamBehind"].as_u64(), v["upstreamAhead"].as_u64(), v["wip"].as_u64());
    assert_eq!(flags(&v), (Some(1), Some(1), Some(0), Some(0), Some(0)), "SA-01, behind main only: {v}");

    let r = e.call("workspace.rebase", json!({ "branch": "feat/a" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r}");
    assert!(is_ancestor(&e.repo, "main", "feat/a"));
    assert!(!r["forcePushTo"].is_null(), "already on origin: {r}");
    assert_eq!(e.head(&e.repo), "feat/a");

    let v = e.view("feat/a").await;
    assert_eq!((v["behind"].as_u64(), v["ahead"].as_u64(), v["rewritten"].as_bool()), (Some(0), Some(1), Some(true)), "SA-04: {v}");
    e.refused("workspace.push", json!({ "branch": "feat/a" })).await;
    e.call("workspace.push", json!({ "branch": "feat/a", "force": true })).await;
    assert_eq!(rev(&e.origin, "feat/a"), rev(&e.repo, "feat/a"));
}

/// BR-04: main → feat/a → feat/b → feat/c (each child made from its parent with New branch), and main moved
/// on. feat/a is rebased onto main, then the "Update the branches under it" dialog runs: pin each child to its
/// parent, rebase parents first. Every branch ends on its updated parent, each commit once, the checked-out one
/// too. A child made with a plain `git switch -c` has no declared parent: once it has a commit, the map files it under
/// the branch it was made from, found from history.
#[tokio::test]
async fn br04_group_update_rebases_each_child_onto_its_updated_parent() {
    let e = env().await;
    sh(&e.repo, &["switch", "-qc", "feat/a"]);
    commit_file(&e.repo, "a.txt", "x\n");
    for (b, from) in [("feat/b", "feat/a"), ("feat/c", "feat/b")] {
        e.call("items.create", json!({ "from": from, "kind": "feat", "description": "", "branchName": b, "where": "switch" })).await;
        commit_file(&e.repo, &format!("{}.txt", &b[5..]), "x\n");
    }
    sh(&e.repo, &["switch", "-q", "main"]);
    commit_file(&e.repo, "main.txt", "m\n");
    // The deepest one is checked out: it rebases in place, the others in throwaway worktrees.
    sh(&e.repo, &["switch", "-q", "feat/c"]);
    assert_eq!(e.view("feat/b").await["parent"], "feat/a");
    assert_eq!(e.view("feat/c").await["parent"], "feat/b");

    let r = e.call("workspace.rebase", json!({ "branch": "feat/a" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r}");
    // The dialog lists the children from the parents the map showed: rebasing feat/a must not move them elsewhere.
    assert_eq!(e.view("feat/b").await["parent"], "feat/a", "feat/b still under feat/a once it is rebased");

    for (b, parent) in [("feat/b", "feat/a"), ("feat/c", "feat/b")] {
        e.call("branches.setParent", json!({ "branch": b, "parent": parent })).await;
    }
    for b in ["feat/b", "feat/c"] {
        let r = e.call("workspace.rebase", json!({ "branch": b })).await;
        assert_eq!(r["conflicts"], json!([]), "{b}: {r}");
    }

    assert!(is_ancestor(&e.repo, "main", "feat/a"));
    assert!(is_ancestor(&e.repo, "feat/a", "feat/b"));
    assert!(is_ancestor(&e.repo, "feat/b", "feat/c"));
    assert_eq!(git_out(&e.repo, &["log", "--format=%s", "main..feat/c"]), "edit c.txt\nedit b.txt\nedit a.txt", "old copies dropped");
    for (b, parent) in [("feat/a", "main"), ("feat/b", "feat/a"), ("feat/c", "feat/b")] {
        let v = e.view(b).await;
        assert_eq!((v["parent"].as_str(), v["behind"].as_u64()), (Some(parent), Some(0)), "{b}: {v}");
    }
    assert_eq!(e.head(&e.repo), "feat/c");
    assert_eq!(status(&e.repo), "");

    sh(&e.repo, &["switch", "-qc", "feat/d"]);
    commit_file(&e.repo, "d.txt", "x\n");
    assert_eq!(e.view("feat/d").await["parent"], "feat/c");
}

/// BR-22: main ships to prod by merge commits, so prod is behind main and holds the release tag. The map starts from
/// prod with main under it; staging, level with main, stays under main, and so does a dev further behind than prod
/// (dev branches are ahead by design). Main's actions still treat it as the default branch: a merge has nowhere to go.
#[tokio::test]
async fn br22_least_advanced_trunk_is_the_root() {
    let e = env().await;
    sh(&e.repo, &["branch", "prod"]);
    sh(&e.repo, &["switch", "-qc", "dev"]);
    commit_file(&e.repo, "dev.txt", "d\n");
    sh(&e.repo, &["switch", "-q", "main"]);
    for f in ["a.txt", "b.txt", "c.txt"] {
        commit_file(&e.repo, f, "x\n");
    }
    sh(&e.repo, &["branch", "staging"]);
    sh(&e.repo, &["switch", "-q", "prod"]);
    sh(&e.repo, &["merge", "-q", "--no-ff", "-m", "Merge main into prod", "main~2"]);
    sh(&e.repo, &["tag", "v1.0.0"]);
    sh(&e.repo, &["switch", "-q", "main"]);
    sh(&e.repo, &["push", "-q", "origin", "main", "prod", "staging", "dev", "v1.0.0"]);

    let (prod, main) = (e.view("prod").await, e.view("main").await);
    assert_eq!((prod["parent"].as_str(), prod["role"].as_str(), prod["lastTag"].as_str()), (None, Some("trunk"), Some("v1.0.0")), "{prod}");
    assert_eq!((main["parent"].as_str(), main["role"].as_str()), (Some("prod"), Some("trunk")), "{main}");
    // b and c are not in prod yet; prod's merge commit is not in main.
    assert_eq!((main["ahead"].as_u64(), main["behind"].as_u64()), (Some(2), Some(1)), "{main}");
    assert_eq!(e.view("staging").await["parent"], "main");
    assert_eq!(e.view("dev").await["parent"], "main");

    let err = e.refused("branches.merge", json!({ "branch": "main" })).await;
    assert!(err.contains("no other branch to merge into"), "{err}");
    assert!(!is_ancestor(&e.repo, "main", "prod"), "main went into prod");

    // Level with main, prod still goes first: it is the one tagged.
    sh(&e.repo, &["switch", "-q", "prod"]);
    sh(&e.repo, &["merge", "-q", "--no-ff", "-m", "Merge main into prod", "main"]);
    sh(&e.repo, &["switch", "-q", "main"]);
    assert_eq!(e.view("prod").await["parent"], Value::Null);
    assert_eq!(e.view("main").await["parent"], "prod");
}

// ---------------------------------------------------------------- Suggested actions

/// feat/x pushed with a.txt, then a teammate pushes `theirs` (file, body) on top, fetched here.
async fn teammate_pushed(e: &Env, theirs: (&str, &str)) {
    sh(&e.repo, &["switch", "-qc", "feat/x"]);
    commit_file(&e.repo, "a.txt", "a\n");
    e.call("workspace.push", json!({ "branch": "feat/x" })).await;
    let other = e.teammate("feat/x");
    commit_file(&other, theirs.0, theirs.1);
    sh(&other, &["push", "-q", "origin", "feat/x"]);
    e.call("branches.fetch", json!({})).await;
}

/// SA-02: a teammate pushed to the branch and it has nothing of its own, so the map suggests "Reset to origin".
/// The reset fast-forwards it.
#[tokio::test]
async fn sa02_origin_moved_on_offers_reset_to_origin() {
    let e = env().await;
    teammate_pushed(&e, ("t.txt", "t\n")).await;
    let v = e.view("feat/x").await;
    assert_eq!((v["upstreamBehind"].as_u64(), v["upstreamAhead"].as_u64(), v["wip"].as_u64()), (Some(1), Some(0), Some(0)), "{v}");

    let r = e.call("branches.reset", json!({ "branch": "feat/x", "safe": true })).await;
    assert_eq!(r["conflicts"], json!([]), "{r}");
    assert_eq!(rev(&e.repo, "feat/x"), rev(&e.origin, "feat/x"));
    assert!(e.repo.join("t.txt").exists());
    assert_eq!(e.view("feat/x").await["upstreamBehind"], 0);
}

/// SA-11: same as SA-02 with uncommitted changes: the map still suggests "Reset to origin". The changes (an edit
/// and a new file) are stashed, the branch reset, the changes put back on top, the stash dropped. When putting them
/// back conflicts with origin's copy, the files are left in conflict and the stash is kept.
#[tokio::test]
async fn sa11_reset_to_origin_puts_uncommitted_changes_back() {
    let e = env().await;
    teammate_pushed(&e, ("t.txt", "t\n")).await;
    std::fs::write(e.repo.join("a.txt"), "edited\n").unwrap();
    std::fs::write(e.repo.join("new.txt"), "new\n").unwrap();
    let v = e.view("feat/x").await;
    assert_eq!((v["upstreamBehind"].as_u64(), v["upstreamAhead"].as_u64(), v["wip"].as_u64()), (Some(1), Some(0), Some(2)), "{v}");

    let r = e.call("branches.reset", json!({ "branch": "feat/x", "safe": true })).await;
    assert_eq!(r["conflicts"], json!([]), "{r}");
    assert_eq!(rev(&e.repo, "feat/x"), rev(&e.origin, "feat/x"));
    assert!(e.repo.join("t.txt").exists());
    assert_eq!(std::fs::read_to_string(e.repo.join("a.txt")).unwrap(), "edited\n");
    assert_eq!(std::fs::read_to_string(e.repo.join("new.txt")).unwrap(), "new\n");
    assert_eq!(git_out(&e.repo, &["stash", "list"]), "", "stash dropped");

    // The teammate changed a.txt too: the edit put back conflicts with theirs.
    let e = env().await;
    teammate_pushed(&e, ("a.txt", "theirs\n")).await;
    std::fs::write(e.repo.join("a.txt"), "mine\n").unwrap();
    let r = e.call("branches.reset", json!({ "branch": "feat/x", "safe": true })).await;
    assert_eq!(r["conflicts"], json!(["a.txt"]), "{r}");
    assert_eq!(rev(&e.repo, "feat/x"), rev(&e.origin, "feat/x"));
    assert_eq!(git_out(&e.repo, &["stash", "list"]).lines().count(), 1, "stash kept");
    assert!(std::fs::read_to_string(e.repo.join("a.txt")).unwrap().contains("mine"), "the edit is in the conflict");
}

// ---------------------------------------------------------------- Commits

/// CM-02: reset to a commit keeps the dropped change staged (soft), unstaged (mixed), or drops it (hard).
#[tokio::test]
async fn cm02_reset_soft_mixed_hard() {
    let e = env().await;
    let base = rev(&e.repo, "HEAD");
    sh(&e.repo, &["switch", "-qc", "feat/r"]);
    commit_file(&e.repo, "README.md", "# changed\n");
    let reset = |mode: &'static str| e.call("commits.reset", json!({ "branch": "feat/r", "sha": base, "mode": mode }));

    reset("soft").await;
    assert_eq!((rev(&e.repo, "HEAD"), status(&e.repo)), (base.clone(), "M  README.md".into()), "soft: staged");
    sh(&e.repo, &["commit", "-qm", "again"]);
    reset("mixed").await;
    assert_eq!((rev(&e.repo, "HEAD"), status(&e.repo)), (base.clone(), " M README.md".into()), "mixed: unstaged");
    sh(&e.repo, &["commit", "-qam", "again"]);
    reset("hard").await;
    assert_eq!((rev(&e.repo, "HEAD"), status(&e.repo)), (base.clone(), String::new()), "hard: gone");
    assert_eq!(std::fs::read_to_string(e.repo.join("README.md")).unwrap(), "# repo\n");
}

/// CM-12: a branch reset onto a shipped release's commit, from that release's list on the trunk, is marked to start
/// there: the map gets the release that shipped the commit and keeps it unmerged. A branch made from a tag is too. A branch
/// at an old commit without the mark (merged long ago) is not, and a marked one reset past the latest tag stops being.
#[tokio::test]
async fn cm12_reset_onto_a_shipped_commit_starts_from_that_release() {
    let e = env().await;
    sh(&e.repo, &["tag", "-a", "v1.0.0", "-m", "v1.0.0"]);
    let v1 = rev(&e.repo, "HEAD");
    commit_file(&e.repo, "a.txt", "a\n");
    let inside = rev(&e.repo, "HEAD");
    commit_file(&e.repo, "b.txt", "b\n");
    sh(&e.repo, &["tag", "-a", "v1.1.0", "-m", "v1.1.0"]);
    commit_file(&e.repo, "c.txt", "c\n");
    sh(&e.repo, &["push", "-q", "--follow-tags", "origin", "main"]);
    sh(&e.repo, &["branch", "feat/old", &inside]);
    e.call("items.create", json!({ "from": "main", "kind": "feat", "description": "", "branchName": "feat/debug", "where": "switch" })).await;

    e.call("commits.reset", json!({ "branch": "feat/debug", "sha": inside, "mode": "hard", "shipped": true })).await;
    assert_eq!(rev(&e.repo, "HEAD"), inside);
    let v = e.view("feat/debug").await;
    assert_eq!(v["fork"], json!({ "tag": "v1.1.0", "sha": inside }), "{v}");
    assert_eq!((v["merged"].as_bool(), v["behind"].as_u64()), (Some(false), Some(2)), "{v}");
    assert_eq!(e.view("feat/old").await["fork"], Value::Null, "no mark, no line from the trunk");

    e.call("items.create", json!({ "from": "v1.0.0", "kind": "fix", "description": "", "branchName": "fix/at-tag", "where": "switch" })).await;
    let v = e.view("fix/at-tag").await;
    assert_eq!((v["fork"].clone(), v["merged"].as_bool()), (json!({ "tag": "v1.0.0", "sha": v1 }), Some(false)), "{v}");

    sh(&e.repo, &["switch", "-q", "feat/debug"]);
    e.call("commits.reset", json!({ "branch": "feat/debug", "sha": rev(&e.repo, "main"), "mode": "hard" })).await;
    assert_eq!(e.view("feat/debug").await["fork"], Value::Null, "back past the latest tag");
}

/// CM-13: "Create a branch from that commit" in a commit list. The branch starts at the commit and merges into the list's
/// branch; from a shipped release's commit it is marked like a branch made from a tag. A bad commit id makes nothing.
#[tokio::test]
async fn cm13_create_a_branch_from_a_commit() {
    let e = env().await;
    commit_file(&e.repo, "a.txt", "a\n");
    let inside = rev(&e.repo, "HEAD");
    commit_file(&e.repo, "b.txt", "b\n");
    sh(&e.repo, &["tag", "-a", "v1.0.0", "-m", "v1.0.0"]);
    commit_file(&e.repo, "c.txt", "c\n");
    sh(&e.repo, &["push", "-q", "--follow-tags", "origin", "main"]);
    sh(&e.repo, &["switch", "-qc", "feat/a"]);
    commit_file(&e.repo, "d.txt", "d\n");
    let first = rev(&e.repo, "HEAD");
    commit_file(&e.repo, "e.txt", "e\n");

    e.call("items.create", json!({ "from": "feat/a", "at": first, "kind": "feat", "description": "", "branchName": "feat/b", "where": "switch" })).await;
    assert_eq!(rev(&e.repo, "HEAD"), first);
    let v = e.view("feat/b").await;
    assert_eq!((v["parent"].as_str(), v["checkedOut"].as_bool(), v["fork"].clone()), (Some("feat/a"), Some(true), Value::Null), "{v}");

    e.call("items.create", json!({ "from": "main", "at": inside, "shipped": true, "kind": "fix", "description": "", "branchName": "fix/old", "where": "switch" })).await;
    assert_eq!(rev(&e.repo, "HEAD"), inside);
    let v = e.view("fix/old").await;
    assert_eq!((v["parent"].as_str(), v["fork"].clone()), (Some("main"), json!({ "tag": "v1.0.0", "sha": inside })), "{v}");

    e.refused("items.create", json!({ "from": "main", "at": "not-a-sha", "kind": "fix", "description": "", "branchName": "fix/bad", "where": "switch" })).await;
    e.refused("items.create", json!({ "from": "main", "at": "deadbeef", "kind": "fix", "description": "", "branchName": "fix/gone", "where": "switch" })).await;
    assert_eq!(git_out(&e.repo, &["branch", "--list", "fix/bad", "fix/gone"]), "");
}

/// CM-03: a pushed branch reset back a commit from the commit list. The map suggests Force push: a plain push
/// is refused, a forced one moves origin back too.
#[tokio::test]
async fn cm03_reset_a_pushed_branch_then_force_push() {
    let e = env().await;
    sh(&e.repo, &["switch", "-qc", "feat/r"]);
    commit_file(&e.repo, "a.txt", "a\n");
    commit_file(&e.repo, "b.txt", "b\n");
    e.call("workspace.push", json!({ "branch": "feat/r" })).await;
    let first = rev(&e.repo, "feat/r~1");

    e.call("commits.reset", json!({ "branch": "feat/r", "sha": first, "mode": "hard" })).await;
    let v = e.view("feat/r").await;
    assert_eq!((v["upstreamAhead"].as_u64(), v["upstreamBehind"].as_u64(), v["rewritten"].as_bool()), (Some(0), Some(1), Some(true)), "{v}");
    e.refused("workspace.push", json!({ "branch": "feat/r" })).await;
    e.call("workspace.push", json!({ "branch": "feat/r", "force": true })).await;
    assert_eq!(rev(&e.origin, "feat/r"), first);
}

/// CM-09: a branch pushed to the user's fork (Fork and open pull request on the Pull requests page tracks it there),
/// then pushed and force pushed from the branch map. Both go to the fork, never to origin; a branch made from
/// origin/main still gets its own copy on origin.
#[tokio::test]
async fn cm09_a_branch_tracking_a_fork_pushes_to_the_fork() {
    let e = env().await;
    let fork = e.root.join("fork.git");
    sh(&e.root, &["init", "-q", "--bare", "-b", "main", fork.to_str().unwrap()]);
    sh(&e.repo, &["remote", "add", "fork", fork.to_str().unwrap()]);
    sh(&e.repo, &["switch", "-qc", "feat/f"]);
    commit_file(&e.repo, "a.txt", "a\n");
    sh(&e.repo, &["push", "-q", "-u", "fork", "feat/f"]);

    commit_file(&e.repo, "b.txt", "b\n");
    e.call("workspace.push", json!({ "branch": "feat/f" })).await;
    assert_eq!(rev(&fork, "feat/f"), rev(&e.repo, "feat/f"));
    assert_eq!(rev(&e.origin, "feat/f"), "", "origin never gets it");
    assert_eq!(git_out(&e.repo, &["rev-parse", "--abbrev-ref", "feat/f@{upstream}"]), "fork/feat/f");

    let first = rev(&e.repo, "feat/f~1");
    e.call("commits.reset", json!({ "branch": "feat/f", "sha": first, "mode": "hard" })).await;
    e.call("workspace.push", json!({ "branch": "feat/f", "force": true })).await;
    assert_eq!(rev(&fork, "feat/f"), first);

    sh(&e.repo, &["switch", "-qc", "feat/o", "--track", "origin/main"]);
    commit_file(&e.repo, "c.txt", "c\n");
    e.call("workspace.push", json!({ "branch": "feat/o" })).await;
    assert_eq!(rev(&e.origin, "feat/o"), rev(&e.repo, "feat/o"));
    assert_eq!(git_out(&e.repo, &["rev-parse", "--abbrev-ref", "feat/o@{upstream}"]), "origin/feat/o");
}

/// CM-10: a push to a GitHub origin the user can't write to (a clone of someone else's project). The push is refused
/// with `no_push_access` naming the repository, which the app answers with its offer to fork; a refusal on a host that is
/// not GitHub stays a plain git error. Origin's URL is GitHub's; `pushInsteadOf` sends the push to the bare origin, whose
/// hook answers as GitHub does.
#[tokio::test]
async fn cm10_a_push_github_refuses_asks_to_fork() {
    let e = env().await;
    let hook = e.origin.join("hooks/pre-receive");
    std::fs::write(&hook, "#!/bin/sh\necho 'ERROR: Permission to Swess/exe_launcher.git denied to t1gu1.' >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    sh(&e.repo, &["remote", "set-url", "origin", "git@github.com:Swess/exe_launcher.git"]);
    sh(&e.repo, &["config", &format!("url.{}.pushInsteadOf", e.origin.display()), "git@github.com:Swess/exe_launcher.git"]);
    commit_file(&e.repo, "a.txt", "a\n");

    let err = rpc::call(&e.k, "workspace.push", e.params(json!({ "branch": "main" }))).await.unwrap_err();
    let body = gitnetix_core::ErrorBody::from(&err);
    assert_eq!((body.code, body.repo.as_deref()), ("no_push_access", Some("Swess/exe_launcher")), "{err}");

    sh(&e.repo, &["remote", "set-url", "origin", "git@git.example.com:Swess/exe_launcher.git"]);
    sh(&e.repo, &["config", &format!("url.{}.pushInsteadOf", e.origin.display()), "git@git.example.com:Swess/exe_launcher.git"]);
    let err = rpc::call(&e.k, "workspace.push", e.params(json!({ "branch": "main" }))).await.unwrap_err();
    assert_eq!(err.code(), "git", "{err}");
}

/// CM-04: the commit list flags the local tip and origin's tip, which the UI highlights. In step, one commit
/// holds both; reset back, origin's tip shows as not pulled; a new commit shows as not pushed.
#[tokio::test]
async fn cm04_commit_list_marks_the_local_and_origin_tips() {
    let e = env().await;
    sh(&e.repo, &["switch", "-qc", "feat/h"]);
    for f in ["a.txt", "b.txt", "c.txt"] {
        commit_file(&e.repo, f, "x\n");
    }
    e.call("workspace.push", json!({ "branch": "feat/h" })).await;
    let flags = |list: &Value| -> Vec<(String, bool, bool, bool, bool)> {
        list.as_array()
            .unwrap()
            .iter()
            .filter(|c| c["base"] != true)
            .map(|c| (c["subject"].as_str().unwrap().to_string(), c["local"] == true, c["origin"] == true, c["unpulled"] == true, c["unpushed"] == true))
            .collect()
    };
    let list = || e.call("workspace.commits", json!({ "branch": "feat/h" }));
    let t = |s: &str, l, o, pl, ps| (s.to_string(), l, o, pl, ps);
    // Commits made in the same second come in either order.
    let sorted = |mut v: Vec<(String, bool, bool, bool, bool)>| {
        v.sort();
        v
    };

    assert_eq!(flags(&list().await), [t("edit c.txt", true, true, false, false), t("edit b.txt", false, false, false, false), t("edit a.txt", false, false, false, false)]);

    let b = rev(&e.repo, "feat/h~1");
    e.call("commits.reset", json!({ "branch": "feat/h", "sha": b, "mode": "hard" })).await;
    assert_eq!(flags(&list().await).len(), 3, "origin's tip is still listed");
    assert_eq!(sorted(flags(&list().await)), [t("edit a.txt", false, false, false, false), t("edit b.txt", true, false, false, false), t("edit c.txt", false, true, true, false)]);

    commit_file(&e.repo, "d.txt", "d\n");
    assert_eq!(
        sorted(flags(&list().await)),
        [t("edit a.txt", false, false, false, false), t("edit b.txt", false, false, false, false), t("edit c.txt", false, true, true, false), t("edit d.txt", true, false, false, true)]
    );
}

/// CM-09: a branch merged with a merge commit. The merge keeps its commit, so the target is 2 ahead of origin, but
/// its list has one row for the merge with the branch's commit folded under it, and the map counts one row. A branch
/// that merged its base in folds nothing: the base's commits are not in its list.
#[tokio::test]
async fn cm09_a_merge_commit_lists_what_it_brought_under_it() {
    let e = env().await;
    sh(&e.repo, &["switch", "-qc", "docs/readme"]);
    commit_file(&e.repo, "docs.md", "docs\n");
    sh(&e.repo, &["switch", "-q", "main"]);
    let merge = json!({ "branch": "docs/readme", "into": "main", "deleteBranch": true, "push": false, "rebase": false, "squash": false, "squashAi": false, "stay": false });
    e.call("branches.merge", merge).await;
    assert_eq!(git_out(&e.repo, &["rev-list", "--count", "origin/main..main"]), "2", "the merge commit and the branch's");

    let main = e.view("main").await;
    assert_eq!((main["upstreamAhead"].as_u64(), main["unreleased"].as_u64(), main["folded"].as_u64()), (Some(2), Some(3), Some(1)));
    let list = e.call("workspace.commits", json!({ "branch": "main", "unreleased": true })).await;
    let rows: Vec<(&str, Vec<(&str, bool)>)> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["subject"].as_str().unwrap(), c["merged"].as_array().map_or(vec![], |m| m.iter().map(|m| (m["subject"].as_str().unwrap(), m["unpushed"] == true)).collect())))
        .collect();
    assert_eq!(rows, [("Merge branch 'docs/readme' into main", vec![("edit docs.md", true)]), ("edit README.md", vec![])]);

    // main merged into a branch: its commits are main's, none fold under the merge.
    sh(&e.repo, &["switch", "-qc", "feat/s", "main~1"]);
    commit_file(&e.repo, "s.txt", "s\n");
    e.call("branches.sync", json!({ "branch": "feat/s" })).await;
    let s = e.view("feat/s").await;
    assert_eq!((s["ahead"].as_u64(), s["folded"].as_u64()), (Some(2), Some(0)));
    let list = e.call("workspace.commits", json!({ "branch": "feat/s" })).await;
    assert!(list.as_array().unwrap().iter().all(|c| c.get("merged").is_none()), "{list:#}");
}

// ---------------------------------------------------------------- Worktrees

/// WT-01: a new branch opened in a worktree, committed to through the app, rebased in its worktree once main
/// moved, then squash merged with delete: one squash commit on main with all its files, branch and folder gone.
#[tokio::test]
async fn wt01_worktree_create_commit_rebase_and_squash_merge() {
    let e = env().await;
    let r = e.call("items.create", json!({ "from": "main", "kind": "feat", "description": "wt", "branchName": "feat/wt", "where": "worktree" })).await;
    let wt = PathBuf::from(r["worktree"].as_str().unwrap_or_else(|| panic!("no worktree: {r}")));
    assert_eq!(e.head(&wt), "feat/wt");
    assert_eq!(e.head(&e.repo), "main", "the main checkout stays where it was");
    assert!(e.view("feat/wt").await["worktree"].is_string());

    for (f, msg) in [("one.txt", "feat: one"), ("two.txt", "feat: two")] {
        std::fs::write(wt.join(f), "x\n").unwrap();
        e.call("workspace.commit", json!({ "branch": "feat/wt", "message": msg, "all": true })).await;
    }
    assert_eq!(status(&wt), "");
    assert_eq!(git_out(&e.repo, &["log", "--format=%s", "main..feat/wt"]), "feat: two\nfeat: one");

    commit_file(&e.repo, "main.txt", "m\n");
    assert_eq!(e.view("feat/wt").await["behind"], 1);
    let r = e.call("workspace.rebase", json!({ "branch": "feat/wt" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r}");
    assert!(is_ancestor(&e.repo, "main", "feat/wt"));
    assert!(wt.join("main.txt").exists(), "rebased in its worktree");
    assert_eq!(status(&wt), "");

    // Squash without Rebase: the branch's commits collapse into one, merged into main by a merge commit.
    let before = rev(&e.repo, "main");
    let m = e.call("branches.merge", json!({ "branch": "feat/wt", "squash": true, "deleteBranch": true })).await;
    assert_eq!(m["deleted"], true, "{m}");
    assert_eq!(git_out(&e.repo, &["log", "--no-merges", "--format=%s", &format!("{before}..main")]).lines().next(), Some("squash | feat/wt"));
    assert_eq!(git_out(&e.repo, &["rev-list", "--no-merges", "--count", &format!("{before}..main")]), "1", "one squash commit");
    let files = git_out(&e.repo, &["ls-tree", "--name-only", "main"]);
    assert!(files.contains("one.txt") && files.contains("two.txt"), "{files}");
    assert!(rev(&e.repo, "refs/heads/feat/wt").is_empty());
    assert!(!wt.exists(), "worktree folder removed");
    assert_eq!(e.head(&e.repo), "main");
}

/// WT-02: an existing branch opened in a worktree and closed again. Closing is refused while the worktree holds
/// uncommitted work, unless forced. The branch stays either way.
#[tokio::test]
async fn wt02_open_an_existing_branch_in_a_worktree_and_remove_it() {
    let e = env().await;
    sh(&e.repo, &["switch", "-qc", "feat/e"]);
    commit_file(&e.repo, "e.txt", "e\n");
    sh(&e.repo, &["switch", "-q", "main"]);

    let path = e.call("worktrees.create", json!({ "branch": "feat/e" })).await["path"].as_str().unwrap().to_string();
    let wt = PathBuf::from(&path);
    assert_eq!(e.head(&wt), "feat/e");
    assert!(wt.join("e.txt").exists());
    assert!(e.view("feat/e").await["worktree"].is_string());

    std::fs::write(wt.join("scratch.txt"), "wip\n").unwrap();
    e.refused("worktrees.remove", json!({ "path": path })).await;
    assert!(wt.join("scratch.txt").exists(), "refused: the work stays");
    e.call("worktrees.remove", json!({ "path": path, "force": true })).await;
    assert!(!wt.exists());
    assert_eq!(rev(&e.repo, "refs/heads/feat/e").len(), 40, "the branch stays");
    assert!(e.view("feat/e").await["worktree"].is_null());
}

/// The project's worktrees as the Worktrees & agents page lists them (`worktrees.list`), main checkout left out.
async fn listed_worktrees(e: &Env) -> Vec<(String, String)> {
    let list = e.call("worktrees.list", json!({})).await;
    let mut out: Vec<(String, String)> = list
        .as_array()
        .unwrap()
        .iter()
        .filter(|w| w["projectId"] == e.pid.as_str() && w["main"] == false)
        .map(|w| (w["branch"].as_str().unwrap().to_string(), w["path"].as_str().unwrap().to_string()))
        .collect();
    out.sort();
    out
}

/// The project's branches the map gets with a worktree, and its path.
async fn mapped_worktrees(e: &Env) -> Vec<(String, String)> {
    let ov = e.call("workspace.overview", json!({})).await;
    let mut out: Vec<(String, String)> = ov["branches"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|b| Some((b["name"].as_str()?.to_string(), b["worktree"].as_str()?.to_string())))
        .collect();
    out.sort();
    out
}

#[tokio::test]
async fn wt09_worktrees_page_and_map_list_the_same_worktrees() {
    // WT-09: an open worktree, one whose branch is merged into main with nothing of its own left, then one removed.
    let e = env().await;
    let open = e.call("worktrees.create", json!({ "branch": "feat/open" })).await["path"].as_str().unwrap().to_string();
    commit_file(Path::new(&open), "open.txt", "open\n");
    let done = e.call("worktrees.create", json!({ "branch": "feat/done" })).await["path"].as_str().unwrap().to_string();
    commit_file(Path::new(&done), "done.txt", "done\n");
    sh(&e.repo, &["merge", "-q", "--no-ff", "feat/done", "-m", "Merge feat/done"]);
    commit_file(&e.repo, "later.txt", "main moved on\n");

    let listed = listed_worktrees(&e).await;
    assert_eq!(listed.len(), 2, "{listed:?}");
    assert_eq!(mapped_worktrees(&e).await, listed, "the map gets every worktree the page lists, at the same path");
    let merged = e.view("feat/done").await;
    assert_eq!(merged["merged"], true, "feat/done is merged into main: {merged:#}");
    assert_eq!(merged["worktree"], json!(done), "and still flagged with its worktree, which keeps it a tile on the map");

    e.call("worktrees.remove", json!({ "path": done })).await;
    let listed = listed_worktrees(&e).await;
    assert_eq!(listed, vec![("feat/open".to_string(), open)]);
    assert_eq!(mapped_worktrees(&e).await, listed, "a removed worktree leaves both");
}
