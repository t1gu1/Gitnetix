//! Headless Gitnetix: the companion API without the desktop window.
//! Handy on a dev box you drive from the mobile app.

use std::io::IsTerminal;

use gitnetix_core::{store::data_dir, Gitnetix};

fn main() -> anyhow::Result<()> {
    gitnetix_core::runtime()?.block_on(serve())
}

async fn serve() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into())).init();
    let k = Gitnetix::open(&data_dir())?;
    let cfg = k.store.read(|c| c.server.clone());
    match gitnetix_server::spawn(k.clone(), None).await? {
        Some(addr) => {
            println!("Gitnetix companion API on http(s)://{addr}");
            // Only to a terminal: under launchd, systemd or nohup stdout goes to a log file, and the token gives full control.
            if std::io::stdout().is_terminal() {
                println!("Pairing token: {}", cfg.token);
            } else {
                println!("Pairing token: server.token in {}", gitnetix_core::store::active_config_path(&data_dir()).display());
            }
            if !cfg.lan {
                println!("Listening on localhost only. Allow devices on your network in the Gitnetix menu to pair a phone.");
            }
        }
        None => {
            println!("Companion API is disabled in the Gitnetix menu, under Companion & MCP.");
            return Ok(());
        }
    }
    // Here, not before: with the API disabled the process exits at once and would kill the resumed agents.
    // The login shell's PATH first, which may hold the CLI they use.
    gitnetix_core::project_commands::login_dirs().await;
    k.agents.resume_interrupted();
    // Live updates and phones from anywhere go back on the relay when on.
    gitnetix_core::live::wake(&k);
    tokio::signal::ctrl_c().await?;
    k.agents.shutdown();
    Ok(())
}
