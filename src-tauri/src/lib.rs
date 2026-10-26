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
        serde_json::json!({ "enabled": s.enabled, "port": s.port, "lan": s.lan, "token": s.token, "hosts": lan_hosts(), "ufw": ufw_active() })
    }

    // shortcut: ufw only (CachyOS, Ubuntu, Manjaro default); add firewalld if someone needs it.
    fn ufw_active() -> bool {
        cfg!(target_os = "linux") && std::process::Command::new("systemctl").args(["is-active", "--quiet", "ufw"]).status().is_ok_and(|s| s.success())
    }

    /// Open the companion port to this computer's own subnet only. pkexec shows the system password prompt.
    #[tauri::command]
    pub async fn allow_firewall(engine: State<'_, Engine>) -> Result<String, String> {
        let port = engine.0.store.read(|c| c.server.port).to_string();
        let ip = lan_hosts().into_iter().next().ok_or("No network connection found")?;
        let subnet = subnet_of(&ip).ok_or_else(|| format!("No network interface has the address {ip}"))?;
        let out = tauri::async_runtime::spawn_blocking(move || {
            std::process::Command::new("pkexec").args(["ufw", "allow", "from", &subnet, "to", "any", "port", &port, "proto", "tcp"]).output()
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not run pkexec: {e}"))?;
        match out.status.code() {
            Some(0) => Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()),
            Some(126) | Some(127) => Err("Not authorized: the password prompt was cancelled".into()),
            _ => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        }
    }

    fn subnet_of(ip: &str) -> Option<String> {
        let out = std::process::Command::new("ip").args(["-4", "-o", "addr"]).output().ok()?;
        let key = format!("{ip}/");
        let len = String::from_utf8_lossy(&out.stdout).split_whitespace().find_map(|w| w.strip_prefix(&key)?.parse().ok())?;
        Some(network(ip.parse().ok()?, len))
    }

    fn network(ip: std::net::Ipv4Addr, len: u32) -> String {
        let mask = u32::MAX.checked_shl(32 - len.min(32)).unwrap_or(0);
        format!("{}/{len}", std::net::Ipv4Addr::from(u32::from(ip) & mask))
    }

    #[test]
    fn network_masks_host_bits() {
        assert_eq!(network([192, 168, 68, 76].into(), 22), "192.168.68.0/22");
        assert_eq!(network([10, 1, 2, 3].into(), 0), "0.0.0.0/0");
        assert_eq!(network([10, 1, 2, 3].into(), 32), "10.1.2.3/32");
    }

    /// The system browser fails to start with the AppImage's bundled libs, so launch it without them.
    #[tauri::command]
    pub fn open_url(url: String) -> Result<(), String> {
        // Links come from tickets and hosts; never hand other schemes (file:, custom handlers) to the OS.
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(format!("Not a web link: {url}"));
        }
        #[cfg(target_os = "linux")]
        if gitnetix_core::shell::appimage_env().is_some() {
            let mut child = gitnetix_core::shell::without_appimage(&mut std::process::Command::new("xdg-open")).arg(url).spawn().map_err(|e| e.to_string())?;
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

    /// Dev builds load the UI from Vite and embed nothing, so serve the `pnpm build` output instead.
    fn dev_asset(path: &str) -> Option<(Vec<u8>, String)> {
        if !cfg!(debug_assertions) || path.contains("..") {
            return None;
        }
        let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist");
        let file = dist.join(path.trim_start_matches('/'));
        let file = if file.is_file() { file } else { dist.join("index.html") };
        let bytes = std::fs::read(&file).ok()?;
        let mime = tauri::utils::mime_type::MimeType::parse(&bytes, &file.to_string_lossy());
        Some((bytes, mime))
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
        let assets = app.asset_resolver();
        let ui: gitnetix_server::Ui = Arc::new(move |path| match assets.get(path.to_string()) {
            Some(a) => Some((a.bytes().to_vec(), a.mime_type().to_string())),
            None => dev_asset(path),
        });
        tauri::async_runtime::spawn(async move {
            if let Err(e) = gitnetix_server::spawn(server_k, Some(ui)).await {
                tracing::warn!("companion API not started: {e}");
            }
        });
        app.manage(Engine(k));
        // Dev builds show which branch of the source tree they were started from.
        #[cfg(debug_assertions)]
        if let Some(win) = app.get_webview_window("main") {
            let branch = std::process::Command::new("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(env!("CARGO_MANIFEST_DIR"))
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|b| !b.is_empty())
                .unwrap_or_else(|| "unknown".into());
            let _ = win.set_title(&format!("{} | dev - {branch}", win.title().unwrap_or_default()));
        }
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
        .invoke_handler(tauri::generate_handler![desktop::rpc, desktop::companion, desktop::allow_firewall, desktop::open_url]);

    builder.run(tauri::generate_context!()).expect("error while running Gitnetix");
}
