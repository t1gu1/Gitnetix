// Two real Gitnetix apps (Tauri windows, not a browser) on a sandbox settings folder, to test what one instance sees of
// the other's changes. The UI is built into the app: no Vite runs, so no other checkout's dev server on 1420 gets in the way.
//
//   bun run app:two [--separate] [--no-build]  build, then open windows 1 and 2; Ctrl-C closes both
//   bun run app:two shot <1|2> <file.png>     picture of what window 1 or 2 shows (its page, without the title bar)
//
// --separate: one settings folder each, like two computers that share only the git remote.
// Never the real settings folder: a second instance there resumes the agents the first one is running.
// Each instance's API is http://127.0.0.1:<port>/rpc with `authorization: Bearer <token>`, printed at start and kept in
// <sandbox>/instances.json; its log is <sandbox>/instance-<n>.log.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const sandbox = join(tmpdir(), "gitnetix-two");
const state = join(sandbox, "instances.json");
const args = process.argv.slice(2);

if (args[0] === "shot") {
  const [, n, file] = args;
  const it = JSON.parse(readFileSync(state, "utf8")).instances[Number(n) - 1];
  if (!it || !file) throw new Error("usage: bun run app:two shot <1|2> <file.png>, while bun run app:two runs");
  // The app takes the picture of its own page (`app.screenshot`): capturing its window from outside needs the
  // terminal to hold the Screen Recording permission.
  const png = join(it.home, "window.png");
  rmSync(png, { force: true });
  const res = await fetch(`http://127.0.0.1:${it.port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${it.token}` },
    body: JSON.stringify({ method: "app.screenshot", params: {} }),
  });
  if (!res.ok) throw new Error(`window ${n}: ${(await res.json().catch(() => ({}))).message ?? res.status}`);
  for (let i = 0; i < 50 && !existsSync(png); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(png)) throw new Error(`window ${n} took no picture; see ${join(sandbox, `instance-${n}.log`)}`);
  // A copy: the settings folder and `file` may sit on different disks, where a rename fails.
  copyFileSync(png, resolve(file));
  rmSync(png);
  process.exit(0);
}

// OAuth app keys for local builds, from the main checkout's .env.local, as scripts/dev.mjs does.
const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
const localEnv = join(dirname(common || ".git"), ".env.local");
if (existsSync(localEnv)) process.loadEnvFile(localEnv);

if (!args.includes("--no-build")) {
  const built = spawnSync(process.execPath, ["run", "tauri", "build", "--debug", "--no-bundle"], { stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
const bin = resolve("target", "debug", process.platform === "win32" ? "gitnetix.exe" : "gitnetix");

const homes = args.includes("--separate") ? [join(sandbox, "home-1"), join(sandbox, "home-2")] : [join(sandbox, "home"), join(sandbox, "home")];
for (const home of new Set(homes)) {
  mkdirSync(home, { recursive: true });
  // A new folder skips the first-run and agent setup: the CLI agent on this computer is the one either way.
  const cfg = join(home, "config.json");
  if (!existsSync(cfg)) {
    const claude = { method: "cli", model: "claude-sonnet-5-5", effort: "medium", connected: true };
    writeFileSync(cfg, JSON.stringify({ ui: { onboarding: false }, ai: { providers: { claude } } }));
  }
}

const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function up(port) {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`instance on port ${port} did not start; see its log in ${sandbox}`);
}

const kids = [];
const instances = [];
for (const [i, home] of homes.entries()) {
  const port = await freePort();
  const log = openSync(join(sandbox, `instance-${i + 1}.log`), "w");
  const env = { ...process.env, GITNETIX_HOME: home, GITNETIX_PORT: String(port), GITNETIX_TITLE: String(i + 1) };
  const child = spawn(bin, [], { stdio: ["ignore", log, log], env });
  kids.push(child);
  // One at a time: a new folder's first launch writes its settings.
  await up(port);
  const token = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).server.token;
  instances.push({ pid: child.pid, port, token, home });
  console.log(`[two-apps] window ${i + 1}: pid ${child.pid}, API http://127.0.0.1:${port}/rpc, token ${token}, settings ${home}`);
}
writeFileSync(state, JSON.stringify({ instances }, null, 2));
console.log(`[two-apps] screenshot: bun run app:two shot <1|2> <file.png>. Ctrl-C closes both.`);

let open = kids.length;
for (const k of kids) k.on("exit", () => --open || process.exit(0));
const quit = () => kids.forEach((k) => k.kill());
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
