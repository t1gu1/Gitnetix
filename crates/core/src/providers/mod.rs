pub mod azure;
pub mod azure_auth;
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

/// The host a project's pull requests live on; every method goes to the same-named one of `GitHub` or `Azure`.
pub enum PrHost {
    GitHub(github::GitHub),
    Azure(azure::Azure),
}

macro_rules! each {
    ($self:ident, $h:ident => $e:expr) => {
        match $self {
            PrHost::GitHub($h) => $e,
            PrHost::Azure($h) => $e,
        }
    };
}

impl PrHost {
    /// github | azure
    pub fn provider(&self) -> &'static str {
        match self {
            PrHost::GitHub(_) => "github",
            PrHost::Azure(_) => "azure",
        }
    }

    pub fn repo(&self) -> RepoRef {
        match self {
            PrHost::GitHub(g) => g.repo.clone(),
            PrHost::Azure(a) => a.repo_ref(),
        }
    }

    pub async fn list(&self) -> crate::error::Result<Vec<github::PrSummary>> {
        each!(self, h => h.list().await)
    }
    pub async fn detail(&self, number: u64) -> crate::error::Result<github::PrDetail> {
        each!(self, h => h.detail(number).await)
    }
    pub async fn create(&self, head: &str, base: &str, title: &str, body: &str, draft: bool) -> crate::error::Result<github::PrSummary> {
        each!(self, h => h.create(head, base, title, body, draft).await)
    }
    pub async fn update(&self, number: u64, title: &str, body: &str) -> crate::error::Result<()> {
        each!(self, h => h.update(number, title, body).await)
    }
    pub async fn merge(&self, number: u64, method: &str) -> crate::error::Result<()> {
        each!(self, h => h.merge(number, method).await)
    }
    pub async fn set_closed(&self, number: u64, closed: bool) -> crate::error::Result<()> {
        each!(self, h => h.set_closed(number, closed).await)
    }
    pub async fn review(&self, number: u64, vote: &str, body: &str) -> crate::error::Result<()> {
        each!(self, h => h.review(number, vote, body).await)
    }
    pub async fn comment(&self, number: u64, body: &str) -> crate::error::Result<()> {
        each!(self, h => h.comment(number, body).await)
    }
    pub async fn reply(&self, number: u64, comment_db_id: u64, body: &str) -> crate::error::Result<()> {
        each!(self, h => h.reply(number, comment_db_id, body).await)
    }
    pub async fn edit_comment(&self, id: &str, body: &str) -> crate::error::Result<()> {
        each!(self, h => h.edit_comment(id, body).await)
    }
    pub async fn set_resolved(&self, thread_id: &str, resolved: bool) -> crate::error::Result<()> {
        each!(self, h => h.set_resolved(thread_id, resolved).await)
    }
    pub async fn react(&self, subject_id: &str, content: &str, add: bool) -> crate::error::Result<()> {
        each!(self, h => h.react(subject_id, content, add).await)
    }
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
