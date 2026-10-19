//! Tauri shell. On desktop it hosts the engine and exposes one `rpc`
//! command plus an event stream. On iOS/Android it ships the same UI in
//! remote mode: the web layer talks to a desktop over the companion API.

#[cfg(desktop)]
mod desktop {
    use std::sync::Arc;

    use gitnetix_core::{rpc, store::data_dir, ErrorBody, Gitnetix};
    use serde_json::Value;
    use tauri::{Emitter, Manager, State};

    pub struct Engine(pub Arc<Gitnetix>);

    #[tauri::command]
    pub async fn rpc(engine: State<'_, Engine>, method: String, params: Value) -> Result<Value, ErrorBody> {
        let k = engine.0.clone();
        rpc::call(&k, &method, params).await.map_err(|e| ErrorBody::from(&e))
    }

    #[tauri::command]
    pub fn companion(engine: State<'_, Engine>) -> Value {
        let s = engine.0.store.read(|c| c.server.clone());
        serde_json::json!({ "enabled": s.enabled, "port": s.port, "lan": s.lan, "token": s.token, "hosts": lan_hosts() })
    }

    /// Local IPv4 addresses, shown to pair a phone.
    fn lan_hosts() -> Vec<String> {
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

    pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
        let k = Gitnetix::open(&data_dir())?;
        let handle = app.handle().clone();
        let mut rx = k.subscribe();
        tauri::async_runtime::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let _ = handle.emit("gitnetix://event", ev);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
        let server_k = k.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = gitnetix_server::spawn(server_k).await {
                tracing::warn!("companion API not started: {e}");
            }
        });
        app.manage(Engine(k));
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt().with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into())).try_init();
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init()).plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(desktop::setup)
        .invoke_handler(tauri::generate_handler![desktop::rpc, desktop::companion]);

    builder.run(tauri::generate_context!()).expect("error while running Gitnetix");
}
