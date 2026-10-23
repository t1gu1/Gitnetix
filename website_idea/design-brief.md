# Gitnetix website: design brief

Use this brief to design a one-page marketing site (landing page) for **Gitnetix**, a desktop Git
client. Give a dark-first design with a light-mode variant, responsive down to phone width.

## Product in one sentence

Gitnetix is a release-centric Git client that replaces the commit graph with a **tree of branches**
(main → releases → features/fixes), ships a release in one click, and runs an AI agent on every
branch.

## The big idea (lead with this)

Every other Git client draws the **commit graph**: colored rails, crossing merges, hundreds of dots.
It shows what git stored, not what you are working on.

Gitnetix has **no commit graph**. It shows branches the way you think about them:

- `main` at the top.
- **Releases** (`release/x.y.z`) under it.
- **Features and fixes** under the release they belong to.
- **Merged** work tucked into a group under its parent.
- **Falling behind** branches grouped for one-click cleanup.
- **Shipped** releases below a separator, with their version tag.
- A glowing **orange path** runs from `main` down to the branch you have checked out, with a soft
  pulse traveling along it. "You are here."

The engine works out each branch's parent on its own: declared parent, merge commits, pull requests
on GitHub/Azure DevOps, squash merges, or closest history. Even squash-merged PRs land under the
right release.

## Audience

- Developers on teams that ship versioned releases (apps, libraries, SaaS with release branches).
- Leads who own the release and are tired of "which branch is in which release?".
- Developers already running AI coding agents (Claude Code, Codex, Gemini) who want them on
  parallel branches.

## Tone

Calm, confident, a little playful. Short sentences. Show, don't list. No buzzword soup.
Avoid "revolutionary", "next-gen", "AI-powered" as a headline.

## Headline options

- **See your work, not your commits.** (preferred)
- Git without the subway map.
- The Git client that knows what you're shipping.

Sub-headline: *Branches as a tree. Releases as a button. An agent on every branch.*

## Page structure

1. **Hero**
   - Headline + sub-headline.
   - Primary CTA: "Download" (auto-detect OS: Linux AppImage, macOS dmg, Windows setup.exe).
     Secondary: "View on GitHub".
   - Hero visual: app window showing the branch tree with the orange path (see
     `images/hero-branch-tree.png`). Animate the pulse running down the path if possible.

2. **Graph vs tree** (the core differentiator)
   - Side by side: tangled commit graph ("The subway map") vs Gitnetix tree ("A tree of intent").
   - Reference: `images/graph-vs-tree.png`.
   - Caption: "Which branch is mine? What ships next? What's dead?" → "Where you are, what ships
     next, what's done. At a glance."
   - Nice to have: scroll-triggered morph from the tangle into the tree.

3. **The tree, explained** (3 to 5 small annotated callouts on one tree screenshot)
   - Orange path: where you are and what you merge into.
   - Ahead/behind counts against the *real* parent, not just origin.
   - Merged group: done work moves aside on its own, even after a squash PR.
   - Falling behind: stale branches gathered, cleaned up in one click.
   - Shipped: past releases with their tags; delete a tag and the release reopens.

4. **Cut. Build. Ship.** (release flow)
   - 4 steps: Cut a release → Branch work (worktrees) → Agents help → Ship.
   - Ship = date `CHANGELOG.md`, fast-forward `main`, tag `vx.y.z`, push. One click.
   - Reference: `images/release-flow.png`.

5. **One branch. One worktree. One agent.**
   - Each branch can open in its own worktree with its own AI agent and terminal.
   - Supported: Claude Code, Codex, Gemini, Copilot, Ollama, or API keys.
   - Phone companion app approves and steers agents remotely. MCP bridge lets other agents drive
     Gitnetix.
   - Reference: `images/agents-everywhere.png`.

6. **AI writes the boring text** (compact feature grid)
   - Commit messages, branch names, PR descriptions, release notes, conflict resolutions,
     ticket triage.
   - Editable templates, per-task model routing (cheap model for commits, strong one for conflicts).

7. **Fits your stack** (logo strip / small cards)
   - Pull requests: GitHub, Azure DevOps.
   - Tickets: Jira, Trello, Asana (branches matched to tickets by key).
   - Platforms: Linux, macOS, Windows desktop; iOS/Android companion; headless server.

8. **Under the hood** (small, for devs)
   - Rust engine on the real `git` CLI, React UI, Tauri 2 shell. Small, fast, native.
   - Secrets in the OS keychain.

9. **Final CTA**
   - "Stop reading the subway map." + Download buttons.
   - Footer: GitHub, changelog, license.

## Visual language (match the app)

Colors come straight from the app (`src/styles/app.css`).

| Token | Dark | Light | Use |
|---|---|---|---|
| bg | `#0e0f11` | `#f3f3f1` | page background |
| panel | `#15171a` | `#ffffff` | cards, window |
| raised | `#1c1f23` | `#f4f4f2` | raised rows |
| line | `#272a30` | `#e2e2de` | borders, rails |
| fg | `#e8e9eb` | `#16171a` | text |
| muted | `#a0a5ae` | `#575c65` | secondary text |
| faint | `#7a808a` | `#787d86` | labels |
| **accent** | `#f0a43a` | `#f6b860` | orange path, CTAs, "you are here" |
| trunk | `#f7c48a` | `#a85a12` | `main` / trunk branches |
| release | `#c4a7ff` | `#6b46c1` | release branches, tags |
| add / ahead | `#62d6ae` | `#17744d` | ahead counts, merged, success |
| warn / behind | `#e3b45a` | `#8a5a00` | behind counts, falling behind |
| mod / work | `#86aeff` | `#2452c2` | feature/fix branches |
| del | `#ff9089` | `#b0271f` | danger |

- **Fonts:** Instrument Sans (UI, headings), JetBrains Mono (branch names in code, terminal).
- **Signature element:** the orange path with a moving pulse. Reuse it as a motif: a thin orange
  line that runs down the page from section to section, like the path in the tree, ending at the
  final CTA.
- **Shapes:** rounded 8–16 px radius, thin 1 px borders, subtle glow on accent only.
- **Icons by role:** circle = trunk / work branch, rounded square = release, dashed circle = falling
  behind, filled dot = checked out.
- **Motion:** gentle. The pulse, a soft glow on the checked-out row, cards fading up on scroll.
  Respect `prefers-reduced-motion`.
- Mood: dark IDE-like, warm orange highlight on cool graphite. Lots of breathing room.

## Assets in this folder

- `images/gitnetix-logo.jpg`, `images/app-icon.png`: brand logo and app icon.
- `images/hero-branch-tree.png` / `.svg`: hero app mock.
- `images/graph-vs-tree.png` / `.svg`: core comparison.
- `images/release-flow.png` / `.svg`: release flow steps.
- `images/agents-everywhere.png` / `.svg`: worktrees, agents, phone companion.
- `why-gitnetix.md`: the full list of differentiators, for copy.

The mocks are illustrations, not real screenshots. Swap in real app screenshots when available.

## Do not

- Do not draw a commit graph anywhere except as the "before" in the comparison.
- Do not use purple-gradient AI-startup clichés. The accent is orange.
- Do not claim GitLab/Bitbucket/Gitea support (not done yet).
