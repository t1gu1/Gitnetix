//! Headless Gitnetix: the companion API without the desktop window.
//! Handy on a dev box you drive from the mobile app.

use gitnetix_core::{store::data_dir, Gitnetix};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into())).init();
    let k = Gitnetix::open(&data_dir())?;
    let cfg = k.store.read(|c| c.server.clone());
    match gitnetix_server::spawn(k.clone(), None).await? {
        Some(addr) => {
            println!("Gitnetix companion API on http(s)://{addr}");
            println!("Pairing token: {}", cfg.token);
            if !cfg.lan {
                println!("Listening on localhost only. Turn on LAN access in Settings › Companion to pair a phone.");
            }
        }
        None => {
            println!("Companion API is disabled in Settings.");
            return Ok(());
        }
    }
    // Here, not before: with the API disabled the process exits at once and would kill the resumed agents.
    k.agents.resume_interrupted();
    tokio::signal::ctrl_c().await?;
    k.agents.shutdown();
    Ok(())
}
