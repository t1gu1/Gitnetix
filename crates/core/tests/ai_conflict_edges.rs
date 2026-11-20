//! Conflict shapes that are easy to get wrong, resolved by the machine's real AI during a rebase. Cases AI-01 to
//! AI-06 of `list-of-test.md`. Ignored by default: they spend AI usage and take about a minute each. Run them with
//!
//!     cargo test -p gitnetix-core --test ai_conflict_edges -- --ignored --test-threads=2
//!
//! The provider is `claude` (its CLI on PATH, signed in); `GITNETIX_TEST_AI=codex` (or any provider id) picks another.
//! The fake-AI tests that check the plumbing on every run are `conflict_resolution.rs` and `rebase_ai.rs`.

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

fn write(dir: &Path, file: &str, body: &str) {
    let path = dir.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

fn commit(dir: &Path, file: &str, body: &str, message: &str) {
    write(dir, file, body);
    sh(dir, &["add", "-A"]);
    sh(dir, &["commit", "-qm", message]);
}

fn read(dir: &Path, file: &str) -> String {
    std::fs::read_to_string(dir.join(file)).unwrap_or_default()
}

/// A repo where `base` is on main, then feat/x and main each change it their way. Opened with real AI on.
struct Case {
    _tmp: tempfile::TempDir,
    repo: PathBuf,
    k: Arc<Gitnetix>,
    pid: String,
}

async fn case(base: &[(&str, &str)]) -> Case {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    sh(&repo, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.email", "t@example.com"), ("user.name", "Test"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
        sh(&repo, &["config", k, v]);
    }
    for (f, body) in base {
        write(&repo, f, body);
    }
    write(&repo, "README.md", "# repo\n");
    sh(&repo, &["add", "-A"]);
    sh(&repo, &["commit", "-qm", "chore: init"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let provider = std::env::var("GITNETIX_TEST_AI").unwrap_or_else(|_| "claude".into());
    rpc::call(&k, "ai.saveProvider", json!({ "id": provider, "method": "cli" })).await.unwrap();
    rpc::call(&k, "ai.setDefault", json!({ "id": provider })).await.unwrap();
    let pid = rpc::call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await.unwrap()[0]["id"].as_str().unwrap().to_string();
    Case { _tmp: tmp, repo, k, pid }
}

impl Case {
    /// Rebases feat/x (checked out) onto main with AI resolving; every conflict has to be settled.
    async fn rebase(&self) -> Value {
        sh(&self.repo, &["switch", "-q", "feat/x"]);
        let r = rpc::call(&self.k, "workspace.rebase", json!({ "projectId": self.pid, "branch": "feat/x", "resolve": true })).await.unwrap();
        assert_eq!((r["conflicts"].clone(), r["errors"].clone(), r["aborted"].clone()), (json!([]), json!([]), json!(false)), "{r:#}");
        assert!(r["resolved"].as_u64().is_some_and(|n| n > 0), "nothing conflicted, the case is wrong: {r:#}");
        assert!(Command::new("git").current_dir(&self.repo).args(["merge-base", "--is-ancestor", "main", "feat/x"]).status().unwrap().success());
        assert_eq!(git_out(&self.repo, &["status", "--porcelain"]), "", "rebase finished clean");
        r
    }

    fn markers(&self, file: &str) -> usize {
        read(&self.repo, file).lines().filter(|l| l.starts_with("<<<<<<<") || l.starts_with(">>>>>>>") || *l == "=======").count()
    }
}

/// AI-01: both sides change the same line in compatible ways (main renames, the branch changes the value).
#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai01_same_line_changed_on_both_sides() {
    let c = case(&[("src/config.ts", "export const TIMEOUT = 30;\nexport const RETRIES = 3;\n")]).await;
    sh(&c.repo, &["switch", "-qc", "feat/x"]);
    commit(&c.repo, "src/config.ts", "export const TIMEOUT = 45;\nexport const RETRIES = 3;\n", "feat: longer timeout");
    sh(&c.repo, &["switch", "-q", "main"]);
    commit(&c.repo, "src/config.ts", "export const REQUEST_TIMEOUT = 30;\nexport const RETRIES = 3;\n", "refactor: rename timeout");
    c.rebase().await;
    let f = read(&c.repo, "src/config.ts");
    assert_eq!(c.markers("src/config.ts"), 0, "{f}");
    assert!(f.contains("REQUEST_TIMEOUT = 45"), "both intents kept: {f}");
    assert!(f.contains("RETRIES = 3"), "{f}");
}

/// AI-02: a doc that shows conflict markers as an example, with a real conflict right under the example. The
/// example stays exactly as it was; only the real conflict goes.
#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai02_file_whose_text_holds_conflict_markers() {
    let example = "```\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n```\n";
    let doc = |tips: &str| format!("# Resolving conflicts\n\nGit marks a conflict like this:\n\n{example}\n## Tips\n\n{tips}");
    let c = case(&[("docs/conflicts.md", &doc("- Pull before you push.\n"))]).await;
    sh(&c.repo, &["switch", "-qc", "feat/x"]);
    commit(&c.repo, "docs/conflicts.md", &doc("- Pull before you push.\n- Commit small changes.\n"), "docs: commit small");
    sh(&c.repo, &["switch", "-q", "main"]);
    commit(&c.repo, "docs/conflicts.md", &doc("- Pull before you push.\n- Rebase often.\n"), "docs: rebase often");
    c.rebase().await;
    let f = read(&c.repo, "docs/conflicts.md");
    assert_eq!(f.matches(example).count(), 1, "example block intact: {f}");
    assert_eq!(c.markers("docs/conflicts.md"), 3, "only the example's markers left: {f}");
    assert!(f.contains("- Commit small changes.") && f.contains("- Rebase often."), "both tips kept: {f}");
}

/// AI-03: main rewrote a file's code elsewhere and deleted it, the branch edited it. AI decides keep or delete;
/// either way the rebase goes through and nothing is left half done. (The new file must differ enough from the
/// old one, or git takes it for a rename and moves the edit there: no conflict.)
#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai03_changed_here_deleted_there() {
    let c = case(&[("src/legacy.ts", "export function greet(name: string) {\n  return `Hello ${name}`;\n}\n")]).await;
    sh(&c.repo, &["switch", "-qc", "feat/x"]);
    commit(&c.repo, "src/legacy.ts", "export function greet(name: string) {\n  return `Hello ${name}!`;\n}\n", "fix: greet with emphasis");
    sh(&c.repo, &["switch", "-q", "main"]);
    std::fs::remove_file(c.repo.join("src/legacy.ts")).unwrap();
    commit(&c.repo, "src/greet.ts", "type Name = string;\n\nexport const greet = (who: Name): string => [\"Hello\", who].join(\" \");\n", "refactor: rewrite greet in greet.ts");
    c.rebase().await;
    let legacy = read(&c.repo, "src/legacy.ts");
    assert!(legacy.is_empty() || legacy.contains("Hello ${name}!"), "kept with the change, or deleted: {legacy}");
    assert!(c.repo.join("src/greet.ts").exists(), "main's move stays");
}

/// AI-04: both sides add the same new file with different content: the result holds both.
#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai04_both_sides_add_the_same_file() {
    let c = case(&[]).await;
    sh(&c.repo, &["switch", "-qc", "feat/x"]);
    commit(&c.repo, "src/routes.ts", "export const routes = [\n  \"/login\",\n  \"/logout\",\n];\n", "feat: auth routes");
    sh(&c.repo, &["switch", "-q", "main"]);
    commit(&c.repo, "src/routes.ts", "export const routes = [\n  \"/home\",\n  \"/about\",\n];\n", "feat: page routes");
    c.rebase().await;
    let f = read(&c.repo, "src/routes.ts");
    assert_eq!(c.markers("src/routes.ts"), 0, "{f}");
    for r in ["/login", "/logout", "/home", "/about"] {
        assert!(f.contains(r), "{r} missing: {f}");
    }
}

/// AI-05: main converted a file to CRLF line endings (every line changed), the branch edited one line.
#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai05_line_endings_changed_on_one_side() {
    let c = case(&[("notes.txt", "alpha\nbeta\ngamma\n")]).await;
    sh(&c.repo, &["switch", "-qc", "feat/x"]);
    commit(&c.repo, "notes.txt", "alpha\nBETA\ngamma\n", "fix: shout beta");
    sh(&c.repo, &["switch", "-q", "main"]);
    commit(&c.repo, "notes.txt", "alpha\r\nbeta\r\ngamma\r\n", "chore: CRLF line endings");
    c.rebase().await;
    let f = read(&c.repo, "notes.txt");
    assert_eq!(c.markers("notes.txt"), 0, "{f:?}");
    assert!(f.contains("BETA") && f.contains("alpha") && f.contains("gamma"), "{f:?}");
}

/// AI-06: two branch commits each conflict with main on the same line: AI settles each step of the rebase, and the
/// last one wins.
#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai06_every_commit_of_the_rebase_conflicts() {
    let c = case(&[("src/config.ts", "export const TIMEOUT = 30;\n")]).await;
    sh(&c.repo, &["switch", "-qc", "feat/x"]);
    commit(&c.repo, "src/config.ts", "export const TIMEOUT = 45;\n", "feat: 45s timeout");
    commit(&c.repo, "src/config.ts", "export const TIMEOUT = 50;\n", "feat: 50s timeout");
    sh(&c.repo, &["switch", "-q", "main"]);
    commit(&c.repo, "src/config.ts", "export const REQUEST_TIMEOUT = 30;\n", "refactor: rename timeout");
    c.rebase().await;
    let f = read(&c.repo, "src/config.ts");
    assert_eq!(c.markers("src/config.ts"), 0, "{f}");
    assert!(f.contains("REQUEST_TIMEOUT = 50"), "{f}");
    assert_eq!(git_out(&c.repo, &["rev-list", "--count", "main..feat/x"]), "2", "both commits kept");
}
