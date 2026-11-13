//! One RPC surface for every client: `call(method, params) -> JSON`.
//! The Tauri command, the companion HTTP API and the MCP bridge all go
//! through here, so an action added once is available everywhere.

use std::path::{Component, Path};

use serde_json::{json, Value};

use crate::app::{Attachment, Gitnetix, MergeOptions, NewItem, NotesInclude, ViewMode};
use crate::error::{Error, Result};
use crate::git::{Git, LinePick};
use crate::store::{upsert, ConnectMethod, Connection, GitProfile, HostConf, JiraConf, ReleaseKind, Route, TrelloConf, AsanaConf, UserProfile, new_id};
use crate::templates::{self, Template};
use crate::providers::github_auth::{self, Poll};
use crate::providers::{azure_auth, bitbucket::{self, Bitbucket}, gitea::Gitea, gitlab::{self, GitLab}, oauth, RepoRef};
use crate::tickets::{jira_auth, oauth as ticket_oauth};
use crate::{ai, secrets};

/// (method, description, params) — also the MCP tool list.
pub const METHODS: &[(&str, &str, &str)] = &[
    ("app.info", "App version and companion server address", ""),
    ("log.get", "Recent operations and errors, oldest first", ""),
    ("log.clear", "Empty the log", ""),
    ("config.get", "Full app configuration of the active profile (no secrets), with every profile", ""),
    ("git.identity", "The name and email Git commits with outside any repository (empty when unset)", ""),
    ("userProfiles.switch", "Use another profile: its projects, connections, AI setup and settings", "id"),
    ("userProfiles.save", "Create a profile, blank or a copy of profile `from` with its saved tokens; with `id`, rename one or change its avatar (an emoji, an image data URL, \"gravatar:\" and an email, or \"\" for the default one) and color hue. `git`: the identity Gitnetix commits with in all the profile's projects, all empty to leave it to the Git config; only the active profile's can change", "id?, name, avatar?, hue?, from?, git?: {name, email, sign, signingKey?}"),
    ("userProfiles.delete", "Delete a profile with its settings and saved tokens (repositories stay on disk); deleting the active one switches to another, the last one stays", "id"),
    ("ui.set", "Save UI preferences; `onboarding: false` ends the first-run setup", "language?, theme?, lastProject?, animationsOff?, dictationPolish?, onboarding?"),
    ("ui.setView", "Remember how a screen was left (pane width, collapsed section…); no value forgets it", "key, value?"),
    ("server.set", "Configure the companion API", "enabled?, lan?, port?, regenerateToken?"),
    ("projects.list", "List saved projects", ""),
    ("projects.recent", "Projects saved in the other profiles and not in this one, to add back", ""),
    ("projects.icon", "A saved or recent project's own icon (favicon, app or PWA icon, logo) from its tracked files: { path, data (base64) } or null", "path"),
    ("projects.add", "Add local Git repositories", "paths: string[]"),
    ("projects.clone", "Clone a Git repository into a new folder and add it", "url, path"),
    ("projects.remove", "Remove a project from the list (files untouched)", "projectId"),
    ("projects.setHidden", "Close or reopen a project's tab (data kept)", "projectId, hidden"),
    ("projects.reorder", "Set the order of projects", "ids: string[]"),
    ("projects.setGenLang", "Language AI writes in for a project", "projectId, commit?, pr?, release?"),
    ("projects.setPrefs", "Remembered merge, commit and dialog options for a project", "projectId, merge?: {squash?, squashMessage?: branch|ai, rebase?, deleteBranch?, push?, resolveConflicts?}, commit?: {autoPush?}, dialogs?: {finish?: continue|merge, finishSwitch?, newWorktree?, newAgent?, shipPush?, shipChangelog?, deleteOrigin?, cleanupOrigin?}, worktreeFiles?: string[] (paths copied from the main checkout into new worktrees), worktreeLinks?: string[] (paths linked instead)"),
    ("workspace.overview", "Releases, their branches and repo state; `quick` skips history checks when nothing is cached", "projectId, quick?"),
    ("workspace.files", "Changed files of a branch, or of one commit when `commit` is given", "projectId, branch, mode: branch|wip|project, commit?"),
    ("workspace.diff", "Diff of one file; in wip mode `staged` picks the side; `commit` diffs that commit (`from` = the file's old path when that commit renamed it); `full` keeps the whole file", "projectId, branch, mode, path, staged?, commit?, from?, full?"),
    ("workspace.blobs", "Old and new contents of one file, base64 (image previews); same picking as workspace.diff", "projectId, branch, mode, path, staged?, commit?"),
    ("workspace.commits", "Commits a branch has that its base does not (a trunk: recent history), newest first; once all are listed, the last one, flagged `base`, is where the branch left its base; `limit` (default 200 for a trunk, 500 for a branch) is raised to reach older ones", "projectId, branch, limit?"),
    ("workspace.blame", "Who last changed each line of one file on the new side of its diff (the old side with old: true, for removed lines), sides picked like workspace.diff: lines, runs [sha, line count] in file order, and their commits (the all-zero sha is uncommitted work)", "projectId, branch, mode, path, commit?, staged?, old?"),
    ("workspace.fileHistory", "Commits of a branch that changed one file, newest first, following renames: each with the file's path there, from (its old path, on a rename), status and line counts; `limit` (default 200) is raised to reach older ones", "projectId, branch, path, limit?"),
    ("commits.revert", "Revert a commit with a new commit on its branch", "projectId, branch, sha"),
    ("commits.cherryPick", "Copy a commit onto a checked-out branch", "projectId, onto, sha"),
    ("commits.reset", "Reset a checked-out branch to a commit", "projectId, branch, sha, mode: soft|mixed|hard"),
    ("commits.tag", "Tag a commit (annotated, message defaults to the name) and push it to origin", "projectId, sha, name, message?"),
    ("workspace.switch", "Check out a branch (uncommitted work comes along); abort = first abort the rebase/merge/cherry-pick/revert the checkout is stopped in; wip = stash|carry the uncommitted changes the checkout would overwrite (refused otherwise); returns conflicts left by carrying them", "projectId, branch, abort?, wip?"),
    ("workspace.stage", "Stage files (all when paths is empty)", "projectId, branch, paths?"),
    ("workspace.unstage", "Unstage files (all when paths is empty)", "projectId, branch, paths?"),
    ("workspace.stageLines", "Stage some changed lines of one file, picked from its unstaged diff: each a removal (kind \"-\", n = old line number) or an addition (kind \"+\", n = new line number) with its text; refused when the file changed since", "projectId, branch, path, lines: [{kind, n, text}]"),
    ("workspace.unstageLines", "Unstage some changed lines of one file, picked from its staged diff like workspace.stageLines", "projectId, branch, path, lines: [{kind, n, text}]"),
    ("workspace.discardLines", "Throw away some changed lines of one file, picked from its unstaged diff like workspace.stageLines: they go back to their staged version in the working tree", "projectId, branch, path, lines: [{kind, n, text}]"),
    ("workspace.discard", "Discard staged or unstaged changes (all on that side when paths is empty)", "projectId, branch, staged, paths?"),
    ("workspace.ignore", "Add a file or folder (dir = true) to the checkout's root .gitignore", "projectId, branch, path, dir?"),
    ("workspace.commitMessage", "AI-written commit message for the staged changes", "projectId, branch"),
    ("workspace.prepareCommitMessage", "Write ahead, staging nothing, the AI commit message that staging everything and committing would ask for; such a commit made before anything changes takes it", "projectId, branch"),
    ("workspace.commit", "Commit staged changes (all = stage everything first); empty message = AI writes it", "projectId, branch, message?, all?"),
    ("workspace.push", "Push a branch to origin; force = replace its upstream after a rebase (--force-with-lease --force-if-includes)", "projectId, branch, force?"),
    ("workspace.rebase", "Rebase a branch onto onto (a local or origin-only branch), else onto its release; its target stays; AI resolves the conflicts of every commit on the way when the project has it on; returns conflicts left, errors (files AI could not resolve), resolved (files AI resolved), aborted, and forcePushTo when it was already pushed", "projectId, branch, onto?"),
    ("workspace.rebaseContinue", "AI resolves a paused rebase's conflicts and carries it through every commit left (even when the project has AI resolving off); returns like workspace.rebase", "projectId, branch"),
    ("workspace.rebaseRuns", "Rebases AI is carrying through right now: branch, onto, step of steps, subject, files being resolved, startedAt", ""),
    ("workspace.abort", "Abort the rebase, merge, cherry-pick or revert a branch's checkout is stopped in: back to where it was before it started; a rebase AI is carrying through stops first", "projectId, branch"),
    ("releases.create", "Cut a release branch", "projectId, version, kind: next|hotfix, from?"),
    ("releases.suggestVersion", "Version for a new release: next = minor bump of the highest tag or release branch, hotfix = patch bump of the latest tag", "projectId, kind: next|hotfix"),
    ("releases.ship", "Fast-forward main to the release and tag it", "projectId, version, push?"),
    ("releases.delete", "Forget an open release (branch kept)", "projectId, version"),
    ("items.suggestName", "AI branch name for a feature or fix", "projectId, kind, description, ticket?"),
    ("items.create", "New feature/fix branch in a release, or off another branch or a tag (release empty, from = branch or tag)", "projectId, release?, from?, kind, description, branchName?, ticket?, where: switch|worktree, startAgent?, provider?, model?, effort?, files?"),
    ("items.attach", "Attach an existing branch to a release", "projectId, branch, release, kind"),
    ("items.remove", "Remove a branch from its release", "projectId, branch, deleteBranch?"),
    ("branches.stash", "Stash a checked-out branch's uncommitted changes, untracked files included", "projectId, branch"),
    ("stashes.list", "Every stash of the project, newest first, with the branch it was made on", "projectId"),
    ("stashes.files", "Files a stash holds, untracked ones included", "projectId, sha"),
    ("stashes.diff", "Diff of one file of a stash; `full` keeps the whole file", "projectId, sha, path, full?"),
    ("stashes.blobs", "Old and new contents of one file of a stash, base64", "projectId, sha, path"),
    ("stashes.apply", "Apply a stash onto a checked-out branch; pop = drop it once applied cleanly (kept on conflicts, which are returned)", "projectId, branch, sha, pop?"),
    ("stashes.drop", "Delete a stash for good", "projectId, sha"),
    ("branches.pull", "Fast-forward a branch to its upstream (checked out or not); wip = stash|carry the uncommitted changes the pull would overwrite (refused otherwise); returns conflicts left by carrying them", "projectId, branch, wip?"),
    ("branches.tag", "Tag a branch's tip (annotated, message defaults to the name) and push it to origin", "projectId, branch, name, message?"),
    ("tags.checkout", "Check out a tag's commit (detached HEAD; uncommitted work comes along)", "projectId, name"),
    ("tags.delete", "Delete a tag, locally and on origin", "projectId, name"),
    ("branches.reset", "Hard-reset a branch to its upstream, dropping local commits (and uncommitted changes when checked out)", "projectId, branch"),
    ("branches.merge", "Merge a branch into its release (or parent branch, or `into`): a merge commit, or rebase = rebase it onto the target and fast-forward; squash = collapse its commits first (\"squash | <branch>\", or squashAi = AI writes the message); deleteBranch = delete it last, locally and on origin; push = push the target after; stay = don't switch the main checkout to the target", "projectId, branch, into?, deleteBranch?, squash?, squashAi?, rebase?, push?, stay?"),
    ("branches.sync", "Merge a branch's base into it to bring it up to date", "projectId, branch"),
    ("branches.setParent", "Choose what a branch merges into (an open release branch attaches it to that release; a release branch changes the branch it was cut from)", "projectId, branch, parent"),
    ("branches.fetch", "Fetch origin, pruning deleted branches", "projectId"),
    ("branches.autoFetch", "Fetch origin only when its branch or tag tips moved since this last fetched (asked with ls-remote, which writes nothing); returns whether it fetched", "projectId"),
    ("branches.cleanup", "Delete branches, skipping the ones that can't go; force = even if unmerged, remote = on origin too", "projectId, branches: string[], force?, remote?"),
    ("branches.delete", "Delete a local branch and its worktree; force = even if unmerged, remote = on origin too. Not the default or a host-protected branch", "projectId, branch, force?, remote?"),
    ("branches.rename", "Rename a branch; remote = on origin too, for everyone (GitHub moves its open PRs along; Azure DevOps refuses while a PR is open from or into it). An open release's branch takes the version of its new name, release/<version>, and its CHANGELOG.md section is renamed in a commit (changelog = true; not pushed; changelogError says why that commit failed, the rename done). A local branch whose upstream is gone and whose renamedTo is set follows that rename and tracks it", "projectId, branch, name, remote?"),
    ("submodules.list", "Submodules of the project: URL, tracked branch, recorded vs checked-out commit, uncommitted files, commits behind its remote", "projectId"),
    ("submodules.add", "Add a submodule (path defaults to the URL's last segment) and clone it", "projectId, url, path?, branch?"),
    ("submodules.update", "Check out the recorded commit of one submodule (path) or all, cloning missing ones, nested included; remote = the tracked branch's tip instead", "projectId, path?, remote?"),
    ("submodules.sync", "Copy the URLs from .gitmodules into the local clones of one submodule or all", "projectId, path?"),
    ("submodules.set", "Change a submodule's URL and/or tracked branch (empty branch = the remote's default)", "projectId, path, url?, branch?"),
    ("submodules.stage", "Stage the commit checked out in a submodule as its new pin", "projectId, path"),
    ("submodules.remove", "Remove a submodule: deinit, delete its folder and clone; the removal is staged", "projectId, path"),
    ("submodules.fetch", "Fetch every initialized submodule's origin", "projectId"),
    ("worktrees.list", "Every worktree across projects with its agent (log left out: agents.list has it); cached = the list last built (null before the first), at once and without agents", "cached?"),
    ("worktrees.create", "Open a branch in a new worktree", "projectId, branch"),
    ("worktrees.setFiles", "Paths copied (files) or linked (links) from the main checkout into new worktrees of every project", "files?: string[], links?: string[]"),
    ("worktrees.remove", "Remove a worktree", "projectId, path, force?"),
    ("agents.list", "Agent sessions", ""),
    ("agents.get", "One agent session with its log", "id"),
    ("agents.start", "Start an agent on a branch (or main checkout)", "projectId, branch?, request, ticket?, provider?, model?, effort?, files?"),
    ("agents.message", "Send a follow-up message to an agent, queued until its run ends while it works; files: [{ name, data (base64) | path }]", "id, text, files?"),
    ("agents.file", "A file sent to an agent, base64 (only from its attachments folder)", "id, path"),
    ("agents.unqueue", "Take a message waiting for the agent's run to end off its queue, when it is still `text` at `index`; returns it", "id, index, text"),
    ("agents.sendNow", "Stop the agent's run and send its queued messages now (Claude Code only: other CLIs can't resume)", "id"),
    ("agents.retry", "Run the agent's last prompt again, after its run failed", "id"),
    ("agents.continue", "Continue an agent a usage limit stopped, now instead of when the limit resets (credits added, another agent picked); stop cancels its wait", "id"),
    ("agents.diff", "Diff of one file a turn of the agent changed, between the snapshots its log's files line names; `full` keeps the whole file", "id, from, to, path, full?"),
    ("agents.blobs", "Old and new contents of one file a turn of the agent changed, base64 (image previews); same snapshots as agents.diff", "id, from, to, path"),
    ("agents.pause", "Pause an agent", "id"),
    ("agents.resume", "Resume an agent", "id"),
    ("agents.stop", "Stop an agent", "id"),
    ("agents.remove", "Delete an agent session", "id"),
    ("shell.open", "Terminal of a checkout (main checkout or worktree) of the project, numbered from 0: starts its shell if needed, returns recent output", "projectId, path, tab?, cols, rows"),
    ("shell.write", "Type into a checkout's terminal", "path, tab?, data"),
    ("shell.resize", "Resize a checkout's terminal", "path, tab?, cols, rows"),
    ("shell.close", "End a checkout's terminal and forget its output", "path, tab"),
    ("shell.scripts", "Commands of every project tool in a checkout of the project (package.json scripts, Cargo, Docker Compose, Make, LÖVE…) whose program is installed, each with the command line that runs it from the checkout root", "projectId, path"),
    ("ai.catalog", "AI providers, their status and settings", ""),
    ("ai.models", "Models an AI provider offers, each with the effort levels it takes (Copilot's, Codex's and Antigravity's are read from their CLI for the signed-in account)", "id"),
    ("ai.saveProvider", "Configure an AI provider", "id, method?, model?, effort?, baseUrl?, apiKey?"),
    ("ai.setDefault", "Default AI provider; `routeAll` hands it every task too (Claude keeps its per-task models)", "id, routeAll?"),
    ("ai.test", "Test an AI provider", "id"),
    ("dictation.transcribe", "Turn recorded speech into text on this computer (the first time downloads a 740 MB speech model)", "audio (base64), mime"),
    ("dictation.cancel", "Stop the transcriptions under way; they end with an error", ""),
    ("dictation.polish", "Rewrite dictated text into clear text with AI and the project's context; unchanged when turned off or no AI is set up", "text, projectId?, branch?, field?, typed?"),
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
    ("prs.reply", "Reply in a review thread", "projectId, number, threadId, commentId, body"),
    ("prs.resolve", "Resolve or reopen a review thread", "projectId, threadId, resolved"),
    ("prs.react", "Add or remove a reaction", "projectId, subjectId, content, add"),
    ("prs.draftReply", "AI-drafted reply for a thread; with draft, that started reply polished instead (editing = id of the comment it rewrites)", "projectId, number, threadId, draft?, editing?"),
    ("prs.draftReview", "AI-drafted review summary", "projectId, number"),
    ("tickets.list", "Tickets from Jira, Trello, Asana and the GitHub issues of the project's repository, with their release; mine = only the user's Jira and GitHub tickets, sprint = only Jira tickets in an open sprint", "projectId, mine?, sprint?"),
    ("tickets.get", "One ticket with its full description, by key or by the branch linked to it; null when none", "projectId, key? | branch?"),
    ("tickets.setRelease", "Plan a ticket into a release", "projectId, key, release"),
    ("tickets.triage", "AI suggestions for unplanned tickets", "projectId"),
    ("tickets.statuses", "Statuses a ticket can move to (Jira transitions, Trello lists, Asana sections, GitHub project board columns and closed/open)", "source, conn, id"),
    ("tickets.setStatus", "Move a ticket to one of tickets.statuses", "source, conn, id, to"),
    ("jira.versions", "Versions a Jira ticket's fix version can be set to", "id (connection), key"),
    ("jira.setFixVersions", "Set a Jira ticket's fix versions to exactly these version ids; empty clears them", "id (connection), key, versions"),
    ("integrations.save", "Connect GitHub, Azure DevOps (token = personal access token, config.org), GitLab (config.url = self-managed server), Bitbucket (config.email = Atlassian account of an API token), Gitea (config.url), Jira, Trello or Asana; a GitLab, Bitbucket or Gitea token is checked with the server first; a Jira, Trello or Asana config without id adds a connection", "kind, config?, token?"),
    ("integrations.checkJira", "Sign in to a Jira connection with its saved token; the user's name, or an error", "id"),
    ("jira.projects", "The Jira projects a connection can see", "id"),
    ("jira.signInStart", "Start \"Sign in with Atlassian\": the URL to open in the browser", ""),
    ("jira.signInFinish", "Wait for the browser sign-in to finish; done = Jira connected", ""),
    ("integrations.checkTrello", "Sign in to a Trello connection with its saved token: the user's name and open boards, or an error", "id"),
    ("trello.signInStart", "Start \"Sign in with Trello\": the URL to open in the browser", ""),
    ("trello.signInFinish", "Wait for the browser sign-in to finish; done = a Trello connection added", ""),
    ("integrations.checkAsana", "Sign in to an Asana connection with its saved token: the user's name and workspaces, or an error", "id"),
    ("asana.projects", "The active projects of an Asana workspace, by default the connection's", "id, workspace?"),
    ("asana.signInStart", "Start \"Sign in with Asana\": the URL to open in the browser", ""),
    ("asana.signInFinish", "Wait for the browser sign-in to finish; done = an Asana connection added, on the account's first workspace", ""),
    ("github.repos", "Repositories of the linked GitHub account, last pushed first: { fullName, description, private, cloneUrl, sshUrl }", ""),
    ("git.saveLogin", "Save the HTTPS login git signs in to a host with (token = password or access token), in the keychain; the next fetch or push to that host uses it", "host, username, token"),
    ("github.signInStart", "Start \"Sign in with GitHub\": a code for the user to enter at verificationUri", ""),
    ("github.signInPoll", "Check whether the user entered the code; done = token stored and GitHub connected", "deviceCode"),
    ("azure.signInStart", "Start \"Sign in with Azure DevOps\": a code for the user to enter at verificationUri", ""),
    ("azure.signInPoll", "Check whether the user entered the code; done = tokens stored and Azure DevOps connected", "deviceCode"),
    ("gitlab.signInStart", "Start \"Sign in with GitLab\" on gitlab.com, or on a self-managed server (url) with the ID of an OAuth app registered there (clientId): a code for the user to enter at verificationUri", "url?, clientId?"),
    ("gitlab.signInPoll", "Check whether the user entered the code; done = tokens stored and GitLab connected", "deviceCode, url?, clientId?"),
    ("bitbucket.signInStart", "Start \"Sign in with Bitbucket\": the URL to open in the browser", ""),
    ("bitbucket.signInFinish", "Wait for the browser sign-in to finish; done = Bitbucket connected", ""),
    ("gitea.signInStart", "Start \"Sign in with Gitea\" on a server (url) with the client ID of a public OAuth app registered there (redirect URI http://127.0.0.1/callback): the URL to open in the browser", "url, clientId"),
    ("gitea.signInFinish", "Wait for the browser sign-in to finish; done = Gitea connected", ""),
    ("gitlab.repos", "Repositories of the linked GitLab account, like github.repos", ""),
    ("bitbucket.repos", "Repositories of the linked Bitbucket account, like github.repos", ""),
    ("gitea.repos", "Repositories of the linked Gitea account, like github.repos", ""),
    ("integrations.disconnect", "Disconnect an integration (kind github, azure, gitlab, bitbucket, gitea, jira, trello, asana; id = which Jira, Trello or Asana connection)", "kind, id?"),
    ("notes.refs", "Tags and branches for a notes range", "projectId"),
    ("notes.range", "Commit, branch and ticket counts in a range", "projectId, from, to"),
    ("notes.generate", "AI release notes", "projectId, from, to, templateId?, language, include"),
    ("notes.changelog", "Prepend notes to CHANGELOG.md", "projectId, markdown"),
    ("changelog.update", "AI adds what a branch changes to the Unreleased section of its CHANGELOG.md and commits it on the branch", "projectId, branch"),
    ("changelog.release", "Move the Unreleased section of an open release's CHANGELOG.md into its version and commit it on the release branch; when the version already lists entries, AI merges both (highlights first), else they are added under the matching headings", "projectId, version"),
    ("changelog.latest", "Merge the Unreleased section of a branch's CHANGELOG.md into its latest version, like changelog.release, and commit it on the branch", "projectId, branch"),
    ("notes.publish", "Publish a release on the project's git host (GitHub, GitLab or Gitea)", "projectId, tag, target, name, body"),
    ("analytics.get", "Activity and release stats; with emails, only those people's commits, merges and the releases holding their commits", "projectIds (empty = all) or projectId (or \"all\"), days, emails? (empty = everyone)"),
    ("analytics.day", "Commits authored on a day, with the branch each was made on", "projectIds (empty = all) or projectId (or \"all\"), date (YYYY-MM-DD), emails? (empty = everyone)"),
    ("analytics.sprints", "Jira sprint stats per board: velocity, burndown, hours left over, completion per person, over the last `count` sprints (2 to 12, default 6); with assignees, only their tickets. Jira's answers of the last 5 minutes are used again unless fresh", "projectIds (empty = all), count?, assignees? (empty = everyone), fresh?"),
    ("analytics.weekly", "Tickets done per week and per person over the last `weeks` weeks (4 to 52, default 12), from Jira, Trello and Asana", "projectIds (empty = all), weeks?"),
    ("analytics.ask", "AI answer to a question about the ticket charts; data = the sprints or weeks on screen as JSON text, history = earlier questions and answers", "question, data, history?: [{question, answer}]"),
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

/// `projectIds`, else the one `projectId`.
/// The strings of array param `key`; none when it is missing.
fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect()
}

fn project_ids(v: &Value) -> Vec<String> {
    match v.get("projectIds").and_then(Value::as_array) {
        Some(a) => a.iter().filter_map(Value::as_str).map(String::from).collect(),
        None => os(v, "projectId").into_iter().collect(),
    }
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
fn line_picks(v: &Value) -> Result<Vec<LinePick>> {
    Ok(serde_json::from_value(v.get("lines").cloned().unwrap_or(json!([])))?)
}

fn files(v: &Value) -> Result<Vec<Attachment>> {
    Ok(serde_json::from_value(v.get("files").cloned().unwrap_or(json!([])))?)
}

fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

fn u(v: &Value, k: &str) -> Result<u64> {
    v.get(k).and_then(Value::as_u64).ok_or_else(|| Error::Invalid(format!("missing `{k}`")))
}

/// A checkout's terminal number; its first one when missing.
fn tab(v: &Value) -> u32 {
    v.get("tab").and_then(Value::as_u64).unwrap_or(0) as u32
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

fn trello_conn(k: &Gitnetix, p: &Value) -> Result<TrelloConf> {
    let id = os(p, "id").unwrap_or_default();
    k.store.read(|c| c.integrations.trello.iter().find(|t| t.id == id).cloned()).ok_or_else(|| Error::NotConnected("Trello".into()))
}

fn asana_conn(k: &Gitnetix, p: &Value) -> Result<AsanaConf> {
    let id = os(p, "id").unwrap_or_default();
    k.store.read(|c| c.integrations.asana.iter().find(|a| a.id == id).cloned()).ok_or_else(|| Error::NotConnected("Asana".into()))
}

/// The account's first workspace: tasks are listed per workspace, so a connection needs one until the user picks another.
fn first_workspace(me: &Value) -> Result<String> {
    me["workspaces"][0]["id"].as_str().map(String::from).ok_or_else(|| Error::Invalid("this Asana account has no workspace".into()))
}

/// The Atlassian sign-in is shared by every OAuth connection; drop it once none is left.
fn drop_unused_atlassian_sign_in(k: &Gitnetix) -> Result<()> {
    if !k.store.read(|c| c.integrations.jira.iter().any(|j| j.cloud_id.is_some())) {
        secrets::delete(jira_auth::KEY)?;
    }
    Ok(())
}

/// A server address as typed, without its trailing slash; None when empty.
fn server_url(v: Option<String>) -> Result<Option<String>> {
    let Some(u) = v.map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty()) else { return Ok(None) };
    match reqwest::Url::parse(&u) {
        Ok(url) if matches!(url.scheme(), "https" | "http") && url.host_str().is_some() => Ok(Some(u)),
        _ => Err(Error::Invalid(format!("{u} is not a server address, like https://git.example.com"))),
    }
}

/// The GitLab server and OAuth app a sign-in goes to: the app given (`clientId`) on `url`, else gitlab.com and the built-in app.
fn gitlab_app(p: &Value) -> Result<(String, String)> {
    let base = server_url(os(p, "url"))?.unwrap_or_else(|| gitlab::CLOUD.into());
    let given = os(p, "clientId").map(|i| i.trim().to_string()).filter(|i| !i.is_empty());
    match given.or_else(|| (base == gitlab::CLOUD && !gitlab::CLIENT_ID.is_empty()).then(|| gitlab::CLIENT_ID.into())) {
        Some(id) => Ok((base, id)),
        None if base == gitlab::CLOUD => Err(Error::Unsupported("GitLab sign-in is not set up in this build; use a personal access token".into())),
        None => Err(Error::Invalid(format!("enter the application ID of the OAuth app registered on {base}"))),
    }
}

/// Mark a GitLab, Bitbucket or Gitea connection signed in: the account, and the server and OAuth app (None for a pasted token) its tokens belong to.
fn host_connected(k: &Gitnetix, kind: &str, url: Option<String>, client_id: Option<String>, user: Option<String>) -> Result<()> {
    k.store.write(|c| {
        let h = c.integrations.host_mut(kind).ok_or_else(|| Error::Invalid(format!("unknown git provider {kind}")))?;
        *h = HostConf { url, client_id, connected: true, user };
        Ok(())
    })
}

/// What a profile's avatar may be: an emoji, a photo as an image data URL (kept in profiles.json, so small), or "gravatar:" and an email.
fn valid_avatar(a: &str) -> bool {
    if a.starts_with("data:image/") {
        a.len() <= 256 * 1024
    } else if let Some(email) = a.strip_prefix("gravatar:") {
        email.contains('@') && email.len() <= 254
    } else {
        a.chars().count() <= 16
    }
}

/// A profile's Git identity as sent, trimmed: none when all empty, which leaves commits to the Git config.
fn git_identity(v: &Value) -> Result<Vec<GitProfile>> {
    let mut g: GitProfile = serde_json::from_value(v.clone())?;
    g.name = g.name.trim().into();
    g.email = g.email.trim().into();
    g.signing_key = g.signing_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    if !g.email.is_empty() && !g.email.contains('@') {
        return Err(Error::Invalid("That email has no @".into()));
    }
    Ok(if g.name.is_empty() && g.email.is_empty() && !g.sign { Vec::new() } else { vec![g] })
}

/// `git config --get-regexp` lines as `{ name, email }`; the last value wins, as in Git.
fn git_user(out: &str) -> Value {
    let mut user = json!({ "name": "", "email": "" });
    for (key, v) in out.lines().filter_map(|l| l.split_once(' ')) {
        user[key.trim_start_matches("user.")] = v.trim().into();
    }
    user
}

#[test]
fn git_user_keeps_the_last_value_of_each() {
    assert_eq!(git_user("user.name Old\nuser.email jo@example.com\nuser.name Jo Doe\n"), json!({ "name": "Jo Doe", "email": "jo@example.com" }));
    assert_eq!(git_user(""), json!({ "name": "", "email": "" }));
}

#[test]
fn avatars_are_an_emoji_a_photo_or_a_gravatar_email() {
    assert!(valid_avatar("") && valid_avatar("🦊") && valid_avatar("👩‍💻"));
    assert!(valid_avatar("data:image/jpeg;base64,/9j/4AAQ"));
    assert!(!valid_avatar(&format!("data:image/png;base64,{}", "A".repeat(300 * 1024))), "too big for profiles.json");
    assert!(valid_avatar("gravatar:me@example.com") && !valid_avatar("gravatar:nobody"));
    assert!(!valid_avatar("a sentence, not an avatar"));
}

/// Reads polled all the time: logged only when they fail.
const QUIET: &[&str] = &[".info", ".get", ".list", ".overview", ".files", ".diff", ".blobs", ".commits", ".catalog", ".statuses", ".versions", ".projects", ".refs", ".range", ".preview", ".clear", "analytics.day", "analytics.sprints", "analytics.weekly", "shell.write", "shell.resize", "shell.scripts", "ui.setView", "github.signInPoll", "azure.signInPoll", "gitlab.signInPoll", "github.repos", "gitlab.repos", "bitbucket.repos", "gitea.repos"];

/// Actions in flight.
static BUSY: std::sync::Mutex<usize> = std::sync::Mutex::new(0);

/// One action in flight. While any is, the file named by `GITNETIX_BUSY_FILE` exists:
/// `pnpm app` (scripts/dev.mjs) waits for it to go before restarting the app on a Rust change, and Vite before reloading the page.
struct Busy;

impl Busy {
    fn enter() -> Busy {
        Busy::count(true);
        Busy
    }

    fn count(up: bool) {
        let Some(file) = std::env::var_os("GITNETIX_BUSY_FILE") else { return };
        let mut n = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        if up {
            *n += 1;
        } else {
            *n -= 1;
        }
        if up && *n == 1 {
            let _ = std::fs::write(&file, "");
        } else if *n == 0 {
            let _ = std::fs::remove_file(&file);
        }
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        Busy::count(false);
    }
}

#[test]
fn busy_file_lives_while_any_action_runs() {
    let file = std::env::temp_dir().join(format!("gitnetix-busy-test-{}", std::process::id()));
    std::env::set_var("GITNETIX_BUSY_FILE", &file);
    let a = Busy::enter();
    let b = Busy::enter();
    assert!(file.exists());
    drop(a);
    assert!(file.exists());
    drop(b);
    assert!(!file.exists());
}

/// Run `method`, logging what it will attempt and how it ended.
pub async fn call(k: &Gitnetix, method: &str, p: Value) -> Result<Value> {
    let quiet = QUIET.iter().any(|q| method.ends_with(q));
    let _busy = (!quiet).then(Busy::enter);
    if !quiet {
        crate::log::info(format!("Will attempt to {method} {}", scrub(&p, "")));
    }
    let start = std::time::Instant::now();
    // Boxed: `dispatch`'s future is over 1 MiB in debug builds, and inline it overflows the 2 MiB test/worker stacks.
    let out = Box::pin(dispatch(k, method, p)).await;
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
        "config.get" => {
            let mut c = to(k.store.snapshot())?;
            let profiles = k.store.profiles();
            c["userProfiles"] = to(profiles.list)?;
            c["activeProfile"] = profiles.active.into();
            Ok(c)
        }
        "git.identity" => {
            let (_, out, _) = Git::new(dirs::home_dir().unwrap_or_default()).try_run(&["config", "--get-regexp", r"^user\.(name|email)$"]).await?;
            to(git_user(&out))
        }
        "userProfiles.switch" => {
            k.switch_profile(&s(&p, "id")?)?;
            ok()
        }
        "userProfiles.save" => {
            let name = s(&p, "name")?.trim().to_string();
            if name.is_empty() {
                return Err(Error::Invalid("A profile needs a name".into()));
            }
            let avatar = os(&p, "avatar").unwrap_or_default();
            if !valid_avatar(&avatar) {
                return Err(Error::Invalid("An avatar is an emoji, a photo or a Gravatar email".into()));
            }
            let hue = p.get("hue").and_then(Value::as_u64).map(|h| (h % 360) as u16);
            let git = p.get("git").map(git_identity).transpose()?;
            let prof = UserProfile { id: os(&p, "id").unwrap_or_default(), name, avatar, hue };
            if prof.id.is_empty() {
                return to(k.create_profile(prof, os(&p, "from").as_deref(), git)?);
            }
            // The other profiles' settings are on disk only, unloaded.
            if git.is_some() && prof.id != k.store.active() {
                return Err(Error::Invalid("Switch to this profile to change its Git identity".into()));
            }
            k.store.update_profile(prof.clone())?;
            if let Some(g) = git {
                k.store.write(|c| {
                    c.profiles = g;
                    Ok(())
                })?;
            }
            to(prof)
        }
        "userProfiles.delete" => {
            k.delete_profile(&s(&p, "id")?)?;
            ok()
        }
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
                if let Some(x) = p.get("dictationPolish").and_then(Value::as_bool) {
                    c.ui.dictation_polish = x;
                }
                if let Some(x) = p.get("onboarding").and_then(Value::as_bool) {
                    c.ui.onboarding = x;
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
        "projects.recent" => to(k.recent_projects()),
        "projects.icon" => to(k.project_icon(&s(&p, "path")?).await?.map(|(path, data)| json!({ "path": path, "data": data }))),
        "projects.add" => {
            let paths = list(&p, "paths")?;
            to(k.add_projects(paths).await?)
        }
        "projects.clone" => to(k.clone_project(&s(&p, "url")?, &s(&p, "path")?).await?),
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
                if let Some(f) = p.get("worktreeFiles") {
                    pr.worktree_files = worktree_files(f)?;
                }
                if let Some(f) = p.get("worktreeLinks") {
                    pr.worktree_links = worktree_files(f)?;
                }
                Ok(())
            })?;
            ok()
        }
        "worktrees.setFiles" => {
            let files = p.get("files").map(worktree_files).transpose()?;
            let links = p.get("links").map(worktree_files).transpose()?;
            k.store.write(|c| {
                if let Some(f) = files {
                    c.worktree_files = f;
                }
                if let Some(l) = links {
                    c.worktree_links = l;
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
            Some(sha) => to(k.commit_diff(&s(&p, "projectId")?, &sha, &s(&p, "path")?, b(&p, "full"), os(&p, "from").as_deref()).await?),
            None => to(k.diff(&s(&p, "projectId")?, &s(&p, "branch")?, mode(&p)?, &s(&p, "path")?, p.get("staged").and_then(Value::as_bool), b(&p, "full")).await?),
        },
        "workspace.blobs" => match os(&p, "commit") {
            Some(sha) => to(k.commit_blobs(&s(&p, "projectId")?, &sha, &s(&p, "path")?).await?),
            None => to(k.blobs(&s(&p, "projectId")?, &s(&p, "branch")?, mode(&p)?, &s(&p, "path")?, p.get("staged").and_then(Value::as_bool)).await?),
        },
        "workspace.commits" => to(k.commits(&s(&p, "projectId")?, &s(&p, "branch")?, p.get("limit").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok())).await?),
        "workspace.blame" => to(k.blame(&s(&p, "projectId")?, &s(&p, "branch")?, mode(&p)?, &s(&p, "path")?, os(&p, "commit").as_deref(), p.get("staged").and_then(Value::as_bool), b(&p, "old")).await?),
        "workspace.fileHistory" => to(k.file_history(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "path")?, p.get("limit").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok())).await?),
        "commits.revert" => to(json!({ "sha": k.revert_commit(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "sha")?).await? })),
        "commits.cherryPick" => to(json!({ "sha": k.cherry_pick(&s(&p, "projectId")?, &s(&p, "onto")?, &s(&p, "sha")?).await? })),
        "commits.reset" => {
            k.reset_branch(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "sha")?, &s(&p, "mode")?).await?;
            ok()
        }
        "commits.tag" => {
            k.tag_commit(&s(&p, "projectId")?, &s(&p, "sha")?, &s(&p, "name")?, os(&p, "message").as_deref()).await?;
            ok()
        }
        "workspace.switch" => to(json!({ "conflicts": k.switch_branch(&s(&p, "projectId")?, &s(&p, "branch")?, b(&p, "abort"), os(&p, "wip").as_deref()).await? })),
        "workspace.commitMessage" => to(json!({ "message": k.generate_commit_message(&s(&p, "projectId")?, &s(&p, "branch")?).await? })),
        "workspace.prepareCommitMessage" => {
            k.prepare_commit_message(&s(&p, "projectId")?, &s(&p, "branch")?).await?;
            ok()
        }
        "workspace.stage" => {
            k.stage(&s(&p, "projectId")?, &s(&p, "branch")?, &list(&p, "paths")?).await?;
            ok()
        }
        "workspace.unstage" => {
            k.unstage(&s(&p, "projectId")?, &s(&p, "branch")?, &list(&p, "paths")?).await?;
            ok()
        }
        "workspace.stageLines" | "workspace.unstageLines" => {
            k.stage_lines(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "path")?, &line_picks(&p)?, method == "workspace.unstageLines").await?;
            ok()
        }
        "workspace.discardLines" => {
            k.discard_lines(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "path")?, &line_picks(&p)?).await?;
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
        "workspace.rebase" => to(k.rebase(&s(&p, "projectId")?, &s(&p, "branch")?, os(&p, "onto").as_deref()).await?),
        "workspace.rebaseContinue" => to(k.rebase_continue(&s(&p, "projectId")?, &s(&p, "branch")?).await?),
        "workspace.rebaseRuns" => to(k.rebase_runs()),
        "workspace.abort" => {
            k.abort_in_progress(&s(&p, "projectId")?, &s(&p, "branch")?).await?;
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
        "branches.pull" => {
            let (output, conflicts) = k.pull_branch(&s(&p, "projectId")?, &s(&p, "branch")?, os(&p, "wip").as_deref()).await?;
            to(json!({ "output": output, "conflicts": conflicts }))
        }
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
        "branches.autoFetch" => to(k.auto_fetch(&s(&p, "projectId")?).await?),
        "branches.cleanup" => {
            let branches = list(&p, "branches")?;
            to(k.cleanup_branches(&s(&p, "projectId")?, &branches, b(&p, "force"), b(&p, "remote")).await?)
        }
        "branches.rename" => to(k.rename_branch(&s(&p, "projectId")?, &s(&p, "branch")?, &s(&p, "name")?, b(&p, "remote")).await?),
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
        "worktrees.list" if b(&p, "cached") => to(k.saved_worktrees()),
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
        "agents.file" => to(k.agent_file(&s(&p, "id")?, &s(&p, "path")?).await?),
        "agents.unqueue" => to(k.agents.unqueue(&s(&p, "id")?, u(&p, "index")? as usize, &s(&p, "text")?)?),
        "agents.sendNow" => {
            k.agents.send_now(&s(&p, "id")?)?;
            ok()
        }
        "agents.retry" => {
            k.agent_retry(&s(&p, "id")?)?;
            ok()
        }
        "agents.continue" => {
            k.agent_continue(&s(&p, "id")?)?;
            ok()
        }
        "agents.diff" => to(k.agent_diff(&s(&p, "id")?, &s(&p, "from")?, &s(&p, "to")?, &s(&p, "path")?, b(&p, "full")).await?),
        "agents.blobs" => to(k.agent_blobs(&s(&p, "id")?, &s(&p, "from")?, &s(&p, "to")?, &s(&p, "path")?).await?),
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
        "shell.open" => to(k.shell_open(&s(&p, "projectId")?, &s(&p, "path")?, tab(&p), u(&p, "cols")? as u16, u(&p, "rows")? as u16).await?),
        "shell.write" => {
            k.shells.write(&s(&p, "path")?, tab(&p), &s(&p, "data")?).await?;
            ok()
        }
        "shell.resize" => {
            k.shells.resize(&s(&p, "path")?, tab(&p), u(&p, "cols")? as u16, u(&p, "rows")? as u16)?;
            ok()
        }
        "shell.close" => {
            k.shells.remove(&s(&p, "path")?, Some(u(&p, "tab")? as u32));
            ok()
        }
        "shell.scripts" => to(k.shell_scripts(&s(&p, "projectId")?, &s(&p, "path")?).await?),

        // ---- AI setup ----
        "ai.catalog" => {
            // CLIs found only on the login shell's PATH show as found from the first launch on.
            crate::project_commands::login_dirs().await;
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
        "ai.models" => to(ai::models(&s(&p, "id")?).await?),
        "ai.saveProvider" => {
            let id = s(&p, "id")?;
            let info = ai::provider_info(&id)?;
            let key = os(&p, "apiKey").filter(|k| !k.is_empty());
            if let (None, Some(url)) = (&key, os(&p, "baseUrl")) {
                // A saved key belongs to the server it was saved for: a new base URL needs its own.
                let saved = k.store.read(|c| c.ai.providers.get(&id).and_then(|c| c.base_url.clone()));
                if saved.filter(|u| !u.is_empty()) != Some(url).filter(|u| !u.is_empty()) && secrets::get(&secrets::ai_key(&id))?.is_some() {
                    return Err(Error::Invalid("Paste the API key for this base URL: the saved one is for the previous server.".into()));
                }
            }
            if let Some(key) = &key {
                secrets::set(&secrets::ai_key(&id), key)?;
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
            let route_all = p.get("routeAll").and_then(Value::as_bool).unwrap_or(false);
            k.store.write(|c| {
                c.ai.providers.entry(id.clone()).or_default();
                // The default routes name Claude's models: another provider runs every task on its own model.
                if route_all {
                    c.ai.routing = if id == "claude" { crate::store::AiConfig::default().routing } else { Default::default() };
                }
                c.ai.default_provider = id;
                Ok(())
            })?;
            ok()
        }
        "ai.test" => k.ai_test(&s(&p, "id")?).await,
        "dictation.transcribe" => {
            use base64::Engine;
            let audio = base64::engine::general_purpose::STANDARD.decode(s(&p, "audio")?).map_err(|e| Error::Invalid(format!("audio: {e}")))?;
            let events = k.events.clone();
            let progress = move |done, total| {
                let _ = events.send(crate::events::Event::DictationModel { done, total });
            };
            let audio = crate::dictation::Audio::Recorded { bytes: audio, mime: os(&p, "mime").unwrap_or_default() };
            let text = k.dictate(audio, progress).await?;
            to(json!({ "text": text }))
        }
        "dictation.cancel" => {
            k.dictation.cancel();
            ok()
        }
        "dictation.polish" => {
            let text = k.polish_dictation(&s(&p, "text")?, os(&p, "projectId").as_deref(), os(&p, "branch").as_deref(), &os(&p, "field").unwrap_or_default(), &os(&p, "typed").unwrap_or_default()).await?;
            to(json!({ "text": text }))
        }
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
            // Claude Code signs in right away with `auth login`; the other CLIs ask on their first run.
            let login = if id == "claude" { " auth login" } else { "" };
            open_terminal(&format!("{}{login}", path.to_string_lossy()))?;
            ok()
        }

        // ---- templates ----
        "templates.list" => {
            let kinds: Vec<Value> = templates::KINDS
                .iter()
                .map(|(id, label)| json!({ "id": id, "label": label, "globals": *id != templates::GLOBAL && !templates::NO_GLOBALS.contains(id), "variables": templates::variables(id).into_iter().map(|(n, h)| json!({"name": n, "hint": h})).collect::<Vec<_>>() }))
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
            let pid = s(&p, "projectId")?;
            let gh = k.pr_host(&pid).await?;
            gh.merge(u(&p, "number")?, &os(&p, "method").unwrap_or_else(|| "merge".into())).await?;
            // The merge happened on origin: fetch it so the branch shows merged here. The merge stands even if this fails.
            let _ = k.fetch(&pid).await;
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
            gh.reply(u(&p, "number")?, &os(&p, "threadId").unwrap_or_default(), u(&p, "commentId")?, &s(&p, "body")?).await?;
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
            let mut sources: Vec<&str> = [
                ("jira", integ.jira.iter().any(|j| on(&j.repos))),
                ("trello", integ.trello.iter().any(|t| on(&t.repos))),
                ("asana", integ.asana.iter().any(|a| on(&a.repos))),
            ]
                .into_iter()
                .filter(|(_, on)| *on)
                .map(|(n, _)| n)
                .collect();
            // The issues of a GitHub origin, with the account of Git providers.
            if k.github(&pid).await.is_ok() {
                sources.push("github");
            }
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
                // A saved API token belongs to the site it was saved for: a new site needs its own.
                if token.is_none() && conf.cloud_id.is_none() {
                    let saved = k.store.read(|c| c.integrations.jira.iter().find(|j| j.id == conf.id).map(|j| j.base_url.clone()));
                    if saved.is_some_and(|b| b != conf.base_url) {
                        return Err(Error::Invalid("Paste the API token for this site: the saved one is for the previous site.".into()));
                    }
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
                // Only a browser sign-in sets this: a pasted token replaces it, else it stays as saved.
                let signed_in = token.is_none()
                    && k.store.read(|c| if kind == "trello" { c.integrations.trello.iter().any(|t| t.id == id && t.oauth) } else { c.integrations.asana.iter().any(|a| a.id == id && a.oauth) });
                cfg["oauth"] = signed_in.into();
                // Sign in before saving, so "Connected" means the tracker accepted the token.
                let mut user = Value::Null;
                if kind == "trello" {
                    let conf = serde_json::from_value::<TrelloConf>(cfg)?;
                    if let Some(t) = &token {
                        user = crate::tickets::trello_account(&conf, t).await?["user"].take();
                        secrets::set(&conf.secret(), t)?;
                    }
                    k.store.write(|c| {
                        upsert(&mut c.integrations.trello, conf.clone());
                        Ok(())
                    })?;
                } else {
                    let mut conf = serde_json::from_value::<AsanaConf>(cfg)?;
                    if let Some(t) = &token {
                        let mut me = crate::tickets::asana_me(t).await?;
                        if conf.workspace_gid.is_empty() {
                            conf.workspace_gid = first_workspace(&me)?;
                        }
                        user = me["user"].take();
                        secrets::set(&conf.secret(), t)?;
                    }
                    k.store.write(|c| {
                        upsert(&mut c.integrations.asana, conf.clone());
                        Ok(())
                    })?;
                }
                return to(json!({ "ok": true, "id": id, "user": user }));
            }
            if matches!(kind.as_str(), "gitlab" | "bitbucket" | "gitea") {
                let pat = token.ok_or_else(|| Error::Invalid("missing `token`".into()))?;
                let url = server_url(os(&cfg, "url"))?;
                let email = os(&cfg, "email").map(|e| e.trim().to_string()).filter(|e| !e.is_empty());
                let auth = oauth::Tokens { access_token: pat.clone(), email: email.clone(), ..Default::default() }.header();
                // Saved once the server took it, so "Connected" means it works.
                let user = match kind.as_str() {
                    "gitlab" => GitLab::new(RepoRef::default(), url.as_deref().unwrap_or(gitlab::CLOUD), auth).me().await?,
                    "bitbucket" => Bitbucket::new(RepoRef::default(), auth).me().await?,
                    _ => Gitea::new(RepoRef::default(), url.as_deref().ok_or_else(|| Error::Invalid("missing the Gitea server".into()))?, auth).me().await?,
                };
                oauth::save_pat(&kind, &pat, email)?;
                let user = Some(user).filter(|u| !u.is_empty());
                host_connected(k, &kind, url.filter(|_| kind != "bitbucket"), None, user.clone())?;
                return to(json!({ "ok": true, "user": user }));
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
            if kind == "github" && token.is_none() {
                // The saved token belongs to the server it was saved for: a new API base needs its own.
                let api = os(&cfg, "apiBase").filter(|s| !s.is_empty());
                if api != k.store.read(|c| c.integrations.github_api.clone()) && secrets::get("github")?.is_some() {
                    return Err(Error::Invalid("Paste a token for this server: the saved one is for the previous server.".into()));
                }
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
        "integrations.checkTrello" => {
            let conf = trello_conn(k, &p)?;
            to(crate::tickets::trello_account(&conf, &crate::tickets::trello_token(&conf).await?).await?)
        }
        "trello.signInStart" => to(json!({ "url": ticket_oauth::start(&ticket_oauth::TRELLO).await? })),
        "trello.signInFinish" => {
            let v = ticket_oauth::finish(&ticket_oauth::TRELLO).await?;
            let conf = TrelloConf { id: new_id(), oauth: true, ..Default::default() };
            // Checked before saving, so a sign-in Trello then refuses leaves nothing behind.
            let me = crate::tickets::trello_account(&conf, v["access_token"].as_str().unwrap_or("")).await?;
            ticket_oauth::save(&conf.secret(), &v, None)?;
            k.store.write(|c| {
                upsert(&mut c.integrations.trello, conf.clone());
                Ok(())
            })?;
            to(json!({ "id": conf.id, "user": me["user"] }))
        }
        "integrations.checkAsana" => {
            let conf = asana_conn(k, &p)?;
            to(crate::tickets::asana_me(&crate::tickets::asana_token(&conf).await?).await?)
        }
        "asana.projects" => {
            let conf = asana_conn(k, &p)?;
            let workspace = os(&p, "workspace").filter(|w| !w.is_empty()).unwrap_or_else(|| conf.workspace_gid.clone());
            to(crate::tickets::asana_projects(&crate::tickets::asana_token(&conf).await?, &workspace).await?)
        }
        "asana.signInStart" => to(json!({ "url": ticket_oauth::start(&ticket_oauth::ASANA).await? })),
        "asana.signInFinish" => {
            let v = ticket_oauth::finish(&ticket_oauth::ASANA).await?;
            let me = crate::tickets::asana_me(v["access_token"].as_str().unwrap_or("")).await?;
            let conf = AsanaConf { id: new_id(), workspace_gid: first_workspace(&me)?, oauth: true, ..Default::default() };
            ticket_oauth::save(&conf.secret(), &v, None)?;
            k.store.write(|c| {
                upsert(&mut c.integrations.asana, conf.clone());
                Ok(())
            })?;
            to(json!({ "id": conf.id, "user": me["user"] }))
        }
        "github.repos" => to(k.github_repos().await?),
        "git.saveLogin" => {
            // Pasted tokens often carry stray whitespace.
            let login = crate::git::Login { username: s(&p, "username")?.trim().into(), token: s(&p, "token")?.trim().into() };
            crate::git::save_login(&s(&p, "host")?, login)?;
            ok()
        }
        "github.signInStart" => to(github_auth::start().await?),
        "github.signInPoll" => match github_auth::poll(&s(&p, "deviceCode")?).await? {
            Poll::Pending => to(json!({ "status": "pending" })),
            Poll::SlowDown(interval) => to(json!({ "status": "pending", "interval": interval })),
            // Stored by `poll`, with the refresh token that renews it.
            Poll::Token(t) => {
                let user = github_auth::login(&t).await.ok().filter(|u| !u.is_empty());
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
        "gitlab.signInStart" => {
            let (base, id) = gitlab_app(&p)?;
            to(oauth::device_start(&format!("{base}/oauth/authorize_device"), &id, gitlab::SCOPE, "GitLab").await?)
        }
        "gitlab.signInPoll" => {
            let (base, id) = gitlab_app(&p)?;
            match oauth::device_poll(&format!("{base}/oauth/token"), &id, &s(&p, "deviceCode")?, "GitLab", "gitlab").await? {
                Poll::Pending => to(json!({ "status": "pending" })),
                Poll::SlowDown(interval) => to(json!({ "status": "pending", "interval": interval })),
                Poll::Token(t) => {
                    let user = GitLab::new(RepoRef::default(), &base, format!("Bearer {t}")).me().await.ok().filter(|u| !u.is_empty());
                    host_connected(k, "gitlab", (base != gitlab::CLOUD).then_some(base), Some(id), user.clone())?;
                    to(json!({ "status": "done", "user": user }))
                }
            }
        }
        "bitbucket.signInStart" => {
            let (id, secret) = bitbucket::client()?;
            let b = oauth::Browser {
                site: "Bitbucket",
                server: "https://bitbucket.org".into(),
                key: "bitbucket",
                authorize_url: bitbucket::AUTHORIZE_URL.into(),
                token_url: bitbucket::TOKEN_URL.into(),
                client_id: id.into(),
                secret: Some(secret),
                port: bitbucket::PORT,
            };
            to(json!({ "url": oauth::browser_start(b).await? }))
        }
        "gitea.signInStart" => {
            let url = server_url(os(&p, "url"))?.ok_or_else(|| Error::Invalid("missing the Gitea server".into()))?;
            let id = os(&p, "clientId").map(|i| i.trim().to_string()).filter(|i| !i.is_empty());
            let id = id.ok_or_else(|| Error::Invalid(format!("enter the client ID of the OAuth app registered on {url}")))?;
            let b = oauth::Browser {
                site: "Gitea",
                authorize_url: format!("{url}/login/oauth/authorize"),
                token_url: format!("{url}/login/oauth/access_token"),
                server: url,
                key: "gitea",
                client_id: id,
                secret: None,
                port: 0,
            };
            to(json!({ "url": oauth::browser_start(b).await? }))
        }
        "bitbucket.signInFinish" | "gitea.signInFinish" => {
            let kind = if method.starts_with("gitea") { "gitea" } else { "bitbucket" };
            let (t, b) = oauth::browser_finish(kind).await?;
            let user = match kind {
                "gitea" => Gitea::new(RepoRef::default(), &b.server, t.header()).me().await,
                _ => Bitbucket::new(RepoRef::default(), t.header()).me().await,
            };
            let user = user.ok().filter(|u| !u.is_empty());
            host_connected(k, kind, (kind == "gitea").then_some(b.server), Some(b.client_id), user.clone())?;
            to(json!({ "user": user }))
        }
        m @ ("gitlab.repos" | "bitbucket.repos" | "gitea.repos") => to(k.host_repos(m.split('.').next().unwrap_or("")).await?),
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
                    other => {
                        // The server and OAuth app stay, to sign in again.
                        if let Some(h) = c.integrations.host_mut(other) {
                            h.connected = false;
                            h.user = None;
                        }
                    }
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
        "changelog.latest" => to(json!({ "message": k.changelog_into_latest(&s(&p, "projectId")?, &s(&p, "branch")?).await? })),
        "notes.publish" => {
            let gh = k.pr_host(&s(&p, "projectId")?).await?;
            let url = gh.create_release(&s(&p, "tag")?, &s(&p, "target")?, &s(&p, "name")?, &s(&p, "body")?).await?;
            to(json!({ "url": url }))
        }

        // ---- analytics ----
        "analytics.get" => to(k.analytics(&project_ids(&p), p.get("days").and_then(Value::as_i64).unwrap_or(30), &strings(&p, "emails")).await?),
        "analytics.day" => {
            let date = chrono::NaiveDate::parse_from_str(&s(&p, "date")?, "%Y-%m-%d").map_err(|_| Error::Invalid("date must be YYYY-MM-DD".into()))?;
            to(k.analytics_day(&project_ids(&p), date, &strings(&p, "emails")).await)
        }
        "analytics.sprints" => {
            let count = p.get("count").and_then(Value::as_u64).unwrap_or(6).clamp(2, 12) as usize;
            let fresh = p.get("fresh").and_then(Value::as_bool).unwrap_or(false);
            to(k.sprint_report(&project_ids(&p), count, &strings(&p, "assignees"), fresh).await?)
        }
        "analytics.ask" => {
            let history: Vec<(String, String)> = p
                .get("history")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|h| (h["question"].as_str().unwrap_or("").to_string(), h["answer"].as_str().unwrap_or("").to_string()))
                .collect();
            to(json!({ "answer": k.ask_tickets(&s(&p, "question")?, &os(&p, "data").unwrap_or_default(), &history).await? }))
        }
        "analytics.weekly" => {
            let weeks = p.get("weeks").and_then(Value::as_u64).unwrap_or(12).clamp(4, 52) as usize;
            to(k.weekly_report(&project_ids(&p), weeks).await?)
        }

        other => Err(Error::NotFound(format!("method {other}"))),
    }
}

/// AppleScript that runs `program` in a new Terminal window. The shell gets the path quoted: Claude Desktop's copy is under "Application Support".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn terminal_script(program: &str) -> String {
    let sh = format!("'{}'", program.replace('\'', r"'\''"));
    format!("tell application \"Terminal\" to do script \"{}\"\ntell application \"Terminal\" to activate", sh.replace('\\', r"\\").replace('"', "\\\""))
}

/// Open the user's terminal running `cmd` (used for CLI sign-in).
fn open_terminal(cmd: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("osascript").args(["-e", &terminal_script(cmd)]).spawn()?;
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
            if crate::shell::without_appimage(&mut std::process::Command::new(term)).args(["-e", cmd]).spawn().is_ok() {
                return Ok(());
            }
        }
        Err(Error::Unsupported("no terminal found; run the CLI yourself to sign in".into()))
    }
}

/// Paths copied or linked into new worktrees, joined to both checkouts: `..` or an absolute path would write outside the worktree.
fn worktree_files(v: &Value) -> Result<Vec<String>> {
    let files: Vec<String> = serde_json::from_value(v.clone())?;
    let inside = |f: &String| Path::new(f).components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    match files.iter().find(|f| !inside(f)) {
        Some(bad) => Err(Error::Invalid(format!("“{bad}” is not a path inside the project"))),
        None => Ok(files),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn terminal_script_quotes_the_path_for_the_shell() {
        let s = super::terminal_script("/Users/a/Library/Application Support/Claude/it's/claude");
        assert!(s.starts_with(r#"tell application "Terminal" to do script "'/Users/a/Library/Application Support/Claude/it'\\''s/claude'""#), "{s}");
    }
}
