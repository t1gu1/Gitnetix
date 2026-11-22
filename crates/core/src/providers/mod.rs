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

/// Why a comment on the code was refused: its lines come from a head the pull request has moved past.
pub(crate) const MOVED: &str = "the pull request got new commits since its diff loaded. Reload it and post the comment again";

/// Refs of origin that hold pull request `number`'s head commit on host `kind` (see [`PrHost::provider`]), best
/// first: the pull request's own (it outlives its branch and covers a fork's), then its branch `head`.
pub fn head_refs(kind: &str, number: u64, head: &str) -> Vec<String> {
    let own = match kind {
        "github" | "gitea" => Some(format!("refs/pull/{number}/head")),
        "gitlab" => Some(format!("refs/merge-requests/{number}/head")),
        // The merge Azure DevOps tries out: its second parent is the head.
        "azure" => Some(format!("refs/pull/{number}/merge")),
        _ => None,
    };
    own.into_iter().chain(plain_branch(head).then(|| format!("refs/heads/{head}"))).collect()
}

/// A branch name safe in a fetch refspec: nothing git would read as an option, a destination (`a:b`), a forced
/// update (`+a`) or a pattern. Git refuses all of these in a branch name; a host's answer is checked anyway.
pub fn plain_branch(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with(['-', '+', '/'])
        && !name.contains("..")
        && !name.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, ':' | '*' | '?' | '[' | '\\' | '^' | '~'))
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
    pub async fn set_base(&self, number: u64, base: &str) -> Result<()> {
        each!(self, h => h.set_base(number, base).await)
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
    /// A comment on lines of the diff; see [`github::LineAnchor`].
    pub async fn line_comment(&self, number: u64, at: &github::LineAnchor, body: &str) -> Result<()> {
        each!(self, h => h.line_comment(number, at, body).await)
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

    /// A picture of this host that needs the sign-in (a private repository's, an upload), as a data: URL.
    pub async fn picture(&self, src: &str) -> Result<String> {
        each!(self, h => h.picture(src).await)
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

/// How host `kind` (see [`host_kind`]; "github" or "azure" otherwise) shows a file at a commit, after the repository's root.
fn file_marker(kind: &str) -> &'static [&'static str] {
    match kind {
        "gitlab" => &["-", "blob"],
        "gitea" => &["src", "commit"],
        "bitbucket" => &["src"],
        _ => &["blob"],
    }
}

/// A web link to lines `lines` (first and last) of `path` at commit `sha`, in the repository whose pages start at
/// `root` (`https://github.com/acme/web`), as host `kind` writes it.
pub fn file_link(kind: &str, root: &str, sha: &str, path: &str, lines: Option<(u32, u32)>) -> Result<String> {
    let mut u = reqwest::Url::parse(root.trim_end_matches('/')).map_err(|e| Error::Invalid(format!("{root}: {e}")))?;
    if kind == "azure" {
        let mut q = u.query_pairs_mut();
        q.append_pair("path", &format!("/{path}")).append_pair("version", &format!("GC{sha}"));
        // Whole lines: from the first one's start to the start of the line after the last.
        if let Some((a, b)) = lines {
            q.append_pair("line", &a.to_string()).append_pair("lineEnd", &(b + 1).to_string()).append_pair("lineStartColumn", "1").append_pair("lineEndColumn", "1");
        }
        drop(q);
        return Ok(u.to_string());
    }
    u.path_segments_mut().map_err(|_| Error::Invalid(format!("{root} is no web address")))?.pop_if_empty().extend(file_marker(kind)).push(sha).extend(path.split('/'));
    if let Some((a, b)) = lines {
        u.set_fragment(Some(&match (kind, a == b) {
            ("bitbucket", true) => format!("lines-{a}"),
            ("bitbucket", false) => format!("lines-{a}:{b}"),
            (_, true) => format!("L{a}"),
            ("gitlab", false) => format!("L{a}-{b}"),
            (_, false) => format!("L{a}-L{b}"),
        }));
    }
    Ok(u.to_string())
}

/// The commit, path and lines of a [`file_link`] (or the host's own link to a file at a commit) into the repository
/// at `root`; None for a link anywhere else.
pub fn parse_file_link(kind: &str, root: &str, url: &str) -> Option<(String, String, Option<(u32, u32)>)> {
    let (u, r) = (reqwest::Url::parse(url).ok()?, reqwest::Url::parse(root.trim_end_matches('/')).ok()?);
    if u.origin() != r.origin() {
        return None;
    }
    let segs = |x: &reqwest::Url| x.path_segments().map(|s| s.filter(|p| !p.is_empty()).map(String::from).collect::<Vec<_>>()).unwrap_or_default();
    let (us, rs) = (segs(&u), segs(&r));
    // Hosts take owner and repository names in any case.
    if us.len() < rs.len() || !us.iter().zip(&rs).all(|(a, b)| a.eq_ignore_ascii_case(b)) {
        return None;
    }
    let sha_ok = |s: &str| (7..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit());
    if kind == "azure" {
        let q: std::collections::HashMap<_, _> = u.query_pairs().collect();
        let sha = q.get("version")?.strip_prefix("GC")?.to_string();
        let path = q.get("path")?.trim_start_matches('/').to_string();
        let num = |k: &str| q.get(k).and_then(|n| n.parse::<u32>().ok()).filter(|n| *n > 0);
        let lines = num("line").map(|a| (a, num("lineEnd").filter(|b| *b > a).map_or(a, |b| if num("lineEndColumn") == Some(1) { b - 1 } else { b })));
        return (us.len() == rs.len() && sha_ok(&sha) && !path.is_empty()).then_some((sha, path, lines));
    }
    let marker = file_marker(kind);
    let rest = &us[rs.len()..];
    if rest.len() < marker.len() + 2 || !rest.iter().zip(marker).all(|(a, b)| a == b) {
        return None;
    }
    let (sha, file) = rest[marker.len()..].split_first()?;
    let path = file.iter().map(|p| unpercent(p)).collect::<Option<Vec<_>>>()?.join("/");
    sha_ok(sha).then(|| (sha.clone(), path, u.fragment().and_then(line_range)))
}

/// The lines a link's fragment points at: `L12`, `L12-L20`, `L12C3-L20C9` (GitHub, Gitea), `L12-20` (GitLab),
/// `lines-12:20` (Bitbucket).
fn line_range(frag: &str) -> Option<(u32, u32)> {
    let f = frag.strip_prefix("lines-").or_else(|| frag.strip_prefix('L'))?;
    let num = |s: &str| s.trim_start_matches('L').split('C').next()?.parse::<u32>().ok().filter(|n| *n > 0);
    let mut parts = f.splitn(2, ['-', ':']);
    let a = num(parts.next()?)?;
    let b = match parts.next() {
        Some(p) => num(p)?,
        None => a,
    };
    Some((a.min(b), a.max(b)))
}

/// `s` with its %XX escapes decoded; None when that isn't UTF-8.
fn unpercent(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%').then(|| b.get(i + 1..i + 3)).flatten().and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(n) => {
                out.push(n);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_links_round_trip_on_every_host() {
        let sha = "3f9c2a1b7e";
        for (kind, root, want) in [
            ("github", "https://github.com/acme/web", "https://github.com/acme/web/blob/3f9c2a1b7e/src/up%20load/a%23b.ts#L18-L23"),
            ("gitlab", "https://gitlab.example.com/team/sub/web", "https://gitlab.example.com/team/sub/web/-/blob/3f9c2a1b7e/src/up%20load/a%23b.ts#L18-23"),
            ("gitea", "https://git.example.com:3000/acme/web", "https://git.example.com:3000/acme/web/src/commit/3f9c2a1b7e/src/up%20load/a%23b.ts#L18-L23"),
            ("bitbucket", "https://bitbucket.org/acme/web", "https://bitbucket.org/acme/web/src/3f9c2a1b7e/src/up%20load/a%23b.ts#lines-18:23"),
            ("azure", "https://dev.azure.com/acme/Web/_git/web", "https://dev.azure.com/acme/Web/_git/web?path=%2Fsrc%2Fup+load%2Fa%23b.ts&version=GC3f9c2a1b7e&line=18&lineEnd=24&lineStartColumn=1&lineEndColumn=1"),
        ] {
            let link = file_link(kind, root, sha, "src/up load/a#b.ts", Some((18, 23))).unwrap();
            assert_eq!(link, want, "{kind}");
            assert_eq!(parse_file_link(kind, root, &link), Some((sha.into(), "src/up load/a#b.ts".into(), Some((18, 23)))), "{kind}");
            // One line, and no lines.
            let one = file_link(kind, root, sha, "a.rs", Some((7, 7))).unwrap();
            assert_eq!(parse_file_link(kind, root, &one).unwrap().2, Some((7, 7)), "{kind}");
            assert_eq!(parse_file_link(kind, root, &file_link(kind, root, sha, "a.rs", None).unwrap()).unwrap().2, None, "{kind}");
        }
    }

    #[test]
    fn file_links_elsewhere_are_not_ours() {
        let root = "https://github.com/acme/web";
        // GitHub's own links: columns, owner case.
        assert_eq!(parse_file_link("github", root, "https://github.com/Acme/Web/blob/0123abcd/README.md#L3C2-L9C4"), Some(("0123abcd".into(), "README.md".into(), Some((3, 9)))));
        for other in [
            "https://github.com/acme/webapp/blob/0123abcd/a.rs",
            "https://github.com/acme/web/tree/0123abcd/src",
            "https://github.com/acme/web/blob/main/a.rs",
            "https://gitlab.com/acme/web/blob/0123abcd/a.rs",
            "http://github.com/acme/web/blob/0123abcd/a.rs",
            "https://github.com/acme/web/blob/0123abcd",
            "not a link",
        ] {
            assert_eq!(parse_file_link("github", root, other), None, "{other}");
        }
    }

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
    fn head_refs_stay_plain_refspecs() {
        assert_eq!(head_refs("github", 7, "feat/x"), ["refs/pull/7/head", "refs/heads/feat/x"]);
        assert_eq!(head_refs("gitlab", 7, "feat"), ["refs/merge-requests/7/head", "refs/heads/feat"]);
        assert_eq!(head_refs("bitbucket", 7, "feat"), ["refs/heads/feat"]);
        for bad in ["a:refs/heads/main", "+main", "-x", "a b", "a..b", "x*", ""] {
            assert!(!plain_branch(bad), "{bad}");
        }
        assert_eq!(head_refs("azure", 3, "main:evil"), ["refs/pull/3/merge"]);
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
