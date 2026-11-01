//! Every project of a profile commits with the profile's Git identity; without one, the repository's config decides.

use std::path::Path;
use std::process::Command;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

async fn call(k: &Gitnetix, m: &str, p: Value) -> Value {
    rpc::call(k, m, p).await.unwrap_or_else(|e| panic!("{m}: {e}"))
}

/// Commits a change through Gitnetix; returns its author.
async fn commit(k: &Gitnetix, pid: &str, repo: &Path, text: &str) -> String {
    std::fs::write(repo.join("a"), text).unwrap();
    call(k, "workspace.commit", json!({ "projectId": pid, "branch": "main", "message": text, "all": true })).await;
    git(repo, &["log", "-1", "--format=%an <%ae>"])
}

async fn add(k: &Gitnetix, repo: &Path) -> String {
    call(k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn projects_commit_with_the_profile_identity() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "repo@example.com"], &["config", "user.name", "Repo"], &["config", "commit.gpgsign", "false"]] {
        git(&repo, args);
    }
    std::fs::write(repo.join("a"), "0").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let pid = add(&k, &repo).await;
    assert_eq!(commit(&k, &pid, &repo, "1").await, "Repo <repo@example.com>", "no identity yet: the repository's");

    call(&k, "userProfiles.save", json!({ "id": "default", "name": "Work", "git": { "name": " Pro ", "email": "pro@work.com", "sign": false } })).await;
    assert_eq!(commit(&k, &pid, &repo, "2").await, "Pro <pro@work.com>");

    let home = call(&k, "userProfiles.save", json!({ "name": "Home", "git": { "name": "Me", "email": "me@home.org" } })).await;
    assert_eq!(commit(&k, &pid, &repo, "3").await, "Pro <pro@work.com>", "a new profile's identity goes to its own settings");
    let err = rpc::call(&k, "userProfiles.save", json!({ "id": home["id"], "name": "Home", "git": { "email": "x@y.z" } })).await;
    assert!(err.is_err(), "only the active profile's identity changes");
    assert!(rpc::call(&k, "userProfiles.save", json!({ "id": "default", "name": "Work", "git": { "email": "nope" } })).await.is_err());

    call(&k, "userProfiles.save", json!({ "id": "default", "name": "Work", "git": { "name": "", "email": "" } })).await;
    assert_eq!(commit(&k, &pid, &repo, "4").await, "Repo <repo@example.com>", "all empty: the repository's again");

    call(&k, "userProfiles.switch", json!({ "id": home["id"] })).await;
    let pid = add(&k, &repo).await;
    assert_eq!(commit(&k, &pid, &repo, "5").await, "Me <me@home.org>");
}
