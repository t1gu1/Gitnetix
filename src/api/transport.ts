// Two ways to reach the engine, same RPC surface:
//  - local: inside the desktop Tauri app (invoke → Rust)
//  - remote: the mobile app or a plain browser talking to a desktop's
//    companion API over HTTP + Server-Sent Events.

import type { GitnetixEvent } from "./types";

export class RpcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Remote {
  url: string;
  token: string;
}

const REMOTE_KEY = "gitnetix.remote";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const isMobileUA = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Desktop Tauri window: the engine is in-process. */
export const isLocal = isTauri && !isMobileUA;

function loadRemote(): Remote | null {
  try {
    const raw = localStorage.getItem(REMOTE_KEY);
    return raw ? (JSON.parse(raw) as Remote) : null;
  } catch {
    return null;
  }
}

export function saveRemote(r: Remote | null) {
  try {
    if (r) localStorage.setItem(REMOTE_KEY, JSON.stringify(r));
    else localStorage.removeItem(REMOTE_KEY);
  } catch {
    /* storage unavailable: pairing lasts for this session only */
  }
  remote = r;
}

let remote: Remote | null = isLocal ? null : loadRemote();

export function currentRemote() {
  return remote;
}

function normalise(url: string) {
  let u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(u)) u = `http://${u}`;
  return u;
}

/** Check a companion address and token before saving them. */
export async function testRemote(url: string, token: string): Promise<Remote> {
  const r = { url: normalise(url), token: token.trim() };
  const health = await fetch(`${r.url}/health`).catch(() => null);
  if (!health || !health.ok) throw new RpcError("unreachable", `No Gitnetix at ${r.url}`);
  const res = await fetch(`${r.url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${r.token}` },
    body: JSON.stringify({ method: "app.info", params: {} }),
  });
  if (res.status === 401) throw new RpcError("unauthorized", "Wrong pairing token");
  if (!res.ok) throw new RpcError("http", `Companion answered ${res.status}`);
  return r;
}

export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (isLocal) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      return await invoke<T>("rpc", { method, params });
    } catch (e) {
      const err = e as { code?: string; message?: string } | string;
      if (typeof err === "string") throw new RpcError("other", err);
      throw new RpcError(err.code ?? "other", err.message ?? String(e));
    }
  }
  if (!remote) throw new RpcError("not_paired", "Not connected to a Gitnetix desktop");
  let res: Response;
  try {
    res = await fetch(`${remote.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${remote.token}` },
      body: JSON.stringify({ method, params }),
    });
  } catch {
    throw new RpcError("unreachable", `Cannot reach ${remote.url}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new RpcError(body.code ?? "http", body.message ?? `HTTP ${res.status}`);
  return body as T;
}

/** Subscribe to engine events. Returns an unsubscribe function. */
export function subscribe(onEvent: (e: GitnetixEvent) => void): () => void {
  if (isLocal) {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<GitnetixEvent>("gitnetix://event", (e) => onEvent(e.payload)).then((u) => {
        if (cancelled) u();
        else unlisten = u;
      }),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }
  if (!remote) return () => {};
  const es = new EventSource(`${remote.url}/events?token=${encodeURIComponent(remote.token)}`);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {
      /* ignore malformed event */
    }
  };
  return () => es.close();
}

export interface CompanionInfo {
  enabled: boolean;
  port: number;
  lan: boolean;
  token: string;
  hosts: string[];
}

export async function companionInfo(): Promise<CompanionInfo | null> {
  if (!isLocal) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CompanionInfo>("companion");
}

/** Native folder picker on desktop; null elsewhere. */
export async function pickFolders(): Promise<string[] | null> {
  if (!isLocal) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ directory: true, multiple: true, title: "Choose Git repositories" });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}

export async function openExternal(url: string) {
  if (isLocal) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** Show a file or folder in the system file manager (desktop only). */
export async function revealPath(path: string) {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/** Folder drops onto the desktop window. */
export function onFolderDrop(handler: (paths: string[]) => void, onHover?: (over: boolean) => void): () => void {
  if (!isLocal) return () => {};
  let un: (() => void) | null = null;
  let cancelled = false;
  import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "over" || p.type === "enter") onHover?.(true);
        else if (p.type === "leave") onHover?.(false);
        else if (p.type === "drop") {
          onHover?.(false);
          handler(p.paths);
        }
      })
      .then((u) => {
        if (cancelled) u();
        else un = u;
      }),
  );
  return () => {
    cancelled = true;
    un?.();
  };
}
