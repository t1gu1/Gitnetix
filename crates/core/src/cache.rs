//! Results of slow git work, kept on disk so the next overview (and the next launch) skips it.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Answers the commit cache adds before the older ones go: the file holds at most twice this.
const MAX_ENTRIES: usize = if cfg!(test) { 4 } else { 20_000 };

/// Checks whose answer is fixed for a pair of commits, so it stays true for good: a yes or no,
/// or a list (patch ids). Keyed by the check's name and both SHAs.
pub struct CommitCache {
    file: PathBuf,
    map: Mutex<Answers>,
    dirty: AtomicBool,
}

/// Two generations: once `fresh` is full it becomes `old`, and what `old` held goes. An answer read from `old` comes
/// back to `fresh`, so the ones still asked for live on while those of tips long gone drop out, and a big repository
/// never loses all of them at once (each lost answer is git work again).
#[derive(Default)]
struct Answers {
    fresh: HashMap<String, Value>,
    old: HashMap<String, Value>,
}

impl Answers {
    fn get(&mut self, key: &str) -> Option<Value> {
        if let Some(answer) = self.fresh.get(key) {
            return Some(answer.clone());
        }
        let answer = self.old.remove(key)?;
        self.put(key.to_string(), answer.clone());
        Some(answer)
    }

    fn put(&mut self, key: String, answer: Value) {
        if self.fresh.len() >= MAX_ENTRIES {
            self.old = std::mem::take(&mut self.fresh);
        }
        self.fresh.insert(key, answer);
    }
}

impl CommitCache {
    /// Load the answers saved under `dir`, as the older generation; a missing or unreadable file starts empty.
    pub fn open(dir: &Path) -> CommitCache {
        let file = dir.join("commit-cache.json");
        let old = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        CommitCache { file, map: Mutex::new(Answers { fresh: HashMap::new(), old }), dirty: AtomicBool::new(false) }
    }

    pub fn get<T: DeserializeOwned>(&self, check: &str, tip: &str, base: &str) -> Option<T> {
        let answer = self.map.lock().unwrap().get(&format!("{check}:{tip}:{base}"))?;
        serde_json::from_value(answer).ok()
    }

    pub fn insert(&self, check: &str, tip: &str, base: &str, answer: impl Serialize) {
        let Ok(answer) = serde_json::to_value(answer) else { return };
        self.map.lock().unwrap().put(format!("{check}:{tip}:{base}"), answer);
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Write new answers to disk, if there are any: both generations, in one map.
    pub fn save(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let json = {
            let a = self.map.lock().unwrap();
            serde_json::to_string(&a.old.iter().chain(&a.fresh).collect::<HashMap<_, _>>())
        };
        let Ok(json) = json else { return };
        write_atomic(&self.file, json);
    }
}

/// The last value built per project, with the key it was built for; a different key is a miss.
pub struct ViewCache<T> {
    dir: PathBuf,
    map: Mutex<HashMap<String, Arc<Saved<T>>>>,
}

#[derive(Serialize, Deserialize)]
pub struct Saved<T> {
    key: u64,
    value: T,
}

impl<T: Serialize + DeserializeOwned> ViewCache<T> {
    /// Values live in `dir`, one file per project, read on first use.
    pub fn open(dir: PathBuf) -> ViewCache<T> {
        ViewCache { dir, map: Mutex::default() }
    }

    pub fn get(&self, project_id: &str, key: u64) -> Option<Arc<Saved<T>>> {
        self.last(project_id).filter(|s| s.key == key)
    }

    /// The last value built, whatever key it was built for.
    pub fn last(&self, project_id: &str) -> Option<Arc<Saved<T>>> {
        let mut map = self.map.lock().unwrap();
        if !map.contains_key(project_id) {
            let saved: Saved<T> = std::fs::read(self.file(project_id)).ok().and_then(|b| serde_json::from_slice(&b).ok())?;
            map.insert(project_id.into(), Arc::new(saved));
        }
        map.get(project_id).cloned()
    }

    pub fn insert(&self, project_id: &str, key: u64, value: T) {
        let saved = Arc::new(Saved { key, value });
        if let Ok(json) = serde_json::to_string(&*saved) {
            let _ = std::fs::create_dir_all(&self.dir);
            write_atomic(&self.file(project_id), json);
        }
        self.map.lock().unwrap().insert(project_id.into(), saved);
    }

    fn file(&self, project_id: &str) -> PathBuf {
        // Ids are generated hex, but never let one reach outside the folder.
        let safe: String = project_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
        self.dir.join(format!("{safe}.json"))
    }
}

impl<T> Saved<T> {
    pub fn value(&self) -> &T {
        &self.value
    }
}

/// The last answer of a slow listing, on disk so the next look (even after a restart) shows it at once while a fresh one builds.
pub struct LastCache {
    file: PathBuf,
    /// What the file holds: an unchanged answer isn't written again.
    json: Mutex<Option<String>>,
}

impl LastCache {
    /// A missing or unreadable file holds nothing.
    pub fn open(file: PathBuf) -> LastCache {
        let json = std::fs::read_to_string(&file).ok();
        LastCache { file, json: Mutex::new(json) }
    }

    /// The last answer; none when nothing was saved or it no longer reads as a `T`.
    pub fn get<T: DeserializeOwned>(&self) -> Option<T> {
        serde_json::from_str(self.json.lock().unwrap().as_deref()?).ok()
    }

    pub fn set(&self, value: &impl Serialize) {
        let Ok(json) = serde_json::to_string(value) else { return };
        let mut held = self.json.lock().unwrap();
        if held.as_deref() != Some(json.as_str()) {
            write_atomic(&self.file, json.clone());
            *held = Some(json);
        }
    }
}

/// Stable hash of the parts a cached value was built from.
pub fn key_of(parts: &[&str]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for p in parts {
        p.hash(&mut h);
    }
    h.finish()
}

/// Temp file and rename so a reader never sees a torn file. Each write its own temp name: two writers of one file (the
/// app and gitnetix-server share the data folder, two projects' builds save the commit cache) would otherwise rename
/// each other's half-written one into place.
fn write_atomic(file: &Path, contents: String) {
    static WRITES: AtomicU64 = AtomicU64::new(0);
    let tmp = file.with_extension(format!("json.{}.{}.tmp", std::process::id(), WRITES.fetch_add(1, Ordering::Relaxed)));
    if std::fs::write(&tmp, contents).and_then(|_| std::fs::rename(&tmp, file)).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_saved_answers_and_lists() {
        let dir = tempfile::tempdir().unwrap();
        // A file saved before lists were kept: yes/no answers only.
        std::fs::write(dir.path().join("commit-cache.json"), r#"{"squash2:a:b":true}"#).unwrap();
        let cache = CommitCache::open(dir.path());
        cache.insert("patches", "a", "c", ["p1", "p2"]);
        cache.save();
        let again = CommitCache::open(dir.path());
        assert_eq!(again.get::<bool>("squash2", "a", "b"), Some(true));
        assert_eq!(again.get::<Vec<String>>("patches", "a", "c"), Some(vec!["p1".to_string(), "p2".to_string()]));
        assert_eq!(again.get::<bool>("patches", "a", "c"), None);
    }

    #[test]
    fn a_full_cache_drops_the_answers_nobody_read_again() {
        let dir = tempfile::tempdir().unwrap();
        let cache = CommitCache::open(dir.path());
        for i in 0..MAX_ENTRIES {
            cache.insert("ancestor", &format!("t{i}"), "b", true);
        }
        // Full: the next answers start a new generation, and every earlier one is still there.
        cache.insert("ancestor", "new", "b", true);
        assert!((0..MAX_ENTRIES).all(|i| cache.get::<bool>("ancestor", &format!("t{i}"), "b") == Some(true)));
        // Reading them brought them back; filling up twice more drops only what was not read since.
        cache.insert("ancestor", "read-later", "b", false);
        for i in 0..2 * MAX_ENTRIES {
            cache.insert("ancestor", &format!("n{i}"), "b", true);
            if i == MAX_ENTRIES {
                assert_eq!(cache.get::<bool>("ancestor", "read-later", "b"), Some(false));
            }
        }
        assert_eq!(cache.get::<bool>("ancestor", "read-later", "b"), Some(false));
        assert_eq!(cache.get::<bool>("ancestor", "t0", "b"), None);
        // Both generations reach the file, and come back from it.
        cache.save();
        assert_eq!(CommitCache::open(dir.path()).get::<bool>("ancestor", "read-later", "b"), Some(false));
    }

    #[test]
    fn writers_of_one_file_never_tear_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("views.json");
        std::thread::scope(|s| {
            for t in 0..8 {
                let file = &file;
                s.spawn(move || {
                    for i in 0..50 {
                        write_atomic(file, format!("{{\"writer\":{t},\"write\":{i},\"pad\":\"{}\"}}", "x".repeat(10_000)));
                    }
                });
            }
        });
        let last: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(last["pad"].as_str().unwrap().len(), 10_000);
        let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("views.json")], "no temp file left behind");
    }

    #[test]
    fn last_answer_survives_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("last.json");
        assert_eq!(LastCache::open(file.clone()).get::<Vec<String>>(), None);
        LastCache::open(file.clone()).set(&["a", "b"]);
        let again = LastCache::open(file.clone());
        assert_eq!(again.get::<Vec<String>>(), Some(vec!["a".to_string(), "b".to_string()]));
        // Saved in another shape: read as nothing, not an error.
        assert_eq!(again.get::<Vec<u32>>(), None);
    }
}
