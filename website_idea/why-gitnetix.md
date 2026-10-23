# Why Gitnetix is different

Most Git clients (GitKraken, Fork, Sourcetree, Tower, GitHub Desktop, Sublime Merge) are built
around one picture: the **commit graph**. Colored rails, merge diamonds, hundreds of dots.
It shows *what git stored*. It does not show *what you are working on*.

Gitnetix drops the commit graph. It shows **branches as a tree of intent**: which release a
feature belongs to, what is still open, what already shipped, what is rotting.

---

## 1. A branch tree, not a commit graph

| Classic client | Gitnetix |
|---|---|
| Rails of commits, merges crossing everywhere | Folder-like tree: `main` → releases → features/fixes |
| You decode the topology yourself | Engine works out each branch's parent for you |
| Merged branches look like every other line | Merged work moves aside, under a **Merged** group |
| Shipped releases are just tags in the log | **Shipped** section, separated, with version tag |
| Stale branches pile up silently | **Falling behind** section with one-click cleanup |

How the parent is found (`crates/core/src/app.rs`, `parent_of`):
1. Declared parent (release base, branch you attached it to).
2. A merge commit that names where it went.
3. A pull request on GitHub / Azure DevOps that took it in, or a squash that carries it.
4. Otherwise the closest target by history: fewest commits of its own, then fewest missing.

Result: even squash-merged PRs land under the right release. Branches whose ticket key shows
up in a later squash get a **"likely merged"** tag, and are never auto-deleted.

## 2. The orange path

The checked-out branch gets a glowing orange path drawn from `main` down to it, with a pulse
traveling along it. Branches it only passes by are dimmed. One glance answers
"where am I, and what will this merge into?" No other client has this.

## 3. Release-centric workflow built in

- A **release** is a branch `release/x.y.z` cut from `main` (or from the last tag, for a hotfix).
- **Features and fixes** branch off a release.
- **Ship** dates the `Unreleased` section of `CHANGELOG.md`, fast-forwards `main`, tags `vx.y.z`,
  and pushes. One button.
- Delete a tag → the release reopens.

Other clients give you raw git verbs. Gitnetix gives you the release flow teams actually run.

## 4. Status on every row, same order every time

Each branch row: icon by role (trunk / release / work), ahead ↑ / behind ↓ against its *real*
parent (not just origin), WIP count, conflict marker, rewritten-history warning, running/waiting
agent, avatars. The push button wiggles when commits wait for origin.

## 5. Worktrees and AI agents per branch

- Open any branch in its own **worktree** with one click.
- Run an **AI agent** (Claude Code, Codex, Gemini, Copilot, Ollama) on each branch, in parallel.
- A shell terminal beside every agent.
- Closing a worktree can merge it into a branch you choose.

Branches become parallel workstations, not just pointers.

## 6. AI writes the boring text

Commit messages, branch names, PR descriptions, release notes, conflict resolutions, ticket
triage. Driven by editable **templates** and per-task **model routing** (cheap model for commit
messages, strong model for conflicts). Works with a signed-in CLI or an API key.

## 7. Tickets and PRs in the same place

- GitHub and Azure DevOps PRs: list, review, comment, merge.
- Jira, Trello, Asana: branches matched to tickets by key, release guessed from Jira fix version.

## 8. Manage from your phone

Same React UI ships as an iOS/Android app (or any browser). Pair with the desktop or a headless
server and drive releases, agents and PRs remotely. Every action also exposed as an **MCP tool**,
so agents can drive Gitnetix too.

## 9. Fast and native

Rust engine wrapping the real `git` CLI, React UI, Tauri 2 shell. Small download, Linux / macOS /
Windows. Branch views cached per project, only changed branches rebuilt. Origin fetched and pruned
every five minutes.

---

## One-line pitch candidates

- **"See your work, not your commits."**
- "Git without the subway map."
- "Branches as a tree. Releases as a button. Agents on every branch."
- "The Git client that knows what you're shipping."
