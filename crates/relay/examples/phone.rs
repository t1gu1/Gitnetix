//! The phone app's Rust side on a desktop, for end-to-end tests. `phone <dir> <port>` serves the commands the app's
//! page invokes (src-tauri/src/remote.rs) as `POST /invoke/<command>` with the same JSON arguments, and the computer's
//! events as Server-Sent Events on `GET /events`. Listens on 127.0.0.1 only.

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use gitnetix_relay::phone::Phone;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

struct S {
    phone: Phone,
    events: broadcast::Sender<Value>,
}

async fn invoke(State(s): State<Arc<S>>, Path(cmd): Path<String>, Json(a): Json<Value>) -> Response {
    let text = |k: &str| a[k].as_str().unwrap_or_default().to_string();
    let out = match cmd.as_str() {
        "relay_pair" => s.phone.pair(&text("link"), &text("name")).await,
        "relay_sign_in_poll" => s.phone.sign_in_poll(&text("deviceCode")).await,
        "relay_rpc" => s.phone.call(&text("method"), a["params"].clone()).await,
        "relay_forget" => Ok(Value::Null),
        _ => return (StatusCode::NOT_FOUND, Json(json!({ "code": "not_found", "message": cmd }))).into_response(),
    };
    if cmd == "relay_forget" {
        s.phone.forget();
    }
    match out {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(e)).into_response(),
    }
}

async fn events(State(s): State<Arc<S>>) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(s.events.subscribe()).filter_map(|v| Some(Ok(Event::default().data(v.ok()?.to_string()))));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(dir), Some(port)) = (args.next(), args.next()) else {
        eprintln!("usage: phone <dir> <port>");
        std::process::exit(2);
    };
    let (bus, _) = broadcast::channel(1024);
    let tx = bus.clone();
    let phone = Phone::new(std::path::Path::new(&dir), move |ev| {
        let _ = tx.send(ev);
    });
    let app = Router::new()
        // The app's calls carry attachments (the page caps them at 25 MB), as Tauri's IPC does.
        .route("/invoke/{cmd}", post(invoke).layer(axum::extract::DefaultBodyLimit::max(48 << 20)))
        .route("/events", get(events))
        // The page comes from another port (vite).
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(Arc::new(S { phone, events: bus }));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port.parse::<u16>().expect("a port"))).await.expect("the port is free");
    println!("phone stand-in on http://127.0.0.1:{port}");
    axum::serve(listener, app).await.unwrap();
}
