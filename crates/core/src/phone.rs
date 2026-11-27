//! Your phone from anywhere. Phones paired with this computer reach it through the Gitnetix relay, and every call and
//! event between them is encrypted end to end (gitnetix-relay). The server introduces a phone of the same account
//! with a single-use code. The secret in the pairing QR code, which the server never sees, proves it is the phone
//! that scanned it, and from then on its own key does. The relay socket itself is live.rs's.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gitnetix_relay::{self as relay, Channel, Id, Link};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use crate::error::{Error, ErrorBody, Result};
use crate::events::Event;
use crate::{account, live, rpc, secrets, Gitnetix};

/// The keychain item holding this computer's Noise key pair, and by device id each paired phone's key and secret.
const PHONES: &str = "gitnetix.phones";

/// How long the secret of the QR code shown waits for its phone after it last showed. The server's code in it lasts
/// 2 minutes and is made again meanwhile; the secret stays, so a phone that scanned the previous one still pairs.
const PENDING_FOR: Duration = Duration::from_secs(10 * 60);

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    secret: String,
    public: String,
    phones: BTreeMap<String, Pin>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Pin {
    key: String,
    psk: String,
}

fn saved() -> Result<Saved> {
    Ok(secrets::get(PHONES)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
}

fn keep(s: &Saved) -> Result<()> {
    secrets::set(PHONES, &serde_json::to_string(s)?)
}

/// A phone on the relay now, halfway through its handshake or with its channel open.
enum Peer {
    Shaking { hs: Box<relay::HandshakeState>, psk: [u8; 32], new: bool },
    Open(Arc<Open>),
}

struct Open {
    id: Id,
    channel: Mutex<Channel>,
    closed: AtomicBool,
    flow: relay::Flow,
}

impl Open {
    /// Seals one message for this phone and queues its pieces, in order. False once the phone or the socket left.
    fn send(&self, v: &Value) -> bool {
        let Ok(bytes) = serde_json::to_vec(v) else { return false };
        // Held until every piece is queued, so a call's answer and an event never mix their pieces.
        let mut ch = self.channel.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        match ch.seal(&bytes) {
            Ok(pieces) => pieces.iter().all(|p| out(relay::frame(&self.id, relay::DATA, p))),
            Err(_) => false,
        }
    }
}

static PEERS: Mutex<BTreeMap<Id, Peer>> = Mutex::new(BTreeMap::new());
/// The secret of the QR code shown, and when it last showed.
static PENDING: Mutex<Option<([u8; 32], Instant)>> = Mutex::new(None);
/// Frames for the relay socket, while it is open.
static OUT: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>> = Mutex::new(None);

fn out(frame: Vec<u8>) -> bool {
    OUT.lock().unwrap().as_ref().is_some_and(|tx| tx.send(frame).is_ok())
}

fn peer(id: &Id) -> Option<Arc<Open>> {
    match PEERS.lock().unwrap().get(id) {
        Some(Peer::Open(o)) => Some(o.clone()),
        _ => None,
    }
}

impl Open {
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.flow.end();
    }
}

fn close(id: &Id) {
    if let Some(Peer::Open(o)) = PEERS.lock().unwrap().remove(id) {
        o.close();
    }
}

fn close_all() {
    for (_, p) in std::mem::take(&mut *PEERS.lock().unwrap()) {
        if let Peer::Open(o) = p {
            o.close();
        }
    }
}

/// Called by the relay task before it sends a frame to a phone. A piece waits until that phone has room for it. False
/// when the phone left, and the frame is dropped.
pub(crate) async fn room(f: &[u8]) -> bool {
    match relay::split(f) {
        Some((_, kind, _)) if kind != relay::DATA => true,
        Some((to, _, data)) => match peer(&to) {
            Some(o) => o.flow.room(data.len()).await,
            None => false,
        },
        None => false,
    }
}

/// The relay socket opened, and phones' frames go out through it.
pub(crate) fn attach(tx: mpsc::UnboundedSender<Vec<u8>>) {
    *OUT.lock().unwrap() = Some(tx);
}

/// The socket closed. Every phone's channel ends with it, and each phone starts its handshake again.
pub(crate) fn detach() {
    *OUT.lock().unwrap() = None;
    close_all();
}

/// A relay notice that a phone left, or that a frame for it found it gone.
pub(crate) fn notice(text: &str) {
    let v: Value = serde_json::from_str(text).unwrap_or_default();
    if v["type"] == "offline" || v["code"] == "peer_offline" {
        if let Some(id) = v["peer"].as_str().and_then(relay::unhex) {
            close(&id);
        }
    }
}

/// A binary frame from the relay, with a phone's handshake step, a piece of its message, or how much of ours it opened.
/// Returns the acknowledgment to send at once, outside the queue, since the phone may be waiting for it.
pub(crate) fn frame(k: &Arc<Gitnetix>, raw: &[u8]) -> Option<Vec<u8>> {
    let (from, kind, data) = relay::split(raw)?;
    // Turned off while live updates keep the socket open, so the phone hears its connection ended and tries later.
    if !k.store.read(|c| c.account.phones) {
        if kind == relay::HELLO1 || kind == relay::DATA {
            out(relay::frame(&from, relay::RESET, &[]));
        }
        return None;
    }
    let done = match kind {
        relay::HELLO1 => hello(from, data).map(|_| None),
        relay::HELLO3 => welcome(k, from, data).map(|_| None),
        relay::DATA => piece(k, from, data),
        relay::ACK => {
            if let Some(o) = peer(&from) {
                o.flow.acked(data);
            }
            Ok(None)
        }
        _ => Ok(None),
    };
    match done {
        Ok(ack) => ack.map(|a| relay::frame(&from, relay::ACK, &a)),
        Err(refusal) => {
            if refusal == relay::BYE {
                crate::log::info(format!("Turned away a phone that isn't paired with this computer ({})", relay::hex(&from)));
            }
            out(relay::frame(&from, refusal, &[]));
            None
        }
    }
}

/// The phone's first handshake message. A paired phone's handshake uses its own secret, a new phone the secret of the
/// QR code shown; with neither, it isn't welcome here.
fn hello(from: Id, msg: &[u8]) -> std::result::Result<(), u8> {
    let s = saved().map_err(|_| relay::RESET)?;
    let pending = PENDING.lock().unwrap().filter(|(_, at)| at.elapsed() < PENDING_FOR).map(|(psk, _)| psk);
    let (psk, new) = match s.phones.get(&relay::hex(&from)).and_then(|p| relay::key(&p.psk)) {
        Some(psk) => (psk, false),
        None => (pending.ok_or(relay::BYE)?, true),
    };
    let secret = relay::key(&s.secret).ok_or(relay::BYE)?;
    let mut hs = relay::responder(&secret, &psk).map_err(|_| relay::RESET)?;
    relay::read(&mut hs, msg).map_err(|_| relay::RESET)?;
    let reply = relay::write(&mut hs).map_err(|_| relay::RESET)?;
    // A phone back after a drop ends its old channel.
    close(&from);
    PEERS.lock().unwrap().insert(from, Peer::Shaking { hs: Box::new(hs), psk, new });
    out(relay::frame(&from, relay::HELLO2, &reply));
    Ok(())
}

/// The phone's last handshake message, with its key proven by the secret. A new phone is paired from here on, its key
/// pinned; a paired phone must show the key it paired with.
fn welcome(k: &Arc<Gitnetix>, from: Id, msg: &[u8]) -> std::result::Result<(), u8> {
    let Some(Peer::Shaking { mut hs, psk, new }) = PEERS.lock().unwrap().remove(&from) else { return Err(relay::RESET) };
    // A wrong secret fails here, for example from a phone that scanned an older QR code.
    relay::read(&mut hs, msg).map_err(|_| relay::BYE)?;
    let key = relay::remote(&hs).ok_or(relay::BYE)?;
    let id = relay::hex(&from);
    let mut s = saved().map_err(|_| relay::RESET)?;
    if new {
        s.phones.insert(id, Pin { key: relay::b64(&key), psk: relay::b64(&psk) });
        keep(&s).map_err(|_| relay::RESET)?;
        *PENDING.lock().unwrap() = None;
        crate::log::info("Paired a phone. It reaches this computer from anywhere now");
    } else if s.phones.get(&id).and_then(|p| relay::key(&p.key)) != Some(key) {
        return Err(relay::BYE);
    }
    let open = Arc::new(Open { id: from, channel: Mutex::new(Channel::new(*hs).map_err(|_| relay::RESET)?), closed: AtomicBool::new(false), flow: Default::default() });
    PEERS.lock().unwrap().insert(from, Peer::Open(open.clone()));
    open.send(&json!({ "welcome": account::computer_name() }));
    forward(k.subscribe(), open);
    Ok(())
}

#[derive(Deserialize)]
struct Req {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

/// A piece of a phone's message, and the acknowledgment due. A whole call runs on its own task, like the companion
/// API's, and answers when done.
fn piece(k: &Arc<Gitnetix>, from: Id, data: &[u8]) -> std::result::Result<Option<[u8; 8]>, u8> {
    let open = peer(&from).ok_or(relay::RESET)?;
    let opened = open.channel.lock().unwrap().open(data);
    let ack = open.flow.opened(data.len());
    let msg = match opened {
        Ok(Some(m)) => m,
        Ok(None) => return Ok(ack),
        Err(_) => {
            close(&from);
            return Err(relay::RESET);
        }
    };
    let Ok(req) = serde_json::from_slice::<Req>(&msg) else { return Ok(ack) };
    let k = k.clone();
    tokio::spawn(async move {
        let reply = match rpc::call(&k, &req.method, req.params).await {
            Ok(v) => json!({ "id": req.id, "result": v }),
            Err(e) => json!({ "id": req.id, "error": ErrorBody::from(&e) }),
        };
        open.send(&reply);
    });
    Ok(ack)
}

/// The engine's events go to the phone as they happen, like the companion API's event stream.
fn forward(mut rx: broadcast::Receiver<Event>, open: Arc<Open>) {
    tokio::spawn(async move {
        loop {
            let ev = match rx.recv().await {
                Ok(ev) => ev,
                // Some went past while the phone was behind: one of them may have been a project's change.
                Err(broadcast::error::RecvError::Lagged(_)) => Event::Missed {},
                Err(_) => return,
            };
            if !open.send(&json!({ "event": ev })) {
                return;
            }
        }
    });
}

/// The Account page's box: whether phones may reach this computer, and the phones paired with it.
pub async fn status(k: &Gitnetix) -> Result<Value> {
    let on = k.store.read(|c| c.account.phones);
    let mut list = Vec::new();
    if let Some((host, _)) = live::stored_host() {
        let pins = saved()?.phones;
        let open: Vec<String> = PEERS.lock().unwrap().iter().filter(|(_, p)| matches!(p, Peer::Open(_))).map(|(id, _)| relay::hex(id)).collect();
        for d in account::api(Method::GET, "/v1/devices", None).await?.as_array().into_iter().flatten() {
            let id = d["id"].as_str().unwrap_or_default();
            if d["kind"] == "client" && d["hostId"].as_str() == Some(host.as_str()) {
                list.push(json!({ "id": id, "name": d["name"], "platform": d["platform"], "paired": pins.contains_key(id), "connected": open.iter().any(|o| o == id), "lastSeenAt": d["lastSeenAt"] }));
            }
        }
    }
    Ok(json!({ "on": on, "connected": on && live::is_connected(), "phones": list }))
}

/// Phones on or off. On makes this computer a host of the account and opens the relay; off closes it unless live
/// updates keep it. Paired phones stay paired, and reach it again once it is back on.
pub async fn set(k: &Gitnetix, on: bool) -> Result<Value> {
    if on {
        live::host().await?;
    }
    k.store.write(|c| {
        c.account.phones = on;
        Ok(())
    })?;
    if !on {
        close_all();
    }
    live::wake(k);
    status(k).await
}

/// What the pairing QR code holds for one more phone: the server's single-use code and this computer's secret for
/// that phone, which the server never sees.
pub async fn pair(k: &Gitnetix) -> Result<Value> {
    if !k.store.read(|c| c.account.phones) {
        set(k, true).await?;
    }
    let host = live::host().await?;
    let (_, token) = live::stored_host().ok_or_else(|| Error::NotConnected("this computer as a host".into()))?;
    let v = account::answer(crate::net::client().post(format!("{}/v1/pairing/codes", account::server())).bearer_auth(token).send().await?).await?;
    let mut s = saved()?;
    if relay::key(&s.public).is_none() {
        let keys = relay::keys().map_err(|e| Error::Other(e.message))?;
        (s.secret, s.public) = (relay::b64(&keys.secret), relay::b64(&keys.public));
        keep(&s)?;
    }
    let psk = {
        let mut p = PENDING.lock().unwrap();
        let psk = p.filter(|(_, at)| at.elapsed() < PENDING_FOR).map(|(psk, _)| psk).unwrap_or_else(relay::random32);
        *p = Some((psk, Instant::now()));
        psk
    };
    let link = Link { api: account::server(), host, name: account::computer_name(), code: v["code"].as_str().unwrap_or_default().into(), key: relay::key(&s.public).unwrap_or_default(), psk };
    Ok(json!({ "link": link.to_string(), "expiresIn": v["expiresIn"] }))
}

/// Removes a phone from the account and from this computer. The relay drops it within 30 s.
pub async fn remove(k: &Gitnetix, id: &str) -> Result<Value> {
    match account::api(Method::DELETE, &format!("/v1/devices/{}", account::hex_id(id)?), None).await {
        Ok(_) | Err(Error::NotFound(_)) => {}
        Err(e) => return Err(e),
    }
    let mut s = saved()?;
    if s.phones.remove(id).is_some() {
        keep(&s)?;
    }
    if let Some(id) = relay::unhex(id) {
        close(&id);
    }
    status(k).await
}

/// Called when this computer leaves the account. Its phones went with it, and their keys go too.
pub(crate) fn forget() {
    let _ = secrets::delete(PHONES);
    *PENDING.lock().unwrap() = None;
    close_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A phone through the whole handshake and one call, frames passed by hand where the relay would.
    #[tokio::test]
    async fn a_phone_that_scanned_the_code_pairs_and_calls_and_others_are_turned_away() {
        // Secrets are kept by profile, and other tests switch the profile in use.
        let _turn = secrets::test_turn();
        let dir = tempfile::tempdir().unwrap();
        let k = Gitnetix::open(dir.path()).unwrap();
        k.store.write(|c| {
            c.account.phones = true;
            Ok(())
        })
        .unwrap();
        let computer = relay::keys().unwrap();
        keep(&Saved { secret: relay::b64(&computer.secret), public: relay::b64(&computer.public), phones: Default::default() }).unwrap();
        let psk = relay::random32();
        *PENDING.lock().unwrap() = Some((psk, Instant::now()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        attach(tx);
        let phone_id: Id = [7; 12];
        // What the phone gets back, as the relay would hand it over: sender id, kind, bytes.
        let mut next = async || {
            let f = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap();
            let (to, kind, data) = relay::split(&f).unwrap();
            assert_eq!(to, phone_id);
            (kind, data.to_vec())
        };
        let from_phone = |kind, data: &[u8]| {
            let mut f = phone_id.to_vec();
            f.push(kind);
            f.extend_from_slice(data);
            f
        };

        let phone = relay::keys().unwrap();
        let mut hs = relay::initiator(&phone.secret, &psk).unwrap();
        frame(&k, &from_phone(relay::HELLO1, &relay::write(&mut hs).unwrap()));
        let (kind, msg2) = next().await;
        assert_eq!(kind, relay::HELLO2);
        relay::read(&mut hs, &msg2).unwrap();
        assert_eq!(relay::remote(&hs), Some(computer.public), "the phone sees the key its QR code showed");
        frame(&k, &from_phone(relay::HELLO3, &relay::write(&mut hs).unwrap()));
        let mut ch = Channel::new(hs).unwrap();
        let (kind, welcome) = next().await;
        assert_eq!(kind, relay::DATA);
        assert!(serde_json::from_slice::<Value>(&ch.open(&welcome).unwrap().unwrap()).unwrap()["welcome"].is_string());
        assert!(PENDING.lock().unwrap().is_none(), "the code's secret pairs one phone only");
        assert_eq!(saved().unwrap().phones.get(&relay::hex(&phone_id)).map(|p| p.key.clone()), Some(relay::b64(&phone.public)));

        for piece in ch.seal(&serde_json::to_vec(&json!({ "id": 1, "method": "app.info" })).unwrap()).unwrap() {
            frame(&k, &from_phone(relay::DATA, &piece));
        }
        // Engine events may come first.
        let answer = loop {
            let (_, data) = next().await;
            let v: Value = serde_json::from_slice(&ch.open(&data).unwrap().unwrap()).unwrap();
            if v["id"] == 1 {
                break v;
            }
        };
        assert!(answer["result"]["version"].is_string(), "{answer}");

        // Another phone of the account, with no secret from a QR code, is turned away.
        let stranger: Id = [9; 12];
        let mut hs = relay::initiator(&relay::keys().unwrap().secret, &relay::random32()).unwrap();
        let mut f = stranger.to_vec();
        f.push(relay::HELLO1);
        f.extend_from_slice(&relay::write(&mut hs).unwrap());
        frame(&k, &f);
        let refused = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap();
        assert_eq!(relay::split(&refused).map(|(to, kind, _)| (to, kind)), Some((stranger, relay::BYE)));
        detach();
        forget();
    }
}
