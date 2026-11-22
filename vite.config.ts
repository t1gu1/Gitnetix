import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and, on mobile, a LAN-reachable dev server.
const host = process.env.TAURI_DEV_HOST;
// GITNETIX_DEV_PORT moves the dev server off 1420 when another app holds it (`pnpm app` passes it on to Tauri).
const port = Number(process.env.GITNETIX_DEV_PORT) || 1420;
// Set by `pnpm app` (scripts/dev.mjs): exists while the app runs an action.
const busy = process.env.GITNETIX_BUSY_FILE;

/** Gitnetix merges and switches branches in this very checkout: a page reload halfway would drop the rest of the flow
 * (its result, the worktree cleanup after). Updates wait until it has been idle 2s, as the Rust restart does, then reload once.
 * shortcut: an index.html or vite.config.ts change still reloads at once (Vite handles those before plugins); rare in a merge. */
function holdWhileBusy(busy: string): Plugin {
  let busyAt = 0;
  let held = false;
  const idle = () => !existsSync(busy) && Date.now() - busyAt >= 2000;
  return {
    name: "gitnetix-hold-while-busy",
    configureServer(server) {
      const timer = setInterval(() => {
        if (existsSync(busy)) busyAt = Date.now();
        else if (held && idle()) {
          held = false;
          server.ws.send({ type: "full-reload" });
        }
      }, 250);
      server.httpServer?.once("close", () => clearInterval(timer));
    },
    hotUpdate() {
      if (idle()) return;
      held = true;
      return [];
    },
  };
}

/** The phone fetches the home-screen icon on its own, without the companion's self-signed certificate the user accepted,
 * and gets nothing: the icon rides inside the page instead. */
const inlineTouchIcon: Plugin = {
  name: "gitnetix-inline-touch-icon",
  transformIndexHtml: (html) =>
    html.replace(
      'href="/apple-touch-icon.png"',
      `href="data:image/png;base64,${readFileSync(new URL("public/apple-touch-icon.png", import.meta.url)).toString("base64")}"`,
    ),
};

/** The newest release tag, shown as the dev build's version: Cargo.toml and tauri.conf.json keep 0.1.0.
 * shortcut: read when Vite starts, and `pnpm app` keeps Vite across restarts; restart it to show a newer tag. */
function lastTag() {
  try {
    return execFileSync("git", ["tag", "--list", "v*", "--sort=-creatordate"], { encoding: "utf8" }).split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}

export default defineConfig({
  define: { __DEV_TAG__: JSON.stringify(lastTag()) },
  plugins: [react(), inlineTouchIcon, busy ? holdWhileBusy(busy) : null],
  clearScreen: false,
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: port + 1 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
  // ES workers can split: the diff highlighter loads each language's grammar only when a file needs it.
  worker: { format: "es" },
});
