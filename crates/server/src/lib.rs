//! Companion API: the same RPC surface as the desktop window, over HTTP.
//!
//! - `POST /rpc` `{ "method": "...", "params": {...} }` → result JSON
//! - `GET /events?token=…` → Server-Sent Events (agent logs, project changes)
//! - `GET /health` → `{ "ok": true }` (no auth, used for pairing)
//!
//! Every call except `/health` needs `Authorization: Bearer <token>`. The
//! server listens on 127.0.0.1 unless LAN access is turned on in Settings.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
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

#[derive(Clone)]
struct AppState {
    k: Arc<Gitnetix>,
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

pub fn router(k: Arc<Gitnetix>) -> Router {
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
    Router::new()
        .route("/health", get(|| async { Json(json!({ "ok": true, "app": "gitnetix", "version": env!("CARGO_PKG_VERSION") })) }))
        .route("/rpc", post(rpc_handler))
        .route("/methods", get(methods_handler))
        .route("/events", get(events_handler))
        .layer(cors)
        .with_state(AppState { k })
}

/// Bind and serve until the process exits. Returns the bound address.
pub async fn spawn(k: Arc<Gitnetix>) -> anyhow::Result<Option<SocketAddr>> {
    let cfg = k.store.read(|c| c.server.clone());
    if !cfg.enabled {
        return Ok(None);
    }
    let host = if cfg.lan { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
    let addr = SocketAddr::from((host, cfg.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;
    let app = router(k);
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!("companion server stopped: {e}");
        }
    });
    tracing::info!("companion API on http://{bound}");
    Ok(Some(bound))
}
