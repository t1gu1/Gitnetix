//! Conflicts that need no choice are settled without AI, on every step of a rebase and in a merge. AI gets only the
//! rest, and a file edited by hand since git wrote it goes to AI as it is. Cases AI-08 to AI-12 of `list-of-test.md`;
//! the rules themselves are checked in `src/auto_resolve.rs`. A fake `ollama` CLI on PATH stands in for the AI and
//! notes each file it is asked about. Own test binary: PATH is process-wide.
// The fake CLI is a `#!/bin/sh` script with an execute bit.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

fn sh(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn git_out(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(repo).args(args).output().unwrap();
    String::from_utf8(out.stdout).unwrap()
}

fn rev(repo: &Path, r: &str) -> String {
    git_out(repo, &["rev-parse", "--verify", "-q", r]).trim().to_string()
}

fn commit(repo: &Path, files: &[(&str, &str)], message: &str) {
    for (path, body) in files {
        std::fs::write(repo.join(path), body).unwrap();
    }
    sh(repo, &["add", "-A"]);
    sh(repo, &["commit", "-qm", message]);
}

async fn call(k: &Gitnetix, m: &str, p: Value) -> Value {
    match rpc::call(k, m, p).await {
        Ok(v) => v,
        Err(e) => panic!("{m}: {e}"),
    }
}

/// AI-08 to AI-12, one test as they share the fake AI on PATH.
#[tokio::test]
async fn ai08_to_ai12_conflicts_needing_no_choice_are_settled_without_ai() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let asked = tmp.path().join("asked");
    let script = bin.join("ollama");
    // Notes the file it is asked about, then swaps the conflict it's shown for "resolved by AI".
    std::fs::write(&script, format!("#!/bin/sh\n[ \"$1\" = list ] && exit 0\nprompt=$(cat)\nprintf '%s\\n' \"$prompt\" | sed -n 's/^Resolve the merge conflicts in \\(.*\\) between .*/\\1/p' >> '{}'\necho '[[FIND]]'\nprintf '%s\\n' \"$prompt\" | awk '/^<<<<<<< /{{f=1}} f{{print}} /^>>>>>>> /{{f=0}}'\nprintf '[[REPLACE]]\\nresolved by AI\\n[[END]]\\n'\n", asked.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default()));

    let repo = tmp.path().join("atlas-api");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"], &["config", "core.autocrlf", "false"]] {
        sh(&repo, args);
    }
    commit(&repo, &[("README.md", "# atlas\n")], "init");
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    call(&k, "ai.saveProvider", json!({ "id": "ollama", "method": "cli" })).await;
    call(&k, "ai.setDefault", json!({ "id": "ollama" })).await;
    call(&k, "ai.setRoute", json!({ "task": "conflict", "provider": "ollama" })).await;
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let read = |f: &str| std::fs::read_to_string(repo.join(f)).unwrap();
    let asked_about = || std::fs::read_to_string(&asked).unwrap_or_default();
    let rebase = |branch: &'static str| {
        sh(&repo, &["switch", "-q", branch]);
        call(&k, "workspace.rebase", json!({ "projectId": pid, "branch": branch, "onto": "main" }))
    };

    // AI-08: both steps of a rebase settled without AI: lines both sides added at one place, changes to lines next to
    // each other, a test both sides appended.
    let tests = |names: &[&str]| names.iter().map(|n| format!("#[test]\nfn {n}() {{\n    assert!(true);\n}}\n")).collect::<Vec<_>>().join("\n");
    commit(&repo, &[(".gitignore", "target/\n"), ("config.toml", "name = \"atlas\"\nport = 80\nhost = \"localhost\"\n"), ("tests.rs", &tests(&["first"]))], "base");
    sh(&repo, &["switch", "-qc", "feat/r"]);
    commit(&repo, &[(".gitignore", "target/\n.env\n"), ("config.toml", "name = \"atlas\"\nport = 8080\nhost = \"localhost\"\n")], "ignore .env, port 8080");
    commit(&repo, &[("tests.rs", &tests(&["first", "from_branch"]))], "test from the branch");
    sh(&repo, &["switch", "-q", "main"]);
    commit(&repo, &[(".gitignore", "target/\nnode_modules/\n"), ("config.toml", "name = \"atlas-api\"\nport = 80\nhost = \"localhost\"\n"), ("tests.rs", &tests(&["first", "from_main"]))], "main moves on");
    let r = rebase("feat/r").await;
    assert_eq!((r["conflicts"].clone(), r["errors"].clone(), r["resolved"].clone()), (json!([]), json!([]), json!(3)), "{r}");
    assert_eq!(rev(&repo, "feat/r~2"), rev(&repo, "main"));
    let log = call(&k, "log.get", json!({})).await;
    let about = |file: &str| log.as_array().unwrap().iter().filter_map(|e| e["text"].as_str()).filter(|t| t.contains(file)).collect::<Vec<_>>().join("\n");
    assert_eq!(read(".gitignore"), "target/\nnode_modules/\n.env\n", "{}", about(".gitignore"));
    assert_eq!(read("config.toml"), "name = \"atlas-api\"\nport = 8080\nhost = \"localhost\"\n", "{}", about("config.toml"));
    assert_eq!(read("tests.rs"), tests(&["first", "from_main", "from_branch"]), "{}", about("tests.rs"));
    assert_eq!(asked_about(), "", "AI was asked");
    let settled = log.as_array().unwrap().iter().filter(|e| e["text"].as_str().is_some_and(|t| t.contains("without AI: none of its conflicts needed a choice"))).count();
    assert_eq!(settled, 3, "{log}");

    // AI-09: a merge, in a page that shows conflict markers as text: the example stays, the real conflict goes.
    let example = "```\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n```\n";
    let doc = |tips: &str| format!("# Conflicts\n\n{example}\n## Tips\n\n- Pull first.\n{tips}");
    sh(&repo, &["switch", "-q", "main"]);
    commit(&repo, &[("docs.md", &doc(""))], "docs");
    sh(&repo, &["switch", "-qc", "feat/d"]);
    commit(&repo, &[("docs.md", &doc("- Commit small.\n"))], "tip: commit small");
    sh(&repo, &["switch", "-q", "main"]);
    commit(&repo, &[("docs.md", &doc("- Rebase often.\n"))], "tip: rebase often");
    call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/d", "into": "main", "deleteBranch": false })).await;
    assert_eq!(read("docs.md"), doc("- Rebase often.\n- Commit small.\n"));
    assert_eq!(rev(&repo, "main^2"), rev(&repo, "feat/d"));
    assert_eq!(asked_about(), "", "AI was asked");

    // AI-10: in one step, a file that needs no choice and one that does (the same line changed on both sides): AI is
    // asked about the second only.
    commit(&repo, &[("list.md", "- one\n"), ("limits.ts", "export const TIMEOUT = 30;\n")], "list and limits");
    sh(&repo, &["switch", "-qc", "feat/m"]);
    commit(&repo, &[("list.md", "- one\n- from branch\n"), ("limits.ts", "export const TIMEOUT = 45;\n")], "branch edits");
    sh(&repo, &["switch", "-q", "main"]);
    commit(&repo, &[("list.md", "- one\n- from main\n"), ("limits.ts", "export const REQUEST_TIMEOUT = 30;\n")], "main edits");
    let r = rebase("feat/m").await;
    assert_eq!((r["conflicts"].clone(), r["resolved"].clone()), (json!([]), json!(2)), "{r}");
    assert_eq!(read("list.md"), "- one\n- from main\n- from branch\n");
    assert_eq!(read("limits.ts"), "resolved by AI\n");
    assert_eq!(asked_about(), "limits.ts\n");

    // AI-11: AI resolving off, the rebase stops and nothing touches the file. Its first conflict settled by hand, then
    // "Resolve with AI": the file goes to AI as it is (no choice was needed, but it is no longer what git wrote).
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "merge": { "resolveConflicts": false } })).await;
    sh(&repo, &["switch", "-q", "main"]);
    commit(&repo, &[("steps.txt", "a\nb\n1\n2\n3\n4\n5\nx\n")], "steps");
    sh(&repo, &["switch", "-qc", "feat/h"]);
    commit(&repo, &[("steps.txt", "a\nB\n1\n2\n3\n4\n5\nx\nfrom branch\n")], "branch steps");
    sh(&repo, &["switch", "-q", "main"]);
    commit(&repo, &[("steps.txt", "A\nb\n1\n2\n3\n4\n5\nx\nfrom main\n")], "main steps");
    let r = rebase("feat/h").await;
    assert_eq!(r["conflicts"], json!(["steps.txt"]), "{r}");
    let work = read("steps.txt");
    assert_eq!(work.matches("<<<<<<<").count(), 2, "{work}");
    let end = work.find(">>>>>>>").unwrap();
    let end = end + work[end..].find('\n').unwrap() + 1;
    std::fs::write(repo.join("steps.txt"), format!("a, b by hand\n{}", &work[end..])).unwrap();
    let r = call(&k, "workspace.rebaseContinue", json!({ "projectId": pid, "branch": "feat/h" })).await;
    assert_eq!((r["conflicts"].clone(), r["resolved"].clone()), (json!([]), json!(1)), "{r}");
    assert_eq!(read("steps.txt"), "a, b by hand\n1\n2\n3\n4\n5\nx\nresolved by AI\n");
    assert_eq!(asked_about(), "limits.ts\nsteps.txt\n");
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "merge": { "resolveConflicts": true } })).await;

    // AI-12: main moved a file to CRLF line endings, the branch changed a line: the change is kept, every line in CRLF.
    sh(&repo, &["switch", "-q", "main"]);
    commit(&repo, &[("notes.txt", "alpha\nbeta\ngamma\n")], "notes");
    sh(&repo, &["switch", "-qc", "feat/c"]);
    commit(&repo, &[("notes.txt", "alpha\nBETA\ngamma\n")], "shout beta");
    sh(&repo, &["switch", "-q", "main"]);
    commit(&repo, &[("notes.txt", "alpha\r\nbeta\r\ngamma\r\n")], "CRLF line endings");
    let r = rebase("feat/c").await;
    assert_eq!((r["conflicts"].clone(), r["resolved"].clone()), (json!([]), json!(1)), "{r}");
    assert_eq!(read("notes.txt"), "alpha\r\nBETA\r\ngamma\r\n");
    assert_eq!(rev(&repo, "feat/c~1"), rev(&repo, "main"));
    assert_eq!(asked_about(), "limits.ts\nsteps.txt\n", "AI was asked about notes.txt");
    assert!(git_out(&repo, &["status", "--porcelain"]).is_empty());
}
