import { useEffect } from "react";
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { rpc, subscribe } from "./transport";
import type {
  AgentSession,
  AiCatalog,
  Analytics,
  Config,
  FileChange,
  Hunk,
  Overview,
  PrDetail,
  PrSummary,
  ProjectSummary,
  Template,
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
              list?.map((s) => (s.id === e.sessionId ? { ...s, lines: [...s.lines, e.line] } : s)),
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
            qc.invalidateQueries({ queryKey: ["worktrees"] });
            qc.invalidateQueries({ queryKey: ["projects"] });
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

export const useConfig = () => useQuery({ queryKey: ["config"], queryFn: () => rpc<Config>("config.get") });
export const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: () => rpc<ProjectSummary[]>("projects.list") });

export const useOverview = (projectId?: string) =>
  useQuery({
    queryKey: ["overview", projectId],
    queryFn: () => rpc<Overview>("workspace.overview", { projectId }),
    enabled: !!projectId,
  });

export const useFiles = (projectId?: string, branch?: string, mode = "branch") =>
  useQuery({
    queryKey: ["files", projectId, branch, mode],
    queryFn: () => rpc<FileChange[]>("workspace.files", { projectId, branch, mode }),
    enabled: !!projectId && !!branch,
    refetchInterval: mode === "wip" ? 4_000 : false,
  });

export const useDiff = (projectId?: string, branch?: string, mode = "branch", path?: string) =>
  useQuery({
    queryKey: ["diff", projectId, branch, mode, path],
    queryFn: () => rpc<Hunk[]>("workspace.diff", { projectId, branch, mode, path }),
    enabled: !!projectId && !!branch && !!path,
  });

export const useAgents = () =>
  useQuery({ queryKey: ["agents"], queryFn: () => rpc<AgentSession[]>("agents.list"), refetchInterval: 15_000 });

export const useWorktrees = () =>
  useQuery({ queryKey: ["worktrees"], queryFn: () => rpc<WorktreeView[]>("worktrees.list"), refetchInterval: 10_000 });

export const useAiCatalog = () => useQuery({ queryKey: ["ai"], queryFn: () => rpc<AiCatalog>("ai.catalog") });

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

export const useTickets = (projectId?: string) =>
  useQuery({
    queryKey: ["tickets", projectId],
    queryFn: () => rpc<{ sources: string[]; tickets: Ticket[]; syncedAt?: string }>("tickets.list", { projectId }),
    enabled: !!projectId,
    retry: false,
    staleTime: 60_000,
  });

export const useAnalytics = (projectId: string, days: number) =>
  useQuery({
    queryKey: ["analytics", projectId, days],
    queryFn: () => rpc<Analytics>("analytics.get", { projectId, days }),
    staleTime: 60_000,
  });

/**
 * Fire an RPC from a button: shows errors as toasts and refreshes the
 * given query keys afterwards.
 */
export function useAction<T = unknown, V extends Record<string, unknown> = Record<string, unknown>>(
  method: string,
  opts: { invalidate?: unknown[][]; success?: string | ((r: T) => string | undefined) } = {},
) {
  const qc = useQueryClient();
  return useMutation<T, Error, V>({
    mutationFn: (vars) => rpc<T>(method, vars),
    onSuccess: (r) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
      const msg = typeof opts.success === "function" ? opts.success(r) : opts.success;
      if (msg) toast(msg, "ok");
    },
    onError: (e) => toast(e.message, "error"),
  });
}
