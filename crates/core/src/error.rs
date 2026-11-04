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
    /// Uncommitted changes a checkout would overwrite: git refused to switch.
    #[error("{0}")]
    WouldOverwrite(String),
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
            Error::WouldOverwrite(_) => "would_overwrite",
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
}

impl From<&Error> for ErrorBody {
    fn from(e: &Error) -> Self {
        let host = match e {
            Error::Git { stderr, .. } => crate::git::login_host(stderr),
            _ => None,
        };
        ErrorBody { code: e.code(), message: e.to_string(), host }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
