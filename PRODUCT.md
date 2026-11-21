# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Desktop app in a Tauri 2 shell (macOS, Windows, Linux); the same React UI also runs in a browser and on a paired phone through the companion server.

## Users

Developers who run many release, feature and fix branches at once, often in separate worktrees, with an AI agent (Claude Code, Codex, Antigravity, Copilot, Ollama) working on several of them in parallel. The app stays open all day next to their editor and terminal; they glance at it, act, and go back to code. They also check on and drive it from their phone.

## Product Purpose

A Git client with no commit graph. It shows work as branches, releases and agents instead of commits, and turns release chores (cutting `release/x.y.z`, tagging, changelog, publishing) into one action. Success: the user knows at a glance what every branch is, where it stands against its parent and release, and what each agent is doing, without reading history.

## Positioning

"See your work, not your commits." Branches on a map inferred from intent (parent detection, release sections, falling behind, shipped, likely merged), releases as a button, an agent on every branch. Neighbouring Git clients center the commit graph; Gitnetix does not have one. Commits appear only inside the branch or release they belong to, never as a global graph.

## Operating Context

- Project tabs, in order: Workspace, Pull requests, Tickets, Release notes, Submodules, Analytics.
- Workspace is the branch map (it replaced the branch tree in 0.23.0; trunk station map since 0.26.0): `main` and releases form the trunk, shipped releases are stations on it that unfold into the commits they shipped, one column per nesting level, and a branch built on another work branch is filed under it. Each branch box lists its 4 newest commits with "See all"; commits a merge brought in fold under that merge's row. Filters for person, merged, falling behind and shipped; search across branch names, tag names and commit subjects; zoom at pointer and drag to pan. Selecting a branch opens its card (suggested action as a split button) with its files panel under it and a file's diff floating over the map, and a focus view with a files panel (WIP, Branch, Project) and code. A terminal / agent run panel docks on the right on wide screens.
- Branch actions from the map: rebase (also in a temporary worktree for branches checked out nowhere), stage & commit all, publish, create tag & update changelog, finish and merge for worktrees, delete (switches to the parent first when checked out).
- Pull requests: diffs read from the local clone, line comments pinned to the diffed commit, on GitHub, GitLab, Azure DevOps, Bitbucket and Gitea. On a GitHub project you can't push to, pushing and opening a pull request go through a fork on your account; when origin is your fork, the page asks whether pull requests go to the original repository or the fork.
- Tickets: Jira, Trello, Asana, Linear and GitHub issues, with comment threads, files, priority, and editable priority/type/labels on Jira and Linear.
- Analytics, with Sprints and Weekly views when a tracker is connected.
- Also: worktrees, stash, file history (author avatar over the line number, click to the commit), logs, templates, settings, onboarding (theme, then required Agent setup), phone pairing by QR code, a manual update check in the menu (dev builds show the newest tag plus "dev").
- Agents: a signed-in agent CLI is required (`claude`, `codex`, `agy`, `copilot` or `ollama`); Claude Code and Copilot runs have permission modes (Bypass by default, the other CLIs always bypass) with in-chat Allow / Refuse cards; Copilot asks through its ACP server (`copilot --acp`) at Accept edits and Use agent permissions. In agent chat, `/` opens a skills menu and images or Markdown files named in a reply open in the app's viewer. Sessions another Gitnetix instance saves in the same data folder show and stream here, but actions taken here don't reach their runs.
- AI writes commit messages, branch names, PR descriptions, release notes, conflict resolutions and ticket triage from editable templates with per-task model routing.
- Every client (desktop, phone/browser, MCP agents) goes through one RPC surface (`crates/core/src/rpc.rs`).

## Capabilities and Constraints

- Frontend: React 19 + Vite, one stylesheet `src/styles/app.css`, theme tokens applied from `src/lib/themes.ts`.
- 38 color themes must all keep working: Gitnetix Black & White (dark and light), Gitnetix Dark/Light, plus the Tokyo Night, Catppuccin, Rosé Pine, Dracula, Night Owl, Nord, Ayu, Everforest, Kanagawa and Gruvbox families. The app's colors are mixed from each theme's surfaces, text and accent. Default theme for new users, and the one System follows, is Gitnetix Black & White (`DEFAULT_THEME` in `src/lib/themes.ts`).
- Branch types (`src/lib/kinds.ts`: feat, fix, refactor, perf, style, test, docs, chore, ci, a11y, build, poc, release) are user-configurable per project; an unlisted prefix such as `wip/` joins the list.
- Must stay usable at phone width: under 900 px the layout is single-pane with a bottom tab bar.
- Desktop runs on WebKitGTK on Linux (bundled 2.50.4 in the AppImage); rendering cost there matters for animations, shadows and blur.
- Branch view results are cached by `VIEW_CACHE_VERSION` (`crates/core/src/app.rs`).

## Brand Commitments

- Name: Gitnetix. Tagline: "See your work, not your commits."
- Logo: faceted "G" (`src/lib/logo.ts`), one color shaded facet by facet so it takes each theme's accent. The app icon is a white G on a slate tile, in the Black & White theme's colors. `gitnetix-logo.jpg` is the earlier gold rendering.
- Redesign direction from the owner (2026-11-18), shipped in 0.26.0: modern and clean; less multi-colored, less rounded; the old look read as generic. Every view and what it does stayed; only the visual signature changed.
- Branch type reads by its label, not by its own hue. Color is reserved for meaning (added, deleted, warning, selection, status).

## Evidence on Hand

- Marketing screenshots: `website/public/og.png` (desktop branch map) and `website/public/phone.jpg` (mobile layout), both refreshed 2026-11-19 in the Black & White look.
- Product writing: `CHANGELOG.md` (most current), `README.md`, `website_idea/why-gitnetix.md`, `website_idea/design-brief.md`. README and `website_idea/` still describe a branch tree; the map replaced it in 0.23.0, so prefer the CHANGELOG where they disagree.
- No testimonials, user counts or benchmarks exist; do not invent them.

## Product Principles

- Intent over history: show what work is and where it stands, never raw commit topology.
- Glanceable: the state of every branch and agent readable in one look from beside an editor.
- One action per chore: releases, tags and changelogs are buttons, with git's safety kept (nothing pushed half-done).
- Same product everywhere: desktop, browser, phone and MCP agents share one surface.
- The user's colors: any of the supported themes must look intentional, not just tolerated.

## Accessibility & Inclusion

- Text and controls meet WCAG AA contrast in every shipped theme.
- No other formal standard is set.
