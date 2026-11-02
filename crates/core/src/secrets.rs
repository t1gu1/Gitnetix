//! API keys and tokens. Stored in the OS keychain when available; otherwise
//! in a 0600 file next to the config (mobile / headless builds). Until the app
//! opens its own folder they only last the run: tests never touch the user's.

use crate::error::{Error, Result};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

const SERVICE: &str = "dev.gitnetix.app";

#[cfg(feature = "keychain")]
mod imp {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::collections::{BTreeMap, HashSet};
    use std::sync::atomic::AtomicU64;
    use std::sync::mpsc;
    use std::time::Duration;

    /// The keychain item holding every token: one item, so the system asks once per run, not once per token.
    pub(super) const ALL: &str = "all-tokens";

    /// How long a caller waits on the keychain before going on without the secret.
    const WAIT: Duration = Duration::from_secs(2);

    pub(super) trait Keychain: Sync {
        fn read(&self, item: &str) -> Result<Option<String>>;
        fn write(&self, item: &str, value: &str) -> Result<()>;
        /// Deleting an item that isn't there is fine.
        fn delete(&self, item: &str) -> Result<()>;
    }

    struct Os;

    fn entry(item: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, item).map_err(|e| Error::Other(format!("keychain: {e}")))
    }

    impl Keychain for Os {
        fn read(&self, item: &str) -> Result<Option<String>> {
            match entry(item)?.get_password() {
                Ok(v) => Ok(Some(v)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(Error::Other(format!("keychain: {e}"))),
            }
        }

        fn write(&self, item: &str, value: &str) -> Result<()> {
            entry(item)?.set_password(value).map_err(|e| Error::Other(format!("keychain: {e}")))
        }

        fn delete(&self, item: &str) -> Result<()> {
            match entry(item)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(Error::Other(format!("keychain: {e}"))),
            }
        }
    }

    /// Random key made at launch, for masking the tokens kept for the run.
    static RUN_KEY: LazyLock<[u8; 32]> = LazyLock::new(|| {
        let mut k = [0; 32];
        k[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        k[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        k
    });
    static NONCE: AtomicU64 = AtomicU64::new(0);

    /// A token kept for the run, XORed with a SHA-256 key stream from the run's key: no token sits as plain
    /// text in the app's memory, swap or crash reports. Whoever can read that memory at will finds the key too.
    pub(super) struct Masked {
        nonce: u64,
        bytes: Vec<u8>,
    }

    fn xor(nonce: u64, data: &mut [u8]) {
        for (i, chunk) in data.chunks_mut(32).enumerate() {
            let block = Sha256::new().chain_update(*RUN_KEY).chain_update(nonce.to_le_bytes()).chain_update((i as u64).to_le_bytes()).finalize();
            chunk.iter_mut().zip(block).for_each(|(b, k)| *b ^= k);
        }
    }

    impl Masked {
        pub(super) fn new(plain: &str) -> Masked {
            // A nonce per token: two tokens never share a key stream.
            let nonce = NONCE.fetch_add(1, Ordering::Relaxed);
            let mut bytes = plain.as_bytes().to_vec();
            xor(nonce, &mut bytes);
            Masked { nonce, bytes }
        }

        pub(super) fn open(&self) -> String {
            let mut b = self.bytes.clone();
            xor(self.nonce, &mut b);
            String::from_utf8(b).unwrap_or_default()
        }
    }

    /// Zero a plain copy before its memory goes back to the allocator.
    fn wipe(s: String) {
        let mut b = s.into_bytes();
        b.fill(0);
        std::hint::black_box(&b);
    }

    /// What the keychain gave this run.
    #[derive(Default)]
    struct Kept {
        /// Every token, once the item holding them is read.
        all: Option<HashMap<String, Masked>>,
        /// Keys without an item of their own from before the single one.
        no_old: HashSet<String>,
        /// Items being read, waiting on the user.
        pending: HashSet<String>,
    }

    pub(super) struct Vault {
        keychain: &'static dyn Keychain,
        kept: Mutex<Kept>,
        /// One write at a time, each with the latest tokens: a late write never drops a newer token.
        writing: Mutex<()>,
        wait: Duration,
    }

    static VAULT: LazyLock<Vault> = LazyLock::new(|| Vault::new(&Os, WAIT));

    pub fn get(key: &str) -> Result<Option<String>> {
        VAULT.get(key)
    }

    pub fn set(key: &str, value: &str) -> Result<()> {
        VAULT.set(key, value)
    }

    pub fn delete(key: &str) -> Result<()> {
        VAULT.delete(key)
    }

    impl Vault {
        pub(super) fn new(keychain: &'static dyn Keychain, wait: Duration) -> Vault {
            Vault { keychain, kept: Default::default(), writing: Mutex::new(()), wait }
        }

        pub(super) fn get(&'static self, key: &str) -> Result<Option<String>> {
            self.read_all()?;
            {
                let k = self.kept.lock().unwrap();
                if let Some(v) = k.all.as_ref().and_then(|a| a.get(key)) {
                    return Ok(Some(v.open()));
                }
                if k.no_old.contains(key) {
                    return Ok(None);
                }
            }
            let key = key.to_string();
            self.asked(&key.clone(), move || self.move_old(&key))
        }

        pub(super) fn set(&'static self, key: &str, value: &str) -> Result<()> {
            self.read_all()?;
            let before = self.tokens(|a| a.insert(key.into(), Masked::new(value)));
            self.save().inspect_err(|_| self.restore(key, before))
        }

        pub(super) fn delete(&'static self, key: &str) -> Result<()> {
            self.read_all()?;
            if let Some(before) = self.tokens(|a| a.remove(key)) {
                self.save().inspect_err(|_| self.restore(key, Some(before)))?;
            }
            // Its item from before, if never moved in: it would come back on the next read.
            self.keychain.delete(key)?;
            self.kept.lock().unwrap().no_old.insert(key.into());
            Ok(())
        }

        fn tokens<T>(&self, f: impl FnOnce(&mut HashMap<String, Masked>) -> T) -> T {
            f(self.kept.lock().unwrap().all.as_mut().expect("tokens read"))
        }

        fn restore(&self, key: &str, before: Option<Masked>) {
            self.tokens(|a| match before {
                Some(v) => a.insert(key.into(), v),
                None => a.remove(key),
            });
        }

        /// Read the item holding every token, once per run.
        fn read_all(&'static self) -> Result<()> {
            if self.kept.lock().unwrap().all.is_some() {
                return Ok(());
            }
            self.asked(ALL, move || {
                // Another read may have just ended.
                if self.kept.lock().unwrap().all.is_some() {
                    return Ok(());
                }
                let all = match self.keychain.read(ALL)? {
                    Some(json) => {
                        let plain: Result<HashMap<String, String>> = serde_json::from_str(&json).map_err(|e| Error::Other(format!("keychain: unreadable tokens: {e}")));
                        wipe(json);
                        plain?
                            .into_iter()
                            .map(|(k, v)| {
                                let m = Masked::new(&v);
                                wipe(v);
                                (k, m)
                            })
                            .collect()
                    }
                    None => HashMap::new(),
                };
                self.kept.lock().unwrap().all = Some(all);
                Ok(())
            })
        }

        /// `key`'s token saved before the single item, in an item of its own: moved in on its first read.
        fn move_old(&self, key: &str) -> Result<Option<String>> {
            let Some(v) = self.keychain.read(key)? else {
                self.kept.lock().unwrap().no_old.insert(key.into());
                return Ok(None);
            };
            self.tokens(|a| a.insert(key.into(), Masked::new(&v)));
            self.save()?;
            // Left behind, it is only read again once the token is deleted, which deletes it too.
            let _ = self.keychain.delete(key);
            Ok(Some(v))
        }

        fn save(&self) -> Result<()> {
            let _one = self.writing.lock().unwrap();
            let plain: BTreeMap<String, String> = self.tokens(|a| a.iter().map(|(k, v)| (k.clone(), v.open())).collect());
            let json = serde_json::to_string(&plain)?;
            plain.into_values().for_each(wipe);
            let saved = self.keychain.write(ALL, &json);
            wipe(json);
            saved
        }

        /// Runs `job` on `item` off the caller's thread, one at a time per item: the system can ask the user
        /// before an app reads an item (macOS does for each rebuilt app), and the read waits on them. Past
        /// the wait the caller gets an error and goes on; the job still ends and keeps what it got.
        fn asked<T: Send + 'static>(&'static self, item: &str, job: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
            // One ask at a time: another would stack a second prompt.
            if !self.kept.lock().unwrap().pending.insert(item.to_string()) {
                return Err(waiting());
            }
            let (tx, rx) = mpsc::channel();
            let item = item.to_string();
            std::thread::spawn(move || {
                let got = job();
                self.kept.lock().unwrap().pending.remove(&item);
                let _ = tx.send(got);
            });
            rx.recv_timeout(self.wait).unwrap_or_else(|_| Err(waiting()))
        }
    }

    fn waiting() -> Error {
        Error::Other("keychain: waiting for access, answer the system prompt".into())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// A keychain in memory, counting reads per item.
        #[derive(Default)]
        struct Fake {
            items: Mutex<HashMap<String, String>>,
            reads: Mutex<Vec<String>>,
            /// How long the user takes to answer the prompt.
            answer: Duration,
        }

        impl Keychain for Fake {
            fn read(&self, item: &str) -> Result<Option<String>> {
                self.reads.lock().unwrap().push(item.into());
                std::thread::sleep(self.answer);
                Ok(self.items.lock().unwrap().get(item).cloned())
            }
            fn write(&self, item: &str, value: &str) -> Result<()> {
                self.items.lock().unwrap().insert(item.into(), value.into());
                Ok(())
            }
            fn delete(&self, item: &str) -> Result<()> {
                self.items.lock().unwrap().remove(item);
                Ok(())
            }
        }

        fn fake(items: &[(&str, &str)], answer: Duration) -> &'static Fake {
            let items = items.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            Box::leak(Box::new(Fake { items: Mutex::new(items), answer, ..Default::default() }))
        }

        /// A new run of the app on `keychain`.
        fn run(keychain: &'static Fake) -> &'static Vault {
            Box::leak(Box::new(Vault::new(keychain, Duration::from_secs(5))))
        }

        fn reads(f: &Fake) -> usize {
            std::mem::take(&mut *f.reads.lock().unwrap()).len()
        }

        #[test]
        fn a_read_waiting_on_the_user_holds_no_one_up() {
            let kc = fake(&[(ALL, r#"{"github":"token"}"#)], Duration::from_millis(300));
            let v: &'static Vault = Box::leak(Box::new(Vault::new(kc, Duration::from_millis(50))));
            assert!(v.get("github").is_err(), "gives up past the wait");
            assert!(v.get("azure").is_err(), "no second ask while the first waits");
            std::thread::sleep(Duration::from_millis(400));
            assert_eq!(v.get("github").unwrap().as_deref(), Some("token"), "the late answer is kept");
            assert_eq!(reads(kc), 1);
        }

        #[test]
        fn every_token_comes_from_one_read_per_run() {
            let kc = fake(&[(ALL, r#"{"github":"gh","ai.claude":"sk"}"#)], Duration::ZERO);
            let v = run(kc);
            assert_eq!(v.get("github").unwrap().as_deref(), Some("gh"));
            assert_eq!(v.get("ai.claude").unwrap().as_deref(), Some("sk"));
            assert_eq!(reads(kc), 1);
            assert_eq!(v.get("azure").unwrap(), None, "a token never saved: one look for an old item");
            assert_eq!(v.get("azure").unwrap(), None);
            assert_eq!(reads(kc), 1);
        }

        #[test]
        fn a_token_saved_alone_moves_into_the_single_item() {
            let kc = fake(&[("github", "gh"), ("jira.a", "j")], Duration::ZERO);
            let v = run(kc);
            assert_eq!(v.get("github").unwrap().as_deref(), Some("gh"));
            v.set("ai.claude", "sk").unwrap();
            assert!(!kc.items.lock().unwrap().contains_key("github"), "its old item is gone");
            assert_eq!(kc.items.lock().unwrap()["jira.a"], "j", "one never read stays where it is");

            let next = run(kc);
            reads(kc);
            assert_eq!(next.get("github").unwrap().as_deref(), Some("gh"));
            assert_eq!(next.get("ai.claude").unwrap().as_deref(), Some("sk"));
            assert_eq!(reads(kc), 1, "next run: one read for both");
        }

        #[test]
        fn a_deleted_token_stays_deleted() {
            let kc = fake(&[(ALL, r#"{"github":"new"}"#), ("github", "old")], Duration::ZERO);
            let v = run(kc);
            v.delete("github").unwrap();
            assert_eq!(v.get("github").unwrap(), None);
            assert_eq!(run(kc).get("github").unwrap(), None, "the old item doesn't come back");
        }

        #[test]
        fn kept_tokens_are_masked() {
            let (a, b) = (Masked::new("ghp_secret"), Masked::new("ghp_secret"));
            assert_ne!(a.bytes, b"ghp_secret");
            assert_ne!(a.bytes, b.bytes, "each its own key stream");
            assert_eq!(a.open(), "ghp_secret");
        }
    }
}

#[cfg(not(feature = "keychain"))]
mod imp {
    use super::*;
    use std::collections::BTreeMap;

    fn path() -> std::path::PathBuf {
        crate::store::data_dir().join("secrets.json")
    }

    fn load() -> BTreeMap<String, String> {
        std::fs::read_to_string(path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    fn save(m: &BTreeMap<String, String>) -> Result<()> {
        crate::store::write_private(&path(), serde_json::to_string(m)?)?;
        Ok(())
    }

    pub fn get(key: &str) -> Result<Option<String>> {
        let _ = SERVICE;
        Ok(load().get(key).cloned())
    }

    pub fn set(key: &str, value: &str) -> Result<()> {
        let mut m = load();
        m.insert(key.into(), value.into());
        save(&m)
    }

    pub fn delete(key: &str) -> Result<()> {
        let mut m = load();
        m.remove(key);
        save(&m)
    }
}

/// Off until the app opens its own folder: till then secrets stay in `RUN_ONLY`, a test's among them.
static SAVED: AtomicBool = AtomicBool::new(false);
static RUN_ONLY: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

/// Keep secrets past the run: in the keychain, or the file where there is none.
pub fn save_for_good() {
    SAVED.store(true, Ordering::Relaxed);
}

fn read(key: &str) -> Result<Option<String>> {
    if SAVED.load(Ordering::Relaxed) { imp::get(key) } else { Ok(RUN_ONLY.lock().unwrap().get(key).cloned()) }
}

fn write(key: &str, value: &str) -> Result<()> {
    if SAVED.load(Ordering::Relaxed) {
        return imp::set(key, value);
    }
    RUN_ONLY.lock().unwrap().insert(key.into(), value.into());
    Ok(())
}

fn erase(key: &str) -> Result<()> {
    if SAVED.load(Ordering::Relaxed) {
        return imp::delete(key);
    }
    RUN_ONLY.lock().unwrap().remove(key);
    Ok(())
}

/// Prefix of the keys of the profile in use: none for the first profile, whose keys predate profiles.
static SCOPE: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());

fn scope_of(profile: &str) -> String {
    if profile == crate::store::FIRST_PROFILE { String::new() } else { format!("profile.{profile}.") }
}

/// Point `get`, `set` and `delete` at profile `id`'s secrets.
pub fn use_profile(id: &str) {
    *SCOPE.write().unwrap() = scope_of(id);
}

fn scoped(key: &str) -> String {
    format!("{}{key}", SCOPE.read().unwrap())
}

pub fn get(key: &str) -> Result<Option<String>> {
    read(&scoped(key))
}

pub fn set(key: &str, value: &str) -> Result<()> {
    write(&scoped(key), value)
}

pub fn delete(key: &str) -> Result<()> {
    erase(&scoped(key))
}

/// Copy profile `from`'s secrets among `keys` to profile `to`. One the keychain won't give is left out.
pub fn copy(keys: &[String], from: &str, to: &str) -> Result<()> {
    let (from, to) = (scope_of(from), scope_of(to));
    for k in keys {
        if let Some(v) = read(&format!("{from}{k}")).ok().flatten() {
            write(&format!("{to}{k}"), &v)?;
        }
    }
    Ok(())
}

/// Delete profile `id`'s secrets among `keys`.
pub fn forget(keys: &[String], id: &str) -> Result<()> {
    let scope = scope_of(id);
    keys.iter().try_for_each(|k| erase(&format!("{scope}{k}")))
}

pub fn require(key: &str, what: &str) -> Result<String> {
    get(key)?.filter(|s| !s.is_empty()).ok_or_else(|| Error::NotConnected(what.to_string()))
}

/// Keychain key names, one per provider or integration.
pub fn ai_key(provider: &str) -> String {
    format!("ai.{provider}")
}
