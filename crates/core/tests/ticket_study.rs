//! Tickets AI writes: from a branch's work, and from a request after an agent studies the code in throwaway checkouts
//! of each project's default branch, which go with its session. A fake `ollama` CLI on PATH stands in for the AI.
//! Own test binary: PATH is process-wide.
// The fake CLI is a `#!/bin/sh` script with an execute bit.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use gitnetix_core::agents::AgentStatus;
use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

fn sh(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn git_out(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(repo).args(args).output().unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "Test"], &["config", "commit.gpgsign", "false"]] {
        sh(dir, args);
    }
}

fn commit(repo: &Path, path: &str, body: &str, message: &str) {
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

/// Worktree folders git lists for `repo`, the main checkout aside.
fn linked(repo: &Path) -> Vec<String> {
    git_out(repo, &["worktree", "list", "--porcelain"]).lines().filter_map(|l| l.strip_prefix("worktree ")).skip(1).map(String::from).collect()
}

/// WT-10, and a ticket drafted from a branch's work.
#[tokio::test]
async fn wt10_tickets_from_a_branch_and_from_a_study_of_each_default_branch() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let prompts = tmp.path().join("prompts");
    std::fs::create_dir(&prompts).unwrap();
    // Saves each prompt; a study answers with its ticket between the markers, a one-shot draft with the ticket alone.
    // `ollama list`, the model list read before the first run, is not a prompt.
    let script = bin.join("ollama");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n[ \"$1\" = list ] && exit 0\nprompt=$(cat)\nn=$(ls '{p}' | wc -l)\nprintf '%s' \"$prompt\" > '{p}/'$n\ncase \"$prompt\" in\n*'Before you write, study the code'*) printf 'I read report.ts.\\n\\n[[TICKET]]\\nExport the report as CSV\\n\\n## Acceptance criteria\\n- [ ] A CSV downloads\\n[[END]]\\n';;\n*) printf 'Add CSV export\\n\\n## Goal\\nExport rows.\\n\\n## Done when\\n- [ ] A CSV downloads\\n';;\nesac\n",
            p = prompts.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default()));
    let prompt = |n: usize| std::fs::read_to_string(prompts.join(n.to_string())).unwrap();

    // atlas: origin has main at "init"; main has a commit since, not pushed.
    let atlas = tmp.path().join("atlas");
    repo(&atlas);
    commit(&atlas, "report.ts", "export function report() {}\n", "init");
    let origin = tmp.path().join("origin.git");
    sh(tmp.path(), &["init", "-q", "--bare", "-b", "main", &origin.to_string_lossy()]);
    sh(&atlas, &["remote", "add", "origin", &origin.to_string_lossy()]);
    sh(&atlas, &["push", "-q", "-u", "origin", "main"]);
    let pushed = git_out(&atlas, &["rev-parse", "origin/main"]);
    commit(&atlas, "local.txt", "not pushed\n", "local only");
    // The work a ticket is written from, checked out with changes of its own.
    sh(&atlas, &["switch", "-qc", "feat/csv"]);
    commit(&atlas, "csv.ts", "export function csv() {}\n", "feat: csv export");
    std::fs::write(atlas.join("wip.txt"), "uncommitted\n").unwrap();
    // docs: no origin.
    let docs = tmp.path().join("docs");
    repo(&docs);
    commit(&docs, "guide.md", "# Guide\n", "docs");
    let docs_main = git_out(&docs, &["rev-parse", "main"]);

    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    call(&k, "ai.saveProvider", json!({ "id": "ollama", "method": "cli" })).await;
    call(&k, "ai.setDefault", json!({ "id": "ollama" })).await;
    let added = call(&k, "projects.add", json!({ "paths": [atlas.to_string_lossy(), docs.to_string_lossy()] })).await;
    let (pid, docs_id) = (added[0]["id"].as_str().unwrap().to_string(), added[1]["id"].as_str().unwrap().to_string());

    // From the branch: its commits and diff against main, with the template picked.
    let d = call(&k, "tickets.draft", json!({ "projectId": pid, "branch": "feat/csv", "template": "ticket-task", "request": "Mention the button" })).await;
    assert_eq!(d["title"], "Add CSV export");
    assert_eq!(d["body"], "## Goal\nExport rows.\n\n## Done when\n- [ ] A CSV downloads");
    let p = prompt(0);
    for part in ["Write a task ticket for atlas.", "What the user asked for:\nMention the button", "Commits on feat/csv that main does not have yet", "feat: csv export", "+export function csv() {}", "The work on feat/csv is done already.", "- [ ] …"] {
        assert!(p.contains(part), "missing {part:?} in {p}");
    }

    // A study: a checkout of each project's default branch, origin's copy when there is one.
    let s = call(
        &k,
        "tickets.study",
        json!({ "projectId": pid, "projects": [docs_id, pid], "request": "Let people export the report as CSV", "source": "jira", "conn": "j1", "place": "ATL", "kind": "10001" }),
    )
    .await;
    let id = s["id"].as_str().unwrap().to_string();
    let study = &s["study"];
    assert_eq!((study["source"].as_str(), study["conn"].as_str(), study["place"].as_str(), study["kind"].as_str(), study["template"].as_str()), (Some("jira"), Some("j1"), Some("ATL"), Some("10001"), Some("ticket-feature")));
    let checkouts: Vec<(String, String)> = study["checkouts"].as_array().unwrap().iter().map(|c| (c["projectId"].as_str().unwrap().into(), c["path"].as_str().unwrap().into())).collect();
    assert_eq!(checkouts.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), [pid.as_str(), docs_id.as_str()], "this project first, each once");
    assert_eq!(s["cwd"].as_str(), Some(checkouts[0].1.as_str()));
    let (atlas_wt, docs_wt) = (Path::new(&checkouts[0].1), Path::new(&checkouts[1].1));
    assert!(atlas_wt.file_name().unwrap().to_string_lossy().starts_with("atlas.ticket-"), "{}", atlas_wt.display());
    assert_eq!(git_out(atlas_wt, &["rev-parse", "HEAD"]), pushed, "origin's main, not the local one");
    assert_eq!(git_out(docs_wt, &["rev-parse", "HEAD"]), docs_main);
    assert!(git_out(atlas_wt, &["symbolic-ref", "-q", "HEAD"]).is_empty(), "detached, so no branch is taken");
    assert!(!atlas_wt.join("local.txt").exists() && !atlas_wt.join("wip.txt").exists());
    // The user's checkout is left as it was.
    assert_eq!(git_out(&atlas, &["branch", "--show-current"]), "feat/csv");
    assert!(atlas.join("wip.txt").exists());

    let mut waited = 0;
    while k.agents.get(&id).unwrap().status == AgentStatus::Running && waited < 100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        waited += 1;
    }
    let session = k.agents.get(&id).unwrap();
    assert!(session.lines.iter().any(|l| l.text.contains("[[TICKET]]")), "{:?}", session.lines);
    let p = prompt(1);
    for part in ["Write a feature ticket for atlas.", "What the user asked for:\nLet people export the report as CSV", &format!("- {} (atlas)", checkouts[0].1), &format!("- {} (docs)", checkouts[1].1), "between a line [[TICKET]] and a line [[END]]", "Write the result in English."] {
        assert!(p.contains(part), "missing {part:?} in {p}");
    }
    assert!(!p.contains("Reply with the result only"), "an agent explains, then gives the ticket: {p}");

    // Dismissed: the session and its checkouts go, the user's checkouts stay.
    call(&k, "agents.remove", json!({ "id": id })).await;
    assert!(k.agents.get(&id).is_err());
    assert!(!atlas_wt.exists() && !docs_wt.exists());
    assert_eq!((linked(&atlas), linked(&docs)), (vec![], vec![]));
    assert!(atlas.join("wip.txt").exists());
}
