// `tauri dev` kills the app the moment a Rust file changes, even halfway through a merge.
// This runs it without its watcher and restarts it only once no action has run for 2s:
// the app keeps GITNETIX_BUSY_FILE while one does (see `Busy` in crates/core/src/rpc.rs). Vite holds page reloads the same way (vite.config.ts).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// OAuth app keys the release build gets from GitHub secrets (GITNETIX_*_CLIENT_ID/_SECRET), for local builds.
// Read from the main checkout's .env.local, so every worktree shares one file; variables already set win.
const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
const localEnv = join(dirname(common || ".git"), ".env.local");
if (existsSync(localEnv)) process.loadEnvFile(localEnv);

const busy = join(tmpdir(), `gitnetix-busy-${process.pid}`);
const env = { ...process.env, GITNETIX_BUSY_FILE: busy };
const win = process.platform === "win32";
// Node runs the CLIs' own scripts: on Windows node_modules/.bin only has .cmd shims, which spawn cannot start without a shell.
const vitePath = join("node_modules", "vite", "bin", "vite.js");
const tauriPath = join("node_modules", "@tauri-apps", "cli", "tauri.js");
// The companion serves phones the built UI from dist/ (`dev_asset` in src-tauri/src/lib.rs); without it they get a blank page.
// shortcut: built only when missing; `pnpm build` again to show UI changes on the phone.
if (!existsSync("dist/index.html")) spawnSync(process.execPath, [vitePath, "build"], { stdio: "inherit" });
// Vite lives across app restarts; tauri only rebuilds and relaunches the app.
const vite = spawn(process.execPath, [vitePath], { stdio: "inherit", env });
let tauri;
let restarting = false;
let changed = 0;
let busyAt = 0;

const alive = () => tauri.exitCode === null && tauri.signalCode === null;
// Windows has no process groups: taskkill /T stops the tree (cargo and the app) instead.
const stopTauri = () => (win ? spawnSync("taskkill", ["/pid", String(tauri.pid), "/T", "/F"], { stdio: "ignore" }) : process.kill(-tauri.pid, "SIGTERM"));

function start() {
  rmSync(busy, { force: true });
  // Own process group, so one kill takes cargo and the app with it. On Windows detached would open a new console window.
  tauri = spawn(process.execPath, [tauriPath, "dev", "--no-watch", "--config", '{"build":{"beforeDevCommand":null}}'], { stdio: ["ignore", "inherit", "inherit"], env, detached: !win });
  tauri.on("exit", (code) => {
    if (restarting) {
      restarting = false;
      start();
    } else if (code === 0) quit(0);
    else console.log("[dev] Gitnetix stopped; save a Rust file to rebuild");
  });
}

function quit(code) {
  if (alive()) stopTauri();
  vite.kill();
  rmSync(busy, { force: true });
  process.exit(code);
}

function onChange() {
  if (!changed && existsSync(busy)) console.log("[dev] Rust sources changed; restarting once Gitnetix is idle");
  changed = Date.now();
}

for (const dir of ["src-tauri", "crates"]) watch(dir, { recursive: true }, (_, f) => f && !/(^|[\\/])(target|gen)[\\/]/.test(f) && onChange());
watch(".", (_, f) => (f === "Cargo.toml" || f === "Cargo.lock") && onChange());

setInterval(() => {
  const now = Date.now();
  if (alive() && existsSync(busy)) busyAt = now;
  // 1s lets git finish writing files; 2s idle bridges the gaps inside a multi-step operation.
  if (!changed || restarting || now - changed < 1000 || now - busyAt < 2000) return;
  changed = 0;
  if (!alive()) return start();
  restarting = true;
  stopTauri();
}, 250);

process.on("SIGINT", () => quit(130));
process.on("SIGTERM", () => quit(143));
vite.on("exit", (code) => quit(code ?? 1));
start();
