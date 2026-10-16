//! API keys and tokens. Stored in the OS keychain when available; otherwise
//! in a 0600 file next to the config (mobile / headless builds).

use crate::error::{Error, Result};

const SERVICE: &str = "dev.gitnetix.app";

#[cfg(feature = "keychain")]
mod imp {
    use super::*;

    fn entry(key: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, key).map_err(|e| Error::Other(format!("keychain: {e}")))
    }

    pub fn get(key: &str) -> Result<Option<String>> {
        match entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Other(format!("keychain: {e}"))),
        }
    }

    pub fn set(key: &str, value: &str) -> Result<()> {
        entry(key)?.set_password(value).map_err(|e| Error::Other(format!("keychain: {e}")))
    }

    pub fn delete(key: &str) -> Result<()> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Other(format!("keychain: {e}"))),
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
        let p = path();
        std::fs::write(&p, serde_json::to_string(m)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600))?;
        }
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
