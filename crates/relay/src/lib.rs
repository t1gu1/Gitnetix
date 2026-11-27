//! The private channel between a phone and its computer through the Gitnetix relay. The relay passes binary frames
//! between a computer and the phones paired with it. Both ends run a Noise handshake over those frames with a secret
//! the pairing QR code carried and the server never saw, so the server can neither read the calls nor send its own.
//! The frame format is the back-end README's "Relay frames" and "Private relay traffic".

pub mod phone;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine as _};
use serde::{Deserialize, Serialize};
pub use snow::HandshakeState;

pub const PATTERN: &str = "Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s";

/// A device id on the relay, the first 12 bytes of every frame. Going out it names the receiver, coming in the sender.
pub type Id = [u8; 12];

/// The byte after the id: the three handshake messages (the phone starts), a piece of a message, the computer
/// turning the phone away, or how much of the other side's pieces came in ([`Flow`]). `RESET`: no session open here,
/// start the handshake again. `BYE`: this phone isn't paired here.
pub const HELLO1: u8 = 1;
pub const HELLO2: u8 = 2;
pub const HELLO3: u8 = 3;
pub const DATA: u8 = 4;
pub const RESET: u8 = 5;
pub const BYE: u8 = 6;
pub const ACK: u8 = 7;

/// Noise's limit on one message, and its tag.
const MAX: usize = 65535;
const TAG: usize = 16;
/// Message bytes in one Noise message. The byte before them says whether more follow.
const CHUNK: usize = MAX - TAG - 1;
/// A message being put back together stops at the companion API's own body limit.
const LARGEST: usize = 48 << 20;

/// What went wrong, the way the app's RPC errors read: a code the UI acts on and a message for people, plus the
/// computer's other error fields (the host git couldn't sign in to, and the like).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Error {
    pub code: String,
    pub message: String,
    #[serde(flatten)]
    pub more: serde_json::Map<String, serde_json::Value>,
}

pub fn error(code: &str, message: impl Into<String>) -> Error {
    Error { code: code.into(), message: message.into(), more: Default::default() }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<snow::Error> for Error {
    fn from(e: snow::Error) -> Self {
        error("relay", format!("The encrypted channel failed: {e}"))
    }
}

pub fn frame(to: &Id, kind: u8, data: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(13 + data.len());
    f.extend_from_slice(to);
    f.push(kind);
    f.extend_from_slice(data);
    f
}

/// A received frame: who sent it, what it carries, and the bytes after that.
pub fn split(frame: &[u8]) -> Option<(Id, u8, &[u8])> {
    let (id, rest) = frame.split_first_chunk::<12>()?;
    let (kind, data) = rest.split_first()?;
    Some((*id, *kind, data))
}

pub fn hex(id: &Id) -> String {
    id.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(s: &str) -> Option<Id> {
    let mut id = [0u8; 12];
    if s.len() != 24 {
        return None;
    }
    for (i, b) in id.iter_mut().enumerate() {
        *b = u8::from_str_radix(s.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(id)
}

pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

/// A 32-byte key written by [`b64`].
pub fn key(s: &str) -> Option<[u8; 32]> {
    B64.decode(s).ok()?.try_into().ok()
}

pub fn random32() -> [u8; 32] {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("the system's random source");
    b
}

/// A Noise key pair, a computer's made once or a phone's made at pairing.
pub struct Keys {
    pub secret: [u8; 32],
    pub public: [u8; 32],
}

fn builder() -> snow::Builder<'static> {
    snow::Builder::new(PATTERN.parse().expect("a valid Noise pattern"))
}

pub fn keys() -> Result<Keys, Error> {
    let k = builder().generate_keypair()?;
    let (Ok(secret), Ok(public)) = (k.private.try_into(), k.public.try_into()) else { return Err(error("relay", "Noise made a key of the wrong size")) };
    Ok(Keys { secret, public })
}

/// The phone's side of the handshake, with the secret from the QR code.
pub fn initiator(secret: &[u8; 32], psk: &[u8; 32]) -> Result<HandshakeState, Error> {
    Ok(builder().local_private_key(secret)?.psk(3, psk)?.build_initiator()?)
}

/// The computer's side, with the secret it gave that phone.
pub fn responder(secret: &[u8; 32], psk: &[u8; 32]) -> Result<HandshakeState, Error> {
    Ok(builder().local_private_key(secret)?.psk(3, psk)?.build_responder()?)
}

/// The next handshake message this side sends.
pub fn write(hs: &mut HandshakeState) -> Result<Vec<u8>, Error> {
    let mut buf = vec![0u8; MAX];
    let n = hs.write_message(&[], &mut buf)?;
    buf.truncate(n);
    Ok(buf)
}

/// Takes in the other side's handshake message.
pub fn read(hs: &mut HandshakeState, msg: &[u8]) -> Result<(), Error> {
    let mut buf = vec![0u8; MAX];
    hs.read_message(msg, &mut buf)?;
    Ok(())
}

/// The other side's key, once the handshake showed it.
pub fn remote(hs: &HandshakeState) -> Option<[u8; 32]> {
    hs.get_remote_static()?.try_into().ok()
}

/// One end of an open channel. A message of any size goes as Noise messages of at most 64 KB, which must reach the
/// other end in the order they were sealed.
pub struct Channel {
    t: snow::TransportState,
    inbox: Vec<u8>,
}

impl Channel {
    pub fn new(hs: HandshakeState) -> Result<Channel, Error> {
        Ok(Channel { t: hs.into_transport_mode()?, inbox: Vec::new() })
    }

    /// `msg` as the Noise messages to send, in order.
    pub fn seal(&mut self, msg: &[u8]) -> Result<Vec<Vec<u8>>, Error> {
        let pieces: Vec<&[u8]> = if msg.is_empty() { vec![&[]] } else { msg.chunks(CHUNK).collect() };
        let last = pieces.len() - 1;
        pieces
            .iter()
            .enumerate()
            .map(|(i, piece)| {
                let mut plain = Vec::with_capacity(piece.len() + 1);
                plain.push((i == last) as u8);
                plain.extend_from_slice(piece);
                let mut out = vec![0u8; plain.len() + TAG];
                let n = self.t.write_message(&plain, &mut out)?;
                out.truncate(n);
                Ok(out)
            })
            .collect()
    }

    /// One Noise message from the other end; the whole message once its last piece came.
    pub fn open(&mut self, sealed: &[u8]) -> Result<Option<Vec<u8>>, Error> {
        let mut buf = vec![0u8; sealed.len()];
        let n = self.t.read_message(sealed, &mut buf)?;
        let (&last, piece) = buf[..n].split_first().ok_or_else(|| error("relay", "An empty piece of a message"))?;
        if self.inbox.len() + piece.len() > LARGEST {
            self.inbox.clear();
            return Err(error("too_large", "A message over 48 MB"));
        }
        self.inbox.extend_from_slice(piece);
        Ok((last == 1).then(|| std::mem::take(&mut self.inbox)))
    }
}

/// Keeps one sender under the relay's limit for each device (4 MiB a second, 16 MiB of burst, whole frames counted).
/// The relay drops a frame over it, and a dropped piece breaks the channel for good.
pub struct Pace {
    budget: f64,
    at: Instant,
}

impl Pace {
    const RATE: f64 = 3.0 * 1024.0 * 1024.0;
    const BURST: f64 = 4.0 * 1024.0 * 1024.0;

    pub fn new() -> Pace {
        Pace { budget: Self::BURST, at: Instant::now() }
    }

    /// Waits until a frame of `n` bytes may go.
    pub async fn wait(&mut self, n: usize) {
        let n = n as f64;
        let now = Instant::now();
        self.budget = (self.budget + now.duration_since(self.at).as_secs_f64() * Self::RATE).min(Self::BURST);
        self.at = now;
        if self.budget < n {
            tokio::time::sleep(Duration::from_secs_f64((n - self.budget) / Self::RATE)).await;
            self.budget = n;
            self.at = Instant::now();
        }
        self.budget -= n;
    }
}

impl Default for Pace {
    fn default() -> Self {
        Pace::new()
    }
}

/// The most bytes of pieces sent and not acknowledged yet. The relay closes a socket whose reader falls 8 MB behind (a
/// phone on a slow network, a computer busy opening big messages), so a sender waits for the other side instead.
const WINDOW: u64 = 2 << 20;
/// A receiver acknowledges each time this much more came in.
const ACK_EVERY: u64 = 256 << 10;

/// Flow control with one peer. It counts the bytes of pieces sent and acknowledged, and of those opened and
/// acknowledged back.
#[derive(Default)]
pub struct Flow {
    sent: AtomicU64,
    acked: AtomicU64,
    got: AtomicU64,
    said: AtomicU64,
    ended: AtomicBool,
    more: tokio::sync::Notify,
}

impl Flow {
    /// Waits until a piece of `n` bytes fits in the window, and counts it; false once the channel ended.
    pub async fn room(&self, n: usize) -> bool {
        let n = n as u64;
        loop {
            let more = self.more.notified();
            tokio::pin!(more);
            more.as_mut().enable();
            if self.ended.load(SeqCst) {
                return false;
            }
            let (sent, acked) = (self.sent.load(SeqCst), self.acked.load(SeqCst));
            // With nothing in flight a piece always goes, whatever its size.
            if sent <= acked || sent + n - acked <= WINDOW {
                self.sent.fetch_add(n, SeqCst);
                return true;
            }
            more.await;
        }
    }

    /// Takes the other side's `ACK`, the bytes of pieces it opened so far.
    pub fn acked(&self, data: &[u8]) {
        if let Ok(b) = <[u8; 8]>::try_from(data) {
            self.acked.fetch_max(u64::from_be_bytes(b), SeqCst);
            self.more.notify_waiters();
        }
    }

    /// Counts a piece of `n` bytes opened, and returns the `ACK` to send back when one is due.
    pub fn opened(&self, n: usize) -> Option<[u8; 8]> {
        let got = self.got.fetch_add(n as u64, SeqCst) + n as u64;
        (got - self.said.load(SeqCst) >= ACK_EVERY).then(|| {
            self.said.store(got, SeqCst);
            got.to_be_bytes()
        })
    }

    pub fn end(&self) {
        self.ended.store(true, SeqCst);
        self.more.notify_waiters();
    }
}

/// The pairing QR code: the server the computer's account is on, the computer there, the single-use code a phone of
/// the same account redeems, the computer's Noise key, and the secret that keeps the relay out of the handshake.
/// After `#`, so a browser that opens it never sends it anywhere.
#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    pub api: String,
    pub host: String,
    pub name: String,
    pub code: String,
    pub key: [u8; 32],
    pub psk: [u8; 32],
}

const LINK: &str = "gitnetix://pair#";

impl Link {
    pub fn parse(s: &str) -> Option<Link> {
        let m: HashMap<String, String> = url::form_urlencoded::parse(s.trim().strip_prefix(LINK)?.as_bytes()).into_owned().collect();
        let get = |k: &str| m.get(k).filter(|v| !v.is_empty()).cloned();
        let api = get("api").filter(|a| a.starts_with("https://") || a.starts_with("http://"))?;
        Some(Link { api, host: get("host").filter(|h| unhex(h).is_some())?, name: get("name").unwrap_or_default(), code: get("code")?, key: key(&get("key")?)?, psk: key(&get("psk")?)? })
    }
}

impl std::fmt::Display for Link {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let q = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("api", &self.api)
            .append_pair("host", &self.host)
            .append_pair("name", &self.name)
            .append_pair("code", &self.code)
            .append_pair("key", &b64(&self.key))
            .append_pair("psk", &b64(&self.psk))
            .finish();
        write!(f, "{LINK}{q}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Phone and computer through the whole handshake, as the relay would pass it.
    fn pair(phone_psk: [u8; 32], computer_psk: [u8; 32]) -> Result<(Channel, Channel, [u8; 32], [u8; 32]), Error> {
        let (phone, computer) = (keys()?, keys()?);
        let mut i = initiator(&phone.secret, &phone_psk)?;
        let mut r = responder(&computer.secret, &computer_psk)?;
        read(&mut r, &write(&mut i)?)?;
        read(&mut i, &write(&mut r)?)?;
        let seen_by_phone = remote(&i).unwrap();
        read(&mut r, &write(&mut i)?)?;
        let seen_by_computer = remote(&r).unwrap();
        assert_eq!((seen_by_phone, seen_by_computer), (computer.public, phone.public));
        Ok((Channel::new(i)?, Channel::new(r)?, seen_by_phone, seen_by_computer))
    }

    #[test]
    fn a_message_of_any_size_crosses_in_pieces_of_at_most_64_kb() {
        let psk = random32();
        let (mut phone, mut computer, _, _) = pair(psk, psk).unwrap();
        for size in [0, 10, CHUNK, CHUNK + 1, 3 * CHUNK + 7] {
            let msg: Vec<u8> = (0..size).map(|i| i as u8).collect();
            let pieces = phone.seal(&msg).unwrap();
            assert_eq!(pieces.len(), size.div_ceil(CHUNK).max(1));
            assert!(pieces.iter().all(|p| p.len() <= MAX));
            let mut got = None;
            for (i, p) in pieces.iter().enumerate() {
                got = computer.open(p).unwrap();
                assert_eq!(got.is_some(), i == pieces.len() - 1);
            }
            assert_eq!(got.unwrap(), msg);
        }
        // And back.
        let back = computer.seal(b"{\"id\":1}").unwrap();
        assert_eq!(phone.open(&back[0]).unwrap().unwrap(), b"{\"id\":1}");
    }

    #[test]
    fn without_the_secret_from_the_qr_code_the_handshake_fails() {
        assert!(pair(random32(), random32()).is_err());
    }

    #[test]
    fn a_piece_dropped_on_the_way_breaks_the_channel() {
        let psk = random32();
        let (mut phone, mut computer, _, _) = pair(psk, psk).unwrap();
        let _dropped = phone.seal(b"one").unwrap();
        let next = phone.seal(b"two").unwrap().remove(0);
        assert!(computer.open(&next).is_err());
    }

    #[test]
    fn the_link_reads_back_what_it_wrote() {
        let l = Link { api: "https://api.gitnetix.app".into(), host: "0123456789abcdef01234567".into(), name: "Guy's PC & co".into(), code: "ABCD2345".into(), key: random32(), psk: random32() };
        let text = l.to_string();
        assert!(text.starts_with("gitnetix://pair#api=https%3A%2F%2Fapi.gitnetix.app&host="));
        assert_eq!(Link::parse(&text), Some(l.clone()));
        assert_eq!(Link::parse(&text.replace("host=0123", "host=zz23")), None);
        assert_eq!(Link::parse("https://192.168.1.2:7421/#token=abc"), None);
        assert_eq!(Link::parse(&text.replace("api=https", "api=file")), None);
    }

    #[test]
    fn frames_carry_the_id_and_kind_before_the_bytes() {
        let id = unhex("00112233445566778899aabb").unwrap();
        assert_eq!(hex(&id), "00112233445566778899aabb");
        let f = frame(&id, DATA, b"xyz");
        assert_eq!(split(&f), Some((id, DATA, &b"xyz"[..])));
        assert_eq!(split(&f[..12]), None);
        assert_eq!(unhex("0011"), None);
    }

    #[tokio::test]
    async fn pace_lets_the_burst_through_then_waits() {
        let mut p = Pace::new();
        let t = Instant::now();
        p.wait(4 * 1024 * 1024).await;
        assert!(t.elapsed() < Duration::from_millis(50));
        p.wait(300 * 1024).await;
        assert!(t.elapsed() >= Duration::from_millis(80));
    }

    #[tokio::test]
    async fn a_sender_waits_for_acks_past_the_window() {
        let (sender, receiver) = (std::sync::Arc::new(Flow::default()), Flow::default());
        let piece = 64 * 1024;
        let mut acks = Vec::new();
        for _ in 0..WINDOW as usize / piece {
            assert!(sender.room(piece).await);
            acks.extend(receiver.opened(piece));
        }
        assert_eq!(acks.len(), (WINDOW / ACK_EVERY) as usize, "one ACK each 256 KiB");
        let s = sender.clone();
        let waiting = tokio::spawn(async move { s.room(piece).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiting.is_finished(), "a full window waits");
        sender.acked(&acks[0]);
        assert!(tokio::time::timeout(Duration::from_secs(1), waiting).await.unwrap().unwrap(), "an ACK makes room");
        let s = sender.clone();
        let stuck = tokio::spawn(async move { s.room(WINDOW as usize).await });
        sender.end();
        assert!(!stuck.await.unwrap(), "an ended channel stops waiting");
    }
}
