//! Backups: a save point of this computer's Gitnetix data on the account, encrypted with the account key, and its
//! restore, here or on a new computer. A backup holds every profile's settings (projects and their settings, templates,
//! AI setup) and the agent sessions. Never tokens (each computer's keychain keeps its own), nor caches, logs, models or
//! the companion's certificate, which a computer remakes.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use reqwest::Method;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::agents::AgentStatus;
use crate::error::{Error, Result};
use crate::vault::DataKey;
use crate::{account, Gitnetix};

/// The data folder's files a backup carries, besides `profiles/<id>.json`.
const FILES: [&str; 3] = ["config.json", "profiles.json", "agents.json"];
const DAY: i64 = 24 * 3600;

fn is_profile(name: &str) -> bool {
    name.strip_suffix(".json").is_some_and(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
}

/// Only these names come in from a backup: one naming anything else (`../x`) is refused whole.
fn allowed(name: &str) -> bool {
    FILES.contains(&name) || name.strip_prefix("profiles/").is_some_and(is_profile)
}

/// A profile's settings: each holds the computer's own account state, which never travels.
fn is_config(name: &str) -> bool {
    name == "config.json" || name.starts_with("profiles/")
}

fn without_account(text: &str) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(mut v) => {
            v.as_object_mut().map(|m| m.remove("account"));
            v.to_string()
        }
        Err(_) => text.to_string(),
    }
}

/// The data folder's files a backup takes, by path from the folder.
pub fn pack(dir: &Path) -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    for name in FILES {
        if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
            files.insert(name.to_string(), text);
        }
    }
    for entry in std::fs::read_dir(dir.join("profiles")).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let (true, Ok(text)) = (is_profile(&name), std::fs::read_to_string(entry.path())) {
            files.insert(format!("profiles/{name}"), text);
        }
    }
    for (name, text) in files.iter_mut() {
        if is_config(name) {
            *text = without_account(text);
        }
    }
    files
}

/// Writes a backup's files over this computer's, after copying the current ones into `before-restore-<time>/`. Each
/// profile keeps this computer's own account state. Returns that folder.
pub fn restore_files(dir: &Path, files: &BTreeMap<String, String>) -> Result<PathBuf> {
    if let Some(bad) = files.keys().find(|n| !allowed(n)) {
        return Err(Error::Invalid(format!("This backup names a file Gitnetix doesn't restore: {bad}")));
    }
    let kept = dir.join(format!("before-restore-{}", chrono::Utc::now().format("%Y%m%d-%H%M%S")));
    for name in files.keys() {
        let here = dir.join(name);
        if here.exists() {
            let to = kept.join(name);
            std::fs::create_dir_all(to.parent().unwrap_or(&kept))?;
            std::fs::copy(&here, &to)?;
        }
    }
    for (name, text) in files {
        let path = dir.join(name);
        let mut text = text.clone();
        if is_config(name) {
            let mine = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get("account").cloned());
            if let (Some(mine), Ok(mut v)) = (mine, serde_json::from_str::<Value>(&text)) {
                v["account"] = mine;
                text = v.to_string();
            }
        }
        std::fs::create_dir_all(path.parent().unwrap_or(dir))?;
        crate::store::write_private(&path, text)?;
    }
    Ok(kept)
}

/// A backup is due once a day while the app is open, when the data changed since this computer's last one. Never from
/// an install with no project yet: a new computer before its restore would only push an empty save point.
pub fn due(now: i64, last_at: Option<i64>, last_hash: &str, hash: &str, projects: usize, off: bool) -> bool {
    !off && projects > 0 && hash != last_hash && last_at.is_none_or(|t| now - t >= DAY)
}

fn sealed(files: &BTreeMap<String, String>, user: &str, key: &DataKey) -> Result<Vec<u8>> {
    let plain = serde_json::to_vec(&json!({ "version": 1, "computer": account::computer_name(), "files": files }))?;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&plain)?;
    Ok(key.seal_bytes(&format!("{user}/backup"), &gz.finish()?))
}

fn opened(data: &[u8], user: &str, key: &DataKey) -> Result<BTreeMap<String, String>> {
    let gz = key.open_bytes(&format!("{user}/backup"), data).map_err(|_| Error::Invalid("This backup doesn't open with this account's key".into()))?;
    let mut plain = Vec::new();
    flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut plain)?;
    let v: Value = serde_json::from_slice(&plain)?;
    Ok(serde_json::from_value(v["files"].clone())?)
}

fn hash(files: &BTreeMap<String, String>) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(files).unwrap_or_default()))
}

/// Encodes a query value: a computer's name has spaces.
fn query(v: &str) -> String {
    v.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// Backs up now, under this computer's name.
pub async fn now(k: &Gitnetix) -> Result<Value> {
    let (user, account) = account::account_key().await?;
    let files = pack(&k.dir);
    let body = sealed(&files, &user, &DataKey::derive(&account.secret()))?;
    let made: Value = serde_json::from_slice(&account::call_raw(Method::POST, &format!("/v1/backups?name={}", query(&account::computer_name())), Some(body)).await?)?;
    let h = hash(&files);
    k.store.write(|c| {
        c.account.backed_up_at = Some(chrono::Utc::now().timestamp());
        c.account.backed_up_hash = h;
        Ok(())
    })?;
    Ok(made)
}

/// The daily backup, with the account sync, when it is due.
pub async fn daily(k: &Gitnetix) -> Result<()> {
    let (off, at, last, projects) = k.store.read(|c| (c.account.backups_off, c.account.backed_up_at, c.account.backed_up_hash.clone(), c.projects.len()));
    if due(chrono::Utc::now().timestamp(), at, &last, &hash(&pack(&k.dir)), projects, off) {
        now(k).await?;
    }
    Ok(())
}

/// Replaces this computer's Gitnetix data with a backup's. Refused while an agent runs: its session would be lost.
pub async fn restore(k: &Gitnetix, id: &str) -> Result<Value> {
    let id = account::hex_id(id)?;
    if k.agents.list().iter().any(|s| s.status == AgentStatus::Running) {
        return Err(Error::Invalid("Stop the running agents first: a restore replaces their sessions".into()));
    }
    let (user, account) = account::account_key().await?;
    let data = account::call_raw(Method::GET, &format!("/v1/backups/{id}"), None).await?;
    let files = opened(&data, &user, &DataKey::derive(&account.secret()))?;
    let kept = restore_files(&k.dir, &files)?;
    Ok(json!({ "files": files.len(), "kept": kept.to_string_lossy() }))
}

/// The account's backups, its storage, and this computer's daily switch.
pub async fn list(k: &Gitnetix) -> Result<Value> {
    let mut v = account::api(Method::GET, "/v1/backups", None).await?;
    v["daily"] = json!(!k.store.read(|c| c.account.backups_off));
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::write(d.join("config.json"), r#"{"projects":[{"id":"p1","name":"api","path":"/old/api"}],"ui":{"theme":"nord"},"account":{"live":true,"user":"u1"}}"#).unwrap();
        std::fs::write(d.join("profiles.json"), r#"{"active":"default","list":[]}"#).unwrap();
        std::fs::write(d.join("agents.json"), "[]").unwrap();
        std::fs::create_dir_all(d.join("profiles")).unwrap();
        std::fs::write(d.join("profiles").join("work.json"), r#"{"projects":[],"account":{"user":"u1"}}"#).unwrap();
        for skipped in ["secrets.json", "commit-cache.json", "companion-key.der", "worktrees-cache.json"] {
            std::fs::write(d.join(skipped), "never").unwrap();
        }
        std::fs::create_dir_all(d.join("models")).unwrap();
        std::fs::write(d.join("models").join("big.bin"), "never").unwrap();
        dir
    }

    #[test]
    fn a_backup_takes_settings_and_agent_sessions_but_no_token_cache_or_account_state() {
        let dir = folder();
        let files = pack(dir.path());
        assert_eq!(files.keys().map(String::as_str).collect::<Vec<_>>(), ["agents.json", "config.json", "profiles.json", "profiles/work.json"]);
        assert!(files.values().all(|t| !t.contains("never")));
        assert!(!files["config.json"].contains("\"account\"") && !files["profiles/work.json"].contains("\"account\""));
        assert!(files["config.json"].contains("nord"));
    }

    #[test]
    fn a_restore_keeps_the_old_files_and_this_computers_account_state() {
        let from = folder();
        let files = pack(from.path());
        let to = tempfile::tempdir().unwrap();
        std::fs::write(to.path().join("config.json"), r#"{"projects":[],"ui":{"theme":"light"},"account":{"live":false,"user":"here"}}"#).unwrap();
        let kept = restore_files(to.path(), &files).unwrap();
        let now: Value = serde_json::from_str(&std::fs::read_to_string(to.path().join("config.json")).unwrap()).unwrap();
        assert_eq!(now["ui"]["theme"], "nord");
        assert_eq!(now["projects"][0]["name"], "api");
        assert_eq!(now["account"]["user"], "here", "this computer's account state stays");
        assert!(std::fs::read_to_string(kept.join("config.json")).unwrap().contains("light"));
        assert!(to.path().join("profiles").join("work.json").exists());
    }

    #[test]
    fn a_backup_naming_another_path_is_refused_whole() {
        let to = tempfile::tempdir().unwrap();
        for bad in ["../outside.json", "profiles/../../x.json", "secrets.json", "/etc/passwd"] {
            let files = BTreeMap::from([("config.json".to_string(), "{}".to_string()), (bad.to_string(), "x".to_string())]);
            assert!(restore_files(to.path(), &files).is_err(), "{bad}");
        }
        assert!(!to.path().join("config.json").exists(), "nothing written when refused");
    }

    #[test]
    fn sealed_backups_open_only_with_the_account_key_and_for_that_account() {
        let files = pack(folder().path());
        let key = DataKey::derive(&crate::vault::random32());
        let data = sealed(&files, "u1", &key).unwrap();
        assert_eq!(opened(&data, "u1", &key).unwrap(), files);
        assert!(opened(&data, "u2", &key).is_err());
        assert!(opened(&data, "u1", &DataKey::derive(&crate::vault::random32())).is_err());
        assert!(!String::from_utf8_lossy(&data).contains("nord"));
    }

    #[test]
    fn daily_means_once_a_day_when_something_changed_and_never_from_an_empty_install() {
        let now = 1_000_000;
        assert!(due(now, None, "", "h1", 3, false));
        assert!(!due(now, None, "", "h1", 0, false), "no project yet");
        assert!(!due(now, None, "", "h1", 3, true), "turned off");
        assert!(!due(now, Some(now - 3600), "h0", "h1", 3, false), "an hour ago");
        assert!(due(now, Some(now - DAY), "h0", "h1", 3, false));
        assert!(!due(now, Some(now - 2 * DAY), "h1", "h1", 3, false), "nothing changed");
        assert_eq!(query("Office PC"), "Office%20PC");
    }
}
