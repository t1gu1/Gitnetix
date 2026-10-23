//! Companion API: the same RPC surface as the desktop window, over HTTP.
//!
//! - `POST /rpc` `{ "method": "...", "params": {...} }` → result JSON
//! - `GET /events?token=…` → Server-Sent Events (agent logs, project changes)
//! - `GET /health` → `{ "ok": true }` (no auth, used for pairing)
//! - any other `GET` → the web UI's files, when the host provides them (no auth: the bundle holds no secrets)
//!
//! Every API call except `/health` needs `Authorization: Bearer <token>`. The
//! server listens on 127.0.0.1 unless LAN access is turned on in Settings.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::Stream;
use gitnetix_core::{rpc, ErrorBody, Gitnetix};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::wrappers::BroadcastStream;
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
        .route("/rpc", post(rpc_handler))
        .route("/methods", get(methods_handler))
        .route("/events", get(events_handler))
        .fallback(get(ui_handler))
        .layer(cors)
        .with_state(AppState { k, ui })
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
    let app = router(k, ui);
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!("companion server stopped: {e}");
        }
    });
    tracing::info!("companion API on http://{bound}");
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
