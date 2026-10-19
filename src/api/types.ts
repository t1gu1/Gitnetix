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
}

export interface CommitPrefs {
  /** Push the branch after each commit. */
  autoPush: boolean;
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
  /** Diverged from its upstream only because it was rewritten (rebased): origin's tip was once on the local branch. */
  rewritten: boolean;
  ticket?: string | null;
  /** Exists locally or on origin (false: tracked by Gitnetix but gone). */
  exists: boolean;
  /** All its commits are in the base: merged, nothing new since. */
  merged: boolean;
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
  /** Date of its last commit (ISO 8601). */
  date: string;
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
  conflicts: string[];
  remote?: string | null;
  /** Every stash, newest first (shared by all worktrees). */
  stashes: Stash[];
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
    jira?: { baseUrl: string; email: string; jql?: string | null } | null;
    trello?: { apiKey: string; boardId?: string | null } | null;
    asana?: { workspaceGid: string; projectGid?: string | null } | null;
  };
  ui: {
    language: string;
    theme: string;
    lastProject?: string | null;
    /** How the screens were left (pane widths, collapsed sections…), by key. */
    view: Record<string, string>;
  };
  server: { enabled: boolean; port: number; lan: boolean; token: string };
}

export type AgentStatus = "running" | "waiting" | "paused" | "failed" | "done" | "stopped";

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
  checks: { name: string; status: "pass" | "fail" | "run" }[];
  reviewers: { login: string; vote: "approve" | "changes" | "comment" | "pending" }[];
  threads: PrThread[];
}

export interface Ticket {
  key: string;
  source: "jira" | "trello" | "asana";
  title: string;
  kind: string;
  status: "todo" | "progress" | "review" | "ready" | "done";
  statusLabel: string;
  assignee: string;
  mine: boolean;
  description: string;
  criteria: { text: string; done: boolean }[];
  comments: number;
  url: string;
  whereLabel: string;
  release: string;
  branch?: string | null;
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
  releases: { version: string; shipped: string; features: number; fixes: number; leadDays: number; aiPct: number }[];
}

export type GitnetixEvent =
  | { type: "agentLine"; sessionId: string; line: LogLine }
  | { type: "agentStatus"; sessionId: string; status: AgentStatus }
  | { type: "projectChanged"; projectId: string }
  | { type: "configChanged" };
