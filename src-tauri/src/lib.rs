//! Tauri shell. On desktop it hosts the engine and exposes one `rpc`
//! command plus an event stream. On iOS/Android it ships the same UI in
//! remote mode: the web layer talks to a desktop over the companion API.

use tauri::webview::{PermissionKind, PermissionResponse};

#[cfg(desktop)]
mod mic;

#[cfg(desktop)]
mod desktop {
    use std::sync::Arc;

    use gitnetix_core::{rpc, store::data_dir, ErrorBody, Event, Gitnetix};
    use gitnetix_server::lan_hosts;
    use serde_json::Value;
    use tauri::ipc::Channel;
    use tauri::{Emitter, Manager, State};

    use crate::mic::Recording;

    pub struct Engine(pub Arc<Gitnetix>);

    /// The microphone while dictating.
    #[derive(Default)]
    pub struct Mic(std::sync::Mutex<Option<Recording>>);

    /// Records the microphone for voice dictation; `on_level` gets its loudness meanwhile.
    /// A window command, not an RPC method: a paired phone must not turn on the desktop's microphone.
    #[tauri::command]
    pub async fn dictation_start(mic: State<'_, Mic>, on_level: Channel<f32>) -> Result<(), String> {
        let rec = Recording::start(move |l| {
            let _ = on_level.send(l);
        })?;
        // One left over from a reloaded page stops as it is dropped.
        *mic.0.lock().unwrap() = Some(rec);
        Ok(())
    }

    /// Stops the microphone and turns what it heard into text, expecting the names of `project_id` on `branch`.
    #[tauri::command]
    pub async fn dictation_stop(engine: State<'_, Engine>, mic: State<'_, Mic>, project_id: Option<String>, branch: Option<String>) -> Result<String, String> {
        let rec = mic.0.lock().unwrap().take().ok_or("Not dictating")?;
        let (samples, rate) = tokio::task::spawn_blocking(move || rec.finish()).await.map_err(|e| e.to_string())?;
        let k = engine.0.clone();
        let events = k.events.clone();
        let progress = move |done, total| {
            let _ = events.send(Event::DictationModel { done, total });
        };
        let audio = gitnetix_core::dictation::Audio::Mono { samples, rate };
        k.dictate(audio, project_id.as_deref(), branch.as_deref(), progress).await.map_err(|e| e.to_string())
    }

    /// Stops the microphone and drops what it heard.
    #[tauri::command]
    pub fn dictation_cancel(mic: State<'_, Mic>) {
        mic.0.lock().unwrap().take();
    }

    /// Save the agent logs' latest lines and end their runs before quitting, so a resumed run keeps them and never runs twice.
    pub fn on_event(app: &tauri::AppHandle, ev: tauri::RunEvent) {
        if let tauri::RunEvent::Exit = ev {
            if let Some(e) = app.try_state::<Engine>() {
                e.0.agents.shutdown();
            }
        }
    }

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
        let resume_k = k.clone();
        tauri::async_runtime::spawn(async move { resume_k.agents.resume_interrupted() });
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // The mobile app's voice dictation records in the page, and webviews refuse the microphone unless the app allows it.
        // Safe to allow outright: the window only ever shows Gitnetix's own UI, links open in the browser.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        });

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(desktop::Mic::default())
        .setup(desktop::setup)
        .invoke_handler(tauri::generate_handler![desktop::rpc, desktop::companion, desktop::allow_firewall, desktop::open_url, desktop::dictation_start, desktop::dictation_stop, desktop::dictation_cancel]);

    // The pairing screen scans the desktop's QR code with the phone camera.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    let app = builder.build(tauri::generate_context!()).expect("error while running Gitnetix");
    #[cfg(desktop)]
    app.run(desktop::on_event);
    #[cfg(not(desktop))]
    app.run(|_, _| {});
}
