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

    /// AppImage's AppRun points LD_LIBRARY_PATH, GTK and GIO at bundled libs. The
    /// system browser inherits them and fails to start, so launch it without them.
    #[tauri::command]
    pub fn open_url(url: String) -> Result<(), String> {
        // Links come from tickets and hosts; never hand other schemes (file:, custom handlers) to the OS.
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(format!("Not a web link: {url}"));
        }
        #[cfg(target_os = "linux")]
        if let Some(appdir) = std::env::var_os("APPDIR").filter(|_| std::env::var_os("APPIMAGE").is_some()) {
            let mut cmd = std::process::Command::new("xdg-open");
            for k in ["LD_LIBRARY_PATH", "GTK_DATA_PREFIX", "GTK_THEME", "GSETTINGS_SCHEMA_DIR", "GI_TYPELIB_PATH", "GIO_MODULE_DIR", "GTK_EXE_PREFIX", "GTK_PATH", "GTK_IM_MODULE_FILE", "GDK_PIXBUF_MODULE_FILE", "PYTHONHOME", "PYTHONPATH", "PERLLIB", "QT_PLUGIN_PATH", "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0"] {
                cmd.env_remove(k);
            }
            // Keep the user's own entries, drop the ones pointing inside the AppImage.
            for k in ["PATH", "XDG_DATA_DIRS"] {
                if let Some(v) = std::env::var_os(k) {
                    let kept: Vec<_> = std::env::split_paths(&v).filter(|p| !p.starts_with(&appdir)).collect();
                    cmd.env(k, std::env::join_paths(kept).unwrap_or_default());
                }
            }
            let mut child = cmd.arg(url).spawn().map_err(|e| e.to_string())?;
            std::thread::spawn(move || child.wait());
            return Ok(());
        }
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
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
        .invoke_handler(tauri::generate_handler![desktop::rpc, desktop::companion, desktop::open_url]);

    builder.run(tauri::generate_context!()).expect("error while running Gitnetix");
}
