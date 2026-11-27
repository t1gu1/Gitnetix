//! The phone's end. Pairing signs in to the account once, swaps the computer's single-use code for this phone's own
//! device token, and signs out again. From then on each call reaches the computer through the relay, encrypted end to
//! end, and the computer's events come back the same way.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::{error, frame, hex, key, keys, split, unhex, Channel, Error, Flow, Id, Link, Pace, ACK, BYE, DATA, HELLO1, HELLO2, HELLO3, RESET};

/// What the phone keeps once paired: its own device on the account, and the computer it reaches, with that computer's
/// key from the QR code.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub api: String,
    pub device: String,
    /// Opens the relay and nothing else.
    pub token: String,
    pub host: String,
    pub name: String,
    pub key: String,
    pub psk: String,
    /// This phone's own Noise key.
    pub secret: String,
}

type OnEvent = Arc<dyn Fn(Value) + Send + Sync>;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
/// The socket's sending half. The queue's pieces and the reader's acknowledgments both go out on it.
type Sink = Arc<tokio::sync::Mutex<SplitSink<Socket, Message>>>;

/// How long the computer has for each handshake step.
const STEP: Duration = Duration::from_secs(15);

fn lost() -> Error {
    error("unreachable", "The connection to your computer was lost. Try again")
}

fn unpaired() -> Error {
    error("not_paired", "Your computer no longer knows this phone. Pair it again")
}

fn offline(name: &str) -> Error {
    error("unreachable", format!("{} is offline. Open Gitnetix on it", if name.is_empty() { "Your computer" } else { name }))
}

/// The phone's state: the account session while pairing, the pairing once made (kept in `file`), and the connection.
pub struct Phone {
    file: PathBuf,
    on_event: OnEvent,
    /// While pairing: the server the scanned code is for, and the account session there once signed in.
    signing: Mutex<Option<(String, Option<String>)>>,
    client: Mutex<Option<Arc<Client>>>,
}

impl Phone {
    /// `dir`: the app's own folder. `on_event`: the computer's events, as its UI gets them.
    pub fn new(dir: &Path, on_event: impl Fn(Value) + Send + Sync + 'static) -> Phone {
        Phone { file: dir.join("relay.json"), on_event: Arc::new(on_event), signing: Mutex::new(None), client: Mutex::new(None) }
    }

    /// Pairs with the computer whose QR code is `link`. Without an account session yet, answers `{signIn}` with
    /// GitHub's code to enter. Poll [`Phone::sign_in_poll`], then call this again. Paired, answers `{name}`.
    pub async fn pair(&self, link: &str, name: &str) -> Result<Value, Error> {
        let l = Link::parse(link).ok_or_else(|| error("invalid", "This QR code is not a Gitnetix pairing code"))?;
        let held = self.signing.lock().unwrap().clone().filter(|(api, _)| *api == l.api).and_then(|(_, access)| access);
        let Some(access) = held else { return self.sign_in(&l.api).await };
        let mine = keys()?;
        let body = json!({ "code": l.code, "name": name, "platform": std::env::consts::OS, "publicKey": crate::b64(&mine.public) });
        let v = match call(Method::POST, &l.api, "/v1/pairing/redeem", Some(&access), Some(&body)).await {
            // The session ran out after 15 minutes, so sign in again.
            Err(e) if e.code == "unauthorized" => return self.sign_in(&l.api).await,
            // The server doesn't say which, so the next scan signs in again in case it was the wrong account.
            Err(e) if e.code == "invalid_code" => {
                *self.signing.lock().unwrap() = None;
                return Err(error("invalid_code", "This code expired, or your computer uses another GitHub account. Scan the code again, and sign in with the account your computer uses"));
            }
            r => r?,
        };
        let text = |v: &Value| v.as_str().unwrap_or_default().to_string();
        let device = text(&v["device"]["id"]);
        let pairing = Pairing { api: l.api.clone(), device: device.clone(), token: text(&v["token"]), host: l.host.clone(), name: l.name, key: crate::b64(&l.key), psk: crate::b64(&l.psk), secret: crate::b64(&mine.secret) };
        let client = Client::new(pairing.clone(), self.on_event.clone());
        // The server names the computer that made the code, and it must be the QR code's. Then connect now, so a
        // refused handshake shows on the pairing screen. A phone that couldn't pair leaves the account again.
        let ready = if text(&v["host"]["id"]) == l.host { client.call("app.info", json!({})).await } else { Err(error("invalid", "This code was made by another computer")) };
        if let Err(e) = ready {
            client.close();
            let _ = call(Method::DELETE, &l.api, &format!("/v1/devices/{device}"), Some(&access), None).await;
            return Err(e);
        }
        let _ = call(Method::POST, &l.api, "/v1/auth/logout", Some(&access), None).await;
        *self.signing.lock().unwrap() = None;
        save(&self.file, &pairing)?;
        if let Some(old) = self.client.lock().unwrap().replace(client) {
            old.close();
        }
        Ok(json!({ "name": pairing.name }))
    }

    async fn sign_in(&self, api: &str) -> Result<Value, Error> {
        let v = call(Method::POST, api, "/v1/auth/github/device", None, None).await?;
        *self.signing.lock().unwrap() = Some((api.into(), None));
        Ok(json!({ "signIn": v }))
    }

    /// Asks the server whether the person entered the code on GitHub: `{status: pending | slowDown | done}`.
    /// Signs in without an install key, so the phone never waits for approval among the account's installs.
    pub async fn sign_in_poll(&self, device_code: &str) -> Result<Value, Error> {
        let api = self.signing.lock().unwrap().clone().map(|(api, _)| api).ok_or_else(|| error("invalid", "Scan the pairing code first"))?;
        let v = call(Method::POST, &api, "/v1/auth/github/token", None, Some(&json!({ "deviceCode": device_code }))).await?;
        Ok(match v["status"].as_str() {
            Some("ok") => {
                let access = v["accessToken"].as_str().filter(|t| !t.is_empty()).ok_or_else(|| error("http", "The Gitnetix server sent no session"))?;
                *self.signing.lock().unwrap() = Some((api, Some(access.into())));
                json!({ "status": "done" })
            }
            Some("slow_down") => json!({ "status": "slowDown", "interval": v["interval"] }),
            _ => json!({ "status": "pending" }),
        })
    }

    /// One RPC call on the paired computer.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, Error> {
        let client = {
            let mut c = self.client.lock().unwrap();
            if c.is_none() {
                *c = load(&self.file).map(|p| Client::new(p, self.on_event.clone()));
            }
            c.clone()
        };
        client.ok_or_else(|| error("not_paired", "Not connected to a Gitnetix desktop"))?.call(method, params).await
    }

    /// Forgets the computer. It keeps listing this phone until removed there.
    pub fn forget(&self) {
        *self.signing.lock().unwrap() = None;
        let _ = std::fs::remove_file(&self.file);
        if let Some(c) = self.client.lock().unwrap().take() {
            c.close();
        }
    }
}

fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    // The name the server lists the sign-in under while it lasts.
    C.get_or_init(|| reqwest::Client::builder().user_agent("Gitnetix on a phone").timeout(Duration::from_secs(30)).build().expect("an HTTP client"))
}

/// A route of the Gitnetix server, its refusals as the app's errors.
async fn call(method: Method, api: &str, path: &str, token: Option<&str>, body: Option<&Value>) -> Result<Value, Error> {
    let mut req = http().request(method, format!("{api}{path}"));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if let Some(b) = body {
        req = req.json(b);
    }
    let res = req.send().await.map_err(|e| error("unreachable", format!("Can't reach {api}: {e}")))?;
    let status = res.status().as_u16();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if status < 300 {
        return Ok(v);
    }
    let code = match status {
        401 => "unauthorized",
        402 => "upgrade",
        _ => v["code"].as_str().unwrap_or("http"),
    };
    Err(error(code, v["message"].as_str().unwrap_or("The Gitnetix server refused")))
}

fn save(file: &Path, p: &Pairing) -> Result<(), Error> {
    let failed = |e: std::io::Error| error("other", format!("Can't keep the pairing: {e}"));
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(failed)?;
    }
    let tmp = file.with_extension("tmp");
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    // Its token and keys are for this app alone.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    std::io::Write::write_all(&mut o.open(&tmp).map_err(failed)?, &serde_json::to_vec(p).unwrap_or_default()).map_err(failed)?;
    std::fs::rename(&tmp, file).map_err(failed)
}

fn load(file: &Path) -> Option<Pairing> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

/// The connection to the paired computer, made on the first call and again after a drop.
pub struct Client {
    pairing: Pairing,
    on_event: OnEvent,
    conn: tokio::sync::Mutex<Option<Arc<Conn>>>,
    closed: AtomicBool,
    /// Set once connected, so the next connection tells the UI it may have missed changes meanwhile.
    was: AtomicBool,
}

struct Conn {
    host: Id,
    /// Frames for the socket; an empty one closes it.
    out: mpsc::UnboundedSender<Vec<u8>>,
    channel: Mutex<Channel>,
    calls: Mutex<HashMap<u64, oneshot::Sender<Result<Value, Error>>>>,
    next: AtomicU64,
    dead: AtomicBool,
    flow: Flow,
}

impl Conn {
    /// Seals one message and queues its pieces, in order.
    fn send(&self, v: &Value) -> Result<(), Error> {
        let bytes = serde_json::to_vec(v).map_err(|e| error("invalid", e.to_string()))?;
        let mut ch = self.channel.lock().unwrap();
        for piece in ch.seal(&bytes)? {
            self.out.send(frame(&self.host, DATA, &piece)).map_err(|_| lost())?;
        }
        Ok(())
    }

    /// Every call still waiting gets `why`.
    fn end(&self, why: &Error) {
        self.dead.store(true, Ordering::SeqCst);
        self.flow.end();
        let _ = self.out.send(Vec::new());
        for (_, tx) in self.calls.lock().unwrap().drain() {
            let _ = tx.send(Err(why.clone()));
        }
    }
}

impl Client {
    pub fn new(pairing: Pairing, on_event: OnEvent) -> Arc<Client> {
        Arc::new(Client { pairing, on_event, conn: Default::default(), closed: AtomicBool::new(false), was: AtomicBool::new(false) })
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut c) = self.conn.try_lock() {
            if let Some(c) = c.take() {
                c.end(&lost());
            }
        }
    }

    pub async fn call(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, Error> {
        let conn = self.conn().await?;
        let id = conn.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        conn.calls.lock().unwrap().insert(id, tx);
        if let Err(e) = conn.send(&json!({ "id": id, "method": method, "params": params })) {
            conn.calls.lock().unwrap().remove(&id);
            return Err(e);
        }
        rx.await.unwrap_or_else(|_| Err(lost()))
    }

    async fn conn(self: &Arc<Self>) -> Result<Arc<Conn>, Error> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(unpaired());
        }
        let mut slot = self.conn.lock().await;
        if let Some(c) = slot.as_ref().filter(|c| !c.dead.load(Ordering::SeqCst)) {
            return Ok(c.clone());
        }
        let c = self.connect().await?;
        // The pairing was forgotten while this connected, so the connection ends here.
        if self.closed.load(Ordering::SeqCst) {
            c.end(&unpaired());
            return Err(unpaired());
        }
        *slot = Some(c.clone());
        if self.was.swap(true, Ordering::SeqCst) {
            (self.on_event)(json!({ "type": "missed" }));
        }
        Ok(c)
    }

    /// The socket, the handshake, and the computer's welcome.
    async fn connect(self: &Arc<Self>) -> Result<Arc<Conn>, Error> {
        let p = &self.pairing;
        let (Some(host), Some(secret), Some(psk), Some(pinned)) = (unhex(&p.host), key(&p.secret), key(&p.psk), key(&p.key)) else { return Err(unpaired()) };
        let url = format!("{}/v1/relay", p.api.replacen("http", "ws", 1));
        let mut req = url.into_client_request().map_err(|e| error("invalid", e.to_string()))?;
        req.headers_mut().insert("authorization", format!("Bearer {}", p.token).parse().map_err(|_| unpaired())?);
        let (ws, _) = tokio_tungstenite::connect_async(req).await.map_err(|e| match e {
            tungstenite::Error::Http(r) if r.status() == 401 => error("not_paired", "This phone was removed from your account. Pair it again"),
            tungstenite::Error::Http(r) if r.status() == 402 => error("upgrade", "Reaching your computer from anywhere needs the Pro plan"),
            e => error("unreachable", format!("Can't reach the Gitnetix relay: {e}")),
        })?;
        let (mut sink, mut stream) = ws.split();
        let ready = timed(async {
            while let Some(m) = stream.next().await {
                if let Ok(Message::Text(t)) = m {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap_or_default();
                    if v["type"] == "ready" {
                        return Ok(v);
                    }
                }
            }
            Err(lost())
        })
        .await?;
        if !ready["peers"].as_array().is_some_and(|l| l.iter().any(|d| d["id"] == p.host)) {
            return Err(offline(&p.name));
        }
        let mut hs = crate::initiator(&secret, &psk)?;
        send(&mut sink, frame(&host, HELLO1, &crate::write(&mut hs)?)).await?;
        crate::read(&mut hs, &from_host(&mut stream, host, HELLO2, &p.name).await?)?;
        // The computer must hold the key its QR code showed, or the relay put itself in the middle.
        if crate::remote(&hs) != Some(pinned) {
            return Err(error("not_paired", format!("{} answered with another key than its QR code showed. Pair it again", p.name)));
        }
        send(&mut sink, frame(&host, HELLO3, &crate::write(&mut hs)?)).await?;
        let mut channel = Channel::new(hs)?;
        if channel.open(&from_host(&mut stream, host, DATA, &p.name).await?)?.is_none() {
            return Err(lost());
        }
        let (out, rx) = mpsc::unbounded_channel();
        let conn = Arc::new(Conn { host, out, channel: Mutex::new(channel), calls: Default::default(), next: AtomicU64::new(1), dead: AtomicBool::new(false), flow: Flow::default() });
        let sink = Arc::new(tokio::sync::Mutex::new(sink));
        tokio::spawn(write_loop(sink.clone(), rx, conn.clone()));
        tokio::spawn(read_loop(stream, sink, conn.clone(), self.clone()));
        Ok(conn)
    }

    fn deliver(&self, conn: &Conn, msg: &[u8]) {
        let Ok(v) = serde_json::from_slice::<Value>(msg) else { return };
        if let Some(id) = v["id"].as_u64() {
            if let Some(tx) = conn.calls.lock().unwrap().remove(&id) {
                let _ = tx.send(match v.get("error") {
                    Some(e) => Err(serde_json::from_value(e.clone()).unwrap_or_else(|_| error("other", e.to_string()))),
                    None => Ok(v["result"].clone()),
                });
            }
        } else if let Some(ev) = v.get("event") {
            (self.on_event)(ev.clone());
        }
    }

    /// After a drop, connects again in the background so the computer's events come back, waiting longer each time it
    /// stays offline.
    fn revive(self: &Arc<Self>) {
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut wait = 2;
            loop {
                tokio::time::sleep(Duration::from_secs(wait)).await;
                let Some(c) = me.upgrade().filter(|c| !c.closed.load(Ordering::SeqCst)) else { return };
                match c.conn().await {
                    Err(e) if e.code == "unreachable" => wait = (wait * 2).min(60),
                    _ => return,
                }
            }
        });
    }
}

async fn timed<T>(f: impl std::future::Future<Output = Result<T, Error>>) -> Result<T, Error> {
    tokio::time::timeout(STEP, f).await.unwrap_or_else(|_| Err(error("unreachable", "Your computer didn't answer")))
}

async fn send(sink: &mut SplitSink<Socket, Message>, f: Vec<u8>) -> Result<(), Error> {
    sink.send(Message::Binary(f.into())).await.map_err(|_| lost())
}

/// A notice that the computer left the relay.
fn gone(text: &str, host: &Id) -> bool {
    let v: Value = serde_json::from_str(text).unwrap_or_default();
    (v["type"] == "offline" || v["code"] == "peer_offline") && v["peer"] == hex(host)
}

/// The computer's next handshake step of kind `want`, or why none comes.
async fn from_host(stream: &mut SplitStream<Socket>, host: Id, want: u8, name: &str) -> Result<Vec<u8>, Error> {
    timed(async {
        while let Some(m) = stream.next().await {
            match m.map_err(|_| lost())? {
                Message::Binary(b) => match split(&b) {
                    Some((from, kind, data)) if from == host && kind == want => return Ok(data.to_vec()),
                    Some((from, BYE, _)) if from == host => return Err(unpaired()),
                    Some((from, RESET, _)) if from == host => return Err(lost()),
                    _ => {}
                },
                Message::Text(t) if gone(t.as_str(), &host) => return Err(offline(name)),
                Message::Close(_) => break,
                _ => {}
            }
        }
        Err(lost())
    })
    .await
}

/// Sends the queue's frames in order, each piece once the computer has room for it, all under the relay's limit.
async fn write_loop(sink: Sink, mut rx: mpsc::UnboundedReceiver<Vec<u8>>, conn: Arc<Conn>) {
    let mut pace = Pace::new();
    while let Some(f) = rx.recv().await {
        if f.is_empty() {
            let _ = sink.lock().await.send(Message::Close(None)).await;
            return;
        }
        if f.get(12) == Some(&DATA) && !conn.flow.room(f.len() - 13).await {
            return;
        }
        pace.wait(f.len()).await;
        if sink.lock().await.send(Message::Binary(f.into())).await.is_err() {
            return;
        }
    }
}

async fn read_loop(mut stream: SplitStream<Socket>, sink: Sink, conn: Arc<Conn>, client: Arc<Client>) {
    let why = loop {
        let Some(m) = stream.next().await else { break lost() };
        match m {
            Ok(Message::Binary(b)) => {
                let Some((_, kind, data)) = split(&b).filter(|(from, _, _)| *from == conn.host) else { continue };
                match kind {
                    DATA => {
                        let opened = conn.channel.lock().unwrap().open(data);
                        match opened {
                            Ok(Some(msg)) => client.deliver(&conn, &msg),
                            Ok(None) => {}
                            Err(e) => break e,
                        }
                        // Straight out, not behind the queue, since the computer may be waiting for it to send more.
                        if let Some(ack) = conn.flow.opened(data.len()) {
                            let _ = sink.lock().await.send(Message::Binary(frame(&conn.host, ACK, &ack).into())).await;
                        }
                    }
                    ACK => conn.flow.acked(data),
                    BYE => break unpaired(),
                    RESET => break lost(),
                    _ => {}
                }
            }
            Ok(Message::Text(t)) if gone(t.as_str(), &conn.host) => break offline(&client.pairing.name),
            // Code 4003 means the server revoked this phone.
            Ok(Message::Close(f)) => break if f.is_some_and(|f| u16::from(f.code) == 4003) { unpaired() } else { lost() },
            Err(_) => break lost(),
            _ => {}
        }
    };
    conn.end(&why);
    if why.code == "unreachable" {
        client.revive();
    }
}
