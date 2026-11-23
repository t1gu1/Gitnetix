// UI checks of the branch map (list-of-test.md, UI-01 to UI-04, UI-07 and SA-11): builds a throwaway repo with one branch
// per state, opens it in the app with a headless browser, selects each branch and checks the action its card
// suggests. Exits 1 when a check fails.
//
//   bun scripts/ui-branch-check.mjs [--out <dir>] [--keep]
//
// Runs gitnetix-server (built here) and Vite on free ports with a random token, in a temp folder (GITNETIX_HOME):
// your projects and settings are not touched. --out: where the screenshots go. --keep: keep the temp folder.
// Needs Playwright with Chromium: `bun add -g playwright && bunx playwright install chromium` once, or PLAYWRIGHT_DIR=<playwright package>.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => process.argv.includes(name) && process.argv[process.argv.indexOf(name) + 1];
const out = arg("--out") || join(tmpdir(), "gitnetix-ui-check-shots");
const keep = process.argv.includes("--keep");
const tmp = mkdtempSync(join(tmpdir(), "gitnetix-ui-check-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Scenario repo

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const commit = (cwd, file, message) => {
  writeFileSync(join(cwd, `${file}.txt`), `${file}\n`);
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", message);
};

const repo = join(tmp, "repo");
git(tmp, "init", "-q", "--bare", "-b", "main", "origin.git");
git(tmp, "init", "-q", "-b", "main", "repo");
commit(repo, "readme", "chore: init");
git(repo, "remote", "add", "origin", "../origin.git");
git(repo, "push", "-qu", "origin", "main");
const branch = (name, from, ...commits) => {
  git(repo, "switch", "-qc", name, from);
  for (const [file, message] of commits) commit(repo, file, message);
};
branch("feat/behind", "main", ["behind", "feat: login form"], ["behind2", "feat: login validation"]);
git(repo, "push", "-qu", "origin", "feat/behind");
branch("feat/pulled", "main", ["pulled", "feat: search box"]);
git(repo, "push", "-qu", "origin", "feat/pulled");
branch("feat/wipreset", "main", ["wipreset", "feat: filters"]);
git(repo, "push", "-qu", "origin", "feat/wipreset");
branch("feat/forced", "main", ["f1", "feat: export csv"], ["f2", "feat: export pdf"]);
git(repo, "push", "-qu", "origin", "feat/forced");
git(repo, "reset", "-q", "--hard", "HEAD~1");
branch("feat/merged", "main", ["merged", "fix: typo in footer"]);
git(repo, "switch", "-q", "main");
git(repo, "merge", "-q", "--no-ff", "feat/merged", "-m", "Merge feat/merged");
// Merged into main but still open in a worktree: UI-07.
branch("feat/wtdone", "main", ["wtdone", "docs: debug logs"]);
git(repo, "switch", "-q", "main");
git(repo, "merge", "-q", "--no-ff", "feat/wtdone", "-m", "Merge feat/wtdone");
branch("feat/local", "main", ["local", "feat: dark mode"]);
branch("feat/stack", "feat/local", ["stack", "feat: dark mode toggle"]);
git(repo, "switch", "-q", "main");
commit(repo, "main", "feat: main moved on");
git(repo, "push", "-q", "origin", "main");
branch("feat/wt", "main", ["wt", "feat: in a worktree"]);
git(repo, "switch", "-q", "main");
git(repo, "worktree", "add", "-q", "../wt", "feat/wt");
git(repo, "worktree", "add", "-q", "../wipreset", "feat/wipreset");
git(repo, "worktree", "add", "-q", "../wtdone", "feat/wtdone");
// A teammate pushes on top of feat/pulled and feat/wipreset.
git(tmp, "clone", "-q", "origin.git", "other");
const other = join(tmp, "other");
for (const b of ["feat/pulled", "feat/wipreset"]) {
  git(other, "switch", "-q", b);
  commit(other, `teammate-${b.slice(5)}`, "feat: teammate fix");
  git(other, "push", "-q", "origin", b);
}
git(repo, "fetch", "-q", "origin");
git(repo, "switch", "-q", "feat/behind");
// Uncommitted work where origin moved on: SA-11.
writeFileSync(join(tmp, "wipreset", "wipreset.txt"), "edited\n");

// ---------------------------------------------------------------- Server and Vite

const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const children = [];
const start = (name, cmd, args, env) => {
  const log = join(tmp, `${name}.log`);
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", openSync(log, "w"), openSync(log, "a")] });
  children.push(child);
  return { child, log };
};
// Up once it answers, and still ours: a server that lost its port to another exits.
const waitFor = async (url, { child, log }, name) => {
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`${name} exited:\n${readFileSync(log, "utf8")}`);
    try {
      await fetch(url);
      await sleep(300);
      if (child.exitCode === null) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`${name} did not start, see ${log}`);
};

const cargo = spawnSync("cargo", ["build", "-q", "-p", "gitnetix-server"], { cwd: root, stdio: "inherit" });
if (cargo.status !== 0) throw new Error("cargo build -p gitnetix-server failed");
const port = await freePort();
const vitePort = await freePort();
const token = randomUUID();
const home = join(tmp, "home");
mkdirSync(home);
writeFileSync(join(home, "config.json"), JSON.stringify({ server: { enabled: true, port, token }, ui: { onboarding: false } }));
const SERVER = `http://127.0.0.1:${port}`;
const rpc = async (method, params) => {
  const r = await fetch(`${SERVER}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
  const json = await r.json();
  if (!r.ok || json?.code) throw new Error(`${method}: ${JSON.stringify(json)}`);
  return json;
};

let failed = 0;
let browser;
try {
  const server = start("server", join(root, "target", "debug", "gitnetix-server"), [], { GITNETIX_HOME: home });
  await waitFor(`${SERVER}/`, server, "gitnetix-server");
  const pid = (await rpc("projects.add", { paths: [repo] }))[0].id;
  await rpc("branches.setParent", { projectId: pid, branch: "feat/stack", parent: "feat/local" });
  const vite = start("vite", process.execPath, [join("node_modules", "vite", "bin", "vite.js"), "--port", String(vitePort), "--strictPort"], {});
  await waitFor(`http://localhost:${vitePort}/`, vite, "Vite");

  // ---------------------------------------------------------------- Browser

  const require = createRequire(join(root, "package.json"));
  const npx = join(homedir(), ".npm", "_npx");
  // Bun's global install first, then an older `npx playwright` download.
  const dirs = [process.env.PLAYWRIGHT_DIR, "playwright", join(homedir(), ".bun", "install", "global", "node_modules", "playwright"), ...(existsSync(npx) ? readdirSync(npx).map((d) => join(npx, d, "node_modules", "playwright")) : [])].filter(Boolean);
  const pw = dirs.map((d) => { try { return require(d); } catch { return null; } }).find(Boolean);
  if (!pw) throw new Error("Playwright not found: run `bun add -g playwright && bunx playwright install chromium` once, or set PLAYWRIGHT_DIR");
  // shortcut: the fallback only knows the macOS arm64 cache layout; set CHROME elsewhere when the default launch fails.
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  const cached = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => join(cache, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")) : [];
  for (const executablePath of [process.env.CHROME, undefined, ...cached]) {
    try {
      browser = await pw.chromium.launch(executablePath ? { executablePath } : {});
      break;
    } catch {}
  }
  if (!browser) throw new Error("No Chromium Playwright can launch: run `bunx playwright install chromium`, or set CHROME");

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((r) => localStorage.setItem("gitnetix.remote", JSON.stringify(r)), { url: SERVER, token });
  // "Mine" goes by this machine's Git identity, not the scenario's author: every branch, merged ones hidden (the default).
  await page.addInitScript(() => localStorage.getItem("gnx.map") || localStorage.setItem("gnx.map", JSON.stringify({ who: "all" })));
  // The sandbox has no AI set up: without this the app opens on the AI setup instead of the map.
  await page.route(`${SERVER}/rpc`, async (route) => {
    if (JSON.parse(route.request().postData() || "{}").method !== "config.get") return route.continue();
    const res = await route.fetch();
    const json = await res.json();
    json.ai = { ...json.ai, providers: { ...json.ai?.providers, claude: { connected: true, method: "cli" } } };
    json.ui = { ...json.ui, onboarding: false, theme: "light" };
    return route.fulfill({ response: res, json, headers: { ...res.headers(), "access-control-allow-origin": "*" } });
  });
  await page.goto(`http://localhost:${vitePort}`);
  await page.waitForSelector(".map-crow[data-on]", { timeout: 60000 });

  const check = (id, ok, what) => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${id.padEnd(6)} ${what}`);
  };
  const select = async (name) => {
    await page.locator(`button.map-hitbox[aria-label="Select ${name}"]`).click();
    const card = page.locator(`.map-card[aria-label="Selected branch ${name}"]`);
    await card.waitFor();
    const btn = card.locator(".split-main");
    return { action: (await btn.innerText()).trim().toLowerCase(), tip: (await btn.getAttribute("data-tip")) ?? "", text: (await card.innerText()).toLowerCase() };
  };

  const expected = [
    ["UI-01", "main", "switch", "default branch, checked out elsewhere"],
    ["UI-01", "feat/behind", "rebase", "checked out, behind its parent"],
    ["UI-01", "feat/pulled", "reset to origin", "origin moved on, nothing of its own"],
    ["SA-11", "feat/wipreset", "reset to origin", "origin moved on, uncommitted changes"],
    ["UI-01", "feat/forced", "force push", "reset back after a push"],
    ["UI-01", "feat/local", "switch", "not checked out"],
    ["UI-01", "feat/wt", "continue", "open in a worktree"],
  ];
  for (const [id, name, action, state] of expected) {
    const got = await select(name);
    check(id, got.action === action, `${name} (${state}): "${got.action}", expected "${action}"`);
    if (name === "feat/wipreset") check(id, got.tip.includes("put back on top"), `${name} tip says the changes come back: "${got.tip}"`);
  }
  const stack = await select("feat/stack");
  check("UI-02", stack.text.includes("merges into feat/local"), "feat/stack sits under feat/local");
  await select("feat/behind");
  const active = await page.locator(".map-crow[data-on]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  check("UI-03", active.length === 1 && active[0].includes("feat: login validation"), `highlighted commit is the local tip: ${JSON.stringify(active)}`);
  // With the default filters (merged branches hidden), every worktree Worktrees & agents lists is a tile on the map.
  const worktrees = (await rpc("worktrees.list", {})).filter((w) => w.projectId === pid && !w.main);
  check("UI-07", worktrees.some((w) => w.branch === "feat/wtdone"), `worktrees.list has the merged worktree: ${JSON.stringify(worktrees.map((w) => w.branch))}`);
  for (const w of worktrees) {
    const tiles = await page.locator(`button.map-hitbox[aria-label="Select ${w.branch}"]`).count();
    check("UI-07", tiles === 1, `${w.branch} (worktree at ${w.path}) has a tile on the map: ${tiles}`);
  }
  const wtdone = await select("feat/wtdone");
  check("UI-07", wtdone.text.includes("merged"), "feat/wtdone's card says it is merged");
  // UI-04 is about merged branches: the Merged filter on.
  await page.getByRole("button", { name: /^Merged/ }).click();
  await page.getByText("Clean up merged", { exact: false }).first().waitFor({ timeout: 10000 }).catch(() => {});
  const trunk = (await page.locator("body").innerText()).toLowerCase();
  check("UI-04", trunk.includes("feat/merged") && trunk.includes("clean up merged"), "merged branch listed under the trunk with Clean up merged");
  check("UI", errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ""}`);

  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, "branch-map-rebase.png") });
  await select("feat/wtdone");
  await page.screenshot({ path: join(out, "branch-map-merged-worktree.png") });
  await select("feat/wipreset");
  await page.screenshot({ path: join(out, "branch-map-reset-with-wip.png") });
  console.log(`\nScreenshots in ${out}`);

  // The click itself: reset to origin's copy, the uncommitted edit back on top.
  await page.locator('.map-card[aria-label="Selected branch feat/wipreset"] .split-main').click();
  const told = await page.getByText("your changes are back on top").waitFor({ timeout: 30000 }).then(() => true, () => false);
  const wt = join(tmp, "wipreset");
  const at = git(wt, "rev-parse", "HEAD") === git(wt, "rev-parse", "origin/feat/wipreset");
  check("SA-11", told && at && readFileSync(join(wt, "wipreset.txt"), "utf8") === "edited\n", `clicked: toast ${told}, on origin's tip ${at}, edit kept`);
} finally {
  await browser?.close();
  // Only the processes started here.
  for (const c of children) c.kill();
  if (keep) console.log(`Kept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
