//! End-to-end encryption for the Gitnetix account: the server only ever stores what this makes, and holds no key that
//! opens it. Key pairs are X25519; a key sent to someone is a libsodium sealed box; items are XChaCha20-Poly1305,
//! bound to their place so the server can't swap one for another. The contract is in the back-end's README.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine as _};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use crypto_box::aead::rand_core::RngCore;
use crypto_box::aead::OsRng;
use crypto_box::{PublicKey, SecretKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn unb64(s: &str) -> Result<Vec<u8>> {
    B64.decode(s).map_err(|_| Error::Invalid("not base64url".into()))
}

fn key32(s: &str) -> Result<[u8; 32]> {
    unb64(s)?.try_into().map_err(|_| Error::Invalid("a key is 32 bytes".into()))
}

pub fn random32() -> [u8; 32] {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    b
}

fn hkdf(root: &[u8], info: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(None, root).expand(info.as_bytes(), &mut out).expect("32 bytes is a valid HKDF length");
    out
}

/// A key pair: an install's own, or the account's. Its secret leaves the device only sealed to another key.
pub struct Keys(SecretKey);

impl Keys {
    pub fn generate() -> Keys {
        Keys(SecretKey::from(random32()))
    }

    pub fn from_secret(secret: &[u8]) -> Result<Keys> {
        let bytes: [u8; 32] = secret.try_into().map_err(|_| Error::Invalid("a key is 32 bytes".into()))?;
        Ok(Keys(SecretKey::from(bytes)))
    }

    pub fn secret(&self) -> [u8; 32] {
        self.0.to_bytes()
    }

    pub fn public(&self) -> String {
        b64(self.0.public_key().as_bytes())
    }

    /// Opens what was sealed to this key pair.
    pub fn open(&self, sealed: &str) -> Result<Vec<u8>> {
        self.0.unseal(&unb64(sealed)?).map_err(|_| Error::Invalid("this key can't open it".into()))
    }
}

/// Seals `secret` to `public_key`: only the holder of the matching secret key opens it.
pub fn seal(public_key: &str, secret: &[u8]) -> Result<String> {
    let sealed = PublicKey::from(key32(public_key)?).seal(&mut OsRng, secret).map_err(|_| Error::Invalid("can't seal".into()))?;
    Ok(b64(&sealed))
}

/// What a person compares between two screens before trusting a key: 60 bits, too many for a server to forge a match.
pub fn fingerprint(public_key: &str) -> String {
    let digest = Sha256::digest(public_key.as_bytes());
    let bits = u64::from_be_bytes(digest[..8].try_into().unwrap()) >> 4;
    let chars: String = (0..12).rev().map(|i| ALPHABET[((bits >> (i * 5)) & 31) as usize] as char).collect();
    format!("{}-{}-{}", &chars[..4], &chars[4..8], &chars[8..])
}

/// Crockford base32: no I, L, O or U, so what is read off a screen can't be mistyped as another letter.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The recovery key the person keeps: 25 characters, 125 bits, in five groups.
pub fn new_recovery_key() -> String {
    let mut bytes = [0u8; 25];
    OsRng.fill_bytes(&mut bytes);
    let chars: Vec<String> = bytes.chunks(5).map(|g| g.iter().map(|b| ALPHABET[(b & 31) as usize] as char).collect()).collect();
    chars.join("-")
}

/// Forgives case, dashes, spaces, O for 0 and I or L for 1.
fn normalize_code(s: &str) -> String {
    s.to_uppercase().chars().filter(|c| !c.is_whitespace() && *c != '-').map(|c| match c { 'O' => '0', 'I' | 'L' => '1', c => c }).collect()
}

fn recovery_cipher(recovery_key: &str) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(&hkdf(normalize_code(recovery_key).as_bytes(), "gitnetix/recovery/v1").into())
}

/// The account secret locked with the recovery key: what the server keeps for the day every install is lost.
pub fn lock_with_recovery(recovery_key: &str, account_secret: &[u8]) -> String {
    seal_with(&recovery_cipher(recovery_key), "recovery", account_secret)
}

pub fn open_with_recovery(recovery_key: &str, locked: &str) -> Result<Vec<u8>> {
    open_with(&recovery_cipher(recovery_key), "recovery", locked).map_err(|_| Error::Invalid("That recovery key doesn't match this account".into()))
}

fn seal_with(cipher: &XChaCha20Poly1305, aad: &str, plain: &[u8]) -> String {
    b64(&seal_raw(cipher, aad, plain))
}

/// The nonce, then the ciphertext and its tag.
fn seal_raw(cipher: &XChaCha20Poly1305, aad: &str, plain: &[u8]) -> Vec<u8> {
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher.encrypt(XNonce::from_slice(&nonce), Payload { msg: plain, aad: aad.as_bytes() }).expect("encrypting in memory");
    [&nonce[..], &ct].concat()
}

fn open_with(cipher: &XChaCha20Poly1305, aad: &str, data: &str) -> Result<Vec<u8>> {
    open_raw(cipher, aad, &unb64(data)?)
}

fn open_raw(cipher: &XChaCha20Poly1305, aad: &str, raw: &[u8]) -> Result<Vec<u8>> {
    if raw.len() < 24 + 16 {
        return Err(Error::Invalid("too short to be encrypted data".into()));
    }
    let (nonce, ct) = raw.split_at(24);
    cipher.decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: aad.as_bytes() }).map_err(|_| Error::Invalid("can't decrypt: another key, or the data was changed".into()))
}

/// What a 32-byte root (the account's secret, or an enterprise key) opens: items, and repository keys.
pub struct DataKey {
    cipher: XChaCha20Poly1305,
    index: [u8; 32],
}

impl DataKey {
    pub fn derive(root: &[u8]) -> DataKey {
        DataKey { cipher: XChaCha20Poly1305::new(&hkdf(root, "gitnetix/data/v1").into()), index: hkdf(root, "gitnetix/index/v1") }
    }

    /// Encrypts `plain` for its place, `aad` (owner/kind/key): moved anywhere else, it no longer opens.
    pub fn seal(&self, aad: &str, plain: &[u8]) -> String {
        seal_with(&self.cipher, aad, plain)
    }

    pub fn open(&self, aad: &str, data: &str) -> Result<Vec<u8>> {
        open_with(&self.cipher, aad, data)
    }

    /// Like `seal`, in bytes: a backup is uploaded as is, not as text.
    pub fn seal_bytes(&self, aad: &str, plain: &[u8]) -> Vec<u8> {
        seal_raw(&self.cipher, aad, plain)
    }

    pub fn open_bytes(&self, aad: &str, data: &[u8]) -> Result<Vec<u8>> {
        open_raw(&self.cipher, aad, data)
    }

    /// The repository's name on the server: one repository, one key, and the server can't tell which repository.
    pub fn repo_key(&self, remote: &str) -> String {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.index).expect("HMAC takes any key length");
        mac.update(normalize_remote(remote).as_bytes());
        b64(&mac.finalize().into_bytes())
    }
}

/// One repository whatever the remote's form: git@github.com:Org/Repo.git, ssh://git@github.com:22/org/repo and
/// https://github.com/org/repo/ all give github.com/org/repo.
pub fn normalize_remote(url: &str) -> String {
    let s = url.trim().to_lowercase();
    let s = match s.split_once("://") {
        Some((scheme, rest)) if scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)) => rest.to_string(),
        _ => s,
    };
    // A user, or user:token, before the host.
    let s = match s.split_once('@') {
        Some((user, rest)) if !user.contains('/') => rest.to_string(),
        _ => s,
    };
    // host:port/path, or scp's host:path.
    let s = match s.split_once(':') {
        Some((host, rest)) if !host.contains('/') => {
            let rest = match rest.split_once('/') {
                Some((port, path)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => path,
                _ => rest,
            };
            format!("{host}/{rest}")
        }
        _ => s,
    };
    let s = s.trim_end_matches('/');
    s.strip_suffix(".git").unwrap_or(s).to_string()
}

/// A token pasted into an HTTPS remote (https://user:token@host/…) never leaves the device.
pub fn clean_remote(url: &str) -> String {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    let Some(start) = ["https://", "http://"].iter().find(|s| lower.starts_with(**s)).map(|s| s.len()) else { return url.into() };
    match url[start..].split_once('@') {
        Some((user, host)) if !user.contains('/') => format!("{}{host}", &url[..start]),
        _ => url.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_keys_open_only_for_their_owner() {
        let (alice, bob) = (Keys::generate(), Keys::generate());
        let secret = random32();
        let sealed = seal(&alice.public(), &secret).unwrap();
        assert_eq!(alice.open(&sealed).unwrap(), secret);
        assert!(bob.open(&sealed).is_err());
        assert_eq!(Keys::from_secret(&alice.secret()).unwrap().public(), alice.public());
    }

    #[test]
    fn items_open_only_in_their_own_place_and_with_their_key() {
        let key = DataKey::derive(&random32());
        let data = key.seal("u1/project/abc", b"{\"name\":\"api\"}");
        assert_eq!(key.open("u1/project/abc", &data).unwrap(), b"{\"name\":\"api\"}");
        assert!(key.open("u1/project/other", &data).is_err());
        assert!(DataKey::derive(&random32()).open("u1/project/abc", &data).is_err());
        let mut tampered = unb64(&data).unwrap();
        tampered[30] ^= 1;
        assert!(key.open("u1/project/abc", &b64(&tampered)).is_err());
        assert!(key.open("u1/project/abc", "short").is_err());
    }

    #[test]
    fn the_recovery_key_opens_the_account_secret_however_it_is_typed() {
        let recovery = new_recovery_key();
        assert_eq!(recovery.len(), 29);
        let secret = random32();
        let locked = lock_with_recovery(&recovery, &secret);
        let typed = recovery.to_lowercase().replace('-', " ").replace('0', "o").replace('1', "l");
        assert_eq!(open_with_recovery(&typed, &locked).unwrap(), secret);
        assert!(open_with_recovery(&new_recovery_key(), &locked).is_err());
    }

    #[test]
    fn one_repository_one_key_whatever_the_remote_form() {
        for url in ["git@github.com:Acme/API.git", "https://github.com/acme/api", "https://github.com/acme/api.git/", "ssh://git@github.com:22/acme/api.git", "https://x-access-token:ghp_secret@github.com/acme/api.git"] {
            assert_eq!(normalize_remote(url), "github.com/acme/api", "{url}");
        }
        assert_eq!(normalize_remote("http://localhost:8080/repo"), "localhost/repo");
        let (a, b) = (DataKey::derive(&random32()), DataKey::derive(&random32()));
        assert_eq!(a.repo_key("git@github.com:acme/api.git"), a.repo_key("https://github.com/acme/api"));
        assert_ne!(a.repo_key("https://github.com/acme/api"), b.repo_key("https://github.com/acme/api"));
        assert_ne!(a.repo_key("https://github.com/acme/api"), a.repo_key("https://github.com/acme/web"));
    }

    #[test]
    fn tokens_in_https_remotes_are_dropped() {
        assert_eq!(clean_remote("https://oauth2:glpat-x@gitlab.com/a/b.git"), "https://gitlab.com/a/b.git");
        assert_eq!(clean_remote("HTTPS://ghp_x@github.com/a/b"), "HTTPS://github.com/a/b");
        assert_eq!(clean_remote("ssh://git@host/a/b.git"), "ssh://git@host/a/b.git");
        assert_eq!(clean_remote("git@github.com:a/b.git"), "git@github.com:a/b.git");
    }

    #[test]
    fn fingerprints_are_stable_and_long_enough_to_compare() {
        let k = Keys::generate();
        let f = fingerprint(&k.public());
        assert_eq!(f, fingerprint(&k.public()));
        assert_eq!(f.len(), 14);
        assert_ne!(f, fingerprint(&Keys::generate().public()));
    }
}
