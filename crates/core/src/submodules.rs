//! Git submodules of a project: where each is pinned, what is checked out in
//! it, and how far it is from its remote. Reads `.gitmodules`, the index and
//! each submodule's own repository; changes go through `git submodule`.

use std::collections::HashMap;
use std::path::{Component, Path};

use futures_util::{stream, StreamExt};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::git::{parse_status_z, Git};
use crate::providers::parse_remote;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleState {
    /// Declared but never cloned (`git submodule update --init` not run).
    Uninitialized,
    /// Checked out at the commit the project records.
    Clean,
    /// Checked out at another commit than the recorded one.
    Moved,
    /// Its pointer is conflicted in the index (a merge or rebase touched it).
    Conflict,
    /// In `.gitmodules` but not in the index: added to the file by hand, or half removed.
    Missing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub name: String,
    pub path: String,
    /// URL in `.gitmodules`.
    pub url: String,
    /// URL the local clone actually uses (`.git/config`); None until initialized.
    pub local_url: Option<String>,
    /// The local clone fetches from elsewhere than `.gitmodules` says: a sync is due.
    pub url_drift: bool,
    /// The repository's page on its host (GitHub, GitLab, Azure DevOps…); None for a local or unknown remote.
    pub web_url: Option<String>,
    /// Branch `update --remote` follows, from `.gitmodules`; None = the remote's default.
    pub branch: Option<String>,
    pub state: SubmoduleState,
    /// Commit the project pins (index).
    pub recorded: Option<String>,
    /// The pointer in the index differs from HEAD's: a new pin waiting to be committed.
    pub staged: bool,
    /// Commit checked out in the submodule.
    pub head: Option<String>,
    /// Branch checked out in the submodule; None = detached (the usual case).
    pub head_branch: Option<String>,
    pub subject: Option<String>,
    pub author: Option<String>,
    pub date: Option<String>,
    /// Uncommitted files inside the submodule.
    pub dirty: u32,
    /// Commits checked out that the recorded one lacks, and the reverse.
    pub ahead: u32,
    pub behind: u32,
    /// Remote branch it is compared to (e.g. `origin/main`), as of the last fetch.
    pub upstream: Option<String>,
    /// Commits on `upstream` not checked out yet.
    pub upstream_behind: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchReport {
    pub fetched: u32,
    /// "path: error" for each submodule that could not be fetched.
    pub failed: Vec<String>,
}

#[derive(Default)]
struct Declared {
    path: Option<String>,
    url: Option<String>,
    branch: Option<String>,
}

/// `.gitmodules` entries by name, in file order.
async fn declared(git: &Git) -> Result<Vec<(String, Declared)>> {
    if !git.cwd().join(".gitmodules").exists() {
        return Ok(Vec::new());
    }
    let (_, out, _) = git.try_run(&["config", "-f", ".gitmodules", "-z", "--get-regexp", r"^submodule\."]).await?;
    let mut list: Vec<(String, Declared)> = Vec::new();
    for rec in out.split('\0').filter(|r| !r.is_empty()) {
        let (key, value) = rec.split_once('\n').unwrap_or((rec, ""));
        // Names may hold dots: the setting is after the last one.
        let Some((name, field)) = key.strip_prefix("submodule.").and_then(|k| k.rsplit_once('.')) else { continue };
        let i = match list.iter().position(|(n, _)| n == name) {
            Some(i) => i,
            None => {
                list.push((name.to_string(), Declared::default()));
                list.len() - 1
            }
        };
        let d = &mut list[i].1;
        match field {
            "path" => d.path = Some(value.to_string()),
            "url" => d.url = Some(value.to_string()),
            "branch" => d.branch = Some(value.to_string()).filter(|b| !b.is_empty()),
            _ => {}
        }
    }
    Ok(list.into_iter().filter(|(_, d)| d.path.is_some()).collect())
}

/// Gitlinks (mode 160000) among `paths`: path -> (sha, merge stage).
async fn index_links(git: &Git, paths: &[&str]) -> Result<HashMap<String, (String, u8)>> {
    let args: Vec<&str> = ["ls-files", "-s", "-z", "--"].into_iter().chain(paths.iter().copied()).collect();
    let out = git.run(&args).await?;
    let mut map = HashMap::new();
    for rec in out.split('\0') {
        let Some((meta, path)) = rec.split_once('\t') else { continue };
        let f: Vec<&str> = meta.split(' ').collect();
        if f.len() == 3 && f[0] == "160000" {
            let stage: u8 = f[2].parse().unwrap_or(0);
            // Conflicted: keep "ours" (stage 2) as the pin, and the highest stage as the flag.
            let e = map.entry(path.to_string()).or_insert((String::new(), 0));
            if stage == 0 || stage == 2 || e.0.is_empty() {
                e.0 = f[1].to_string();
            }
            e.1 = e.1.max(stage);
        }
    }
    Ok(map)
}

/// Gitlinks among `paths` in HEAD: path -> sha.
async fn head_links(git: &Git, paths: &[&str]) -> HashMap<String, String> {
    let args: Vec<&str> = ["ls-tree", "-z", "HEAD", "--"].into_iter().chain(paths.iter().copied()).collect();
    let Ok((true, out, _)) = git.try_run(&args).await else { return HashMap::new() };
    out.split('\0')
        .filter_map(|rec| {
            let (meta, path) = rec.split_once('\t')?;
            let f: Vec<&str> = meta.split(' ').collect();
            (f.len() == 3 && f[1] == "commit").then(|| (path.to_string(), f[2].to_string()))
        })
        .collect()
}

/// URLs the local clones use, by submodule name.
async fn local_urls(git: &Git) -> HashMap<String, String> {
    let Ok((_, out, _)) = git.try_run(&["config", "-z", "--get-regexp", r"^submodule\..*\.url$"]).await else { return HashMap::new() };
    out.split('\0')
        .filter_map(|rec| {
            let (key, value) = rec.split_once('\n')?;
            let name = key.strip_prefix("submodule.")?.strip_suffix(".url")?;
            Some((name.to_string(), value.to_string()))
        })
        .collect()
}

/// `rel` (`../kit.git`) resolved against `base` (the project's origin), the way git does.
fn resolve_url(base: &str, rel: &str) -> String {
    let mut base = base.trim_end_matches('/').trim_end_matches(".git").to_string();
    let mut rest = rel;
    loop {
        if let Some(r) = rest.strip_prefix("./") {
            rest = r;
        } else if let Some(r) = rest.strip_prefix("../") {
            rest = r;
            if let Some(i) = base.rfind(['/', ':']) {
                base.truncate(i + usize::from(base.as_bytes()[i] == b':'));
            }
        } else {
            break;
        }
    }
    let sep = if base.ends_with(':') { "" } else { "/" };
    format!("{base}{sep}{rest}")
}

/// Browser page of a remote repository, when the URL names a known kind of host.
pub fn web_url(url: &str) -> Option<String> {
    let r = parse_remote(url)?;
    // Azure DevOps over SSH: `ssh.dev.azure.com:v3/org/project/repo`.
    if r.host == "ssh.dev.azure.com" {
        let mut it = r.owner.strip_prefix("v3/")?.splitn(2, '/');
        let (org, project) = (it.next()?, it.next()?);
        return Some(format!("https://dev.azure.com/{org}/{project}/_git/{}", r.repo));
    }
    Some(format!("https://{}/{}/{}", r.host, r.owner, r.repo))
}

/// Whether the clone's URL matches the declared one. A relative declared URL
/// (`../kit`) was resolved against the project's remote: compare its tail only.
fn same_url(local: &str, declared: &str) -> bool {
    let trim = |u: &str| u.trim_end_matches('/').trim_end_matches(".git").to_string();
    let (local, declared) = (trim(local), trim(declared));
    if !(declared.starts_with("./") || declared.starts_with("../")) {
        return local == declared;
    }
    let tail = declared.split('/').skip_while(|seg| *seg == "." || *seg == "..").collect::<Vec<_>>().join("/");
    local == tail || local.ends_with(&format!("/{tail}")) || local.ends_with(&format!(":{tail}"))
}

async fn count(git: &Git, range: &str) -> Option<(u32, u32)> {
    let (ok, out, _) = git.try_run(&["rev-list", "--left-right", "--count", range]).await.ok()?;
    let mut it = out.split_whitespace().map(|n| n.parse().unwrap_or(0));
    ok.then(|| (it.next().unwrap_or(0), it.next().unwrap_or(0)))
}

/// Every submodule of the repository at `git`, in `.gitmodules` order.
pub async fn list(git: &Git) -> Result<Vec<Submodule>> {
    let decl = declared(git).await?;
    if decl.is_empty() {
        return Ok(Vec::new());
    }
    let paths: Vec<&str> = decl.iter().filter_map(|(_, d)| d.path.as_deref()).collect();
    let (index, head, urls, origin) = tokio::join!(index_links(git, &paths), head_links(git, &paths), local_urls(git), git.remote_url("origin"));
    let (index, head, urls, origin) = (&index?, &head, &urls, &origin.ok().flatten());
    let root = git.cwd();
    Ok(stream::iter(decl)
        .map(|(name, d)| async move {
            let path = d.path.unwrap_or_default();
            let link = index.get(&path);
            let recorded = link.map(|(sha, _)| sha.clone());
            let dir = root.join(&path);
            let local_url = urls.get(&name).cloned();
            let url = d.url.unwrap_or_default();
            let absolute = match (&local_url, origin) {
                (Some(l), _) => Some(l.clone()),
                (None, Some(o)) if url.starts_with("./") || url.starts_with("../") => Some(resolve_url(o, &url)),
                _ => Some(url.clone()),
            };
            let mut s = Submodule {
                web_url: absolute.as_deref().and_then(web_url),
                url_drift: local_url.as_deref().is_some_and(|l| !same_url(l, &url)),
                local_url,
                staged: matches!((&recorded, head.get(&path)), (Some(a), Some(b)) if a != b) || (recorded.is_some() && !head.contains_key(&path)),
                name,
                url,
                branch: d.branch,
                state: SubmoduleState::Clean,
                recorded,
                head: None,
                head_branch: None,
                subject: None,
                author: None,
                date: None,
                dirty: 0,
                ahead: 0,
                behind: 0,
                upstream: None,
                upstream_behind: 0,
                path,
            };
            if link.is_none() {
                s.state = SubmoduleState::Missing;
            } else if link.is_some_and(|(_, stage)| *stage != 0) {
                s.state = SubmoduleState::Conflict;
            }
            if !dir.join(".git").exists() {
                if s.state == SubmoduleState::Clean {
                    s.state = SubmoduleState::Uninitialized;
                }
                return s;
            }
            inspect(&mut s, &Git::new(&dir)).await;
            s
        })
        .buffered(6)
        .collect()
        .await)
}

/// Fill in what is checked out in an initialized submodule.
async fn inspect(s: &mut Submodule, sub: &Git) {
    let (log, branch, status) = tokio::join!(
        sub.try_run(&["log", "-1", "--format=%H%x1f%s%x1f%an%x1f%cI"]),
        sub.current_branch(),
        sub.try_run(&["status", "--porcelain=v1", "-z"]),
    );
    if let Ok((true, out, _)) = log {
        let f: Vec<&str> = out.trim_end().splitn(4, '\x1f').collect();
        if f.len() == 4 {
            s.head = Some(f[0].into());
            s.subject = Some(f[1].into());
            s.author = Some(f[2].into());
            s.date = Some(f[3].into());
        }
    }
    s.head_branch = branch.ok().flatten();
    if let Ok((true, out, _)) = status {
        s.dirty = parse_status_z(&out).len() as u32;
    }
    let Some(head) = s.head.clone() else { return };
    if let Some(rec) = &s.recorded {
        if rec != &head {
            if s.state == SubmoduleState::Clean {
                s.state = SubmoduleState::Moved;
            }
            if let Some((behind, ahead)) = count(sub, &format!("{rec}...{head}")).await {
                (s.ahead, s.behind) = (ahead, behind);
            }
        }
    }
    let branch = match &s.branch {
        Some(b) => b.clone(),
        None => sub.default_branch().await.unwrap_or_else(|_| "main".into()),
    };
    let upstream = format!("origin/{branch}");
    if sub.ref_exists(&format!("refs/remotes/{upstream}")).await.unwrap_or(false) {
        s.upstream_behind = count(sub, &format!("{head}...{upstream}")).await.map_or(0, |(_, r)| r);
        s.upstream = Some(upstream);
    }
}

/// A path inside the repository: relative, no `..`.
pub fn check_path(path: &str) -> Result<&str> {
    let path = path.trim().trim_end_matches('/');
    let ok = !path.is_empty() && Path::new(path).components().all(|c| matches!(c, Component::Normal(_)));
    if ok {
        Ok(path)
    } else {
        Err(Error::Invalid(format!("{path:?} is not a folder inside the project.")))
    }
}

/// Folder a URL clones into by default: its last segment without `.git`.
pub fn default_path(url: &str) -> String {
    let last = url.trim_end_matches('/').rsplit(['/', ':', '\\']).next().unwrap_or("");
    last.strip_suffix(".git").unwrap_or(last).to_string()
}

/// `git submodule add`, then clone what it nests.
pub async fn add(git: &Git, url: &str, path: &str, branch: Option<&str>) -> Result<String> {
    let mut args = vec!["submodule", "add"];
    if let Some(b) = branch {
        args.extend(["-b", b]);
    }
    args.extend(["--", url, path]);
    let mut out = git.run(&args).await?;
    out += &update(git, Some(path), false).await?;
    Ok(out.trim().to_string())
}

/// Check out the recorded commit (or, with `remote`, the tip of the tracked branch),
/// cloning what is missing, nested submodules included. `path` None = all.
pub async fn update(git: &Git, path: Option<&str>, remote: bool) -> Result<String> {
    let mut args = vec!["submodule", "update", "--init", "--recursive", "--jobs", "4"];
    if remote {
        args.push("--remote");
    }
    if let Some(p) = path {
        args.extend(["--", p]);
    }
    let (ok, out, err) = git.try_run(&args).await?;
    if !ok {
        return Err(Error::Git { cmd: "submodule".into(), stderr: err.trim().into() });
    }
    Ok(format!("{out}{err}"))
}

/// Copy the URLs from `.gitmodules` into the local clones. `path` None = all.
pub async fn sync(git: &Git, path: Option<&str>) -> Result<String> {
    let mut args = vec!["submodule", "sync", "--recursive"];
    if let Some(p) = path {
        args.extend(["--", p]);
    }
    Ok(git.run(&args).await?.trim().to_string())
}

/// Change the URL and/or tracked branch in `.gitmodules` (empty branch = the remote's default).
pub async fn set(git: &Git, path: &str, url: Option<&str>, branch: Option<&str>) -> Result<()> {
    if let Some(u) = url {
        // Also syncs the local clone.
        git.run(&["submodule", "set-url", "--", path, u]).await?;
    }
    match branch {
        Some("") => git.run(&["submodule", "set-branch", "--default", "--", path]).await.map(|_| ())?,
        Some(b) => git.run(&["submodule", "set-branch", "--branch", b, "--", path]).await.map(|_| ())?,
        None => {}
    }
    Ok(())
}

/// Remove a submodule: unregister it, delete its folder and pointer, and its clone under `.git/modules`.
/// The removal is staged, ready to commit.
pub async fn remove(git: &Git, s: &Submodule) -> Result<()> {
    let (name, path) = (s.name.as_str(), s.path.as_str());
    // Fails on a submodule that was never initialized: nothing to deinit then.
    let _ = git.try_run(&["submodule", "deinit", "-f", "--", path]).await?;
    // Only in `.gitmodules`: no pointer to remove, and its folder (if any) is not ours to delete.
    if s.state != SubmoduleState::Missing {
        git.run(&["rm", "-f", "--", path]).await?;
    }
    // `git rm` keeps an empty section behind when nothing references the name anymore.
    let _ = git.try_run(&["config", "-f", ".gitmodules", "--remove-section", &format!("submodule.{name}")]).await;
    let _ = git.try_run(&["add", "--", ".gitmodules"]).await;
    if let Some(dir) = git.git_paths(&[&format!("modules/{name}")]).await?.pop() {
        if dir.exists() {
            tokio::fs::remove_dir_all(&dir).await?;
        }
    }
    Ok(())
}

/// Fetch every initialized submodule so their "behind remote" counts are fresh.
pub async fn fetch(git: &Git, subs: &[Submodule]) -> FetchReport {
    // Owned paths: a stream borrowing `subs` trips the Send check of the HTTP handler.
    let paths: Vec<String> = subs.iter().filter(|s| s.head.is_some()).map(|s| s.path.clone()).collect();
    let root = git.cwd();
    let results: Vec<(String, Result<()>)> = stream::iter(paths)
        .map(|path| async move {
            let r = Git::new(root.join(&path)).run(&["fetch", "--quiet", "origin"]).await.map(|_| ());
            (path, r)
        })
        .buffer_unordered(6)
        .collect()
        .await;
    let mut r = FetchReport::default();
    for (path, res) in results {
        match res {
            Ok(()) => r.fetched += 1,
            Err(e) => r.failed.push(format!("{path}: {e}")),
        }
    }
    r.failed.sort();
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_paths() {
        assert_eq!(default_path("https://github.com/acme/ui-kit.git"), "ui-kit");
        assert_eq!(default_path("git@github.com:acme/ui-kit.git"), "ui-kit");
        assert_eq!(default_path("git@host:kit"), "kit");
        assert_eq!(default_path("../shared/"), "shared");
    }

    #[test]
    fn web_urls() {
        assert_eq!(web_url("git@github.com:acme/ui-kit.git").unwrap(), "https://github.com/acme/ui-kit");
        assert_eq!(web_url("https://gitlab.com/acme/web/ui-kit.git").unwrap(), "https://gitlab.com/acme/web/ui-kit");
        assert_eq!(web_url("git@ssh.dev.azure.com:v3/acme/Shop/ui-kit").unwrap(), "https://dev.azure.com/acme/Shop/_git/ui-kit");
        assert_eq!(web_url("/work/ui-kit"), None);
        assert_eq!(web_url("../ui-kit"), None);
    }

    #[test]
    fn relative_urls() {
        assert_eq!(resolve_url("git@github.com:acme/shop.git", "../ui-kit.git"), "git@github.com:acme/ui-kit.git");
        assert_eq!(resolve_url("https://github.com/acme/shop", "../../other/kit"), "https://github.com/other/kit");
        assert_eq!(resolve_url("git@host:shop.git", "../kit"), "git@host:kit");
        assert_eq!(resolve_url("https://h/acme/shop", "./kit"), "https://h/acme/shop/kit");
    }

    #[test]
    fn url_drift() {
        assert!(same_url("/work/ui-kit", "../ui-kit"));
        assert!(same_url("git@github.com:acme/ui-kit.git", "../ui-kit.git"));
        assert!(same_url("https://h/acme/ui-kit", "https://h/acme/ui-kit.git"));
        assert!(!same_url("/work/old-kit", "../ui-kit"));
        assert!(!same_url("https://h/acme/old", "https://h/acme/new"));
    }

    #[test]
    fn paths_stay_inside() {
        assert_eq!(check_path("libs/kit/").unwrap(), "libs/kit");
        assert!(check_path("../kit").is_err());
        assert!(check_path("/abs").is_err());
        assert!(check_path("a/../b").is_err());
        assert!(check_path("  ").is_err());
    }
}
