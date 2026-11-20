//! A claude.ai artifact link is private to the user's claude.ai account, and the artboard is drawn in a frame from another site,
//! so Gitnetix cannot fetch it. Instead it opens the link in its own window, where the user signs in to claude.ai, and saves a
//! picture of what that window shows for the message box to attach.
//! The window is granted no app permissions (capabilities/default.json covers `main` only), and Tauri refuses app commands
//! from remote pages, so claude.ai, or a sign-in page it leads to, can call nothing in Gitnetix.

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc::UnboundedSender;

const LABEL: &str = "artifact";

/// What the platform's snapshot hands back: the PNG bytes, or why there are none.
type Shot = UnboundedSender<Result<Vec<u8>, String>>;

/// `url` when it is a claude.ai artifact link; no other page opens in the window.
fn artifact_url(url: &str) -> Result<Url, String> {
    let bad = || format!("Not a claude.ai artifact link: {url}");
    let u = Url::parse(url).map_err(|_| bad())?;
    let path = u.path();
    let artifact = path.starts_with("/artifact/") || path.starts_with("/code/artifact/");
    if u.scheme() != "https" || u.host_str() != Some("claude.ai") || u.port().is_some() || !artifact {
        return Err(bad());
    }
    Ok(u)
}

/// Opens artifact `url` in the claude.ai window, or shows it there when that window is already open.
/// The sign-in stays in the app's web data, so it is asked for once.
#[tauri::command]
pub async fn artifact_open(app: AppHandle, url: String) -> Result<(), String> {
    let url = artifact_url(&url)?;
    if let Some(win) = app.get_webview_window(LABEL) {
        win.navigate(url).map_err(|e| e.to_string())?;
        let _ = win.unminimize();
        return win.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
        .title("claude.ai artifact: sign in, then attach it from Gitnetix")
        .inner_size(1400.0, 900.0)
        .build()
        .map(drop)
        .map_err(|e| e.to_string())
}

/// Saves a PNG of what the claude.ai window shows, closes it, and returns the file's path for the message box to attach.
#[tauri::command]
pub async fn artifact_capture(app: AppHandle) -> Result<String, String> {
    let win = app.get_webview_window(LABEL).ok_or("The claude.ai window is closed")?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    win.with_webview(move |w| snapshot(w, tx)).map_err(|e| e.to_string())?;
    let png = rx.recv().await.ok_or("The picture was not taken")??;
    // shortcut: pictures stay in the cache folder after the message copies them; clear the folder if it ever grows large.
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("artifacts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    let file = dir.join(format!("claude-artifact-{stamp}.png"));
    std::fs::write(&file, png).map_err(|e| format!("Could not save the picture: {e}"))?;
    let _ = win.close();
    Ok(file.display().to_string())
}

/// Save a PNG of the main window's page as `file`, written whole (a script waits for it to appear). Needs no screen
/// recording permission, unlike capturing the window from outside.
pub fn save_window(app: &AppHandle, file: std::path::PathBuf) {
    let Some(win) = app.get_webview_window("main") else { return };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    if win.with_webview(move |w| snapshot(w, tx)).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let tmp = file.with_extension("png.tmp");
        match rx.recv().await {
            Some(Ok(png)) => {
                let _ = std::fs::write(&tmp, png).and_then(|_| std::fs::rename(&tmp, &file));
            }
            other => tracing::warn!("window picture not taken: {:?}", other.and_then(|r| r.err())),
        }
    });
}

/// The part of the page the window shows: the artboard scrolls inside its own frame, so the whole document would miss it.
#[cfg(target_os = "linux")]
fn snapshot(w: tauri::webview::PlatformWebview, done: Shot) {
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
    w.inner().snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&webkit2gtk::gio::Cancellable>, move |shot| {
        let png = shot.map_err(|e| e.to_string()).and_then(|s| {
            let img = cairo::ImageSurface::try_from(s).map_err(|_| "The picture is not an image".to_string())?;
            let mut out = Vec::new();
            img.write_to_png(&mut out).map_err(|e| e.to_string())?;
            Ok(out)
        });
        let _ = done.send(png);
    });
}

#[cfg(windows)]
fn snapshot(w: tauri::webview::PlatformWebview, done: Shot) {
    use webview2_com::{CapturePreviewCompletedHandler, Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG};
    use windows::Win32::{
        System::Com::{IStream, STREAM_SEEK_END, STREAM_SEEK_SET},
        UI::Shell::SHCreateMemStream,
    };
    fn read(stream: &IStream) -> windows::core::Result<Vec<u8>> {
        let mut size = 0u64;
        unsafe {
            stream.Seek(0, STREAM_SEEK_END, Some(&mut size))?;
            stream.Seek(0, STREAM_SEEK_SET, None)?;
            let mut out = vec![0u8; size as usize];
            let mut got = 0u32;
            stream.Read(out.as_mut_ptr().cast(), size as u32, Some(&mut got)).ok()?;
            out.truncate(got as usize);
            Ok(out)
        }
    }
    let start = || -> windows::core::Result<()> {
        let web = unsafe { w.controller().CoreWebView2()? };
        let stream = unsafe { SHCreateMemStream(None) }.ok_or_else(windows::core::Error::from_thread)?;
        let (s, d) = (stream.clone(), done.clone());
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |res| {
            let _ = d.send(res.and_then(|_| read(&s)).map_err(|e| e.to_string()));
            Ok(())
        }));
        unsafe { web.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler) }
    };
    if let Err(e) = start() {
        let _ = done.send(Err(e.to_string()));
    }
}

// Run on macOS through `save_window` (scripts/two-apps.mjs); the artifact window path itself is untested there.
#[cfg(target_os = "macos")]
fn snapshot(w: tauri::webview::PlatformWebview, done: Shot) {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;
    let web: &WKWebView = unsafe { &*w.inner().cast() };
    let block = block2::RcBlock::new(move |img: *mut NSImage, err: *mut NSError| {
        let png = unsafe { img.as_ref() }
            .and_then(|img| img.TIFFRepresentation())
            .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
            .and_then(|rep| unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) })
            .map(|data| data.to_vec())
            .ok_or_else(|| unsafe { err.as_ref() }.map_or("The picture was not taken".to_string(), |e| e.localizedDescription().to_string()));
        let _ = done.send(png);
    });
    unsafe { web.takeSnapshotWithConfiguration_completionHandler(None, &block) };
}

#[cfg(test)]
mod tests {
    use super::artifact_url;

    #[test]
    fn only_claude_artifact_links_open() {
        assert!(artifact_url("https://claude.ai/artifact/42TrcCHjz8oiMWPau2eauy#artboard-3fb1e4419c3f").is_ok());
        assert!(artifact_url("https://claude.ai/code/artifact/187fb5bc-ae69-4b91-a232-ed302372d53c").is_ok());
        for bad in [
            "http://claude.ai/artifact/x",
            "https://claude.ai/chat/x",
            "https://claude.ai.evil.com/artifact/x",
            "https://evil.com/artifact/x",
            "https://claude.ai:8443/artifact/x",
            "https://user@evil.com/artifact/x",
            "file:///artifact/x",
            "not a link",
        ] {
            assert!(artifact_url(bad).is_err(), "{bad}");
        }
    }
}
