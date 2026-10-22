import { useEffect } from "react";
import { QueryClient, useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";

import { rpc, subscribe } from "./transport";
import type {
  AgentSession,
  AiCatalog,
  Analytics,
  Blobs,
  BranchView,
  Commit,
  CommitPrefs,
  Config,
  FileChange,
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
import { toast } from "../lib/toast";

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
          case "agentLine":
            qc.setQueryData<AgentSession[]>(["agents"], (list) =>
              list?.map((s) => (s.id === e.sessionId ? { ...s, lines: [...s.lines.slice(-1999), e.line] } : s)),
            );
            break;
          case "agentStatus":
            qc.setQueryData<AgentSession[]>(["agents"], (list) =>
              list?.map((s) => (s.id === e.sessionId ? { ...s, status: e.status } : s)),
            );
            qc.invalidateQueries({ queryKey: ["agents"] });
            qc.invalidateQueries({ queryKey: ["worktrees"] });
            qc.invalidateQueries({ queryKey: ["projects"] });
            qc.invalidateQueries({ queryKey: ["overview"] });
            qc.invalidateQueries({ queryKey: ["files"] });
            break;
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

const MERGE_DEFAULTS: MergePrefs = { squash: false, squashMessage: "branch", rebase: false, deleteBranch: true, push: false };
const COMMIT_DEFAULTS: CommitPrefs = { autoPush: false };

type PrefsPatch = { merge?: Partial<MergePrefs>; commit?: Partial<CommitPrefs> };

/** A project's remembered merge and commit options. Changes show at once, then save. */
export function useProjectPrefs(projectId?: string) {
  const qc = useQueryClient();
  const project = useConfig().data?.projects.find((p) => p.id === projectId);
  const save = useMutation<unknown, Error, PrefsPatch>({
    mutationFn: (patch) => rpc("projects.setPrefs", { projectId, ...patch }),
    onMutate: (patch) =>
      qc.setQueryData<Config>(["config"], (c) =>
        c && {
          ...c,
          projects: c.projects.map((p) => (p.id === projectId ? { ...p, merge: { ...MERGE_DEFAULTS, ...p.merge, ...patch.merge }, commit: { ...COMMIT_DEFAULTS, ...p.commit, ...patch.commit } } : p)),
        },
      ),
    onError: (e) => toast(e.message, "error"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });
  return {
    merge: { ...MERGE_DEFAULTS, ...project?.merge },
    commit: { ...COMMIT_DEFAULTS, ...project?.commit },
    setMerge: (merge: Partial<MergePrefs>) => save.mutate({ merge }),
    setCommit: (commit: Partial<CommitPrefs>) => save.mutate({ commit }),
  };
}

export const useConfig = () => useQuery({ queryKey: ["config"], queryFn: () => rpc<Config>("config.get") });
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

export const useCommits = (projectId?: string, branch?: string) =>
  useQuery({
    queryKey: ["commits", projectId, branch],
    queryFn: () => rpc<Commit[]>("workspace.commits", { projectId, branch }),
    enabled: !!projectId && !!branch,
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
  useQuery({ queryKey: ["agents"], queryFn: () => rpc<AgentSession[]>("agents.list"), refetchInterval: 15_000 });

export const useWorktrees = () =>
  useQuery({ queryKey: ["worktrees"], queryFn: () => rpc<WorktreeView[]>("worktrees.list"), refetchInterval: 10_000 });

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

/** Branches of a project a method is running on right now, wherever it was started. */
export function usePendingBranches(method: string, projectId: string): string[] {
  const vars = useMutationState({
    filters: { mutationKey: [method], status: "pending" },
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
  } = {},
) {
  const qc = useQueryClient();
  return useMutation<T, Error, V>({
    // Keyed by method so other screens can tell it is running (e.g. a push started from the commit box).
    mutationKey: [method],
    mutationFn: (vars) => rpc<T>(method, vars),
    onSuccess: async (r, vars) => {
      if (opts.patch) {
        // A fetch started before the action would land after the patch and undo it.
        await Promise.all((opts.invalidate ?? []).map((k) => qc.cancelQueries({ queryKey: k })));
        opts.patch(qc, vars, r);
      }
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
      const msg = typeof opts.success === "function" ? opts.success(r) : opts.success;
      if (msg) toast(msg, "ok");
    },
    onError: (e) => toast(e.message, "error"),
  });
}
