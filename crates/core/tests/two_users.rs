//! Two users on one repo: the TU-* cases of `list-of-test.md` at the repo root. Ada and Bob each run Gitnetix on their
//! own computer: two engines, each with its own settings folder and its own clone of one bare origin. One of them acts
//! through the RPC calls the UI sends. The other one clicks nothing: their map has to show the change within
//! [`SEEN_WITHIN`], brought by `branches.autoFetch`, the call their open window sends every 5 s (`useAutoFetch` in
//! `src/api/hooks.ts`). Then they act on what their map suggests (`primary` in `src/screens/BranchMenu.tsx`), and in
//! the end both maps show the branch the same way.
//!
//! One case: `cargo test -p gitnetix-core --test two_users tu03`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

/// Longest a change may take to show on the other user's map. The engine asks origin at most every `AUTO_FETCH_GAP`
/// (4 s); the window asks every 5 s, so in the app a push shows within about 5 s.
const SEEN_WITHIN: Duration = Duration::from_secs(10);

fn sh(dir: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap().stdout;
    String::from_utf8(out).unwrap().trim_end().to_string()
}

fn is_ancestor(dir: &Path, a: &str, b: &str) -> bool {
    Command::new("git").current_dir(dir).args(["merge-base", "--is-ancestor", a, b]).status().unwrap().success()
}

fn config(dir: &Path, name: &str) {
    let email = format!("{}@example.com", name.to_lowercase());
    for (k, v) in [("user.email", email.as_str()), ("user.name", name), ("commit.gpgsign", "false"), ("core.autocrlf", "false"), ("core.longpaths", "true")] {
        sh(dir, &["config", k, v]);
    }
}

/// One person: their clone, and the Gitnetix running on their computer.
struct User {
    dir: PathBuf,
    k: Arc<Gitnetix>,
    pid: String,
}

impl User {
    async fn call(&self, m: &str, mut p: Value) -> Value {
        p["projectId"] = json!(self.pid);
        match rpc::call(&self.k, m, p).await {
            Ok(v) => v,
            Err(e) => panic!("{m}: {e}"),
        }
    }

    /// The error of a call that has to be refused.
    async fn refused(&self, m: &str, mut p: Value) -> String {
        p["projectId"] = json!(self.pid);
        match rpc::call(&self.k, m, p).await {
            Ok(v) => panic!("{m} went through: {v}"),
            Err(e) => e.to_string(),
        }
    }

    async fn map(&self) -> Vec<Value> {
        let ov = self.call("workspace.overview", json!({})).await;
        ov["branches"].as_array().unwrap().clone()
    }

    /// The branch as this user's map shows it.
    async fn view(&self, branch: &str) -> Value {
        let map = self.map().await;
        map.iter().find(|b| b["name"] == branch).cloned().unwrap_or_else(|| panic!("no {branch} on the map: {:?}", names(&map)))
    }

    /// Waits, as an open window does, until this user's map shows what `check` looks for. Returns that map.
    async fn sees(&self, what: &str, check: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let start = Instant::now();
        loop {
            self.call("branches.autoFetch", json!({})).await;
            let map = self.map().await;
            if check(&map) {
                return map;
            }
            assert!(start.elapsed() < SEEN_WITHIN, "{what}: not on the map after {SEEN_WITHIN:?}: {map:#?}");
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// [`Self::sees`] for one branch. Returns its view.
    async fn sees_branch(&self, branch: &str, what: &str, check: impl Fn(&Value) -> bool) -> Value {
        let map = self.sees(what, |map| map.iter().any(|b| b["name"] == branch && check(b))).await;
        map.into_iter().find(|b| b["name"] == branch).unwrap()
    }

    /// Their map shows `main` behind origin with nothing of its own: they click Reset to origin.
    async fn takes_main(&self) {
        let v = self.sees_branch("main", "the push to main", |v| v["upstreamBehind"].as_u64() > Some(0)).await;
        assert_eq!((&v["upstreamAhead"], &v["checkedOut"]), (&json!(0), &json!(false)), "Reset to origin in primary(): {v:#}");
        self.call("branches.reset", json!({ "branch": "main", "safe": true })).await;
    }

    /// Writes `file` and commits it with Stage & commit all.
    async fn commit(&self, branch: &str, file: &str, body: &str, message: &str) {
        std::fs::write(self.dir.join(file), body).unwrap();
        self.call("workspace.commit", json!({ "branch": branch, "message": message, "all": true })).await;
    }

    fn rev(&self, r: &str) -> String {
        git_out(&self.dir, &["rev-parse", "--verify", "-q", r])
    }

    fn read(&self, file: &str) -> String {
        std::fs::read_to_string(self.dir.join(file)).unwrap()
    }

    /// Subjects of the commits in `range`, newest first.
    fn subjects(&self, range: &str) -> Vec<String> {
        git_out(&self.dir, &["log", "--format=%s", range]).lines().map(String::from).collect()
    }
}

fn names(map: &[Value]) -> Vec<&str> {
    map.iter().filter_map(|b| b["name"].as_str()).collect()
}

/// Ada and Bob, each with a clone of origin's `main` (`README.md`, and `app.txt` holding `timeout = 30`) and Gitnetix
/// open on it. AI conflict resolving is off: conflicts are left to them. `seed` is a third clone, for "someone else
/// pushed to main".
struct Team {
    _tmp: tempfile::TempDir,
    seed: PathBuf,
    ada: User,
    bob: User,
}

async fn team() -> Team {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let origin = root.join("origin.git");
    sh(&root, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    let seed = root.join("seed");
    sh(&root, &["clone", "-q", origin.to_str().unwrap(), seed.to_str().unwrap()]);
    sh(&seed, &["switch", "-qc", "main"]);
    config(&seed, "Carol");
    std::fs::write(seed.join("README.md"), "# repo\n").unwrap();
    std::fs::write(seed.join("app.txt"), "timeout = 30\n").unwrap();
    sh(&seed, &["add", "."]);
    sh(&seed, &["commit", "-qm", "init"]);
    sh(&seed, &["push", "-q", "-u", "origin", "main"]);
    let (ada, bob) = (user(&root, &origin, "Ada").await, user(&root, &origin, "Bob").await);
    Team { _tmp: tmp, seed, ada, bob }
}

async fn user(root: &Path, origin: &Path, name: &str) -> User {
    let dir = root.join(name.to_lowercase());
    sh(root, &["clone", "-q", origin.to_str().unwrap(), dir.to_str().unwrap()]);
    config(&dir, name);
    let k = Gitnetix::open(&root.join(format!("home-{}", name.to_lowercase()))).unwrap();
    let added = rpc::call(&k, "projects.add", json!({ "paths": [dir.to_string_lossy()] })).await.unwrap();
    let u = User { pid: added[0]["id"].as_str().unwrap().to_string(), dir, k };
    u.call("projects.setPrefs", json!({ "merge": { "resolveConflicts": false } })).await;
    // Their window is open: its first look at origin is behind them, so the next one waits the engine's gap.
    u.call("branches.autoFetch", json!({})).await;
    u
}

impl Team {
    /// Someone else pushed a commit to main (`main.txt`).
    fn main_moves_on(&self) {
        std::fs::write(self.seed.join("main.txt"), "main\n").unwrap();
        sh(&self.seed, &["add", "main.txt"]);
        sh(&self.seed, &["commit", "-qm", "main moves on"]);
        sh(&self.seed, &["push", "-q", "origin", "main"]);
    }

    /// Both maps show `branch` the same way, and both clones have it on the same commit.
    async fn same_on_both(&self, branch: &str) {
        let (a, b) = (self.ada.view(branch).await, self.bob.view(branch).await);
        for f in ["exists", "remote", "parent", "ahead", "behind", "upstreamAhead", "upstreamBehind", "merged", "author", "date"] {
            assert_eq!(a[f], b[f], "{branch}.{f} differs between the two maps:\nAda {a:#}\nBob {b:#}");
        }
        let origin = format!("refs/remotes/origin/{branch}");
        let tip = self.ada.rev(&origin);
        assert_eq!(self.bob.rev(&origin), tip, "both saw origin's {branch} on the same commit");
        for u in [&self.ada, &self.bob] {
            let local = u.rev(&format!("refs/heads/{branch}"));
            assert!(local.is_empty() || local == tip, "{}: its {branch} is on origin's commit", u.dir.display());
        }
    }
}

/// Ada starts `feat/shared` from main, commits `a.txt` and publishes it. Bob's map shows it on origin only, under main,
/// one commit ahead. Bob checks it out from origin. Both are then on it, in step with origin.
async fn shared_branch() -> Team {
    let t = team().await;
    let (ada, bob) = (&t.ada, &t.bob);
    ada.call("items.create", json!({ "from": "main", "kind": "feat", "description": "shared", "branchName": "feat/shared", "where": "switch" })).await;
    ada.commit("feat/shared", "a.txt", "a\n", "add a").await;
    ada.call("workspace.push", json!({ "branch": "feat/shared" })).await;

    let v = bob.sees_branch("feat/shared", "Ada's new branch", |v| v["remote"] == true).await;
    // Check out from origin (`switch` in primary(): not local).
    assert_eq!((&v["local"], &v["parent"], &v["ahead"], &v["behind"]), (&json!(false), &json!("main"), &json!(1), &json!(0)), "{v:#}");
    bob.call("workspace.switch", json!({ "branch": "feat/shared" })).await;
    let v = bob.view("feat/shared").await;
    assert_eq!((&v["checkedOut"], &v["upstream"], &v["upstreamAhead"], &v["upstreamBehind"]), (&json!(true), &json!("origin/feat/shared"), &json!(0), &json!(0)), "{v:#}");
    t
}

// ---------------------------------------------------------------- Same branch

/// TU-01: a branch Ada publishes shows up on Bob's map within a few seconds, and he can check it out.
#[tokio::test]
async fn tu01_a_published_branch_shows_up_on_the_other_map() {
    let t = shared_branch().await;
    assert_eq!(t.bob.read("a.txt"), "a\n");
    t.same_on_both("feat/shared").await;
}

/// TU-02: Bob has an uncommitted edit when Ada pushes a commit to the branch they share. His map shows ↓1 with nothing
/// of his own: Reset to origin. It brings Ada's commit and puts his edit back on top.
#[tokio::test]
async fn tu02_a_teammate_push_offers_reset_to_origin_and_keeps_uncommitted_work() {
    let t = shared_branch().await;
    let (ada, bob) = (&t.ada, &t.bob);
    std::fs::write(bob.dir.join("README.md"), "# repo, edited by Bob\n").unwrap();
    ada.commit("feat/shared", "a.txt", "a, again\n", "change a").await;
    ada.call("workspace.push", json!({ "branch": "feat/shared" })).await;

    let v = bob.sees_branch("feat/shared", "Ada's push", |v| v["upstreamBehind"] == 1).await;
    // takeOrigin in primary(): behind origin, nothing of his own; with uncommitted work too.
    assert_eq!((&v["upstreamAhead"], &v["rewritten"], &v["wip"]), (&json!(0), &json!(false), &json!(1)), "{v:#}");
    let r = bob.call("branches.reset", json!({ "branch": "feat/shared", "safe": true })).await;
    assert_eq!(r["conflicts"], json!([]), "{r}");
    assert_eq!(bob.read("a.txt"), "a, again\n");
    assert_eq!(bob.read("README.md"), "# repo, edited by Bob\n", "his edit is back");
    assert_eq!(git_out(&bob.dir, &["stash", "list"]), "", "the stash is dropped");
    t.same_on_both("feat/shared").await;
}

/// TU-03: Ada and Bob each commit a different file on the branch they share. Ada pushes first, so Bob's push is
/// refused. His map shows ↑1 ↓1, not rewritten: Pull, never Force push. The pull puts his commit on top of hers. He
/// pushes, and Ada's map shows ↓1 with nothing of her own: she takes origin's copy. One history, both commits once.
#[tokio::test]
async fn tu03_both_commit_the_later_push_is_refused_and_pull_puts_it_on_top() {
    let t = shared_branch().await;
    let (ada, bob) = (&t.ada, &t.bob);
    ada.commit("feat/shared", "ada.txt", "ada\n", "add ada").await;
    bob.commit("feat/shared", "bob.txt", "bob\n", "add bob").await;
    ada.call("workspace.push", json!({ "branch": "feat/shared" })).await;
    bob.refused("workspace.push", json!({ "branch": "feat/shared" })).await;

    let v = bob.sees_branch("feat/shared", "Ada's push", |v| v["upstreamBehind"] == 1).await;
    // Pull in primary(): diverged, and neither side was rewritten.
    assert_eq!((&v["upstreamAhead"], &v["rewritten"], &v["upstreamRewritten"]), (&json!(1), &json!(false), &json!(false)), "{v:#}");
    bob.call("branches.pull", json!({ "branch": "feat/shared" })).await;
    assert!(is_ancestor(&bob.dir, "origin/feat/shared", "feat/shared"), "his commit sits on Ada's");
    bob.call("workspace.push", json!({ "branch": "feat/shared" })).await;

    let v = ada.sees_branch("feat/shared", "Bob's push", |v| v["upstreamBehind"] == 1).await;
    assert_eq!((&v["upstreamAhead"], &v["rewritten"]), (&json!(0), &json!(false)), "{v:#}");
    ada.call("branches.reset", json!({ "branch": "feat/shared", "safe": true })).await;
    assert_eq!(ada.subjects("origin/main..feat/shared"), ["add bob", "add ada", "add a"]);
    assert_eq!(ada.read("bob.txt"), "bob\n");
    t.same_on_both("feat/shared").await;
}

/// TU-04: Ada and Bob change the same line of `app.txt` on the branch they share, and Ada pushes first. Bob's pull
/// cannot put his commit on top cleanly, and AI is off: it is refused and his branch stays as it was, not stuck in a
/// rebase. He rebases onto origin's copy himself, resolves, continues and pushes. Ada's map shows ↓1 and she takes it.
#[tokio::test]
async fn tu04_same_line_changed_by_both_pull_is_refused_then_rebased_by_hand() {
    let t = shared_branch().await;
    let (ada, bob) = (&t.ada, &t.bob);
    ada.commit("feat/shared", "app.txt", "timeout = 45\n", "timeout 45").await;
    bob.commit("feat/shared", "app.txt", "timeout = 60\n", "timeout 60").await;
    ada.call("workspace.push", json!({ "branch": "feat/shared" })).await;
    bob.sees_branch("feat/shared", "Ada's push", |v| v["upstreamBehind"] == 1 && v["upstreamAhead"] == 1).await;

    let before = bob.rev("feat/shared");
    let why = bob.refused("branches.pull", json!({ "branch": "feat/shared" })).await;
    assert!(why.contains("stopped on conflicts"), "{why}");
    assert_eq!(bob.rev("feat/shared"), before, "his branch is as it was");
    let v = bob.view("feat/shared").await;
    assert_eq!((&v["inProgress"], &v["conflict"], &v["wip"]), (&Value::Null, &json!(false), &json!(0)), "{v:#}");

    // No dialog offers origin's copy of the branch itself yet (F-6): the call its rebase dialog would send for it.
    let r = bob.call("workspace.rebase", json!({ "branch": "feat/shared", "onto": "origin/feat/shared" })).await;
    assert_eq!(r["conflicts"], json!(["app.txt"]), "{r:#}");
    let v = bob.view("feat/shared").await;
    assert_eq!((&v["inProgress"], &v["conflict"]), (&json!("rebase"), &json!(true)), "{v:#}");
    std::fs::write(bob.dir.join("app.txt"), "timeout = 60\n").unwrap();
    bob.call("workspace.stage", json!({ "branch": "feat/shared", "paths": ["app.txt"] })).await;
    let r = bob.call("workspace.rebaseContinue", json!({ "branch": "feat/shared" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r:#}");
    bob.call("workspace.push", json!({ "branch": "feat/shared" })).await;

    ada.sees_branch("feat/shared", "Bob's push", |v| v["upstreamBehind"] == 1 && v["upstreamAhead"] == 0).await;
    ada.call("branches.reset", json!({ "branch": "feat/shared", "safe": true })).await;
    assert_eq!(ada.read("app.txt"), "timeout = 60\n");
    assert_eq!(ada.subjects("origin/main..feat/shared"), ["timeout 60", "timeout 45", "add a"]);
    t.same_on_both("feat/shared").await;
}

/// Main moved on. Ada brings her main up to date (Reset to origin), rebases `feat/shared` onto it (Rebase) and force
/// pushes it (Force push), each the button her map suggests.
async fn ada_rebases_and_force_pushes(t: &Team) {
    let ada = &t.ada;
    t.main_moves_on();
    ada.takes_main().await;
    let v = ada.view("feat/shared").await;
    assert_eq!((&v["behind"], &v["checkedOut"], &v["upstreamAhead"]), (&json!(1), &json!(true), &json!(0)), "{v:#}");
    let r = ada.call("workspace.rebase", json!({ "branch": "feat/shared" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r:#}");
    let v = ada.view("feat/shared").await;
    assert_eq!((&v["rewritten"], &v["behind"]), (&json!(true), &json!(0)), "Force push in primary(): {v:#}");
    ada.call("workspace.push", json!({ "branch": "feat/shared", "force": true })).await;
}

/// TU-05: Ada rebases the branch they share onto main and force pushes it. Bob has nothing of his own on it: his map
/// shows origin was rewritten over his copy and suggests Reset to origin, not Force push (that would undo Ada's rebase).
#[tokio::test]
async fn tu05_a_teammate_rebase_and_force_push_offers_reset_to_origin() {
    let t = shared_branch().await;
    let bob = &t.bob;
    ada_rebases_and_force_pushes(&t).await;

    let v = bob.sees_branch("feat/shared", "Ada's force push", |v| v["upstreamRewritten"] == true).await;
    assert_eq!((&v["rewritten"], &v["upstreamBehind"]), (&json!(false), &json!(2)), "{v:#}");
    bob.call("branches.reset", json!({ "branch": "feat/shared", "safe": true })).await;
    assert_eq!(bob.read("main.txt"), "main\n");
    bob.takes_main().await;
    t.same_on_both("main").await;
    t.same_on_both("feat/shared").await;
}

/// TU-06: same as TU-05, but Bob made a commit Ada never saw. His map suggests Pull, neither Force push nor Reset to
/// origin. The pull puts his commit on top of Ada's rebased branch, with her old commit dropped, not doubled. He pushes
/// without force, and Ada's map shows ↓1.
#[tokio::test]
async fn tu06_a_force_push_over_a_local_commit_pulls_it_on_top_once() {
    let t = shared_branch().await;
    let (ada, bob) = (&t.ada, &t.bob);
    bob.commit("feat/shared", "bob.txt", "bob\n", "add bob").await;
    ada_rebases_and_force_pushes(&t).await;

    let v = bob.sees_branch("feat/shared", "Ada's force push", |v| v["upstreamBehind"] == 2).await;
    assert_eq!((&v["upstreamAhead"], &v["rewritten"], &v["upstreamRewritten"]), (&json!(2), &json!(false), &json!(false)), "Pull in primary(): {v:#}");
    bob.call("branches.pull", json!({ "branch": "feat/shared" })).await;
    assert_eq!(bob.subjects("origin/main..feat/shared"), ["add bob", "add a"], "his commit on top, hers once");
    bob.call("workspace.push", json!({ "branch": "feat/shared" })).await;

    ada.sees_branch("feat/shared", "Bob's push", |v| v["upstreamBehind"] == 1 && v["upstreamAhead"] == 0).await;
    ada.call("branches.reset", json!({ "branch": "feat/shared", "safe": true })).await;
    assert_eq!(ada.read("bob.txt"), "bob\n");
    bob.takes_main().await;
    t.same_on_both("feat/shared").await;
}

/// Main moved on and Ada rebased the branch they share onto it, not pushed yet: her map suggests Force push. Bob
/// pushes `bob.txt` to it meanwhile. Once Ada's map has fetched that, it suggests Pull, not Force push. Returns Bob's
/// commit.
async fn ada_rebases_while_bob_pushes(t: &Team) -> String {
    let (ada, bob) = (&t.ada, &t.bob);
    t.main_moves_on();
    ada.takes_main().await;
    let r = ada.call("workspace.rebase", json!({ "branch": "feat/shared" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r:#}");
    assert_eq!(ada.view("feat/shared").await["rewritten"], true, "Force push in primary(), until Bob pushes");

    bob.commit("feat/shared", "bob.txt", "bob\n", "add bob").await;
    bob.call("workspace.push", json!({ "branch": "feat/shared" })).await;
    let v = ada.sees_branch("feat/shared", "Bob's push", |v| v["upstreamBehind"] == 2).await;
    assert_eq!((&v["rewritten"], &v["upstreamRewritten"]), (&json!(false), &json!(false)), "Pull in primary(), not Force push: {v:#}");
    bob.rev("feat/shared")
}

/// TU-07: Ada rebases the branch they share, and Bob pushes a commit before she force pushes. Her map stops suggesting
/// Force push once it has fetched Bob's commit, and a force push is refused: Bob's commit stays on origin.
#[tokio::test]
async fn tu07_a_force_push_after_a_teammate_push_is_refused() {
    let t = shared_branch().await;
    let bobs = ada_rebases_while_bob_pushes(&t).await;
    t.ada.refused("workspace.push", json!({ "branch": "feat/shared", "force": true })).await;
    let on_origin = git_out(&t.bob.dir, &["ls-remote", "origin", "refs/heads/feat/shared"]);
    assert_eq!(on_origin.split('\t').next(), Some(bobs.as_str()), "Bob's commit stays on origin");
}

/// TU-08: TU-07 continued: Ada clicks Pull, as her map suggests. She gets Bob's commit, and main's commit is not copied
/// into the branch. Her map then suggests Rebase, and the force push after it goes through, Bob's commit included.
/// Bob's map shows origin rewritten over his copy, and he takes it. Both hold main, then Ada's commit and Bob's, once.
#[tokio::test]
async fn tu08_pull_after_a_refused_force_push_keeps_both_commits_and_copies_nothing() {
    let t = shared_branch().await;
    let (ada, bob) = (&t.ada, &t.bob);
    ada_rebases_while_bob_pushes(&t).await;
    ada.call("branches.pull", json!({ "branch": "feat/shared" })).await;
    assert_eq!(ada.subjects("origin/main..feat/shared"), ["add bob", "add a"], "Bob's commit and hers, no copy of main's");
    let v = ada.view("feat/shared").await;
    assert_eq!((&v["upstreamAhead"], &v["behind"]), (&json!(0), &json!(1)), "Rebase in primary(): {v:#}");
    let r = ada.call("workspace.rebase", json!({ "branch": "feat/shared" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r:#}");
    ada.call("workspace.push", json!({ "branch": "feat/shared", "force": true })).await;

    bob.sees_branch("feat/shared", "Ada's force push", |v| v["upstreamRewritten"] == true).await;
    bob.call("branches.reset", json!({ "branch": "feat/shared", "safe": true })).await;
    bob.takes_main().await;
    assert_eq!(bob.subjects("origin/main..feat/shared"), ["add bob", "add a"]);
    t.same_on_both("feat/shared").await;
}

// ---------------------------------------------------------------- Different branches

/// TU-09: Ada and Bob each work on their own branch off main. Ada merges hers into main, pushed, and deletes it. On
/// Bob's map her branch goes and main shows ↓2: Reset to origin. His branch then shows 2 behind main: Rebase, then
/// Force push. Ada's map shows his branch up to date with main.
#[tokio::test]
async fn tu09_a_teammate_merges_into_main_and_the_other_rebases_onto_it() {
    let t = team().await;
    let (ada, bob) = (&t.ada, &t.bob);
    ada.call("items.create", json!({ "from": "main", "kind": "feat", "description": "a", "branchName": "feat/a", "where": "switch" })).await;
    ada.commit("feat/a", "a.txt", "a\n", "add a").await;
    ada.call("workspace.push", json!({ "branch": "feat/a" })).await;
    bob.call("items.create", json!({ "from": "main", "kind": "feat", "description": "b", "branchName": "feat/b", "where": "switch" })).await;
    bob.commit("feat/b", "b.txt", "b\n", "add b").await;
    bob.call("workspace.push", json!({ "branch": "feat/b" })).await;
    bob.sees_branch("feat/a", "Ada's branch", |_| true).await;

    let m = ada.call("branches.merge", json!({ "branch": "feat/a", "deleteBranch": true, "push": true })).await;
    assert_eq!((&m["into"], &m["deleted"], &m["pushed"]), (&json!("main"), &json!(true), &json!(true)), "{m:#}");

    let map = bob.sees("Ada's merge", |map| !names(map).contains(&"feat/a") && map.iter().any(|b| b["name"] == "main" && b["upstreamBehind"] == 2)).await;
    let main = map.iter().find(|b| b["name"] == "main").unwrap();
    assert_eq!(main["upstreamAhead"], 0, "Reset to origin in primary(): {main:#}");
    bob.call("branches.reset", json!({ "branch": "main", "safe": true })).await;
    let v = bob.view("feat/b").await;
    assert_eq!((&v["behind"], &v["upstreamAhead"], &v["checkedOut"]), (&json!(2), &json!(0), &json!(true)), "Rebase in primary(): {v:#}");
    let r = bob.call("workspace.rebase", json!({ "branch": "feat/b" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r:#}");
    assert_eq!(bob.view("feat/b").await["rewritten"], true, "Force push in primary()");
    bob.call("workspace.push", json!({ "branch": "feat/b", "force": true })).await;

    let v = ada.sees_branch("feat/b", "Bob's force push", |v| v["behind"] == 0).await;
    assert_eq!((&v["ahead"], &v["local"]), (&json!(1), &json!(false)), "{v:#}");
    assert!(is_ancestor(&ada.dir, "main", "origin/feat/b"));
    t.same_on_both("main").await;
    t.same_on_both("feat/b").await;
}

/// Ada publishes `feat/api` (`api.txt`). Bob checks it out from origin, starts `feat/ui` from it, commits `ui.txt` and
/// publishes it.
async fn stacked() -> Team {
    let t = team().await;
    let (ada, bob) = (&t.ada, &t.bob);
    ada.call("items.create", json!({ "from": "main", "kind": "feat", "description": "api", "branchName": "feat/api", "where": "switch" })).await;
    ada.commit("feat/api", "api.txt", "api\n", "add api").await;
    ada.call("workspace.push", json!({ "branch": "feat/api" })).await;
    bob.sees_branch("feat/api", "Ada's branch", |_| true).await;
    bob.call("workspace.switch", json!({ "branch": "feat/api" })).await;
    bob.call("items.create", json!({ "from": "feat/api", "kind": "feat", "description": "ui", "branchName": "feat/ui", "where": "switch" })).await;
    bob.commit("feat/ui", "ui.txt", "ui\n", "add ui").await;
    bob.call("workspace.push", json!({ "branch": "feat/ui" })).await;
    assert_eq!(bob.view("feat/ui").await["parent"], "feat/api");
    t
}

/// Bob's map shows his copy of `feat/api` behind origin with nothing of its own (Reset to origin): he takes it. Then
/// `feat/ui` is behind it (Rebase): he rebases it and force pushes. `feat/api..feat/ui` is then his one commit.
async fn bob_follows_feat_api(t: &Team, what: &str, check: impl Fn(&Value) -> bool) {
    let bob = &t.bob;
    let v = bob.sees_branch("feat/api", what, check).await;
    assert!(v["upstreamAhead"] == 0 || v["upstreamRewritten"] == true, "Reset to origin in primary(): {v:#}");
    assert_eq!((&v["rewritten"], &v["checkedOut"]), (&json!(false), &json!(false)), "{v:#}");
    bob.call("branches.reset", json!({ "branch": "feat/api", "safe": true })).await;
    let v = bob.view("feat/ui").await;
    assert_eq!((&v["parent"], &v["checkedOut"], &v["upstreamAhead"]), (&json!("feat/api"), &json!(true), &json!(0)), "{v:#}");
    assert!(v["behind"].as_u64() > Some(0), "Rebase in primary(): {v:#}");
    let r = bob.call("workspace.rebase", json!({ "branch": "feat/ui" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r:#}");
    assert_eq!(bob.subjects("feat/api..feat/ui"), ["add ui"], "only his commit on top, none of feat/api's doubled");
    bob.call("workspace.push", json!({ "branch": "feat/ui", "force": true })).await;
}

/// TU-10: Bob's `feat/ui` is built on Ada's `feat/api`. Ada pushes another commit to `feat/api`. Bob's map shows it
/// within a few seconds; he takes it and rebases `feat/ui` onto it. Ada's map shows `feat/ui` on top of her branch.
#[tokio::test]
async fn tu10_a_stacked_branch_follows_its_parent_moving_on_origin() {
    let t = stacked().await;
    let ada = &t.ada;
    ada.commit("feat/api", "api.txt", "api, more\n", "more api").await;
    ada.call("workspace.push", json!({ "branch": "feat/api" })).await;

    bob_follows_feat_api(&t, "Ada's push", |v| v["upstreamBehind"] == 1).await;
    ada.sees("Bob's force push", |_| is_ancestor(&ada.dir, "feat/api", "origin/feat/ui")).await;
    t.same_on_both("feat/api").await;
}

/// TU-11: same stack, but main moves on and Ada rebases `feat/api` onto it and force pushes. Bob's map shows origin was
/// rewritten over his copy of `feat/api`: Reset to origin. Rebasing `feat/ui` onto it drops the old copy of Ada's commit.
#[tokio::test]
async fn tu11_a_stacked_branch_follows_its_parent_rebased_and_force_pushed() {
    let t = stacked().await;
    let ada = &t.ada;
    t.main_moves_on();
    ada.takes_main().await;
    ada.call("workspace.rebase", json!({ "branch": "feat/api" })).await;
    ada.call("workspace.push", json!({ "branch": "feat/api", "force": true })).await;

    bob_follows_feat_api(&t, "Ada's force push", |v| v["upstreamRewritten"] == true).await;
    assert_eq!(t.bob.read("main.txt"), "main\n");
    t.bob.takes_main().await;
    ada.sees("Bob's force push", |_| is_ancestor(&ada.dir, "feat/api", "origin/feat/ui")).await;
    t.same_on_both("feat/api").await;
}

/// TU-12: Ada's map files Bob's `feat/ui` under `feat/api`, the branch he built it on, as his own map does. Filed under
/// main, it counts Ada's commit as one of his, and merging it into main would take `feat/api` along.
#[tokio::test]
async fn tu12_a_teammate_stacked_branch_is_filed_under_its_parent() {
    let t = stacked().await;
    let v = t.ada.sees_branch("feat/ui", "Bob's branch", |_| true).await;
    assert_eq!((&v["parent"], &v["ahead"]), (&json!("feat/api"), &json!(1)), "{v:#}");
}
