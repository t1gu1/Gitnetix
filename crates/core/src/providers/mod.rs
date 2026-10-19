pub mod github;
pub mod github_auth;

use serde::{Deserialize, Serialize};

/// owner/repo on a git host, parsed from the `origin` remote.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepoRef {
    pub host: String,
    pub owner: String,
    pub repo: String,
}

/// Accepts `git@github.com:o/r.git`, `https://github.com/o/r(.git)`,
/// `ssh://git@github.com/o/r.git`.
pub fn parse_remote(url: &str) -> Option<RepoRef> {
    let url = url.trim();
    let rest = if let Some(r) = url.strip_prefix("git@") {
        r.replacen(':', "/", 1)
    } else if let Some(i) = url.find("://") {
        let r = &url[i + 3..];
        r.split_once('@').map(|(_, b)| b.to_string()).unwrap_or_else(|| r.to_string())
    } else {
        return None;
    };
    let mut parts = rest.trim_end_matches('/').trim_end_matches(".git").splitn(2, '/');
    let host = parts.next()?.split(':').next()?.to_string();
    let path = parts.next()?;
    let (owner, repo) = path.rsplit_once('/')?;
    Some(RepoRef { host, owner: owner.into(), repo: repo.into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remotes() {
        for u in ["git@github.com:acme/atlas-api.git", "https://github.com/acme/atlas-api", "ssh://git@github.com:22/acme/atlas-api.git"] {
            let r = parse_remote(u).unwrap();
            assert_eq!(r.host, "github.com");
            assert_eq!(r.owner, "acme");
            assert_eq!(r.repo, "atlas-api");
        }
    }
}
