// `tauri dev` kills the app the moment a Rust file changes, even halfway through a merge.
// This runs it without its watcher and restarts it only once no action has run for 2s:
// the app keeps GITNETIX_BUSY_FILE while one does (see `Busy` in crates/core/src/rpc.rs). Vite holds page reloads the same way (vite.config.ts).
// shortcut: process-group kill is POSIX only; on Windows use `pnpm tauri dev`.
import { spawn } from "node:child_process";
import { existsSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const busy = join(tmpdir(), `gitnetix-busy-${process.pid}`);
const env = { ...process.env, GITNETIX_BUSY_FILE: busy };
// Vite lives across app restarts; tauri only rebuilds and relaunches the app.
const vite = spawn("vite", { stdio: "inherit", env });
let tauri;
let restarting = false;
let changed = 0;
let busyAt = 0;

const alive = () => tauri.exitCode === null && tauri.signalCode === null;

function start() {
  rmSync(busy, { force: true });
  // Own process group, so one kill takes cargo and the app with it.
  tauri = spawn("tauri", ["dev", "--no-watch", "--config", '{"build":{"beforeDevCommand":null}}'], { stdio: ["ignore", "inherit", "inherit"], env, detached: true });
  tauri.on("exit", (code) => {
    if (restarting) {
      restarting = false;
      start();
    } else if (code === 0) quit(0);
    else console.log("[dev] Gitnetix stopped; save a Rust file to rebuild");
  });
}

function quit(code) {
  if (alive()) process.kill(-tauri.pid, "SIGTERM");
  vite.kill();
  rmSync(busy, { force: true });
  process.exit(code);
}

function onChange() {
  if (!changed && existsSync(busy)) console.log("[dev] Rust sources changed; restarting once Gitnetix is idle");
  changed = Date.now();
}

for (const dir of ["src-tauri", "crates"]) watch(dir, { recursive: true }, (_, f) => f && !/(^|\/)(target|gen)\//.test(f) && onChange());
watch(".", (_, f) => (f === "Cargo.toml" || f === "Cargo.lock") && onChange());

setInterval(() => {
  const now = Date.now();
  if (alive() && existsSync(busy)) busyAt = now;
  // 1s lets git finish writing files; 2s idle bridges the gaps inside a multi-step operation.
  if (!changed || restarting || now - changed < 1000 || now - busyAt < 2000) return;
  changed = 0;
  if (!alive()) return start();
  restarting = true;
  process.kill(-tauri.pid, "SIGTERM");
}, 250);

process.on("SIGINT", () => quit(130));
process.on("SIGTERM", () => quit(143));
vite.on("exit", (code) => quit(code ?? 1));
start();
