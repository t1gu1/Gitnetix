//! API keys and tokens. Stored in the OS keychain when available; otherwise
//! in a 0600 file next to the config (mobile / headless builds).

use crate::error::{Error, Result};

const SERVICE: &str = "dev.gitnetix.app";

#[cfg(feature = "keychain")]
mod imp {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::sync::{mpsc, LazyLock, Mutex};
    use std::time::Duration;

    /// Keychain answers kept for the run, and the keys being read.
    #[derive(Default)]
    pub(super) struct Kept {
        read: HashMap<String, Option<String>>,
        pending: HashSet<String>,
    }

    static KEPT: LazyLock<Mutex<Kept>> = LazyLock::new(Default::default);

    /// How long a caller waits on the keychain before going on without the secret.
    const WAIT: Duration = Duration::from_secs(2);

    fn entry(key: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, key).map_err(|e| Error::Other(format!("keychain: {e}")))
    }

    fn read(key: &str) -> Result<Option<String>> {
        match entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Other(format!("keychain: {e}"))),
        }
    }

    pub fn get(key: &str) -> Result<Option<String>> {
        kept_read(&KEPT, key, WAIT, read)
    }

    /// `read(key)` once per run, off the caller's thread: the system can ask the user before an app
    /// reads a keychain item (macOS does for each rebuilt one), and the read waits on them. Past
    /// `wait` the caller gets an error and goes on; the answer is kept once the user gave it.
    pub(super) fn kept_read(kept: &'static Mutex<Kept>, key: &str, wait: Duration, read: fn(&str) -> Result<Option<String>>) -> Result<Option<String>> {
        {
            let mut k = kept.lock().unwrap();
            if let Some(v) = k.read.get(key) {
                return Ok(v.clone());
            }
            // One ask at a time: another would stack a second prompt.
            if !k.pending.insert(key.to_string()) {
                return Err(waiting());
            }
        }
        let (tx, rx) = mpsc::channel();
        let key = key.to_string();
        std::thread::spawn(move || {
            let got = read(&key);
            let mut k = kept.lock().unwrap();
            k.pending.remove(&key);
            if let Ok(v) = &got {
                k.read.insert(key, v.clone());
            }
            let _ = tx.send(got);
        });
        rx.recv_timeout(wait).unwrap_or_else(|_| Err(waiting()))
    }

    fn waiting() -> Error {
        Error::Other("keychain: waiting for access, answer the system prompt".into())
    }

    pub fn set(key: &str, value: &str) -> Result<()> {
        entry(key)?.set_password(value).map_err(|e| Error::Other(format!("keychain: {e}")))?;
        KEPT.lock().unwrap().read.insert(key.into(), Some(value.into()));
        Ok(())
    }

    pub fn delete(key: &str) -> Result<()> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(Error::Other(format!("keychain: {e}"))),
        }
        KEPT.lock().unwrap().read.insert(key.into(), None);
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicU32, Ordering};

        #[test]
        fn a_read_waiting_on_the_user_holds_no_one_up() {
            static KEPT: LazyLock<Mutex<Kept>> = LazyLock::new(Default::default);
            static ASKED: AtomicU32 = AtomicU32::new(0);
            // The user answers the prompt after 300 ms.
            fn prompt(_: &str) -> Result<Option<String>> {
                ASKED.fetch_add(1, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(300));
                Ok(Some("token".into()))
            }
            let wait = Duration::from_millis(50);
            assert!(kept_read(&KEPT, "github", wait, prompt).is_err(), "gives up past the wait");
            assert!(kept_read(&KEPT, "github", wait, prompt).is_err(), "no second ask while the first waits");
            std::thread::sleep(Duration::from_millis(400));
            assert_eq!(kept_read(&KEPT, "github", wait, prompt).unwrap().as_deref(), Some("token"), "the late answer is kept");
            assert_eq!(ASKED.load(Ordering::Relaxed), 1);
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

pub use imp::{delete, get, set};

pub fn require(key: &str, what: &str) -> Result<String> {
    get(key)?.filter(|s| !s.is_empty()).ok_or_else(|| Error::NotConnected(what.to_string()))
}

/// Keychain key names, one per provider or integration.
pub fn ai_key(provider: &str) -> String {
    format!("ai.{provider}")
}
