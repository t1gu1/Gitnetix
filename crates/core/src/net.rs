//! The one HTTP client every host shares, so connections are pooled.

use std::sync::OnceLock;

pub fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| reqwest::Client::builder().user_agent(concat!("Gitnetix/", env!("CARGO_PKG_VERSION"))).build().expect("http client"))
        .clone()
}
