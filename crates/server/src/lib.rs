//! Companion API: the same RPC surface as the desktop window, over HTTP or HTTPS on the same port.
//!
//! - `POST /rpc` `{ "method": "...", "params": {...} }` → result JSON
//! - `GET /events?token=…` → Server-Sent Events (agent logs, project changes)
//! - `GET /health` → `{ "ok": true }` (no auth, used for pairing)
//! - any other `GET` → the web UI's files, when the host provides them (no auth: the bundle holds no secrets)
//!
//! Every API call except `/health` needs `Authorization: Bearer <token>`. The
//! server listens on 127.0.0.1 unless LAN access is turned on in Settings.
//! HTTPS uses a self-signed certificate: phone browsers give the microphone only to https pages.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::Stream;
use gitnetix_core::{rpc, store::write_private, ErrorBody, Gitnetix};
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder;
use hyper_util::service::TowerToHyperService;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::wrappers::BroadcastStream;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::{rustls, TlsAcceptor};
use tokio_stream::StreamExt;
use tower_http::cors::{Any, CorsLayer};

/// Looks up a web UI file by URL path: bytes and MIME type. Lets a phone browser open the app from this server.
pub type Ui = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;

#[derive(Clone)]
struct AppState {
    k: Arc<Gitnetix>,
    ui: Option<Ui>,
}

#[derive(Deserialize)]
struct RpcReq {
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

fn token_ok(k: &Gitnetix, given: Option<&str>) -> bool {
    let want = k.store.read(|c| c.server.token.clone());
    match given {
        // Constant-time enough for a 64-char random token compare.
        Some(g) => !want.is_empty() && g.len() == want.len() && g.bytes().zip(want.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0,
        None => false,
    }
}

fn bearer(h: &HeaderMap) -> Option<&str> {
    h.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ")
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({ "code": "unauthorized", "message": "Missing or wrong pairing token" }))).into_response()
}

async fn rpc_handler(State(s): State<AppState>, headers: HeaderMap, Json(req): Json<RpcReq>) -> Response {
    if !token_ok(&s.k, bearer(&headers)) {
        return unauthorized();
    }
    match rpc::call(&s.k, &req.method, req.params).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(ErrorBody::from(&e))).into_response(),
    }
}

async fn events_handler(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, Response> {
    let given = bearer(&headers).map(String::from).or(q.token);
    if !token_ok(&s.k, given.as_deref()) {
        return Err(unauthorized());
    }
    let stream = BroadcastStream::new(s.k.subscribe()).filter_map(|ev| {
        let ev = ev.ok()?;
        let data = serde_json::to_string(&ev).ok()?;
        Some(Ok(SseEvent::default().data(data)))
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn methods_handler(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !token_ok(&s.k, bearer(&headers)) {
        return unauthorized();
    }
    let list: Vec<Value> = rpc::METHODS.iter().map(|(m, d, p)| json!({ "method": m, "description": d, "params": p })).collect();
    Json(list).into_response()
}

async fn ui_handler(State(s): State<AppState>, uri: Uri) -> Response {
    match s.ui.as_ref().and_then(|ui| ui(uri.path())) {
        Some((bytes, mime)) => ([(header::CONTENT_TYPE, mime)], bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

pub fn router(k: Arc<Gitnetix>, ui: Option<Ui>) -> Router {
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
    Router::new()
        .route("/health", get(|| async { Json(json!({ "ok": true, "app": "gitnetix", "version": env!("CARGO_PKG_VERSION") })) }))
        // Agent messages carry their attachments in base64 (the UI caps them at 25 MB).
        .route("/rpc", post(rpc_handler).layer(DefaultBodyLimit::max(48 << 20)))
        .route("/methods", get(methods_handler))
        .route("/events", get(events_handler))
        .fallback(get(ui_handler))
        .layer(cors)
        .with_state(AppState { k, ui })
}

/// Local IPv4 addresses, shown to pair a phone.
pub fn lan_hosts() -> Vec<String> {
    // Connecting a UDP socket reveals the outbound interface without sending.
    let mut v = Vec::new();
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                v.push(addr.ip().to_string());
            }
        }
    }
    v
}

/// Apple refuses server certificates valid longer than 825 days, even once their warning is accepted.
const CERT_DAYS: i64 = 800;

/// The self-signed certificate, made once and kept so each phone accepts it once; remade before it expires.
fn tls(dir: &Path) -> anyhow::Result<TlsAcceptor> {
    let (cert, key) = (dir.join("companion-cert.der"), dir.join("companion-key.der"));
    let age = std::fs::metadata(&cert).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
    if !key.exists() || age.is_none_or(|a| a > Duration::from_secs((CERT_DAYS as u64 - 10) * 86400)) {
        // shortcut: names the LAN address of when it was made; a new address gets the browser's name warning too, still one tap to accept.
        let mut p = rcgen::CertificateParams::new([vec!["localhost".into(), "127.0.0.1".into()], lan_hosts()].concat())?;
        p.distinguished_name.push(rcgen::DnType::CommonName, "Gitnetix companion");
        p.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        let now = time::OffsetDateTime::now_utc();
        p.not_before = now - time::Duration::days(1);
        p.not_after = now + time::Duration::days(CERT_DAYS);
        let pair = rcgen::KeyPair::generate()?;
        // Key first: a certificate on disk always has its key.
        write_private(&key, pair.serialize_der())?;
        std::fs::write(&cert, p.self_signed(&pair)?.der())?;
    }
    let chain = vec![CertificateDer::from(std::fs::read(&cert)?)];
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(std::fs::read(&key)?));
    Ok(TlsAcceptor::from(Arc::new(rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(chain, key)?)))
}

/// Bind and serve until the process exits. Returns the bound address.
pub async fn spawn(k: Arc<Gitnetix>, ui: Option<Ui>) -> anyhow::Result<Option<SocketAddr>> {
    let cfg = k.store.read(|c| c.server.clone());
    if !cfg.enabled {
        return Ok(None);
    }
    let host = if cfg.lan { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
    let addr = SocketAddr::from((host, cfg.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;
    // Without it the API still answers over plain HTTP, the way the MCP bridge talks to it.
    let tls = tls(&k.dir).inspect_err(|e| tracing::warn!("companion HTTPS off: {e:#}")).ok();
    let app = router(k, ui);
    tokio::spawn(async move {
        loop {
            let tcp = match listener.accept().await {
                Ok((tcp, _)) => tcp,
                Err(e) => {
                    // Out of file descriptors, say: wait instead of spinning.
                    tracing::warn!("companion accept failed: {e}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };
            let (app, tls) = (app.clone(), tls.clone());
            // Each connection on its own task, so a slow handshake holds up no one else.
            tokio::spawn(async move {
                let http = Builder::new(TokioExecutor::new());
                let svc = TowerToHyperService::new(app);
                // A TLS handshake opens with byte 0x16; anything else is plain HTTP.
                let mut first = [0u8];
                let tls_hello = tcp.peek(&mut first).await.is_ok_and(|n| n == 1 && first[0] == 0x16);
                // Dropped connections and refused handshakes are routine: nothing to report.
                let _ = match (tls_hello, tls) {
                    (true, Some(tls)) => match tls.accept(tcp).await {
                        Ok(s) => http.serve_connection_with_upgrades(TokioIo::new(s), svc).await,
                        Err(_) => return,
                    },
                    (true, None) => return,
                    (false, _) => http.serve_connection_with_upgrades(TokioIo::new(tcp), svc).await,
                };
            });
        }
    });
    tracing::info!("companion API on http(s)://{bound}");
    Ok(Some(bound))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_route_but_health_needs_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let k = Gitnetix::open(dir.path()).unwrap();
        let token = k
            .store
            .write(|c| {
                c.server.port = 0;
                Ok(c.server.token.clone())
            })
            .unwrap();
        let ui: Ui = Arc::new(|p| (p == "/").then(|| (b"<html>".to_vec(), "text/html".into())));
        let addr = spawn(k.clone(), Some(ui)).await.unwrap().unwrap();
        let http = reqwest::Client::new();
        let rpc = |t: Option<&str>| {
            let r = http.post(format!("http://{addr}/rpc")).json(&json!({ "method": "app.info" }));
            match t {
                Some(t) => r.bearer_auth(t),
                None => r,
            }
            .send()
        };
        let get = |path: &str| http.get(format!("http://{addr}{path}")).send();
        let code = |r: reqwest::Result<reqwest::Response>| r.unwrap().status().as_u16();

        assert_eq!(code(rpc(None).await), 401);
        assert_eq!(code(rpc(Some(&"0".repeat(token.len()))).await), 401);
        assert_eq!(code(rpc(Some(&token[..token.len() - 1])).await), 401);
        assert_eq!(code(rpc(Some(&token)).await), 200);
        assert_eq!(code(get("/methods").await), 401);
        assert_eq!(code(get("/events?token=nope").await), 401);
        assert_eq!(code(get("/health").await), 200);
        assert_eq!(code(get("/").await), 200);
        assert_eq!(code(get("/missing.js").await), 404);

        // The same port answers HTTPS, and the certificate is kept, so phones accept it only once.
        let https = reqwest::Client::builder().danger_accept_invalid_certs(true).build().unwrap();
        assert_eq!(code(https.get(format!("https://{addr}/health")).send().await), 200);
        let cert = std::fs::read(dir.path().join("companion-cert.der")).unwrap();
        tls(dir.path()).unwrap();
        assert_eq!(std::fs::read(dir.path().join("companion-cert.der")).unwrap(), cert);

        // No token configured lets nobody in, not even an empty bearer.
        k.store
            .write(|c| {
                c.server.token.clear();
                Ok(())
            })
            .unwrap();
        assert_eq!(code(rpc(Some("")).await), 401);
    }
}
