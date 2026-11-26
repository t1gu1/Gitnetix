use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("git {cmd} failed: {stderr}")]
    Git { cmd: String, stderr: String },
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("not connected: {0}")]
    NotConnected(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("http error: {0}")]
    Http(String),
    #[error("ai error: {0}")]
    Ai(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// GitHub refused a push to origin: the user can't write to `repo` (owner/repo), which they can fork instead.
    #[error("You can't push to {repo} on GitHub. Fork it to push your commits to your own copy.")]
    NoPushAccess { repo: String },
    /// A folder added as a project that holds no Git repository (its path): the app offers to create one there.
    #[error("{0} is not a Git repository")]
    NotRepo(String),
    /// Uncommitted changes a checkout would overwrite: git refused to switch.
    #[error("{0}")]
    WouldOverwrite(String),
    /// The Gitnetix server wants a plan (Pro or Team) for this: the app offers to subscribe.
    #[error("{0}")]
    Upgrade(String),
    /// The Gitnetix server refused a write made on top of something that changed since (`code`: version_conflict, stale_key...).
    #[error("{message}")]
    Conflict { code: String, message: String },
    #[error("{0}")]
    Other(String),
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Http(e.to_string())
    }
}

impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        Error::Other(e.to_string())
    }
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::Git { stderr, .. } if crate::git::login_host(stderr).is_some() => "git_login",
            Error::Git { .. } => "git",
            Error::NotFound(_) => "not_found",
            Error::Invalid(_) => "invalid",
            Error::NotConnected(_) => "not_connected",
            Error::Unsupported(_) => "unsupported",
            Error::Http(_) => "http",
            Error::Ai(_) => "ai",
            Error::Io(_) => "io",
            Error::Json(_) => "json",
            Error::NoPushAccess { .. } => "no_push_access",
            Error::NotRepo(_) => "not_repo",
            Error::WouldOverwrite(_) => "would_overwrite",
            Error::Upgrade(_) => "upgrade",
            Error::Conflict { .. } => "conflict",
            Error::Other(_) => "other",
        }
    }
}

/// Wire shape of an error, shared by the Tauri command and the HTTP API.
#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
    /// `git_login`: the HTTPS host git couldn't sign in to, for the app to ask the user for a login.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// `no_push_access`: the GitHub repository (owner/repo) the user can't push to, for the app to offer a fork.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// `not_repo`: the folder that holds no Git repository, for the app to offer to create one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl From<&Error> for ErrorBody {
    fn from(e: &Error) -> Self {
        let host = match e {
            Error::Git { stderr, .. } => crate::git::login_host(stderr),
            _ => None,
        };
        let repo = match e {
            Error::NoPushAccess { repo } => Some(repo.clone()),
            _ => None,
        };
        let path = match e {
            Error::NotRepo(path) => Some(path.clone()),
            _ => None,
        };
        ErrorBody { code: e.code(), message: e.to_string(), host, repo, path }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
