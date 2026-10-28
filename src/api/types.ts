import type { AdfNode } from "../components/Adf";
// Mirrors the Rust types serialised by gitnetix-core (camelCase).

export type FileStatus = "A" | "M" | "D" | "R" | "C" | " ";

export interface FileChange {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** WIP only: true = staged (in the index), false = unstaged. */
  staged?: boolean;
}

export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
}

export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

/** A changed line picked in a diff: a removal by its old line number, an addition by its new one, with its text. */
export interface LinePick {
  kind: "+" | "-";
  n: number;
  text: string;
}

/** Both versions of a file, base64; null when absent on that side. */
export interface Blobs {
  old: string | null;
  new: string | null;
}

export interface MergePrefs {
  /** Squash the branch into one commit first. */
  squash: boolean;
  /** Who writes the squashed commit's message: "squash | <branch>", or AI. */
  squashMessage: "branch" | "ai";
  /** Rebase and fast-forward instead of a merge commit. */
  rebase: boolean;
  deleteBranch: boolean;
  /** Push the target to origin after. */
  push: boolean;
  /** Let AI resolve the conflicts a merge, rebase, cherry-pick, revert or stash runs into, and carry on. */
  resolveConflicts: boolean;
}

export interface CommitPrefs {
  /** Push the branch after each commit. */
  autoPush: boolean;
}

/** What the other dialogs start with, set in the project's settings. */
export interface DialogPrefs {
  /** How a worktree session ends: keep its branch to continue on, or merge it. */
  finish: "continue" | "merge";
  /** Switch to where the worktree's code lands once it is closed. */
  finishSwitch: boolean;
  /** A new branch gets its own worktree instead of being switched to. */
  newWorktree: boolean;
  /** Start an AI agent on a new branch right away. */
  newAgent: boolean;
  /** Push the default branch and the tag when shipping a release. */
  shipPush: boolean;
  /** Let AI update the release's CHANGELOG.md before shipping it. */
  shipChangelog: boolean;
  /** Also delete a deleted branch on origin. */
  deleteOrigin: boolean;
  /** Also delete the cleaned-up behind branches on origin. */
  cleanupOrigin: boolean;
}

export interface GenLangs {
  commit: string;
  pr: string;
  release: string;
}

export interface Release {
  version: string;
  kind: "next" | "hotfix";
  branch: string;
  base: string;
  createdAt: string;
  shippedAt?: string | null;
  tag?: string | null;
}

export interface BranchMeta {
  kind: string;
  release?: string | null;
  ticket?: string | null;
  worktree?: string | null;
  description?: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  profileId?: string | null;
  genLang: GenLangs;
  merge: MergePrefs;
  commit: CommitPrefs;
  dialogs: DialogPrefs;
  releases: Release[];
  branches: Record<string, BranchMeta>;
  ticketReleases: Record<string, string>;
  aiCommits: string[];
  addedAt: string;
  hidden?: boolean;
  forgottenReleases?: string[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  nextRelease?: string | null;
  runningAgents: number;
  hidden?: boolean;
}

export interface BranchView {
  name: string;
  kind: string;
  short: string;
  worktree?: string | null;
  checkedOut: boolean;
  running: boolean;
  /** An agent on it stopped and waits for the user. */
  waiting: boolean;
  conflict: boolean;
  /** Files with uncommitted changes in its checkout (0 when not checked out). */
  wip: number;
  /** Stashes made on it. */
  stashes: number;
  ahead: number;
  behind: number;
  upstream?: string | null;
  upstreamAhead: number;
  upstreamBehind: number;
  /** Behind or diverged from its upstream only because it was rewritten (rebased, reset): origin's tip was once on the local branch. */
  rewritten: boolean;
  ticket?: string | null;
  /** Exists locally or on origin (false: tracked by Gitnetix but gone). */
  exists: boolean;
  /** All its commits are in the base: merged, nothing new since. */
  merged: boolean;
  /** `merged` by the look of it, not by proof: a pull request carrying its ticket key went into the base after its last commit. Never deleted as merged. */
  likelyMerged: boolean;
  /** Branch it merges into; null for the default branch. */
  parent?: string | null;
  role: "trunk" | "release" | "branch";
  /** Open release it ships in (a release branch: its own version). */
  release?: string | null;
  /** Version this release branch shipped as. */
  shipped?: string | null;
  local: boolean;
  /** Exists on origin. */
  remote: boolean;
  /** The git host protects it (branch protection or a ruleset): it can't be deleted. */
  protected: boolean;
  /** Most likely renamed on origin by someone else (its upstream is gone, this origin branch sits at its tip): following renames it here too. */
  renamedTo?: string | null;
  /** Date of its last commit (ISO 8601). */
  date: string;
  /** Author of its last commit. */
  author: string;
  email: string;
}

export interface Commit {
  sha: string;
  author: string;
  email: string;
  /** Author date (ISO 8601). */
  date: string;
  subject: string;
  body: string;
  /** Tags pointing at it. */
  tags: string[];
  /** Tip of the branch's local copy (a branch's commit list only). */
  local?: boolean;
  /** Tip of the branch's copy on origin (a branch's commit list only). */
  origin?: boolean;
  /** On origin, not pulled into the local branch yet. */
  unpulled?: boolean;
  /** On the local branch, on no origin branch: a hard reset past it loses it. */
  unpushed?: boolean;
}

/** One commit of the commit graph (`workspace.graph`). */
export interface GraphCommit {
  sha: string;
  /** First parent first. */
  parents: string[];
  author: string;
  email: string;
  /** Author date (ISO 8601). */
  date: string;
  subject: string;
  /** Tags pointing at it. */
  tags: string[];
}

/** A branch tip in the commit graph: the local branch, or its origin copy. */
export interface GraphRef {
  name: string;
  remote: boolean;
  sha: string;
}

/** History the graph left out under a shown commit: `count` commits down the first parents of `parent`, back to `join`. */
export interface GraphGap {
  parent: string;
  count: number;
  /** Shown commit the run leads to; none when it runs past what was read. */
  join?: string | null;
}

export interface GraphView {
  /** Newest first per tip, in no overall order. */
  commits: GraphCommit[];
  refs: GraphRef[];
  /** Checked-out branch; null when HEAD is detached. */
  head?: string | null;
  headSha?: string | null;
  gaps: GraphGap[];
}

export interface CleanupResult {
  deleted: string[];
  skipped: { branch: string; reason: string }[];
}

export interface MergeResult {
  into: string;
  sha: string;
  alreadyMerged: boolean;
  deleted: boolean;
  /** Why deleting the branch failed (the merge itself went through). */
  deleteError?: string | null;
  /** The main checkout moved to `into`. */
  switched: boolean;
  /** Why the main checkout didn't move to `into`. */
  stayed?: string | null;
  /** `into` was pushed to origin after the merge. */
  pushed: boolean;
  /** Why pushing `into` failed (the merge itself went through). */
  pushError?: string | null;
  /** Release tag moved to cover new commits: a shipped release merged again into the default branch and pushed. */
  retagged?: string | null;
  /** Why moving or pushing the tag failed (the merge itself went through). */
  tagError?: string | null;
}

export interface RenameResult {
  /** The open release's CHANGELOG.md section was moved to its new version (committed, not pushed). */
  changelog: boolean;
  /** Why committing that section failed; the rename itself went through. */
  changelogError?: string | null;
}

export interface RebaseResult {
  /** Conflicted files where the rebase stopped (empty = done). */
  conflicts: string[];
  /** Upstream that now needs a force push: the branch was already pushed before the rebase. */
  forcePushTo?: string | null;
}

export interface ReleaseView {
  version: string;
  tag: "next" | "hotfix" | "released";
  branch: string;
  base: string;
  open: boolean;
  items: BranchView[];
  note: string;
  /** The release branch itself (open releases only). */
  view?: BranchView | null;
  /** Git tag it shipped as (shipped releases only). */
  tagName?: string | null;
  /** HEAD is detached on its tag. */
  checkedOut: boolean;
}

export interface Overview {
  project: Project;
  currentBranch?: string | null;
  defaultBranch: string;
  releases: ReleaseView[];
  otherBranches: BranchView[];
  defaultView?: BranchView | null;
  /** Every branch (local, origin-only, tracked-but-gone), each with its parent. */
  branches: BranchView[];
  rebasing: boolean;
  /** Branch the main checkout's paused rebase replays onto (the commit when no branch is there). */
  rebaseOnto?: string | null;
  /** The rebase, merge, cherry-pick or revert the main checkout is stopped in the middle of. */
  inProgress?: "rebase" | "merge" | "cherry-pick" | "revert" | null;
  conflicts: string[];
  remote?: string | null;
  /** Every stash, newest first (shared by all worktrees). */
  stashes: Stash[];
  /** The checkout has a CHANGELOG.md at its root. */
  hasChangelog: boolean;
  /** Latest version heading of that CHANGELOG.md. */
  changelogVersion?: string | null;
}

export interface Stash {
  /** Its identity: the stash@{n} position shifts as stashes come and go. */
  sha: string;
  /** Branch it was made on; null from a detached HEAD. */
  branch?: string | null;
  message: string;
  /** When it was made (ISO 8601). */
  date: string;
  /** Holds untracked files too. */
  untracked: boolean;
}

export type SubmoduleState = "uninitialized" | "clean" | "moved" | "conflict" | "missing";

export interface Submodule {
  name: string;
  path: string;
  /** URL in .gitmodules. */
  url: string;
  /** URL the local clone actually uses; null until initialized. */
  localUrl?: string | null;
  /** The local clone fetches from elsewhere than .gitmodules says: a sync is due. */
  urlDrift: boolean;
  /** The repository's page on its host; null for a local or unknown remote. */
  webUrl?: string | null;
  /** Branch `update --remote` follows; null = the remote's default. */
  branch?: string | null;
  state: SubmoduleState;
  /** Commit the project pins. */
  recorded?: string | null;
  /** The pin in the index differs from HEAD's: waiting to be committed. */
  staged: boolean;
  /** Commit checked out in the submodule. */
  head?: string | null;
  /** Branch checked out inside; null = detached. */
  headBranch?: string | null;
  subject?: string | null;
  author?: string | null;
  date?: string | null;
  /** Uncommitted files inside. */
  dirty: number;
  /** Commits checked out that the pin lacks, and the reverse. */
  ahead: number;
  behind: number;
  /** Remote branch compared to, as of the last fetch. */
  upstream?: string | null;
  upstreamBehind: number;
}

export interface StashApplied {
  /** Files left conflicted; the stash is kept then. */
  conflicts: string[];
  /** The stash was dropped (popped cleanly). */
  dropped: boolean;
}

export interface GitProfile {
  id: string;
  label: string;
  name: string;
  email: string;
  sign: boolean;
  signingKey?: string | null;
}

export type ConnectMethod = "cli" | "api";

export interface ProviderConf {
  method: ConnectMethod;
  model: string;
  effort: string;
  baseUrl?: string | null;
  connected: boolean;
}

export interface Route {
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
}

export interface TemplateRule {
  key: string;
  label: string;
  kind: "check" | "number";
  value: boolean | number | string;
}

export interface Template {
  id: string;
  kind: string;
  name: string;
  scope: string;
  isDefault: boolean;
  body: string;
  rules: TemplateRule[];
  model?: string | null;
}

export interface JiraConn {
  /** "" for the connection made before there could be several. */
  id: string;
  baseUrl: string;
  email: string;
  jql?: string | null;
  /** Set when signed in with Atlassian. */
  cloudId?: string | null;
  /** Jira project keys to show; empty = all. */
  projects: string[];
  /** Ids of the projects whose Tickets screen shows it; empty = all. */
  repos: string[];
}

export interface Config {
  version: number;
  projects: Project[];
  profiles: GitProfile[];
  ai: { defaultProvider: string; providers: Record<string, ProviderConf>; routing: Record<string, Route> };
  templates: Template[];
  integrations: {
    githubApi?: string | null;
    githubConnected: boolean;
    githubUser?: string | null;
    azureConnected: boolean;
    azureUser?: string | null;
    jira: JiraConn[];
    /** `id` "" = the connection from before there could be several; `repos`: ids of the projects whose Tickets screen shows it, empty = all. */
    trello: { id: string; apiKey: string; boardId?: string | null; repos: string[] }[];
    asana: { id: string; workspaceGid: string; projectGid?: string | null; repos: string[] }[];
  };
  ui: {
    language: string;
    theme: string;
    lastProject?: string | null;
    /** How the screens were left (pane widths, collapsed sections…), by key. */
    view: Record<string, string>;
    /** Animations turned off, by id (see `ANIMATIONS`). */
    animationsOff: string[];
    /** Languages dictation listens for, as Whisper codes; empty = any. */
    dictationLanguages: string[];
    /** The language the last dictation was mostly in. */
    spokenLanguage?: string | null;
    /** AI rewrites each dictation with the project's context, when a provider is set up. */
    dictationPolish: boolean;
  };
  server: { enabled: boolean; port: number; lan: boolean; token: string };
}

export type AgentStatus = "running" | "waiting" | "paused" | "failed" | "done" | "stopped";

/** A line of the app's Logs page: what it tried and what failed. */
export interface LogEntry {
  at: string;
  error: boolean;
  text: string;
}

export interface LogLine {
  kind: "cmd" | "ai" | "ok" | "dim" | "err" | "wait" | "run";
  text: string;
}

export interface AgentSession {
  id: string;
  projectId: string;
  branch: string;
  cwd: string;
  worktree: boolean;
  status: AgentStatus;
  request: string;
  agentLabel: string;
  lines: LogLine[];
  startedAt: string;
  updatedAt: string;
  resumeId?: string | null;
  /** What the session runs on; missing on sessions from before routing. */
  ai?: { provider: string; model: string; effort: string } | null;
  /** Messages sent while it works, in order; they go out together when the run ends. */
  queued: string[];
}

/** One project in the terminal's command menu (a package.json, a Cargo.toml, a compose file…): its title and each command with the command line that runs it from the checkout root. */
export interface Scripts {
  title: string;
  scripts: [string, string][];
}

/** A checkout's terminal: the main checkout's is shared by every branch on it, each worktree has its own. */
export interface ShellSnapshot {
  /** Canonical checkout path, the terminal's key. */
  cwd: string;
  /** Recent output, base64. */
  data: string;
  /** Bytes output so far; `shellData` events past it follow `data`. */
  end: number;
}

export interface WorktreeView {
  projectId: string;
  projectName: string;
  path: string;
  branch?: string | null;
  main: boolean;
  base?: string | null;
  ticket?: string | null;
  additions: number;
  deletions: number;
  /** Commits not in `base` yet: with `wip`, what a merge would carry. */
  ahead: number;
  /** Commits in `base` not in the branch yet. */
  behind: number;
  /** Files with uncommitted changes. */
  wip: number;
  agent?: AgentSession | null;
}

export interface ModelInfo {
  id: string;
  label: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  mono: string;
  maker: string;
  bin?: string | null;
  methods: ConnectMethod[];
  effort: boolean;
  local: boolean;
  needsUrl: boolean;
  models: ModelInfo[];
}

export interface ProviderStatus {
  id: string;
  status: "connected" | "detected" | "none";
  cliPath?: string | null;
  hasKey: boolean;
}

export interface AiCatalog {
  providers: { info: ProviderInfo; status: ProviderStatus | null; conf: ProviderConf | null }[];
  defaultProvider: string;
  routing: Record<string, Route>;
}

export interface PrSummary {
  number: number;
  title: string;
  head: string;
  base: string;
  state: "open" | "draft" | "merged" | "closed";
  author: string;
  mine: boolean;
  reviewRequested: boolean;
  updatedAt: string;
  url: string;
}

export interface Reaction {
  content: string;
  emoji: string;
  count: number;
  mine: boolean;
}

export interface PrComment {
  id: string;
  databaseId?: number | null;
  author: string;
  body: string;
  createdAt: string;
  reactions: Reaction[];
  canEdit: boolean;
}

export interface PrThread {
  id: string;
  path?: string | null;
  line?: number | null;
  resolved: boolean;
  resolvable: boolean;
  snippet: string[];
  comments: PrComment[];
  /** A review's summary text, with the vote it came with. */
  review?: "approve" | "changes" | "comment" | null;
}

export interface PrDetail extends PrSummary {
  body: string;
  conflict: boolean;
  mergeable?: boolean | null;
  checks: { name: string; status: "pass" | "fail" | "run" | "wait"; url?: string | null }[];
  reviewers: { login: string; vote: "approve" | "changes" | "comment" | "pending" }[];
  threads: PrThread[];
}

export interface Ticket {
  key: string;
  /** The tracker's own id: Jira key, Trello card id, Asana task gid. */
  id: string;
  /** Id of the connection it comes from. */
  conn: string;
  source: "jira" | "trello" | "asana";
  title: string;
  kind: string;
  status: "todo" | "progress" | "review" | "ready" | "done";
  statusLabel: string;
  assignee: string;
  mine: boolean;
  description: string;
  /** Jira's description as Atlassian Document Format. */
  doc?: AdfNode;
  criteria: { text: string; done: boolean }[];
  comments: number;
  url: string;
  whereLabel: string;
  /** The Jira project, Trello board or Asana project it comes from. */
  place: string;
  /** Jira fix versions ("Versions corrigées"), as named there. */
  fixVersions?: string[];
  /** Jira priority name. */
  priority?: string;
  /** Jira time left and original estimate, as Jira writes them ("3h", "1d 2h"). */
  timeRemaining?: string;
  timeEstimate?: string;
  /** Jira parent (epic or story). */
  parentKey?: string;
  parentTitle?: string;
  parentUrl?: string;
  release: string;
  branch?: string | null;
  /** Project holding `branch` when it is another one linked to the same tracker. */
  branchProject?: string | null;
}

/** A status a ticket can move to: a Jira transition, Trello list or Asana section. */
export interface StatusOption {
  id: string;
  name: string;
  status: Ticket["status"];
}

export interface Suggestion {
  key: string;
  kind: string;
  release: string;
  reason: string;
}

export interface Analytics {
  rangeDays: number;
  kpis: { label: string; value: string; delta: string }[];
  days: { date: string; weekend: boolean; total: number; authors: [string, number][]; subjects: string[] }[];
  releases: { project: string; version: string; shipped: string; features: number; fixes: number; leadDays: number; leadHours: number; aiPct: number; featureTitles: string[]; fixTitles: string[]; branches: string[] }[];
}

export interface DayCommit {
  sha: string;
  author: string;
  subject: string;
  /** Empty when no branch holds it any more. */
  branch: string;
  project: string;
}

export type GitnetixEvent =
  | { type: "agentLine"; sessionId: string; line: LogLine }
  | { type: "agentStatus"; sessionId: string; status: AgentStatus }
  | { type: "projectChanged"; projectId: string }
  | { type: "configChanged" }
  | { type: "cleanupStep"; projectId: string; branch: string }
  | { type: "conflictResolving"; projectId: string; files: string[] }
  | { type: "log"; entry: LogEntry }
  | { type: "shellData"; cwd: string; data: string; end: number }
  | { type: "shellExit"; cwd: string }
  | { type: "dictationModel"; done: number; total: number }
  | { type: "overviewProgress"; projectId: string; done: number; total: number }
  | { type: "filesProgress"; projectId: string; done: number; total: number };
