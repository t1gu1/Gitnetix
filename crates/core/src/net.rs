//! The one HTTP client every host shares, so connections are pooled.

use std::sync::OnceLock;

pub fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| reqwest::Client::builder().user_agent(concat!("Gitnetix/", env!("CARGO_PKG_VERSION"))).build().expect("http client"))
        .clone()
}

/// Whether `url` is on `base`'s origin (scheme, host and port): the only place a host's sign-in may go.
pub fn same_origin(url: &reqwest::Url, base: &str) -> bool {
    reqwest::Url::parse(base).is_ok_and(|b| b.origin() == url.origin())
}

/// `src` as a URL, a relative one (GitLab's `/uploads/…`, Gitea's `/attachments/…`) read from `base`.
pub fn resolve(src: &str, base: &str) -> crate::Result<reqwest::Url> {
    reqwest::Url::parse(base).and_then(|b| b.join(src)).map_err(|e| crate::Error::Invalid(format!("{src}: {e}")))
}

/// A picture as a data: URL, read with a request that carries a sign-in. Anything but an image is refused, so a
/// picture link in a description can't read the API with the user's token. A host that sends its files as
/// application/octet-stream (Azure DevOps attachments) gets its type from the file's first bytes. reqwest drops the
/// sign-in on a redirect to another host (signed storage links).
pub async fn picture(req: reqwest::RequestBuilder) -> crate::Result<String> {
    use base64::Engine as _;
    const CAP: usize = 25 << 20;
    let res = req.header("accept", "image/*").send().await?;
    let status = res.status();
    if !status.is_success() {
        return Err(crate::Error::Http(format!("the picture's host answered {status}")));
    }
    let header = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_string();
    if res.content_length().is_some_and(|n| n as usize > CAP) {
        return Err(crate::Error::Invalid("the picture is over 25 MB".into()));
    }
    let bytes = res.bytes().await?;
    if bytes.len() > CAP {
        return Err(crate::Error::Invalid("the picture is over 25 MB".into()));
    }
    let mime = if header.starts_with("image/") { header.as_str() } else { sniff(&bytes).ok_or_else(|| crate::Error::Invalid(format!("not a picture ({header})")))? };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// The picture type a file's first bytes say, for the formats every web view shows.
fn sniff(b: &[u8]) -> Option<&'static str> {
    match b {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_origin_needs_scheme_host_and_port() {
        let base = "https://dev.azure.com";
        let ok = |u: &str| same_origin(&resolve(u, base).unwrap(), base);
        assert!(ok("/org/_apis/wit/attachments/1"));
        assert!(ok("https://dev.azure.com/org/a.png"));
        assert!(!ok("http://dev.azure.com/a.png"));
        assert!(!ok("https://dev.azure.com.evil.test/a.png"));
        assert!(!ok("https://dev.azure.com:444/a.png"));
        assert!(!ok("//evil.test/a.png"));
    }

    #[test]
    fn sniffs_pictures_not_api_answers() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(br#"{"login":"me","email":"me@example.test"}"#), None);
        assert_eq!(sniff(b"<html>Sign in</html>"), None);
    }
}
