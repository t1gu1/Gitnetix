import { useEffect } from "react";
import { QueryClient, useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";

import { isLocal, rpc, subscribe } from "./transport";
import type {
  AgentSession,
  AiCatalog,
  Analytics,
  Blobs,
  BranchView,
  Commit,
  CommitPrefs,
  DayCommit,
  DialogPrefs,
  LogEntry,
  Config,
  FileChange,
  GraphView,
  Hunk,
  MergePrefs,
  Overview,
  PrDetail,
  PrSummary,
  ProjectSummary,
  Submodule,
  Template,
  StatusOption,
  Ticket,
  WorktreeView,
} from "./types";
import { shownStatus } from "../lib/agentLog";
import { dictationModel } from "../lib/dictation";
import { sayIn, toast } from "../lib/toast";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5_000 },
  },
});

/** Keep the cache in sync with what the engine pushes. */
export function useEngineEvents() {
  const qc = useQueryClient();
  useEffect(
    () =>
      subscribe((e) => {
        switch (e.type) {
          case "dictationModel":
            dictationModel(e.done, e.total);
            break;
          case "overviewProgress":
            qc.setQueryData(["overviewProgress", e.projectId], { done: e.done, total: e.total });
            break;
          case "filesProgress":
            qc.setQueryData<FilesProgress | null>(["filesProgress", e.projectId], (prev) => filesProgressStep(prev, e.done, e.total, Date.now()));
            break;
          case "agentLine":
            // A message of yours going out takes the queued ones with it.
            qc.setQueryData<AgentSession[]>(["agents"], (list) =>
              list?.map((s) => (s.id === e.sessionId ? { ...s, lines: [...s.lines.slice(-1999), e.line], queued: e.line.kind === "cmd" ? [] : s.queued } : s)),
            );
            break;
          case "agentStatus": {
            // Phone: buzz when a run needs the user. Only while the page is open; plain-HTTP LAN pages can't push notifications.
            const prev = qc.getQueryData<AgentSession[]>(["agents"])?.find((s) => s.id === e.sessionId);
            qc.setQueryData<AgentSession[]>(["agents"], (list) =>
              list?.map((s) => (s.id === e.sessionId ? { ...s, status: e.status } : s)),
            );
            qc.invalidateQueries({ queryKey: ["agents"] });
            qc.invalidateQueries({ queryKey: ["worktrees"] });
            qc.invalidateQueries({ queryKey: ["projects"] });
            qc.invalidateQueries({ queryKey: ["overview"] });
            qc.invalidateQueries({ queryKey: ["files"] });
            if (!isLocal && prev?.status !== e.status && (e.status === "waiting" || e.status === "failed")) {
              navigator.vibrate?.([200, 100, 200]);
              const on = prev ? ` on ${prev.branch}` : "";
              if (e.status === "failed") toast(`Agent${on} failed`, "error");
              else {
                // Done when its merge options show, which takes the branch's fresh commits and WIP: after the invalidation above, so this joins its refetch.
                const s = prev && { ...prev, status: e.status };
                qc.fetchQuery({ queryKey: ["worktrees"], queryFn: () => rpc<WorktreeView[]>("worktrees.list"), staleTime: 0 })
                  .catch(() => [] as WorktreeView[])
                  .then((wts) => toast(`Agent${on} ${s && shownStatus(s, wts.find((w) => w.path === s.cwd)) === "done" ? "is done" : "is waiting for you"}`, "info", 8000));
              }
            }
            break;
          }
          case "projectChanged":
            qc.invalidateQueries({ queryKey: ["overview", e.projectId] });
            qc.invalidateQueries({ queryKey: ["files", e.projectId] });
            qc.invalidateQueries({ queryKey: ["diff", e.projectId] });
            qc.invalidateQueries({ queryKey: ["blobs", e.projectId] });
            qc.invalidateQueries({ queryKey: ["commits", e.projectId] });
            qc.invalidateQueries({ queryKey: ["worktrees"] });
            qc.invalidateQueries({ queryKey: ["projects"] });
            qc.invalidateQueries({ queryKey: ["submodules", e.projectId] });
            break;
          case "conflictResolving": {
            const text = `Conflicts in ${e.files.join(", ")}: resolving them with AI. This can take a few minutes; Menu › Logs shows progress.`;
            // A merge running in the background says it in its own toast.
            if (!sayIn(e.projectId, text)) toast(text, "info", 12_000);
            break;
          }
          case "log":
            qc.setQueryData<LogEntry[]>(["log"], (l) => l && [...l.slice(-1999), e.entry]);
            break;
          case "configChanged":
            qc.invalidateQueries({ queryKey: ["config"] });
            qc.invalidateQueries({ queryKey: ["projects"] });
            qc.invalidateQueries({ queryKey: ["ai"] });
            break;
        }
      }),
    [qc],
  );
}

const MERGE_DEFAULTS: MergePrefs = { squash: false, squashMessage: "branch", rebase: false, deleteBranch: true, push: false, resolveConflicts: true };
const COMMIT_DEFAULTS: CommitPrefs = { autoPush: false };
const DIALOG_DEFAULTS: DialogPrefs = { finish: "merge", finishSwitch: true, newWorktree: false, newAgent: false, shipPush: true, shipChangelog: true, deleteOrigin: false, cleanupOrigin: true };

type PrefsPatch = { merge?: Partial<MergePrefs>; commit?: Partial<CommitPrefs>; dialogs?: Partial<DialogPrefs> };

/** A project's remembered merge, commit and dialog options. Changes show at once, then save. */
export function useProjectPrefs(projectId?: string) {
  const qc = useQueryClient();
  const project = useConfig().data?.projects.find((p) => p.id === projectId);
  const save = useMutation<unknown, Error, PrefsPatch>({
    mutationFn: (patch) => rpc("projects.setPrefs", { projectId, ...patch }),
    onMutate: (patch) =>
      qc.setQueryData<Config>(["config"], (c) =>
        c && {
          ...c,
          projects: c.projects.map((p) =>
            p.id === projectId
              ? { ...p, merge: { ...MERGE_DEFAULTS, ...p.merge, ...patch.merge }, commit: { ...COMMIT_DEFAULTS, ...p.commit, ...patch.commit }, dialogs: { ...DIALOG_DEFAULTS, ...p.dialogs, ...patch.dialogs } }
              : p,
          ),
        },
      ),
    onError: (e) => toast(e.message, "error"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });
  return {
    merge: { ...MERGE_DEFAULTS, ...project?.merge },
    commit: { ...COMMIT_DEFAULTS, ...project?.commit },
    dialogs: { ...DIALOG_DEFAULTS, ...project?.dialogs },
    setMerge: (merge: Partial<MergePrefs>) => save.mutate({ merge }),
    setCommit: (commit: Partial<CommitPrefs>) => save.mutate({ commit }),
    setDialogs: (dialogs: Partial<DialogPrefs>) => save.mutate({ dialogs }),
  };
}

export const useConfig = () => useQuery({ queryKey: ["config"], queryFn: () => rpc<Config>("config.get") });
export const useLog = () => useQuery({ queryKey: ["log"], queryFn: () => rpc<LogEntry[]>("log.get"), staleTime: Infinity });
export const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: () => rpc<ProjectSummary[]>("projects.list") });

/**
 * The overview right after switching to `branch`, or to `tag` (detached HEAD, `branch` null): it is the
 * checked-out one now and the uncommitted work came along. Counts and the rest wait for the engine's full answer, which can take a while on a big repository.
 */
export function switchedOverview(o: Overview, branch: string | null, tag?: string): Overview {
  const from = o.currentBranch;
  const wip = o.branches.find((b) => b.name === from && !b.worktree)?.wip ?? 0;
  const mark = (b: BranchView): BranchView =>
    b.name === branch ? { ...b, checkedOut: true, wip: b.wip + wip } : b.name === from && !b.worktree ? { ...b, checkedOut: false, wip: 0 } : b;
  return {
    ...o,
    currentBranch: branch,
    branches: o.branches.map(mark),
    otherBranches: o.otherBranches.map(mark),
    defaultView: o.defaultView && mark(o.defaultView),
    releases: o.releases.map((r) => ({ ...r, checkedOut: !!tag && r.tagName === tag, view: r.view && mark(r.view) })),
  };
}

/** `o` with branch `name`'s view put through `f`, wherever it shows. */
export function patchBranch(o: Overview, name: string, f: (b: BranchView) => BranchView): Overview {
  const mark = (b: BranchView) => (b.name === name ? f(b) : b);
  return {
    ...o,
    branches: o.branches.map(mark),
    otherBranches: o.otherBranches.map(mark),
    defaultView: o.defaultView && mark(o.defaultView),
    releases: o.releases.map((r) => ({ ...r, items: r.items.map(mark), view: r.view && mark(r.view) })),
  };
}

/** Show at once what an action did to branch `name`; the refreshed overview replaces it. */
export const patchOverview = (qc: QueryClient, pid: string, name: string, f: (b: BranchView) => BranchView) =>
  qc.setQueryData<Overview>(["overview", pid], (o) => o && patchBranch(o, name, f));

/** Put what an action did in the cache once the reloads of `keys` started before it ended are cancelled: landing after, they would undo it. */
export async function settle(qc: QueryClient, keys: unknown[][], patch: () => void) {
  await Promise.all(keys.map((k) => qc.cancelQueries({ queryKey: k })));
  patch();
}

/** A branch once a commit lands on it: one more of its own and to push, so not merged any more. */
export const committed = (b: BranchView): BranchView => ({
  ...b,
  ahead: b.parent ? b.ahead + 1 : b.ahead,
  upstreamAhead: b.upstream ? b.upstreamAhead + 1 : b.upstreamAhead,
  merged: false,
  likelyMerged: false,
});

/** A branch once pushed: origin has all its commits (`force`: and nothing else). */
export const pushed = (b: BranchView, force = false): BranchView => ({
  ...b,
  upstream: b.upstream ?? `origin/${b.name}`,
  remote: true,
  upstreamAhead: 0,
  ...(force ? { upstreamBehind: 0, rewritten: false } : {}),
});

/** The overview once branch `name` is deleted here (`remote`: from origin too). One origin keeps stays, origin-only. */
export function deletedOverview(o: Overview, name: string, remote: boolean): Overview {
  if (!remote && o.branches.some((b) => b.name === name && b.remote)) return patchBranch(o, name, (b) => ({ ...b, local: false, checkedOut: false, worktree: null, wip: 0 }));
  const drop = (l: BranchView[]) => l.filter((b) => b.name !== name);
  return { ...o, branches: drop(o.branches), otherBranches: drop(o.otherBranches), releases: o.releases.map((r) => ({ ...r, items: drop(r.items) })) };
}

/** Show at once that branch `name` is deleted (`remote`: from origin too); the refreshed overview replaces it. */
export const droppedBranch = (qc: QueryClient, pid: string, name: string, remote: boolean) =>
  settle(qc, [["overview", pid]], () => qc.setQueryData<Overview>(["overview", pid], (o) => o && deletedOverview(o, name, remote)));

/** Show at once that `branch`'s worktree at `path` is gone, its agent sessions with it; the refreshed lists replace this. */
export const droppedWorktree = (qc: QueryClient, pid: string, branch: string, path: string) =>
  settle(qc, [["worktrees"], ["worktreesSaved"], ["agents"], ["overview", pid]], () => {
    for (const k of [["worktrees"], ["worktreesSaved"]]) qc.setQueryData<WorktreeView[] | null>(k, (l) => l?.filter((w) => w.path !== path));
    qc.setQueryData<AgentSession[]>(["agents"], (l) => l?.filter((a) => a.cwd !== path));
    patchOverview(qc, pid, branch, (b) => (b.worktree === path ? { ...b, worktree: null, checkedOut: false, wip: 0 } : b));
  });

/** Cache key of a branch's uncommitted files, as `useFiles(pid, branch, "wip")` reads them. */
export const wipKey = (pid: string, branch: string) => ["files", pid, branch, "wip", undefined, undefined];

/** Show a branch's uncommitted files as `f` leaves them, and their count on its row, ahead of the refresh. */
export function patchWip(qc: QueryClient, pid: string, branch: string, f: (list: FileChange[]) => FileChange[]) {
  const left = f(qc.getQueryData<FileChange[]>(wipKey(pid, branch)) ?? []);
  qc.setQueryData(wipKey(pid, branch), left);
  const wip = new Set(left.map((x) => x.path)).size;
  patchOverview(qc, pid, branch, (b) => ({ ...b, wip }));
}

/** WIP files once `paths` (none: the whole side) move to the `staged` side. A partly staged file keeps one line. */
export function movedWip(list: FileChange[], paths: string[], staged: boolean): FileChange[] {
  const picked = new Set(paths);
  const moves = (f: FileChange) => !!f.staged !== staged && (!paths.length || picked.has(f.path));
  const moving = new Set(list.filter(moves).map((f) => f.path));
  return list.filter((f) => moves(f) || !(!!f.staged === staged && moving.has(f.path))).map((f) => (moves(f) ? { ...f, staged } : f));
}

/** WIP files once `paths` (none: the whole side) are discarded: unstaged edits only, or with `staged` the files' every change. */
export function discardedWip(list: FileChange[], paths: string[], staged: boolean): FileChange[] {
  const picked = new Set(paths);
  const gone = new Set(list.filter((f) => !!f.staged === staged && (!paths.length || picked.has(f.path))).map((f) => f.path));
  return list.filter((f) => !gone.has(f.path) || (!staged && f.staged));
}

/** How far a long stage, unstage or discard has got, as the engine reports it every thousand files.
 * `left`: seconds to go at the pace since its first report, once there is a second of it. */
export type FilesProgress = { done: number; total: number; left?: number; since: { done: number; at: number } };

export function filesProgressStep(prev: FilesProgress | null | undefined, done: number, total: number, now: number): FilesProgress {
  const since = prev && prev.total === total && prev.done <= done ? prev.since : { done, at: now };
  const secs = (now - since.at) / 1000;
  const left = secs >= 1 && done > since.done ? ((total - done) * secs) / (done - since.done) : undefined;
  return { done, total, left, since };
}

export const useFilesProgress = (projectId: string) =>
  useQuery<FilesProgress | null>({ queryKey: ["filesProgress", projectId], queryFn: () => null, enabled: false, staleTime: Infinity }).data;

/** Forget the last run's progress before starting one, so its end doesn't show as this one's. */
export const resetFilesProgress = (qc: QueryClient, projectId: string) => qc.setQueryData(["filesProgress", projectId], null);

/** How far a long rebuild of the project's branches has got, as the engine reports it. */
export const useOverviewProgress = (projectId?: string) =>
  useQuery<{ done: number; total: number } | null>({ queryKey: ["overviewProgress", projectId], queryFn: () => null, enabled: false, staleTime: Infinity }).data;

export const useOverview = (projectId?: string) => {
  const qc = useQueryClient();
  // First look at a project: a quick answer (no counts or merge state yet) shows its
  // branches while the full one builds. Only asked until the full one has arrived once.
  const quick = useQuery({
    queryKey: ["overviewQuick", projectId],
    queryFn: () => rpc<Overview>("workspace.overview", { projectId, quick: true }),
    enabled: !!projectId && qc.getQueryData(["overview", projectId]) === undefined,
    staleTime: Infinity,
  });
  return useQuery({
    queryKey: ["overview", projectId],
    queryFn: () => rpc<Overview>("workspace.overview", { projectId }),
    enabled: !!projectId,
    placeholderData: quick.data,
  });
};

/** Version for a new release: the next one after the latest tag or release branch. */
export const useSuggestedVersion = (projectId: string, kind: "next" | "hotfix", enabled: boolean) =>
  useQuery({
    queryKey: ["suggestVersion", projectId, kind],
    queryFn: () => rpc<{ version: string }>("releases.suggestVersion", { projectId, kind }),
    enabled,
    // Tags and releases change behind it: ask again each time the dialog opens, never show an old answer.
    staleTime: 0,
    gcTime: 0,
  });

/** `commit` lists that commit's files instead of the branch's, `stash` that stash's. */
export const useFiles = (projectId?: string, branch?: string, mode = "branch", commit?: string, stash?: string) =>
  useQuery({
    queryKey: ["files", projectId, branch, mode, commit, stash],
    queryFn: () =>
      stash
        ? rpc<FileChange[]>("stashes.files", { projectId, sha: stash })
        : rpc<FileChange[]>("workspace.files", { projectId, branch, mode, commit }),
    enabled: !!projectId && (!!branch || !!stash),
    refetchInterval: mode === "wip" && !commit && !stash ? 4_000 : false,
  });

/** `full` keeps the whole file as context. */
export const useDiff = (projectId?: string, branch?: string, mode = "branch", path?: string, staged?: boolean, commit?: string, stash?: string, full = false) =>
  useQuery({
    queryKey: ["diff", projectId, branch, mode, path, staged, commit, stash, full],
    queryFn: () =>
      stash
        ? rpc<Hunk[]>("stashes.diff", { projectId, sha: stash, path, full })
        : rpc<Hunk[]>("workspace.diff", { projectId, branch, mode, path, staged, commit, full }),
    enabled: !!projectId && (!!branch || !!stash) && !!path,
  });

/** Both versions of one file (image previews), picked like `useDiff`. */
export const useBlobs = (projectId?: string, branch?: string, mode = "branch", path?: string, staged?: boolean, commit?: string, stash?: string, enabled = true) =>
  useQuery({
    queryKey: ["blobs", projectId, branch, mode, path, staged, commit, stash],
    queryFn: () =>
      stash
        ? rpc<Blobs>("stashes.blobs", { projectId, sha: stash, path })
        : rpc<Blobs>("workspace.blobs", { projectId, branch, mode, path, staged, commit }),
    enabled: enabled && !!projectId && (!!branch || !!stash) && !!path,
  });

/** A file sent to agent `id`, base64 (image previews in its log); saved once, it never changes. */
export const useAgentFile = (id?: string, path?: string, enabled = true) =>
  useQuery({
    queryKey: ["agentFile", id, path],
    queryFn: () => rpc<string>("agents.file", { id, path }),
    enabled: enabled && !!id && !!path,
    staleTime: Infinity,
  });

export const useCommits = (projectId?: string, branch?: string) =>
  useQuery({
    queryKey: ["commits", projectId, branch],
    queryFn: () => rpc<Commit[]>("workspace.commits", { projectId, branch }),
    enabled: !!projectId && !!branch,
  });

/**
 * Commit graph of `branches`. Under the commit lists' key, so whatever refreshes those (an action, a change in git)
 * refreshes it too; `state` stands for what the overview says of those branches, so a fetch that moves origin's tips does as well.
 * The previous graph stays on screen while the next one loads.
 */
export const useGraph = (projectId: string | undefined, branches: string[], state: string, enabled: boolean) =>
  useQuery({
    queryKey: ["commits", projectId, { graph: branches, state }],
    queryFn: () => rpc<GraphView>("workspace.graph", { projectId, branches }),
    enabled: enabled && !!projectId && branches.length > 0,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === projectId ? prev : undefined),
  });

/** Fetch origin (pruning branches deleted there) when a project opens, then every 5 minutes. Quiet on failure: it runs unasked. */
export const useAutoFetch = (projectId?: string, enabled = true) => {
  const qc = useQueryClient();
  useQuery({
    queryKey: ["autoFetch", projectId],
    queryFn: async () => {
      await rpc("branches.fetch", { projectId }).catch(() => {});
      qc.invalidateQueries({ queryKey: ["overview", projectId] });
      return null;
    },
    enabled: enabled && !!projectId,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
};

export const useAgents = () =>
  useQuery({ queryKey: ["agents"], queryFn: () => rpc<AgentSession[]>("agents.list") });

export const useWorktrees = () => {
  const qc = useQueryClient();
  // The list as last built, kept on disk (agents left out): shows at once, even after a restart,
  // while the fresh one builds. Only asked until that has arrived once.
  const saved = useQuery({
    queryKey: ["worktreesSaved"],
    queryFn: () => rpc<WorktreeView[] | null>("worktrees.list", { cached: true }),
    enabled: qc.getQueryData(["worktrees"]) === undefined,
    staleTime: Infinity,
  });
  return useQuery({
    queryKey: ["worktrees"],
    queryFn: () => rpc<WorktreeView[]>("worktrees.list"),
    refetchInterval: 10_000,
    placeholderData: saved.data ?? undefined,
  });
};

export const useSubmodules = (projectId?: string) =>
  useQuery({
    queryKey: ["submodules", projectId],
    queryFn: () => rpc<Submodule[]>("submodules.list", { projectId }),
    enabled: !!projectId,
    refetchInterval: 15_000,
  });

export const useAiCatalog = () => useQuery({ queryKey: ["ai"], queryFn: () => rpc<AiCatalog>("ai.catalog") });

/** Whether AI can run `task`: same lookup the backend does, its route's provider else the default. True while loading. */
export function useAiOn(task: string): boolean {
  const ai = useAiCatalog().data;
  const provider = ai && (ai.routing[task]?.provider || ai.defaultProvider);
  return !ai || !!ai.providers.find((p) => p.info.id === provider)?.conf;
}

export const useTemplates = () =>
  useQuery({
    queryKey: ["templates"],
    queryFn: () =>
      rpc<{ templates: Template[]; kinds: { id: string; label: string; variables: { name: string; hint: string }[] }[] }>(
        "templates.list",
      ),
  });

export const usePrs = (projectId?: string) =>
  useQuery({
    queryKey: ["prs", projectId],
    queryFn: () => rpc<{ provider: string; repo: { owner: string; repo: string }; items: PrSummary[] }>("prs.list", { projectId }),
    enabled: !!projectId,
    retry: false,
  });

export const usePr = (projectId?: string, number?: number) =>
  useQuery({
    queryKey: ["pr", projectId, number],
    queryFn: () => rpc<PrDetail>("prs.get", { projectId, number }),
    enabled: !!projectId && !!number,
    retry: false,
  });

export const useTickets = (projectId?: string, mine = false, sprint = false) =>
  useQuery({
    queryKey: ["tickets", projectId, mine, sprint],
    queryFn: () => rpc<{ sources: string[]; tickets: Ticket[]; syncedAt?: string }>("tickets.list", { projectId, mine, sprint }),
    // Toggling a filter keeps the list on screen while it refetches.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === projectId ? prev : undefined),
    enabled: !!projectId,
    retry: false,
    staleTime: 60_000,
  });

export const useTicketStatuses = (t?: Ticket) =>
  useQuery({
    queryKey: ["ticketStatuses", t?.source, t?.conn, t?.id, t?.statusLabel],
    queryFn: () => rpc<StatusOption[]>("tickets.statuses", { source: t!.source, conn: t!.conn, id: t!.id }),
    enabled: !!t?.id,
    retry: false,
    staleTime: 60_000,
  });

export const useFixVersions = (t?: Ticket) =>
  useQuery({
    queryKey: ["fixVersions", t?.conn, t?.key],
    queryFn: () => rpc<{ id: string; name: string; released: boolean; archived: boolean }[]>("jira.versions", { id: t!.conn, key: t!.key }),
    enabled: t?.source === "jira",
    retry: false,
    staleTime: 60_000,
  });

/** Stats over `projectIds`; an empty list means every project. */
export const useAnalytics = (projectIds: string[], days: number) =>
  useQuery({
    queryKey: ["analytics", [...projectIds].sort(), days],
    queryFn: () => rpc<Analytics>("analytics.get", { projectIds, days }),
    staleTime: 60_000,
  });

/** Commits authored on `date` over `projectIds`, with the branch each was made on. */
export const useAnalyticsDay = (projectIds: string[], date: string) =>
  useQuery({
    queryKey: ["analyticsDay", [...projectIds].sort(), date],
    queryFn: () => rpc<DayCommit[]>("analytics.day", { projectIds, date }),
    staleTime: 60_000,
  });

/** Branches of a project a method (or any of several) is running on right now, wherever it was started. */
export function usePendingBranches(method: string | string[], projectId: string): string[] {
  const methods = ([] as string[]).concat(method);
  const vars = useMutationState({
    filters: { status: "pending", predicate: (m) => methods.includes(m.options.mutationKey?.[0] as string) },
    select: (m) => m.state.variables as { projectId?: string; branch?: string } | undefined,
  });
  return vars.flatMap((v) => (v?.projectId === projectId && v.branch ? [v.branch] : []));
}

/**
 * Fire an RPC from a button: shows errors as toasts and refreshes the
 * given query keys afterwards.
 */

export function useAction<T = unknown, V extends Record<string, unknown> = Record<string, unknown>>(
  method: string,
  opts: {
    invalidate?: unknown[][];
    success?: string | ((r: T) => string | undefined);
    /** Updates the cache with what is already known, so it shows before the invalidated queries come back. */
    patch?: (qc: QueryClient, vars: V, r: T) => void;
    /** Handles an error itself (returns true): no toast then. */
    onError?: (e: Error, vars: V) => boolean;
  } = {},
) {
  const qc = useQueryClient();
  return useMutation<T, Error, V>({
    // Keyed by method so other screens can tell it is running (e.g. a push started from the commit box).
    mutationKey: [method],
    mutationFn: (vars) => rpc<T>(method, vars),
    onSuccess: async (r, vars) => {
      const { patch } = opts;
      if (patch) await settle(qc, opts.invalidate ?? [], () => patch(qc, vars, r));
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
      const msg = typeof opts.success === "function" ? opts.success(r) : opts.success;
      if (msg) toast(msg, "ok");
    },
    onError: (e, vars) => opts.onError?.(e, vars) || toast(e.message, "error"),
  });
}
