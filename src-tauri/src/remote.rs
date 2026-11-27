//! The phone app's way to its computer from anywhere, through the Gitnetix relay, encrypted end to end
//! (gitnetix-relay). On the computer's own network the page talks to its companion API itself.

use gitnetix_relay::{phone::Phone, Error};
use serde_json::Value;
use tauri::{Emitter, Manager, State};

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    // The computer's events reach the page the way the desktop window gets its own.
    let phone = Phone::new(&app.path().app_data_dir()?, move |ev| {
        let _ = handle.emit("gitnetix://event", ev);
    });
    app.manage(phone);
    Ok(())
}

/// Pairs with the computer whose QR code is `link`; `{signIn}` first when the phone isn't signed in to the account.
#[tauri::command]
pub async fn relay_pair(phone: State<'_, Phone>, link: String, name: String) -> Result<Value, Error> {
    phone.pair(&link, &name).await
}

#[tauri::command]
pub async fn relay_sign_in_poll(phone: State<'_, Phone>, device_code: String) -> Result<Value, Error> {
    phone.sign_in_poll(&device_code).await
}

#[tauri::command]
pub async fn relay_rpc(phone: State<'_, Phone>, method: String, params: Value) -> Result<Value, Error> {
    phone.call(&method, params).await
}

#[tauri::command]
pub fn relay_forget(phone: State<'_, Phone>) {
    phone.forget()
}

/// Builds what `run` registers on a phone, so a desktop test build checks the commands as Tauri calls them.
#[test]
fn the_phone_commands_build_as_tauri_calls_them() {
    let _: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![relay_pair, relay_sign_in_poll, relay_rpc, relay_forget]);
    let _ = setup;
}
