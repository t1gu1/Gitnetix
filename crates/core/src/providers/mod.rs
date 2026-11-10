pub mod azure;
pub mod azure_auth;
pub mod bitbucket;
pub mod gitea;
pub mod github;
pub mod github_auth;
pub mod gitlab;
pub mod oauth;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::store::Integrations;

/// owner/repo on a git host, parsed from the `origin` remote. Empty for calls about the account, not a repository.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepoRef {
    pub host: String,
    pub owner: String,
    pub repo: String,
    /// The port an http(s) remote names, which tells two servers on one host apart. An ssh one names the ssh port.
    #[serde(skip)]
    pub port: Option<u16>,
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
    let first = parts.next()?;
    let (host, port) = first.split_once(':').map_or((first, None), |(h, p)| (h, Some(p)));
    let port = port.filter(|_| url.starts_with("http")).and_then(|p| p.parse().ok());
    let path = parts.next()?;
    let (owner, repo) = path.rsplit_once('/')?;
    Some(RepoRef { host: host.into(), owner: owner.into(), repo: repo.into(), port })
}

/// `gitlab`, `bitbucket` or `gitea` when that connection's server is where `repo` lives, so its token may go there.
/// GitLab and Bitbucket are recognized before sign-in on their cloud hosts; a Gitea server once set.
pub fn host_kind(repo: &RepoRef, i: &Integrations) -> Option<&'static str> {
    let on = |url: &str| {
        reqwest::Url::parse(url).is_ok_and(|u| u.host_str() == Some(repo.host.as_str()) && repo.port.is_none_or(|p| u.port_or_known_default() == Some(p)))
    };
    if on(i.gitlab.url.as_deref().unwrap_or(gitlab::CLOUD)) {
        Some("gitlab")
    } else if repo.host == "bitbucket.org" {
        Some("bitbucket")
    } else if i.gitea.url.as_deref().is_some_and(on) {
        Some("gitea")
    } else {
        None
    }
}

/// The `kind` connection (see `host_kind`) for `repo`, its tokens renewed first when they are about to expire.
pub async fn connect(kind: &str, repo: RepoRef, i: &Integrations) -> Result<PrHost> {
    match kind {
        "gitlab" => {
            let base = i.gitlab.url.clone().unwrap_or_else(|| gitlab::CLOUD.into());
            let refresh = || Ok(oauth::Refresh { url: format!("{base}/oauth/token"), client_id: i.gitlab.client_id.clone().unwrap_or_else(|| gitlab::CLIENT_ID.into()), secret: None });
            let auth = oauth::access("gitlab", "GitLab", None, refresh).await?.header();
            Ok(PrHost::GitLab(gitlab::GitLab::new(repo, &base, auth)))
        }
        "bitbucket" => {
            let refresh = || {
                let (id, secret) = bitbucket::client()?;
                Ok(oauth::Refresh { url: bitbucket::TOKEN_URL.into(), client_id: id.into(), secret: Some(secret) })
            };
            Ok(PrHost::Bitbucket(bitbucket::Bitbucket::new(repo, oauth::access("bitbucket", "Bitbucket", None, refresh).await?.header())))
        }
        "gitea" => {
            let base = i.gitea.url.clone().ok_or_else(|| Error::NotConnected("Connect Gitea in the menu, under Git providers".into()))?;
            let refresh = || {
                let id = i.gitea.client_id.clone().ok_or_else(|| Error::NotConnected("Gitea (sign in again: session expired)".into()))?;
                Ok(oauth::Refresh { url: format!("{base}/login/oauth/access_token"), client_id: id, secret: None })
            };
            let auth = oauth::access("gitea", "Gitea", None, refresh).await?.header();
            Ok(PrHost::Gitea(gitea::Gitea::new(repo, &base, auth)))
        }
        other => Err(Error::Invalid(format!("unknown git provider {other}"))),
    }
}

/// The host a project's pull requests live on; every method goes to the same-named one of its provider.
pub enum PrHost {
    GitHub(github::GitHub),
    Azure(azure::Azure),
    GitLab(gitlab::GitLab),
    Bitbucket(bitbucket::Bitbucket),
    Gitea(gitea::Gitea),
}

macro_rules! each {
    ($self:ident, $h:ident => $e:expr) => {
        match $self {
            PrHost::GitHub($h) => $e,
            PrHost::Azure($h) => $e,
            PrHost::GitLab($h) => $e,
            PrHost::Bitbucket($h) => $e,
            PrHost::Gitea($h) => $e,
        }
    };
}

impl PrHost {
    /// github | azure | gitlab | bitbucket | gitea
    pub fn provider(&self) -> &'static str {
        match self {
            PrHost::GitHub(_) => "github",
            PrHost::Azure(_) => "azure",
            PrHost::GitLab(_) => "gitlab",
            PrHost::Bitbucket(_) => "bitbucket",
            PrHost::Gitea(_) => "gitea",
        }
    }

    pub fn repo(&self) -> RepoRef {
        match self {
            PrHost::Azure(a) => a.repo_ref(),
            PrHost::GitHub(g) => g.repo.clone(),
            PrHost::GitLab(g) => g.repo.clone(),
            PrHost::Bitbucket(b) => b.repo.clone(),
            PrHost::Gitea(g) => g.repo.clone(),
        }
    }

    pub async fn list(&self) -> Result<Vec<github::PrSummary>> {
        each!(self, h => h.list().await)
    }
    pub async fn detail(&self, number: u64) -> Result<github::PrDetail> {
        each!(self, h => h.detail(number).await)
    }
    pub async fn create(&self, head: &str, base: &str, title: &str, body: &str, draft: bool) -> Result<github::PrSummary> {
        each!(self, h => h.create(head, base, title, body, draft).await)
    }
    pub async fn update(&self, number: u64, title: &str, body: &str) -> Result<()> {
        each!(self, h => h.update(number, title, body).await)
    }
    pub async fn merge(&self, number: u64, method: &str) -> Result<()> {
        each!(self, h => h.merge(number, method).await)
    }
    pub async fn set_closed(&self, number: u64, closed: bool) -> Result<()> {
        each!(self, h => h.set_closed(number, closed).await)
    }
    pub async fn review(&self, number: u64, vote: &str, body: &str) -> Result<()> {
        each!(self, h => h.review(number, vote, body).await)
    }
    pub async fn comment(&self, number: u64, body: &str) -> Result<()> {
        each!(self, h => h.comment(number, body).await)
    }
    /// GitHub and Azure DevOps answer the comment `comment_db_id`; the others the conversation `thread_id`.
    pub async fn reply(&self, number: u64, thread_id: &str, comment_db_id: u64, body: &str) -> Result<()> {
        match self {
            PrHost::GitHub(h) => h.reply(number, comment_db_id, body).await,
            PrHost::Azure(h) => h.reply(number, comment_db_id, body).await,
            PrHost::GitLab(h) => h.reply(number, thread_id, body).await,
            PrHost::Bitbucket(h) => h.reply(number, thread_id, body).await,
            PrHost::Gitea(h) => h.reply(number, thread_id, body).await,
        }
    }
    pub async fn edit_comment(&self, id: &str, body: &str) -> Result<()> {
        each!(self, h => h.edit_comment(id, body).await)
    }
    pub async fn set_resolved(&self, thread_id: &str, resolved: bool) -> Result<()> {
        each!(self, h => h.set_resolved(thread_id, resolved).await)
    }
    pub async fn react(&self, subject_id: &str, content: &str, add: bool) -> Result<()> {
        each!(self, h => h.react(subject_id, content, add).await)
    }
    /// Empty for Azure DevOps, whose branch policies are not looked up.
    pub async fn protected_branches(&self) -> Result<Vec<String>> {
        match self {
            PrHost::Azure(_) => Ok(vec![]),
            PrHost::GitHub(h) => h.protected_branches().await,
            PrHost::GitLab(h) => h.protected_branches().await,
            PrHost::Bitbucket(h) => h.protected_branches().await,
            PrHost::Gitea(h) => h.protected_branches().await,
        }
    }
    /// The release's page.
    pub async fn create_release(&self, tag: &str, target: &str, name: &str, body: &str) -> Result<String> {
        match self {
            PrHost::GitHub(h) => h.create_release(tag, target, name, body).await,
            PrHost::GitLab(h) => h.create_release(tag, target, name, body).await,
            PrHost::Gitea(h) => h.create_release(tag, target, name, body).await,
            PrHost::Azure(_) | PrHost::Bitbucket(_) => Err(Error::Unsupported(format!("{} has no releases", self.name()))),
        }
    }
    /// Repositories the signed-in account can clone.
    pub async fn user_repos(&self) -> Result<Vec<github::UserRepo>> {
        match self {
            PrHost::GitHub(h) => h.user_repos().await,
            PrHost::GitLab(h) => h.user_repos().await,
            PrHost::Bitbucket(h) => h.user_repos().await,
            PrHost::Gitea(h) => h.user_repos().await,
            PrHost::Azure(_) => Err(Error::Unsupported("Azure DevOps repositories are not listed".into())),
        }
    }
    pub fn name(&self) -> &'static str {
        match self {
            PrHost::GitHub(_) => "GitHub",
            PrHost::Azure(_) => "Azure DevOps",
            PrHost::GitLab(_) => "GitLab",
            PrHost::Bitbucket(_) => "Bitbucket",
            PrHost::Gitea(_) => "Gitea",
        }
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

    #[test]
    fn tokens_only_go_to_their_own_server() {
        let kind = |url: &str, i: &Integrations| host_kind(&parse_remote(url).unwrap(), i);
        let mut i = Integrations::default();
        assert_eq!(kind("git@gitlab.com:acme/api.git", &i), Some("gitlab"));
        assert_eq!(kind("https://bitbucket.org/acme/api.git", &i), Some("bitbucket"));
        assert_eq!(kind("https://github.com/acme/api", &i), None);
        assert_eq!(kind("https://git.acme.io/acme/api", &i), None, "no Gitea server set");
        i.gitea.url = Some("https://git.acme.io".into());
        i.gitlab.url = Some("https://gitlab.acme.io:8443".into());
        assert_eq!(kind("ssh://git@git.acme.io:2222/acme/api.git", &i), Some("gitea"), "the ssh port is not the server's");
        assert_eq!(kind("https://gitlab.acme.io:8443/acme/sub/api.git", &i), Some("gitlab"));
        assert_eq!(kind("https://gitlab.com/acme/api", &i), None, "the token is for the self-managed server now");
        assert_eq!(kind("https://evil.io/acme/api", &i), None);
        // Two servers on one host: an http remote's port picks the right one.
        i.gitlab.url = Some("http://127.0.0.1:8929".into());
        i.gitea.url = Some("http://127.0.0.1:3300".into());
        assert_eq!(kind("http://127.0.0.1:3300/gnx/demo.git", &i), Some("gitea"));
        assert_eq!(kind("http://127.0.0.1:8929/root/demo.git", &i), Some("gitlab"));
        assert_eq!(kind("http://127.0.0.1:9999/x/y.git", &i), None);
    }
}
