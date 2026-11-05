//! A rebase AI carries through every commit on its own, binary files included, telling the UIs how far
//! it is; an abort stops it. A fake `ollama` CLI on PATH stands in for the AI. Own test binary: PATH is
//! process-wide.
// The fake CLI is a `#!/bin/sh` script with an execute bit.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use gitnetix_core::app::{RebaseRun, RunState};
use gitnetix_core::{rpc, Event, Gitnetix};
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

fn commit(repo: &Path, path: &str, body: &[u8], message: &str) {
    std::fs::write(repo.join(path), body).unwrap();
    sh(repo, &["add", "."]);
    sh(repo, &["commit", "-qm", message]);
}

async fn call(k: &Gitnetix, m: &str, p: Value) -> Value {
    match rpc::call(k, m, p).await {
        Ok(v) => v,
        Err(e) => panic!("{m}: {e}"),
    }
}

/// The fake AI, `body` run with the prompt in `$prompt`.
fn fake_ai(script: &Path, body: &str) {
    std::fs::write(script, format!("#!/bin/sh\nprompt=$(cat)\n{body}\n")).unwrap();
    std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Every rebase run news sent so far.
fn runs_told(rx: &mut tokio::sync::broadcast::Receiver<Event>) -> Vec<RebaseRun> {
    let mut out = Vec::new();
    loop {
        match rx.try_recv() {
            Ok(Event::RebaseRun { run }) => out.push(run),
            Ok(_) | Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
            Err(_) => return out,
        }
    }
}

// Not valid UTF-8, with a NUL: git takes them for binary and writes no conflict markers.
const PIN: &[u8] = b"\x89PNG\r\n\x1a\n\x00base\xff";
const PIN_MAIN: &[u8] = b"\x89PNG\r\n\x1a\n\x00main\xff\xfe";
const PIN_BRANCH: &[u8] = b"\x89PNG\r\n\x1a\n\x00branch\xff\xfd";

#[tokio::test]
async fn ai_carries_a_rebase_through_binary_conflicts_and_an_abort_stops_it() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let script = bin.join("ollama");
    let counter = tmp.path().join("answers");
    let picked = tmp.path().join("picked");
    // Text conflicts: an edit swapping the conflict for "resolved N", a new N each time. Binary ones: `$side`.
    let answer = |side: &str| {
        fake_ai(
            &script,
            &format!(
                "case \"$prompt\" in\n*'incoming or current'*) printf '%s' \"$prompt\" > '{picked}'; echo '{side}.';;\n*) n=$(($(cat '{counter}' 2>/dev/null || echo 0) + 1)); echo $n > '{counter}'\necho '[[FIND]]'\nprintf '%s\\n' \"$prompt\" | awk '/^<<<<<<< /{{f=1}} f{{print}} /^>>>>>>> /{{f=0}}'\nprintf '[[REPLACE]]\\nresolved %s\\n[[END]]\\n' \"$n\";;\nesac",
                picked = picked.display(),
                counter = counter.display(),
            ),
        )
    };
    answer("incoming");
    std::env::set_var("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default()));

    let repo = tmp.path().join("atlas-app");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(&repo, args);
    }
    commit(&repo, "README.md", b"# atlas\n", "init");
    commit(&repo, "pin.png", PIN, "add pin");
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    call(&k, "ai.saveProvider", json!({ "id": "ollama", "method": "cli" })).await;
    call(&k, "ai.setDefault", json!({ "id": "ollama" })).await;
    call(&k, "ai.setRoute", json!({ "task": "conflict", "provider": "ollama" })).await;
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();
    let readme = || std::fs::read_to_string(repo.join("README.md")).unwrap();
    let pin = || std::fs::read(repo.join("pin.png")).unwrap();

    // Three commits, each one conflicting: text, binary, text again.
    sh(&repo, &["switch", "-qc", "feat/r"]);
    commit(&repo, "README.md", b"# r1\n", "r1");
    commit(&repo, "pin.png", PIN_BRANCH, "new pin");
    commit(&repo, "README.md", b"# r3\n", "r3");
    sh(&repo, &["switch", "-q", "main"]);
    std::fs::write(repo.join("README.md"), "# main\n").unwrap();
    commit(&repo, "pin.png", PIN_MAIN, "main pin");
    sh(&repo, &["switch", "-q", "feat/r"]);

    let mut rx = k.events.subscribe();
    let r = call(&k, "workspace.rebase", json!({ "projectId": pid, "branch": "feat/r", "onto": "main" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r}");
    assert_eq!(r["errors"], json!([]), "{r}");
    assert_eq!(r["resolved"], 3, "{r}");
    assert_eq!(rev(&repo, "feat/r~3"), rev(&repo, "main"));
    assert_eq!(pin(), PIN_BRANCH);
    assert_eq!(readme(), "resolved 2\n");
    let asked = std::fs::read_to_string(&picked).unwrap();
    assert!(asked.contains("pin.png can't be merged line by line"), "{asked}");
    assert!(asked.contains("incoming: the version from feat/r"), "{asked}");
    assert!(asked.contains("- new pin"), "{asked}");
    assert!(asked.contains("- main pin"), "{asked}");
    // The UIs heard of each commit it stopped on, then of the end.
    let told = runs_told(&mut rx);
    let at = |step: u32| told.iter().find(|r| r.step == step && r.resolved == 0).unwrap_or_else(|| panic!("step {step}: {told:#?}"));
    assert_eq!((at(1).steps, at(1).files.clone()), (3, vec!["README.md".to_string()]));
    assert_eq!((at(2).subject.as_str(), at(2).files.clone()), ("new pin", vec!["pin.png".to_string()]));
    assert_eq!(at(3).subject, "r3");
    let last = told.last().unwrap();
    assert_eq!((last.state, last.resolved_total, last.branch.as_str(), last.onto.as_str()), (RunState::Done, 3, "feat/r", "main"));
    assert_eq!(call(&k, "workspace.rebaseRuns", json!({})).await, json!([]));

    // AI resolving off: the rebase stops on the binary file. Asked for, AI resolves it all the same.
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "merge": { "resolveConflicts": false } })).await;
    answer("current");
    sh(&repo, &["switch", "-qc", "feat/c", "main~1"]);
    commit(&repo, "pin.png", PIN_BRANCH, "pin again");
    let r = call(&k, "workspace.rebase", json!({ "projectId": pid, "branch": "feat/c", "onto": "main" })).await;
    assert_eq!(r["conflicts"], json!(["pin.png"]), "{r}");
    let r = call(&k, "workspace.rebaseContinue", json!({ "projectId": pid, "branch": "feat/c" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r}");
    assert_eq!(r["resolved"], 1, "{r}");
    // Kept main's version: the commit had nothing else, so nothing is left of it.
    assert_eq!(pin(), PIN_MAIN);
    assert_eq!(rev(&repo, "feat/c"), rev(&repo, "main"));

    // First answers that can't be used (edits matching nothing, neither word): a second pass settles
    // the text one conflict at a time and makes AI pick a side, and the rebase goes through.
    call(&k, "projects.setPrefs", json!({ "projectId": pid, "merge": { "resolveConflicts": true } })).await;
    fake_ai(
        &script,
        "case \"$prompt\" in\n*'second pass'*'incoming or current'*) echo incoming;;\n*'incoming or current'*) echo 'maybe both?';;\n*'This is the second pass'*) printf '```\\nmerged one conflict at a time\\n```\\n';;\n*) printf '[[FIND]]\\nnothing like this\\n[[REPLACE]]\\nx\\n[[END]]\\n';;\nesac",
    );
    sh(&repo, &["switch", "-qc", "feat/s", "main~1"]);
    std::fs::write(repo.join("README.md"), "# s\n").unwrap();
    commit(&repo, "pin.png", PIN_BRANCH, "s everywhere");
    let mut rx = k.events.subscribe();
    let r = call(&k, "workspace.rebase", json!({ "projectId": pid, "branch": "feat/s", "onto": "main" })).await;
    assert_eq!(r["conflicts"], json!([]), "{r}");
    assert_eq!(r["resolved"], 2, "{r}");
    assert_eq!(readme(), "merged one conflict at a time\n");
    assert_eq!(pin(), PIN_BRANCH);
    assert_eq!(rev(&repo, "feat/s~1"), rev(&repo, "main"));
    let told = runs_told(&mut rx);
    assert!(told.iter().any(|r| r.second_pass == ["README.md", "pin.png"]), "{told:#?}");
    assert!(told.last().unwrap().second_pass.is_empty());

    // An AI that takes its time: an abort stops it, and the branch is back where it was.
    fake_ai(&script, "sleep 30");
    sh(&repo, &["switch", "-qc", "feat/a", "main~1"]);
    commit(&repo, "README.md", b"# a\n", "a");
    let before = rev(&repo, "feat/a");
    let k2 = k.clone();
    let p2 = pid.clone();
    let running = tokio::spawn(async move { rpc::call(&k2, "workspace.rebase", json!({ "projectId": p2, "branch": "feat/a", "onto": "main" })).await });
    let mut seen = json!([]);
    for _ in 0..200 {
        seen = call(&k, "workspace.rebaseRuns", json!({})).await;
        if seen.as_array().is_some_and(|a| !a.is_empty()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(seen[0]["branch"], "feat/a", "{seen}");
    assert_eq!(seen[0]["files"], json!(["README.md"]), "{seen}");
    // Nothing else touches the checkout meanwhile.
    let err = rpc::call(&k, "workspace.stage", json!({ "projectId": pid, "branch": "feat/a", "paths": ["README.md"] })).await.unwrap_err();
    assert!(err.to_string().contains("AI is rebasing feat/a"), "{err}");
    let err = rpc::call(&k, "workspace.switch", json!({ "projectId": pid, "branch": "main", "abort": true })).await.unwrap_err();
    assert!(err.to_string().contains("AI is rebasing feat/a"), "{err}");
    // The branch it goes onto neither: what it replays onto would move under it.
    let err = rpc::call(&k, "branches.rename", json!({ "projectId": pid, "branch": "main", "name": "trunk" })).await.unwrap_err();
    assert!(err.to_string().contains("Rebase & conflict resolving is running"), "{err}");
    assert!(err.to_string().contains("main stays locked"), "{err}");
    let started = std::time::Instant::now();
    call(&k, "workspace.abort", json!({ "projectId": pid, "branch": "feat/a" })).await;
    assert!(started.elapsed() < Duration::from_secs(10), "the abort waited for the AI");
    let r = running.await.unwrap().unwrap();
    assert_eq!(r["aborted"], true, "{r}");
    assert_eq!(rev(&repo, "feat/a"), before);
    assert_eq!(git_out(&repo, &["symbolic-ref", "--short", "HEAD"]).trim(), "feat/a");
    assert!(git_out(&repo, &["status", "--porcelain"]).is_empty());
    assert_eq!(call(&k, "workspace.rebaseRuns", json!({})).await, json!([]));
}
