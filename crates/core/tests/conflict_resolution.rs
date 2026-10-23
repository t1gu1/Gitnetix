//! Conflicts get resolved by AI and the operation carries on. A fake `ollama` CLI on PATH stands
//! in for the AI. Own test binary: PATH is process-wide.

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
async fn ai_resolves_conflicts_and_the_operation_goes_through() {
    let tmp = tempfile::tempdir().unwrap();
    // Each answer differs ("resolved 1", "resolved 2"…), so no resolution leaves a commit empty.
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let counter = tmp.path().join("answers");
    let script = bin.join("ollama");
    std::fs::write(&script, format!("#!/bin/sh\ncat >/dev/null\nn=$(($(cat '{0}' 2>/dev/null || echo 0) + 1))\necho $n > '{0}'\nprintf 'resolved %s\\n' \"$n\"\n", counter.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default()));

    let repo = tmp.path().join("atlas-api");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    commit_file(&repo, "README.md", "# atlas\n");
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    call(&k, "ai.saveProvider", json!({ "id": "ollama", "method": "cli" })).await;
    call(&k, "ai.setDefault", json!({ "id": "ollama" })).await;
    call(&k, "ai.setRoute", json!({ "task": "conflict", "provider": "ollama" })).await;
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let readme = || std::fs::read_to_string(repo.join("README.md")).unwrap();

    // Merge into the checked-out branch: a merge commit with the resolved file.
    sh(&repo, &["switch", "-qc", "feat/b"]);
    commit_file(&repo, "README.md", "# b\n");
    sh(&repo, &["switch", "-q", "main"]);
    commit_file(&repo, "README.md", "# main\n");
    let b = rev(&repo, "feat/b");
    call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/b", "into": "main", "deleteBranch": false })).await;
    assert_eq!(readme(), "resolved 1\n");
    assert_eq!(rev(&repo, "main^2"), b);
    assert!(git_out(&repo, &["status", "--porcelain"]).is_empty());

    // Merge into a branch checked out nowhere: done in a throwaway worktree, then gone.
    sh(&repo, &["switch", "-qc", "feat/t"]);
    commit_file(&repo, "README.md", "# t\n");
    sh(&repo, &["switch", "-qc", "feat/c", "main"]);
    commit_file(&repo, "README.md", "# c\n");
    sh(&repo, &["switch", "-q", "main"]);
    call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/c", "into": "feat/t", "deleteBranch": false, "stay": true })).await;
    assert_eq!(git_out(&repo, &["show", "feat/t:README.md"]), "resolved 2\n");
    assert_eq!(rev(&repo, "feat/t^2"), rev(&repo, "feat/c"));
    assert_eq!(git_out(&repo, &["worktree", "list"]).lines().count(), 1);

    // Rebase onto the base: goes all the way through.
    sh(&repo, &["switch", "-qc", "feat/r", "main~1"]);
    commit_file(&repo, "README.md", "# r\n");
    let r = call(&k, "workspace.rebase", json!({ "projectId": pid, "branch": "feat/r" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r}");
    assert_eq!(rev(&repo, "feat/r~1"), rev(&repo, "main"));
    assert_eq!(readme(), "resolved 3\n");

    // Cherry-pick onto the checked-out branch.
    sh(&repo, &["switch", "-qc", "feat/p", "main~1"]);
    commit_file(&repo, "README.md", "# p\n");
    let p = rev(&repo, "feat/p");
    sh(&repo, &["switch", "-q", "main"]);
    let before = rev(&repo, "main");
    call(&k, "commits.cherryPick", json!({ "projectId": pid, "onto": "main", "sha": p })).await;
    assert_eq!(rev(&repo, "main~1"), before);
    assert_eq!(readme(), "resolved 4\n");

    // Stash pop: resolved, staged, and the stash dropped.
    std::fs::write(repo.join("README.md"), "# stashed\n").unwrap();
    call(&k, "branches.stash", json!({ "projectId": pid, "branch": "main" })).await;
    commit_file(&repo, "README.md", "# other\n");
    let sha = call(&k, "stashes.list", json!({ "projectId": pid })).await[0]["sha"].as_str().unwrap().to_string();
    let r = call(&k, "stashes.apply", json!({ "projectId": pid, "branch": "main", "sha": sha, "pop": true })).await;
    assert_eq!(r["conflicts"], json!([]), "{r}");
    assert_eq!(r["dropped"], true);
    assert_eq!(readme(), "resolved 5\n");
    sh(&repo, &["commit", "-qm", "resolved stash"]);

    // AI failing: the merge is aborted, nothing changed, and the error says why.
    std::fs::write(&script, "#!/bin/sh\necho 'model not found' >&2\nexit 1\n").unwrap();
    sh(&repo, &["switch", "-qc", "feat/x", "main~1"]);
    commit_file(&repo, "README.md", "# x\n");
    sh(&repo, &["switch", "-q", "main"]);
    let before = rev(&repo, "main");
    let err = rpc::call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/x", "into": "main", "deleteBranch": false })).await.unwrap_err();
    assert!(err.to_string().contains("AI could not resolve README.md"), "{err}");
    assert_eq!(rev(&repo, "main"), before);
    assert!(git_out(&repo, &["status", "--porcelain"]).is_empty());
    assert!(rev(&repo, "MERGE_HEAD").is_empty());
}
