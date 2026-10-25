//! One RPC surface for every client: `call(method, params) -> JSON`.
//! The Tauri command, the companion HTTP API and the MCP bridge all go
//! through here, so an action added once is available everywhere.

use serde_json::{json, Value};

use crate::app::{Attachment, Gitnetix, MergeOptions, NewItem, NotesInclude, ViewMode};
use crate::error::{Error, Result};
use crate::store::{upsert, ConnectMethod, Connection, GitProfile, JiraConf, ReleaseKind, Route, TrelloConf, AsanaConf, new_id};
use crate::templates::{self, Template};
use crate::providers::github_auth::{self, Poll};
use crate::providers::azure_auth;
use crate::tickets::jira_auth;
use crate::{ai, secrets};

/// (method, description, params) — also the MCP tool list.
pub const METHODS: &[(&str, &str, &str)] = &[
    ("app.info", "App version and companion server address", ""),
    ("log.get", "Recent operations and errors, oldest first", ""),
    ("log.clear", "Empty the log", ""),
    ("config.get", "Full app configuration (no secrets)", ""),
    ("ui.set", "Save UI preferences", "language?, theme?, lastProject?, animationsOff?"),
    ("ui.setView", "Remember how a screen was left (pane width, collapsed section…); no value forgets it", "key, value?"),
    ("server.set", "Configure the companion API", "enabled?, lan?, port?, regenerateToken?"),
    ("projects.list", "List saved projects", ""),
    ("projects.add", "Add local Git repositories", "paths: string[]"),
    ("projects.remove", "Remove a project from the list (files untouched)", "projectId"),
    ("projects.setHidden", "Close or reopen a project's tab (data kept)", "projectId, hidden"),
    ("projects.reorder", "Set the order of projects", "ids: string[]"),
    ("projects.setGenLang", "Language AI writes in for a project", "projectId, commit?, pr?, release?"),
    ("projects.setPrefs", "Remembered merge, commit and dialog options for a project", "projectId, merge?: {squash?, squashMessage?: branch|ai, rebase?, deleteBranch?, push?, resolveConflicts?}, commit?: {autoPush?}, dialogs?: {finish?: continue|merge, finishSwitch?, newWorktree?, newAgent?, shipPush?, deleteOrigin?, cleanupOrigin?}"),
    ("projects.setProfile", "Git profile used for commits in a project", "projectId, profileId"),
    ("profiles.save", "Create or update a Git profile", "profile: {id?, label, name, email, sign, signingKey?}"),
    ("profiles.delete", "Delete a Git profile", "id"),
    ("workspace.overview", "Releases, their branches and repo state; `quick` skips history checks when nothing is cached", "projectId, quick?"),
    ("workspace.files", "Changed files of a branch, or of one commit when `commit` is given", "projectId, branch, mode: branch|wip|project, commit?"),
    ("workspace.diff", "Diff of one file; in wip mode `staged` picks the side; `commit` diffs that commit; `full` keeps the whole file", "projectId, branch, mode, path, staged?, commit?, full?"),
    ("workspace.blobs", "Old and new contents of one file, base64 (image previews); same picking as workspace.diff", "projectId, branch, mode, path, staged?, commit?"),
    ("workspace.commits", "Commits a branch has that its base does not (a trunk: recent history)", "projectId, branch"),
    ("commits.revert", "Revert a commit with a new commit on its branch", "projectId, branch, sha"),
    ("commits.cherryPick", "Copy a commit onto a checked-out branch", "projectId, onto, sha"),
    ("commits.reset", "Reset a checked-out branch to a commit", "projectId, branch, sha, mode: soft|mixed|hard"),
    ("workspace.switch", "Check out a branch (uncommitted work comes along); abort = first abort the rebase/merge/cherry-pick/revert the checkout is stopped in", "projectId, branch, abort?"),
    ("workspace.stage", "Stage files (all when paths is empty)", "projectId, branch, paths?"),
    ("workspace.unstage", "Unstage files (all when paths is empty)", "projectId, branch, paths?"),
    ("workspace.discard", "Discard staged or unstaged changes (all on that side when paths is empty)", "projectId, branch, staged, paths?"),
    ("workspace.ignore", "Add a file or folder (dir = true) to the checkout's root .gitignore", "projectId, branch, path, dir?"),
    ("workspace.commitMessage", "AI-written commit message for the staged changes", "projectId, branch"),
    ("workspace.commit", "Commit staged changes (all = stage everything first); empty message = AI writes it", "projectId, branch, message?, all?"),
    ("workspace.push", "Push a branch to origin; force = replace its upstream after a rebase (--force-with-lease --force-if-includes)", "projectId, branch, force?"),
    ("workspace.rebase", "Rebase a branch onto its release; returns conflicts, and forcePushTo when it was already pushed", "projectId, branch"),
    ("workspace.rebaseContinue", "Continue a paused rebase", "projectId, branch"),
    ("workspace.rebaseAbort", "Abort a paused rebase", "projectId, branch"),
    ("workspace.conflictPropose", "AI proposal for a conflicted file", "projectId, branch, path"),
    ("workspace.conflictApply", "Write and stage a resolved file", "projectId, branch, path, content"),
    ("releases.create", "Cut a release branch", "projectId, version, kind: next|hotfix, from?"),
    ("releases.suggestVersion", "Version for a new release: next = minor bump of the highest tag or release branch, hotfix = patch bump of the latest tag", "projectId, kind: next|hotfix"),
    ("releases.ship", "Fast-forward main to the release and tag it", "projectId, version, push?"),
    ("releases.delete", "Forget an open release (branch kept)", "projectId, version"),
    ("items.suggestName", "AI branch name for a feature or fix", "projectId, kind, description, ticket?"),
    ("items.create", "New feature/fix branch in a release, or off another branch or a tag (release empty, from = branch or tag)", "projectId, release?, from?, kind, description, branchName?, ticket?, where: switch|worktree, startAgent?, provider?, model?, effort?"),
    ("items.attach", "Attach an existing branch to a release", "projectId, branch, release, kind"),
    ("items.remove", "Remove a branch from its release", "projectId, branch, deleteBranch?"),
    ("branches.stash", "Stash a checked-out branch's uncommitted changes, untracked files included", "projectId, branch"),
    ("stashes.list", "Every stash of the project, newest first, with the branch it was made on", "projectId"),
    ("stashes.files", "Files a stash holds, untracked ones included", "projectId, sha"),
    ("stashes.diff", "Diff of one file of a stash; `full` keeps the whole file", "projectId, sha, path, full?"),
    ("stashes.blobs", "Old and new contents of one file of a stash, base64", "projectId, sha, path"),
    ("stashes.apply", "Apply a stash onto a checked-out branch; pop = drop it once applied cleanly (kept on conflicts, which are returned)", "projectId, branch, sha, pop?"),
    ("stashes.drop", "Delete a stash for good", "projectId, sha"),
    ("branches.pull", "Fast-forward a branch to its upstream (checked out or not)", "projectId, branch"),
    ("branches.tag", "Tag a branch's tip (annotated, message defaults to the name) and push it to origin", "projectId, branch, name, message?"),
    ("tags.checkout", "Check out a tag's commit (detached HEAD; uncommitted work comes along)", "projectId, name"),
    ("tags.delete", "Delete a tag, locally and on origin", "projectId, name"),
    ("branches.reset", "Hard-reset a branch to its upstream, dropping local commits (and uncommitted changes when checked out)", "projectId, branch"),
    ("branches.merge", "Merge a branch into its release (or parent branch, or `into`): a merge commit, or rebase = rebase it onto the target and fast-forward; squash = collapse its commits first (\"squash | <branch>\", or squashAi = AI writes the message); deleteBranch = delete it last, locally and on origin; push = push the target after; stay = don't switch the main checkout to the target", "projectId, branch, into?, deleteBranch?, squash?, squashAi?, rebase?, push?, stay?"),
    ("branches.sync", "Merge a branch's base into it to bring it up to date", "projectId, branch"),
    ("branches.setParent", "Choose what a branch merges into (an open release branch attaches it to that release; a release branch changes the branch it was cut from)", "projectId, branch, parent"),
    ("branches.fetch", "Fetch origin, pruning deleted branches", "projectId"),
    ("branches.cleanup", "Delete branches, skipping the ones that can't go; force = even if unmerged, remote = on origin too", "projectId, branches: string[], force?, remote?"),
    ("branches.delete", "Delete a local branch and its worktree; force = even if unmerged, remote = on origin too. Not the default or a host-protected branch", "projectId, branch, force?, remote?"),
    ("submodules.list", "Submodules of the project: URL, tracked branch, recorded vs checked-out commit, uncommitted files, commits behind its remote", "projectId"),
    ("submodules.add", "Add a submodule (path defaults to the URL's last segment) and clone it", "projectId, url, path?, branch?"),
    ("submodules.update", "Check out the recorded commit of one submodule (path) or all, cloning missing ones, nested included; remote = the tracked branch's tip instead", "projectId, path?, remote?"),
    ("submodules.sync", "Copy the URLs from .gitmodules into the local clones of one submodule or all", "projectId, path?"),
    ("submodules.set", "Change a submodule's URL and/or tracked branch (empty branch = the remote's default)", "projectId, path, url?, branch?"),
    ("submodules.stage", "Stage the commit checked out in a submodule as its new pin", "projectId, path"),
    ("submodules.remove", "Remove a submodule: deinit, delete its folder and clone; the removal is staged", "projectId, path"),
    ("submodules.fetch", "Fetch every initialized submodule's origin", "projectId"),
    ("worktrees.list", "Every worktree across projects with its agent", ""),
    ("worktrees.create", "Open a branch in a new worktree", "projectId, branch"),
    ("worktrees.remove", "Remove a worktree", "projectId, path, force?"),
    ("agents.list", "Agent sessions", ""),
    ("agents.get", "One agent session with its log", "id"),
    ("agents.start", "Start an agent on a branch (or main checkout)", "projectId, branch?, request, ticket?, provider?, model?, effort?, files?"),
    ("agents.message", "Send a follow-up message to an agent; files: [{ name, data (base64) | path }]", "id, text, files?"),
    ("agents.pause", "Pause an agent", "id"),
    ("agents.resume", "Resume an agent", "id"),
    ("agents.stop", "Stop an agent", "id"),
    ("agents.remove", "Delete an agent session", "id"),
    ("shell.open", "Terminal of a checkout (main checkout or worktree) of the project: starts its shell if needed, returns recent output", "projectId, path, cols, rows"),
    ("shell.write", "Type into a checkout's terminal", "path, data"),
    ("shell.resize", "Resize a checkout's terminal", "path, cols, rows"),
    ("ai.catalog", "AI providers, their status and settings", ""),
    ("ai.saveProvider", "Configure an AI provider", "id, method?, model?, effort?, baseUrl?, apiKey?"),
    ("ai.setDefault", "Default AI provider", "id"),
    ("ai.test", "Test an AI provider", "id"),
    ("ai.setRoute", "Which AI handles a task", "task, provider?, model?, effort?"),
    ("ai.signIn", "Open the provider CLI to sign in", "id"),
    ("templates.list", "AI templates", ""),
    ("templates.save", "Create or update a template", "template"),
    ("templates.delete", "Delete a template", "id"),
    ("templates.setDefault", "Make a template the default for its kind", "id"),
    ("templates.preview", "Run a template on real project data", "projectId, id, language"),
    ("prs.list", "Pull requests of the project", "projectId"),
    ("prs.get", "Pull request details, checks, reviews and conversations", "projectId, number"),
    ("prs.generate", "AI title and description for a branch", "projectId, branch"),
    ("prs.create", "Push and open a PR from a branch", "projectId, branch, draft?, title?, body?"),
    ("prs.update", "Edit PR title and description", "projectId, number, title, body"),
    ("prs.merge", "Merge a PR", "projectId, number, method?"),
    ("prs.close", "Close (abandon) a PR without merging, or reopen it; deleteBranch = also delete its branch, local and on origin, even if unmerged", "projectId, number, reopen?, deleteBranch? (head branch name)"),
    ("prs.review", "Submit a review", "projectId, number, vote: approve|changes|comment, body?"),
    ("prs.comment", "Comment on a PR", "projectId, number, body"),
    ("prs.editComment", "Edit the text of a comment or review summary", "projectId, commentId (node id), body"),
    ("prs.reply", "Reply in a review thread", "projectId, number, commentId, body"),
    ("prs.resolve", "Resolve or reopen a review thread", "projectId, threadId, resolved"),
    ("prs.react", "Add or remove a reaction", "projectId, subjectId, content, add"),
    ("prs.draftReply", "AI-drafted reply for a thread; with draft, that started reply polished instead (editing = id of the comment it rewrites)", "projectId, number, threadId, draft?, editing?"),
    ("prs.draftReview", "AI-drafted review summary", "projectId, number"),
    ("tickets.list", "Tickets from Jira, Trello, Asana with their release; mine = only the user's Jira tickets, sprint = only Jira tickets in an open sprint", "projectId, mine?, sprint?"),
    ("tickets.get", "One ticket with its full description, by key or by the branch linked to it; null when none", "projectId, key? | branch?"),
    ("tickets.setRelease", "Plan a ticket into a release", "projectId, key, release"),
    ("tickets.triage", "AI suggestions for unplanned tickets", "projectId"),
    ("tickets.statuses", "Statuses a ticket can move to (Jira transitions, Trello lists, Asana sections)", "source, conn, id"),
    ("tickets.setStatus", "Move a ticket to one of tickets.statuses", "source, conn, id, to"),
    ("jira.versions", "Versions a Jira ticket's fix version can be set to", "id (connection), key"),
    ("jira.setFixVersions", "Set a Jira ticket's fix versions to exactly these version ids; empty clears them", "id (connection), key, versions"),
    ("integrations.save", "Connect GitHub, Azure DevOps (token = personal access token, config.org), Jira, Trello or Asana; a Jira, Trello or Asana config without id adds a connection", "kind, config?, token?"),
    ("integrations.checkJira", "Sign in to a Jira connection with its saved token; the user's name, or an error", "id"),
    ("jira.projects", "The Jira projects a connection can see", "id"),
    ("jira.signInStart", "Start \"Sign in with Atlassian\": the URL to open in the browser", ""),
    ("jira.signInFinish", "Wait for the browser sign-in to finish; done = Jira connected", ""),
    ("github.signInStart", "Start \"Sign in with GitHub\": a code for the user to enter at verificationUri", ""),
    ("github.signInPoll", "Check whether the user entered the code; done = token stored and GitHub connected", "deviceCode"),
    ("azure.signInStart", "Start \"Sign in with Azure DevOps\": a code for the user to enter at verificationUri", ""),
    ("azure.signInPoll", "Check whether the user entered the code; done = tokens stored and Azure DevOps connected", "deviceCode"),
    ("integrations.disconnect", "Disconnect an integration (id = which Jira, Trello or Asana connection)", "kind, id?"),
    ("notes.refs", "Tags and branches for a notes range", "projectId"),
    ("notes.range", "Commit, branch and ticket counts in a range", "projectId, from, to"),
    ("notes.generate", "AI release notes", "projectId, from, to, templateId?, language, include"),
    ("notes.changelog", "Prepend notes to CHANGELOG.md", "projectId, markdown"),
    ("changelog.update", "AI adds what a branch changes to the Unreleased section of its CHANGELOG.md and commits it on the branch", "projectId, branch"),
    ("changelog.release", "Move the Unreleased section of an open release's CHANGELOG.md into its version and commit it on the release branch", "projectId, version"),
    ("notes.publish", "Publish a GitHub release", "projectId, tag, target, name, body"),
    ("analytics.get", "Activity and release stats", "projectIds (empty = all) or projectId (or \"all\"), days"),
];

fn s(v: &Value, k: &str) -> Result<String> {
    v.get(k)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| Error::Invalid(format!("missing `{k}`")))
}

/// `cur` with the fields given in `patch` replaced.
fn overlay<T: serde::Serialize + serde::de::DeserializeOwned>(cur: &T, patch: &Value) -> Result<T> {
    let mut v = serde_json::to_value(cur)?;
    if let (Some(obj), Some(p)) = (v.as_object_mut(), patch.as_object()) {
        for (k, x) in p {
            obj.insert(k.clone(), x.clone());
        }
    }
    Ok(serde_json::from_value(v)?)
}

fn os(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(String::from)
}

/// Workspace view mode; defaults to "branch".
fn mode(v: &Value) -> Result<ViewMode> {
    os(v, "mode").as_deref().unwrap_or("branch").parse()
}

/// Release kind; anything but "hotfix" is the next release.
fn release_kind(v: &Value) -> ReleaseKind {
    if os(v, "kind").as_deref() == Some("hotfix") { ReleaseKind::Hotfix } else { ReleaseKind::Next }
}

/// String list at `k`, empty when missing.
fn list(v: &Value, k: &str) -> Result<Vec<String>> {
    Ok(serde_json::from_value(v.get(k).cloned().unwrap_or(json!([])))?)
}

/// Files sent with an agent message, empty when missing.
fn files(v: &Value) -> Result<Vec<Attachment>> {
    Ok(serde_json::from_value(v.get("files").cloned().unwrap_or(json!([])))?)
}

fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

fn u(v: &Value, k: &str) -> Result<u64> {
    v.get(k).and_then(Value::as_u64).ok_or_else(|| Error::Invalid(format!("missing `{k}`")))
}

fn ok() -> Result<Value> {
    Ok(json!({ "ok": true }))
}

fn to<T: serde::Serialize>(t: T) -> Result<Value> {
    Ok(serde_json::to_value(t)?)
}

/// The Jira connection named by `id` ("" = the one from before there could be several).
fn jira_conn(k: &Gitnetix, p: &Value) -> Result<JiraConf> {
    let id = os(p, "id").unwrap_or_default();
    k.store.read(|c| c.integrations.jira.iter().find(|j| j.id == id).cloned()).ok_or_else(|| Error::NotConnected("Jira".into()))
}

/// The Atlassian sign-in is shared by every OAuth connection; drop it once none is left.
fn drop_unused_atlassian_sign_in(k: &Gitnetix) -> Result<()> {
    if !k.store.read(|c| c.integrations.jira.iter().any(|j| j.cloud_id.is_some())) {
        secrets::delete(jira_auth::KEY)?;
    }
    Ok(())
}

/// Reads polled all the time: logged only when they fail.
const QUIET: &[&str] = &[".info", ".get", ".list", ".overview", ".files", ".diff", ".blobs", ".commits", ".catalog", ".statuses", ".versions", ".projects", ".refs", ".range", ".preview", ".clear", "shell.write", "shell.resize", "ui.setView", "github.signInPoll", "azure.signInPoll"];

/// Run `method`, logging what it will attempt and how it ended.
pub async fn call(k: &Gitnetix, method: &str, p: Value) -> Result<Value> {
    let quiet = QUIET.iter().any(|q| method.ends_with(q));
    if !quiet {
        crate::log::info(format!("Will attempt to {method} {}", scrub(&p, "")));
    }
    let start = std::time::Instant::now();
    let out = dispatch(k, method, p).await;
    let ms = start.elapsed().as_millis();
    match &out {
        Ok(_) if !quiet => crate::log::info(format!("Done {method} in {ms}ms")),
        Err(e) => crate::log::error(format!("{method} failed after {ms}ms: {e}")),
        _ => {}
    }
    out
}

/// Params as logged: secrets hidden, long text cut.
fn scrub(v: &Value, key: &str) -> Value {
    let k = key.to_ascii_lowercase();
    if ["token", "secret", "password", "key"].iter().any(|s| k.contains(s)) {
        return json!("***");
    }
    match v {
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), scrub(v, k))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(|v| scrub(v, key)).collect()),
        Value::String(s) if s.chars().count() > 120 => json!(format!("{}…", s.chars().take(120).collect::<String>())),
        _ => v.clone(),
    }
}

async fn dispatch(k: &Gitnetix, method: &str, p: Value) -> Result<Value> {
    let p = if p.is_null() { json!({}) } else { p };
    match method {
        "log.get" => to(crate::log::all()),
        "log.clear" => {
            crate::log::clear();
            ok()
        }
        "app.info" => {
            let server = k.store.read(|c| c.server.clone());
            to(json!({
                "version": env!("CARGO_PKG_VERSION"),
                "os": std::env::consts::OS,
                "server": { "enabled": server.enabled, "port": server.port, "lan": server.lan },
                "dataDir": k.dir.to_string_lossy(),
            }))
        }
        "config.get" => to(k.store.snapshot()),
        "ui.set" => {
            k.store.write(|c| {
                if let Some(x) = os(&p, "language") {
                    c.ui.language = x;
                }
                if let Some(x) = os(&p, "theme") {
                    c.ui.theme = x;
                }
                if let Some(x) = os(&p, "lastProject") {
                    c.ui.last_project = Some(x);
                }
                if let Some(x) = p.get("animationsOff").and_then(Value::as_array) {
                    c.ui.animations_off = x.iter().filter_map(|v| v.as_str().map(String::from)).collect();
                }
                Ok(())
            })?;
            ok()
        }
        "ui.setView" => {
            let key = s(&p, "key")?;
            let value = os(&p, "value");
            k.store.write(|c| {
                match value {
                    Some(v) => c.ui.view.insert(key, v),
                    None => c.ui.view.remove(&key),
                };
                Ok(())
            })?;
            ok()
        }
        "server.set" => {
            let cfg = k.store.write(|c| {
                if let Some(x) = p.get("enabled").and_then(Value::as_bool) {
                    c.server.enabled = x;
                }
                if let Some(x) = p.get("lan").and_then(Value::as_bool) {
                    c.server.lan = x;
                }
                if let Some(x) = p.get("port").and_then(Value::as_u64) {
                    c.server.port = x as u16;
                }
                if b(&p, "regenerateToken") {
                    c.server.token = crate::store::new_token();
                }
                Ok(c.server.clone())
            })?;
            to(json!({ "server": cfg, "restartRequired": true }))
        }

        // ---- projects & profiles ----
        "projects.list" => to(k.projects().await),
        "projects.add" => {
            let paths = list(&p, "paths")?;
            to(k.add_projects(paths).await?)
        }
        "projects.remove" => {
            k.remove_project(&s(&p, "projectId")?)?;
            ok()
        }
        "projects.setHidden" => {
            let hidden = p.get("hidden").and_then(|v| v.as_bool()).unwrap_or(true);
            k.set_project_hidden(&s(&p, "projectId")?, hidden)?;
            ok()
        }
        "projects.reorder" => {
            let ids = list(&p, "ids")?;
            k.reorder_projects(&ids)?;
            ok()
        }
        "projects.setGenLang" => {
            k.store.with_project(&s(&p, "projectId")?, |pr| {
                if let Some(x) = os(&p, "commit") {
                    pr.gen_lang.commit = x;
                }
                if let Some(x) = os(&p, "pr") {
                    pr.gen_lang.pr = x;
                }
                if let Some(x) = os(&p, "release") {
                    pr.gen_lang.release = x;
                }
                Ok(())
            })?;
            ok()
        }
        "projects.setPrefs" => {
            k.store.with_project(&s(&p, "projectId")?, |pr| {
                if let Some(m) = p.get("merge") {
                    pr.merge = overlay(&pr.merge, m)?;
                }
                if let Some(c) = p.get("commit") {
                    pr.commit = overlay(&pr.commit, c)?;
                }
                if let Some(d) = p.get("dialogs") {
                    pr.dialogs = overlay(&pr.dialogs, d)?;
                }
                Ok(())
            })?;
            ok()
        }
        "projects.setProfile" => {
            let pid = os(&p, "profileId");
            k.store.with_project(&s(&p, "projectId")?, |pr| {
                pr.profile_id = pid;
                Ok(())
            })?;
            ok()
        }
        "profiles.save" => {
            let mut prof: GitProfile = serde_json::from_value(p.get("profile").cloned().unwrap_or_default())?;
            if prof.email.trim().is_empty() {
                return Err(Error::Invalid("Email is required".into()));
            }
            if prof.id.is_empty() {
                prof.id = new_id();
            }
            let saved = prof.clone();
            k.store.write(|c| {
                match c.profiles.iter_mut().find(|x| x.id == prof.id) {
                    Some(x) => *x = prof,
                    None => c.profiles.push(prof),
                }
                Ok(())
            })?;
            to(saved)
        }
        "profiles.delete" => {
            let id = s(&p, "id")?;
            k.store.write(|c| {
                c.profiles.retain(|x| x.id != id);
                for pr in c.projects.iter_mut() {
                    if pr.profile_id.as_deref() == Some(id.as_str()) {
                        pr.profile_id = None;
                    }
                }
                Ok(())
            })?;
            ok()
        }

        // ---- workspace ----
        "workspace.overview" => to(k.overview(&s(&p, "projectId")?, b(&p, "quick")).await?),
        "workspace.files" => match os(&p, "commit") {
            Some(sha) => to(k.commit_files(&s(&p, "projectId")?, &sha).await?),
            None => to(k.files(&s(&p, "projectId")?, &s(&p, "branch")?, mode(&p)?).await?),
        },
        "workspace.diff" => match os(&p, "commit") {
            Some(sha) => to(k.commit_diff(&s(&p, "projectId")?, &sha, &s(&p, "path")?, b(&p, "full")).await?),
            None => to(k.diff(&s(&p, "projectId")?, &s(&p, "branch")?, mode(&p)?, &s(&p, "path")?, p.get("staged").and_then(Value::as_bool), b(&p, "full")).await?),
        },
        "workspace.blobs" => match os(&p, "commit") {
            Some(sha) => to(k.commit_blobs(&s(&p, "projectId")?, &sha, &s(&p, "path")?).await?),
            None => to(k.blobs(&s(&p, "projectId")?, &s(&p, "branch")?, mode(&p)?, &s(&p, "path")?, p.get("staged").and_then(Value::as_bool)).await?),
        },
        "workspace.commits" => to(k.commits(&s(&p, "projectId")?, &s(&p, "branch")?).await?),
        "commits.revert" => to(json!({ "sha": k.revert_commit(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "sha")?).await? })),
        "commits.cherryPick" => to(json!({ "sha": k.cherry_pick(&s(&p, "projectId")?, &s(&p, "onto")?, &s(&p, "sha")?).await? })),
        "commits.reset" => {
            k.reset_branch(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "sha")?, &s(&p, "mode")?).await?;
            ok()
        }
        "workspace.switch" => {
            k.switch_branch(&s(&p, "projectId")?, &s(&p, "branch")?, b(&p, "abort")).await?;
            ok()
        }
        "workspace.commitMessage" => to(json!({ "message": k.generate_commit_message(&s(&p, "projectId")?, &s(&p, "branch")?).await? })),
        "workspace.stage" => {
            k.stage(&s(&p, "projectId")?, &s(&p, "branch")?, &list(&p, "paths")?).await?;
            ok()
        }
        "workspace.unstage" => {
            k.unstage(&s(&p, "projectId")?, &s(&p, "branch")?, &list(&p, "paths")?).await?;
            ok()
        }
        "workspace.discard" => {
            k.discard(&s(&p, "projectId")?, &s(&p, "branch")?, b(&p, "staged"), &list(&p, "paths")?).await?;
            ok()
        }
        "workspace.ignore" => {
            k.ignore(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "path")?, b(&p, "dir")).await?;
            ok()
        }
        "workspace.commit" => to(k.commit(&s(&p, "projectId")?, &s(&p, "branch")?, os(&p, "message"), b(&p, "all")).await?),
        "workspace.push" => to(json!({ "output": k.push(&s(&p, "projectId")?, &s(&p, "branch")?, b(&p, "force")).await? })),
        "workspace.rebase" => to(k.rebase(&s(&p, "projectId")?, &s(&p, "branch")?).await?),
        "workspace.rebaseContinue" => to(k.rebase_continue(&s(&p, "projectId")?, &s(&p, "branch")?).await?),
        "workspace.rebaseAbort" => {
            k.rebase_abort(&s(&p, "projectId")?, &s(&p, "branch")?).await?;
            ok()
        }
        "workspace.conflictPropose" => to(json!({ "content": k.conflict_propose(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "path")?).await? })),
        "workspace.conflictApply" => {
            k.conflict_apply(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "path")?, &s(&p, "content")?).await?;
            ok()
        }

        // ---- releases & items ----
        "releases.create" => {
            to(k.create_release(&s(&p, "projectId")?, &s(&p, "version")?, release_kind(&p), os(&p, "from")).await?)
        }
        "releases.suggestVersion" => to(json!({ "version": k.suggest_version(&s(&p, "projectId")?, release_kind(&p)).await? })),
        "releases.ship" => to(json!({ "tag": k.ship_release(&s(&p, "projectId")?, &s(&p, "version")?, b(&p, "push")).await? })),
        "releases.delete" => {
            k.delete_release(&s(&p, "projectId")?, &s(&p, "version")?)?;
            ok()
        }
        "items.suggestName" => {
            let (name, ai) = k
                .suggest_branch_name(&s(&p, "projectId")?, &os(&p, "kind").unwrap_or_else(|| "feat".into()), &s(&p, "description")?, os(&p, "ticket").as_deref())
                .await?;
            to(json!({ "name": name, "ai": ai }))
        }
        "items.create" => {
            let req: NewItem = serde_json::from_value(p.clone())?;
            to(k.create_item(&s(&p, "projectId")?, req).await?)
        }
        "items.attach" => {
            k.attach_branch(&s(&p, "projectId")?, &s(&p, "branch")?, os(&p, "release"), &os(&p, "kind").unwrap_or_default())?;
            ok()
        }
        "items.remove" => {
            k.remove_item(&s(&p, "projectId")?, &s(&p, "branch")?, b(&p, "deleteBranch")).await?;
            ok()
        }
        "branches.stash" => {
            k.stash_branch(&s(&p, "projectId")?, &s(&p, "branch")?).await?;
            ok()
        }
        "stashes.list" => to(k.stashes(&s(&p, "projectId")?).await?),
        "stashes.files" => to(k.stash_files(&s(&p, "projectId")?, &s(&p, "sha")?).await?),
        "stashes.blobs" => to(k.stash_blobs(&s(&p, "projectId")?, &s(&p, "sha")?, &s(&p, "path")?).await?),
        "stashes.diff" => to(k.stash_diff(&s(&p, "projectId")?, &s(&p, "sha")?, &s(&p, "path")?, b(&p, "full")).await?),
        "stashes.apply" => to(k.apply_stash(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "sha")?, b(&p, "pop")).await?),
        "stashes.drop" => {
            k.drop_stash(&s(&p, "projectId")?, &s(&p, "sha")?).await?;
            ok()
        }
        "branches.pull" => to(json!({ "output": k.pull_branch(&s(&p, "projectId")?, &s(&p, "branch")?).await? })),
        "branches.tag" => {
            k.tag_branch(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "name")?, os(&p, "message").as_deref()).await?;
            ok()
        }
        "tags.checkout" => {
            k.checkout_tag(&s(&p, "projectId")?, &s(&p, "name")?).await?;
            ok()
        }
        "tags.delete" => {
            k.delete_tag(&s(&p, "projectId")?, &s(&p, "name")?).await?;
            ok()
        }
        "branches.reset" => {
            k.reset_to_upstream(&s(&p, "projectId")?, &s(&p, "branch")?).await?;
            ok()
        }
        "branches.merge" => {
            let opts = MergeOptions { squash: b(&p, "squash"), squash_ai: b(&p, "squashAi"), rebase: b(&p, "rebase"), delete_after: b(&p, "deleteBranch"), push: b(&p, "push"), stay: b(&p, "stay") };
            to(k.merge_branch(&s(&p, "projectId")?, &s(&p, "branch")?, os(&p, "into").as_deref(), opts).await?)
        }
        "branches.sync" => to(k.sync_branch(&s(&p, "projectId")?, &s(&p, "branch")?).await?),
        "branches.setParent" => {
            k.set_parent(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "parent")?)?;
            ok()
        }
        "branches.fetch" => {
            k.fetch(&s(&p, "projectId")?).await?;
            ok()
        }
        "branches.cleanup" => {
            let branches = list(&p, "branches")?;
            to(k.cleanup_branches(&s(&p, "projectId")?, &branches, b(&p, "force"), b(&p, "remote")).await?)
        }
        "branches.delete" => {
            k.delete_branch(&s(&p, "projectId")?, &s(&p, "branch")?, b(&p, "force"), b(&p, "remote")).await?;
            ok()
        }

        // ---- submodules ----
        "submodules.list" => to(k.submodules(&s(&p, "projectId")?).await?),
        "submodules.add" => to(json!({ "output": k.add_submodule(&s(&p, "projectId")?, &s(&p, "url")?, os(&p, "path").as_deref(), os(&p, "branch").as_deref()).await? })),
        "submodules.update" => to(json!({ "output": k.update_submodules(&s(&p, "projectId")?, os(&p, "path").as_deref(), b(&p, "remote")).await? })),
        "submodules.sync" => to(json!({ "output": k.sync_submodules(&s(&p, "projectId")?, os(&p, "path").as_deref()).await? })),
        "submodules.set" => {
            k.set_submodule(&s(&p, "projectId")?, &s(&p, "path")?, os(&p, "url").as_deref(), os(&p, "branch").as_deref()).await?;
            ok()
        }
        "submodules.stage" => {
            k.stage_submodule(&s(&p, "projectId")?, &s(&p, "path")?).await?;
            ok()
        }
        "submodules.remove" => {
            k.remove_submodule(&s(&p, "projectId")?, &s(&p, "path")?).await?;
            ok()
        }
        "submodules.fetch" => to(k.fetch_submodules(&s(&p, "projectId")?).await?),

        // ---- worktrees & agents ----
        "worktrees.list" => to(k.worktrees().await?),
        "worktrees.create" => to(json!({ "path": k.create_worktree(&s(&p, "projectId")?, &s(&p, "branch")?).await? })),
        "worktrees.remove" => {
            k.remove_worktree(&s(&p, "projectId")?, &s(&p, "path")?, b(&p, "force")).await?;
            ok()
        }
        "agents.list" => to(k.agents.list()),
        "agents.get" => to(k.agents.get(&s(&p, "id")?)?),
        "agents.start" => {
            let pick = Route { provider: os(&p, "provider"), model: os(&p, "model"), effort: os(&p, "effort") };
            to(k.start_agent_on(&s(&p, "projectId")?, os(&p, "branch"), &s(&p, "request")?, os(&p, "ticket"), pick, &files(&p)?).await?)
        }
        "agents.configure" => {
            let pick = Route { provider: os(&p, "provider"), model: os(&p, "model"), effort: os(&p, "effort") };
            to(k.agent_configure(&s(&p, "id")?, pick)?)
        }
        "agents.message" => {
            k.agent_message(&s(&p, "id")?, &s(&p, "text")?, &files(&p)?).await?;
            ok()
        }
        "agents.pause" => {
            k.agents.pause(&s(&p, "id")?)?;
            ok()
        }
        "agents.resume" => {
            k.agents.resume(&s(&p, "id")?)?;
            ok()
        }
        "agents.stop" => {
            k.agents.stop(&s(&p, "id")?)?;
            ok()
        }
        "agents.remove" => {
            k.agents.remove(&s(&p, "id")?)?;
            ok()
        }
        "shell.open" => to(k.shell_open(&s(&p, "projectId")?, &s(&p, "path")?, u(&p, "cols")? as u16, u(&p, "rows")? as u16).await?),
        "shell.write" => {
            k.shells.write(&s(&p, "path")?, &s(&p, "data")?).await?;
            ok()
        }
        "shell.resize" => {
            k.shells.resize(&s(&p, "path")?, u(&p, "cols")? as u16, u(&p, "rows")? as u16)?;
            ok()
        }

        // ---- AI setup ----
        "ai.catalog" => {
            let cfg = k.store.read(|c| c.ai.clone());
            let list: Vec<Value> = ai::catalog()
                .into_iter()
                .map(|info| {
                    let st = ai::status(&cfg, info.id).ok();
                    json!({ "info": info, "status": st, "conf": cfg.providers.get(info.id) })
                })
                .collect();
            to(json!({ "providers": list, "defaultProvider": cfg.default_provider, "routing": cfg.routing }))
        }
        "ai.saveProvider" => {
            let id = s(&p, "id")?;
            let info = ai::provider_info(&id)?;
            if let Some(key) = os(&p, "apiKey").filter(|k| !k.is_empty()) {
                secrets::set(&secrets::ai_key(&id), &key)?;
            }
            k.store.write(|c| {
                let conf = c.ai.providers.entry(id.clone()).or_default();
                if let Some(m) = os(&p, "method") {
                    let m = if m == "api" { ConnectMethod::Api } else { ConnectMethod::Cli };
                    if !info.methods.contains(&if m == ConnectMethod::Api { "api" } else { "cli" }) {
                        return Err(Error::Invalid(format!("{} cannot connect that way", info.name)));
                    }
                    if conf.method != m {
                        conf.connected = false;
                    }
                    conf.method = m;
                }
                if let Some(x) = os(&p, "model") {
                    conf.model = x;
                }
                if let Some(x) = os(&p, "effort") {
                    conf.effort = x;
                }
                if let Some(x) = os(&p, "baseUrl") {
                    conf.base_url = Some(x);
                }
                if conf.effort.is_empty() {
                    conf.effort = "medium".into();
                }
                Ok(())
            })?;
            ok()
        }
        "ai.setDefault" => {
            let id = s(&p, "id")?;
            ai::provider_info(&id)?;
            k.store.write(|c| {
                c.ai.providers.entry(id.clone()).or_default();
                c.ai.default_provider = id;
                Ok(())
            })?;
            ok()
        }
        "ai.test" => k.ai_test(&s(&p, "id")?).await,
        "ai.setRoute" => {
            let task = s(&p, "task")?;
            let route = Route { provider: os(&p, "provider").filter(|x| !x.is_empty()), model: os(&p, "model"), effort: os(&p, "effort") };
            k.store.write(|c| {
                if route.provider.is_none() && route.model.is_none() && route.effort.is_none() {
                    c.ai.routing.remove(&task);
                } else {
                    c.ai.routing.insert(task, route);
                }
                Ok(())
            })?;
            ok()
        }
        "ai.signIn" => {
            let id = s(&p, "id")?;
            let (_, path) = ai::cli_path(&id)?;
            open_terminal(&path.to_string_lossy())?;
            ok()
        }

        // ---- templates ----
        "templates.list" => {
            let kinds: Vec<Value> = templates::KINDS
                .iter()
                .map(|(id, label)| json!({ "id": id, "label": label, "variables": templates::variables(id).into_iter().map(|(n, h)| json!({"name": n, "hint": h})).collect::<Vec<_>>() }))
                .collect();
            to(json!({ "templates": k.store.read(|c| c.templates.clone()), "kinds": kinds }))
        }
        "templates.save" => {
            let mut t: Template = serde_json::from_value(p.get("template").cloned().unwrap_or_default())?;
            if t.name.trim().is_empty() {
                return Err(Error::Invalid("Name is required".into()));
            }
            if t.id.is_empty() {
                t.id = new_id();
            }
            let saved = t.clone();
            k.store.write(|c| {
                match c.templates.iter_mut().find(|x| x.id == t.id) {
                    Some(x) => *x = t,
                    None => c.templates.push(t),
                }
                Ok(())
            })?;
            to(saved)
        }
        "templates.delete" => {
            let id = s(&p, "id")?;
            k.store.write(|c| {
                c.templates.retain(|t| t.id != id);
                Ok(())
            })?;
            ok()
        }
        "templates.setDefault" => {
            let id = s(&p, "id")?;
            k.store.write(|c| {
                let kind = c.templates.iter().find(|t| t.id == id).map(|t| t.kind.clone()).ok_or_else(|| Error::NotFound("template".into()))?;
                for t in c.templates.iter_mut().filter(|t| t.kind == kind) {
                    t.is_default = t.id == id;
                }
                Ok(())
            })?;
            ok()
        }
        "templates.preview" => {
            let (output, source) = k.template_preview(&s(&p, "projectId")?, &s(&p, "id")?, &os(&p, "language").unwrap_or_else(|| "en".into())).await?;
            to(json!({ "output": output, "source": source }))
        }

        // ---- pull requests ----
        "prs.list" => {
            let gh = k.pr_host(&s(&p, "projectId")?).await?;
            to(json!({ "provider": gh.provider(), "repo": gh.repo(), "items": gh.list().await? }))
        }
        "prs.get" => {
            let gh = k.pr_host(&s(&p, "projectId")?).await?;
            to(gh.detail(u(&p, "number")?).await?)
        }
        "prs.generate" => {
            let (title, body) = k.generate_pr(&s(&p, "projectId")?, &s(&p, "branch")?).await?;
            to(json!({ "title": title, "body": body }))
        }
        "prs.create" => to(k.create_pr(&s(&p, "projectId")?, &s(&p, "branch")?, b(&p, "draft"), os(&p, "title"), os(&p, "body")).await?),
        "prs.update" => {
            let gh = k.pr_host(&s(&p, "projectId")?).await?;
            gh.update(u(&p, "number")?, &s(&p, "title")?, &os(&p, "body").unwrap_or_default()).await?;
            ok()
        }
        "prs.merge" => {
            let gh = k.pr_host(&s(&p, "projectId")?).await?;
            gh.merge(u(&p, "number")?, &os(&p, "method").unwrap_or_else(|| "merge".into())).await?;
            ok()
        }
        "prs.close" => {
            let gh = k.pr_host(&s(&p, "projectId")?).await?;
            gh.set_closed(u(&p, "number")?, !b(&p, "reopen")).await?;
            // The PR is closed either way; a refused delete is reported, not raised.
            let delete_error = match os(&p, "deleteBranch") {
                Some(branch) => k.delete_branch(&s(&p, "projectId")?, &branch, true, true).await.err().map(|e| e.to_string()),
                None => None,
            };
            to(json!({ "deleteError": delete_error }))
        }
        "prs.review" => {
            let gh = k.pr_host(&s(&p, "projectId")?).await?;
            gh.review(u(&p, "number")?, &s(&p, "vote")?, &os(&p, "body").unwrap_or_default()).await?;
            ok()
        }
        "prs.comment" => {
            let gh = k.pr_host(&s(&p, "projectId")?).await?;
            gh.comment(u(&p, "number")?, &s(&p, "body")?).await?;
            ok()
        }
        "prs.reply" => {
            let gh = k.pr_host(&s(&p, "projectId")?).await?;
            gh.reply(u(&p, "number")?, u(&p, "commentId")?, &s(&p, "body")?).await?;
            ok()
        }
        "prs.resolve" => {
            let gh = k.pr_host(&s(&p, "projectId")?).await?;
            gh.set_resolved(&s(&p, "threadId")?, b(&p, "resolved")).await?;
            ok()
        }
        "prs.editComment" => {
            let gh = k.pr_host(&s(&p, "projectId")?).await?;
            gh.edit_comment(&s(&p, "commentId")?, &s(&p, "body")?).await?;
            ok()
        }
        "prs.react" => {
            let gh = k.pr_host(&s(&p, "projectId")?).await?;
            gh.react(&s(&p, "subjectId")?, &s(&p, "content")?, b(&p, "add")).await?;
            ok()
        }
        "prs.draftReply" => to(json!({ "text": k.draft_reply(&s(&p, "projectId")?, u(&p, "number")?, &s(&p, "threadId")?, os(&p, "draft").as_deref(), os(&p, "editing").as_deref()).await? })),
        "prs.draftReview" => to(json!({ "text": k.draft_review(&s(&p, "projectId")?, u(&p, "number")?).await? })),

        // ---- tickets & integrations ----
        "tickets.list" => {
            let integ = k.store.read(|c| c.integrations.clone());
            let pid = s(&p, "projectId")?;
            let on = |repos: &Vec<String>| crate::store::shows_in(repos, &pid);
            let sources: Vec<&str> = [
                ("jira", integ.jira.iter().any(|j| on(&j.repos))),
                ("trello", integ.trello.iter().any(|t| on(&t.repos))),
                ("asana", integ.asana.iter().any(|a| on(&a.repos))),
            ]
                .into_iter()
                .filter(|(_, on)| *on)
                .map(|(n, _)| n)
                .collect();
            if sources.is_empty() {
                return to(json!({ "sources": [], "tickets": [] }));
            }
            to(json!({ "sources": sources, "tickets": k.tickets(&pid, b(&p, "mine"), b(&p, "sprint")).await?, "syncedAt": crate::store::now() }))
        }
        "tickets.get" => {
            let pid = s(&p, "projectId")?;
            match os(&p, "key").filter(|k| !k.trim().is_empty()) {
                Some(key) => to(k.ticket(&pid, &key).await?),
                None => to(k.branch_ticket(&pid, &s(&p, "branch")?).await?),
            }
        }
        "tickets.setRelease" => {
            k.set_ticket_release(&s(&p, "projectId")?, &s(&p, "key")?, &os(&p, "release").unwrap_or_default())?;
            ok()
        }
        "tickets.triage" => to(k.triage(&s(&p, "projectId")?).await?),
        "tickets.statuses" => to(k.ticket_status(&s(&p, "source")?, &os(&p, "conn").unwrap_or_default(), &s(&p, "id")?, None).await?),
        "tickets.setStatus" => {
            k.ticket_status(&s(&p, "source")?, &os(&p, "conn").unwrap_or_default(), &s(&p, "id")?, Some(&s(&p, "to")?)).await?;
            ok()
        }
        "integrations.save" => {
            let kind = s(&p, "kind")?;
            // Pasted credentials often carry stray whitespace, which Jira answers with a 401.
            let token = os(&p, "token").map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
            let mut cfg = p.get("config").cloned().unwrap_or(json!({}));
            for f in ["baseUrl", "email"] {
                if let Some(v) = cfg[f].as_str() {
                    cfg[f] = v.trim().into();
                }
            }
            if kind == "jira" {
                let mut conf = serde_json::from_value::<JiraConf>(cfg.clone())?;
                if cfg.get("id").is_none_or(Value::is_null) {
                    conf.id = new_id();
                }
                // Sign in before saving, so "Connected" means Jira accepted the token.
                let tok = match &token {
                    Some(t) => t.clone(),
                    None => jira_auth::token(&conf).await?,
                };
                let me = crate::tickets::jira_connect(&mut conf, &tok).await?;
                if let Some(t) = &token {
                    secrets::set(&conf.secret(), t)?;
                }
                k.store.write(|c| {
                    upsert(&mut c.integrations.jira, conf.clone());
                    Ok(())
                })?;
                drop_unused_atlassian_sign_in(k)?;
                return to(json!({ "ok": true, "id": conf.id, "user": me["displayName"] }));
            }
            if kind == "trello" || kind == "asana" {
                // A config without id adds a connection.
                if cfg.get("id").is_none_or(Value::is_null) {
                    cfg["id"] = new_id().into();
                }
                let id = os(&cfg, "id").unwrap_or_default();
                let secret = if kind == "trello" {
                    let conf = serde_json::from_value::<TrelloConf>(cfg)?;
                    let secret = conf.secret();
                    k.store.write(|c| {
                        upsert(&mut c.integrations.trello, conf.clone());
                        Ok(())
                    })?;
                    secret
                } else {
                    let conf = serde_json::from_value::<AsanaConf>(cfg)?;
                    let secret = conf.secret();
                    k.store.write(|c| {
                        upsert(&mut c.integrations.asana, conf.clone());
                        Ok(())
                    })?;
                    secret
                };
                if let Some(t) = &token {
                    secrets::set(&secret, t)?;
                }
                return to(json!({ "ok": true, "id": id }));
            }
            if kind == "azure" {
                let pat = token.ok_or_else(|| Error::Invalid("missing `token`".into()))?;
                let user = Some(azure_auth::save_pat(&pat, cfg["org"].as_str().unwrap_or("")).await?).filter(|u| !u.is_empty());
                k.store.write(|c| {
                    c.integrations.azure_connected = true;
                    c.integrations.azure_user = user.clone();
                    Ok(())
                })?;
                return to(json!({ "ok": true, "user": user }));
            }
            if let Some(t) = &token {
                secrets::set(&kind, t)?;
            }
            k.store.write(|c| {
                match kind.as_str() {
                    "github" => {
                        c.integrations.github_api = os(&cfg, "apiBase").filter(|s| !s.is_empty());
                        c.integrations.github_connected = true;
                        if token.is_some() {
                            c.integrations.github_user = None;
                        }
                    }
                    other => return Err(Error::Invalid(format!("unknown integration {other}"))),
                }
                Ok(())
            })?;
            ok()
        }
        "integrations.checkJira" => {
            let conf = jira_conn(k, &p)?;
            let me = crate::tickets::jira_me(&conf, &jira_auth::token(&conf).await?).await?;
            to(json!({ "user": me["displayName"], "site": conf.base_url, "oauth": conf.cloud_id.is_some() }))
        }
        "jira.projects" => {
            let conf = jira_conn(k, &p)?;
            to(crate::tickets::jira_projects(&conf, &jira_auth::token(&conf).await?).await?)
        }
        "jira.versions" => {
            let conf = jira_conn(k, &p)?;
            to(crate::tickets::jira_versions(&conf, &jira_auth::token(&conf).await?, &s(&p, "key")?).await?)
        }
        "jira.setFixVersions" => {
            let conf = jira_conn(k, &p)?;
            let versions = list(&p, "versions")?;
            crate::tickets::jira_set_fix_versions(&conf, &jira_auth::token(&conf).await?, &s(&p, "key")?, &versions).await?;
            ok()
        }
        "jira.signInStart" => to(json!({ "url": jira_auth::start().await? })),
        "jira.signInFinish" => {
            let site = jira_auth::finish().await?;
            // Signing in to a site already connected replaces that connection, keeping its filters.
            let same = |j: &JiraConf| j.cloud_id.as_deref() == Some(site.cloud_id.as_str()) || j.base_url.trim_end_matches('/') == site.url.trim_end_matches('/');
            let old = k.store.read(|c| c.integrations.jira.iter().find(|j| same(j)).cloned());
            let mut conf = old.clone().unwrap_or_else(|| JiraConf { id: new_id(), ..Default::default() });
            conf.base_url = site.url.clone();
            conf.email = String::new();
            conf.cloud_id = Some(site.cloud_id.clone());
            conf.api_cloud_id = None;
            let me = crate::tickets::jira_me(&conf, &jira_auth::access_token().await?).await?;
            if old.is_some() {
                secrets::delete(&conf.secret())?;
            }
            k.store.write(|c| {
                upsert(&mut c.integrations.jira, conf.clone());
                Ok(())
            })?;
            to(json!({ "id": conf.id, "user": me["displayName"] }))
        }
        "github.signInStart" => to(github_auth::start().await?),
        "github.signInPoll" => match github_auth::poll(&s(&p, "deviceCode")?).await? {
            Poll::Pending => to(json!({ "status": "pending" })),
            Poll::SlowDown(interval) => to(json!({ "status": "pending", "interval": interval })),
            Poll::Token(t) => {
                let user = github_auth::login(&t).await.ok().filter(|u| !u.is_empty());
                secrets::set("github", &t)?;
                k.store.write(|c| {
                    // OAuth tokens are for github.com, not an Enterprise host.
                    c.integrations.github_api = None;
                    c.integrations.github_connected = true;
                    c.integrations.github_user = user.clone();
                    Ok(())
                })?;
                to(json!({ "status": "done", "user": user }))
            }
        },
        "azure.signInStart" => to(azure_auth::start().await?),
        "azure.signInPoll" => match azure_auth::poll(&s(&p, "deviceCode")?).await? {
            Poll::Pending => to(json!({ "status": "pending" })),
            Poll::SlowDown(interval) => to(json!({ "status": "pending", "interval": interval })),
            Poll::Token(t) => {
                let user = azure_auth::login(&azure_auth::bearer(&t)).await.ok().filter(|u| !u.is_empty());
                k.store.write(|c| {
                    c.integrations.azure_connected = true;
                    c.integrations.azure_user = user.clone();
                    Ok(())
                })?;
                to(json!({ "status": "done", "user": user }))
            }
        },
        "integrations.disconnect" => {
            let kind = s(&p, "kind")?;
            if kind == "jira" {
                let conf = jira_conn(k, &p)?;
                secrets::delete(&conf.secret())?;
                k.store.write(|c| {
                    c.integrations.jira.retain(|j| j.id != conf.id);
                    Ok(())
                })?;
                drop_unused_atlassian_sign_in(k)?;
                return ok();
            }
            if kind == "trello" || kind == "asana" {
                let id = os(&p, "id").unwrap_or_default();
                secrets::delete(&if id.is_empty() { kind.clone() } else { format!("{kind}.{id}") })?;
                k.store.write(|c| {
                    c.integrations.trello.retain(|t| kind != "trello" || t.id != id);
                    c.integrations.asana.retain(|a| kind != "asana" || a.id != id);
                    Ok(())
                })?;
                return ok();
            }
            secrets::delete(&kind)?;
            k.store.write(|c| {
                match kind.as_str() {
                    "github" => {
                        c.integrations.github_connected = false;
                        c.integrations.github_user = None;
                    }
                    "azure" => {
                        c.integrations.azure_connected = false;
                        c.integrations.azure_user = None;
                    }
                    _ => {}
                }
                Ok(())
            })?;
            ok()
        }

        // ---- release notes ----
        "notes.refs" => k.notes_refs(&s(&p, "projectId")?).await,
        "notes.range" => k.notes_range(&s(&p, "projectId")?, &s(&p, "from")?, &s(&p, "to")?).await,
        "notes.generate" => {
            let inc: NotesInclude = serde_json::from_value(p.get("include").cloned().unwrap_or(json!({"feat":true,"fix":true,"internal":true,"tickets":true})))?;
            let (markdown, model) = k
                .generate_notes(&s(&p, "projectId")?, &s(&p, "from")?, &s(&p, "to")?, os(&p, "templateId").as_deref(), &os(&p, "language").unwrap_or_else(|| "en".into()), inc)
                .await?;
            to(json!({ "markdown": markdown, "model": model }))
        }
        "notes.changelog" => to(json!({ "path": k.add_to_changelog(&s(&p, "projectId")?, &s(&p, "markdown")?)? })),
        "changelog.update" => to(json!({ "message": k.update_changelog(&s(&p, "projectId")?, &s(&p, "branch")?).await? })),
        "changelog.release" => to(json!({ "message": k.release_changelog(&s(&p, "projectId")?, &s(&p, "version")?).await? })),
        "notes.publish" => {
            let gh = k.github(&s(&p, "projectId")?).await?;
            let url = gh.create_release(&s(&p, "tag")?, &s(&p, "target")?, &s(&p, "name")?, &s(&p, "body")?).await?;
            to(json!({ "url": url }))
        }

        // ---- analytics ----
        "analytics.get" => {
            let ids: Vec<String> = match p.get("projectIds").and_then(Value::as_array) {
                Some(a) => a.iter().filter_map(Value::as_str).map(String::from).collect(),
                None => os(&p, "projectId").into_iter().collect(),
            };
            to(k.analytics(&ids, p.get("days").and_then(Value::as_i64).unwrap_or(30)).await?)
        }

        other => Err(Error::NotFound(format!("method {other}"))),
    }
}

/// Open the user's terminal running `cmd` (used for CLI sign-in).
fn open_terminal(cmd: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let script = format!("tell application \"Terminal\" to do script \"{}\"\ntell application \"Terminal\" to activate", cmd.replace('"', "\\\""));
        std::process::Command::new("osascript").args(["-e", &script]).spawn()?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(["/C", "start", "cmd", "/K", cmd]).spawn()?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if std::process::Command::new(term).args(["-e", cmd]).spawn().is_ok() {
                return Ok(());
            }
        }
        Err(Error::Unsupported("no terminal found; run the CLI yourself to sign in".into()))
    }
}
