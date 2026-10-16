# Gitnetix

Release-centric Git client with AI built in. Rust engine, React UI, Tauri 2 shell.
Desktop does the work; a mobile build of the same UI manages it remotely.

## Workflow

- A **release** is a branch `release/x.y.z` cut from `main` (or from the latest tag for a hotfix).
- **Features and fixes** branch off a release, either by switching branch or in their own **worktree**.
- An **AI agent** (Claude Code CLI, Codex, Gemini…) can work on each branch in parallel.
- **Ship** fast-forwards `main` to the release branch, tags `vx.y.z`, and can push both.
- AI writes commit messages, branch names, PR descriptions, release notes, conflict resolutions and ticket triage, driven by editable **templates** and per-task **model routing**.

## Layout

```
crates/core     engine: git CLI wrapper, release flow, AI providers, agents,
                GitHub, Jira/Trello/Asana, analytics, templates, RPC surface
crates/server   companion HTTP API (+ SSE events), headless server, MCP bridge
src-tauri       Tauri shell: hosts the engine on desktop, remote-only on mobile
src             React UI (all screens from the design canvas)
```

Every client goes through one RPC surface (`crates/core/src/rpc.rs`):
Tauri `invoke("rpc")` on desktop, `POST /rpc` for the phone/browser, and MCP tools for agents.
Adding a method there makes it available everywhere.

## Run

```sh
pnpm install
pnpm app              # desktop app in dev (tauri dev)
pnpm app:build        # bundle (.app / .dmg / .msi / .deb)
cargo test --workspace
```

Requirements: Rust 1.80+, Node 20+, pnpm, `git` on PATH. For AI, either a CLI
(`claude`, `codex`, `gemini`, `copilot`, `ollama`) signed in, or an API key in AI setup.

Headless (no window), e.g. on a dev box you drive from your phone:

```sh
cargo run -p gitnetix-server
```

Config lives in `~/Library/Application Support/gitnetix` (macOS), `~/.config/gitnetix` (Linux),
or `$GITNETIX_HOME`. API keys and tokens go to the OS keychain.

## Mobile (management app)

The iOS/Android build ships the same React UI without the engine. It pairs with a desktop
(or headless) Gitnetix over the companion API and manages releases, agents, worktrees,
PRs and tickets. The layout switches to single-pane with a bottom tab bar under 900 px.

1. Desktop: Menu › Settings › Companion & MCP → enable **Allow devices on my network**, restart.
2. Phone: enter the address and pairing token shown there.

```sh
pnpm tauri ios init && pnpm ios          # needs Xcode
pnpm tauri android init && pnpm android  # needs Android SDK/NDK
```

`src-tauri/Info.ios.plist` allows local-network HTTP on iOS. On Android release builds, set
`android:usesCleartextTraffic="true"` in the generated manifest (or put the companion behind HTTPS/Tailscale).

The same pairing works from any browser: `pnpm dev` and open http://localhost:1420.

**Security:** the companion API is plain HTTP protected by a 64-hex-char token. Anyone holding
the token on your network can run git and agents on your computer. It listens on 127.0.0.1
unless LAN access is on.

## MCP

`gitnetix-mcp` exposes every RPC method as an MCP tool (stdio), forwarding to the running app:

```sh
cargo build -p gitnetix-server --release
claude mcp add gitnetix -- "$(pwd)/target/release/gitnetix-mcp"
```

## Status

Working and tested (`crates/core/tests/release_flow.rs` drives the full flow on a real repo):
projects, releases, feature/fix branches, worktrees, file lists and diffs, commit/push,
rebase with conflict resolution, ship + tag, analytics, companion API, MCP bridge.

Implemented but not yet exercised against live services: AI calls (CLI and API), agent
sessions, GitHub PRs/reviews/releases, Jira/Trello/Asana.

Not done yet: GitLab / Azure DevOps / Bitbucket / Gitea PRs, French UI strings (the AI output
language setting works; the interface itself is English), mobile builds have not been generated.
