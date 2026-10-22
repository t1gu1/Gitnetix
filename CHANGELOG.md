# Changelog

All notable changes to Gitnetix are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

Add entries under `Unreleased` as you go. Shipping a release in Gitnetix renames that
section to `## [x.y.z] - YYYY-MM-DD` and commits it before tagging. The release workflow
copies the version's section (or `Unreleased`, for a tag pushed by hand) into the GitHub
release notes and the in-app update prompt.

## [Unreleased]

### Added
- Publishing a branch now returns checkout to its parent branch.

### Fixed
- Deleting a release tag now reopens that release.
- An untagged shipped release that is ahead of main is now reopened.

### Removed
- Removed the hide-branches toggle from the workspace; the branches pane is always shown.
- Removed status counts from worktrees and moved the session button down.

## [0.4.0] - 2026-10-22

### Added
- Closing a worktree can merge it into a branch you choose.
- Escape closes the open diff in the workspace.
- Resizable panels on the AI setup, pull request, release notes, settings, submodules, templates, tickets and worktrees screens.
- Origin is fetched and pruned when a project opens and every five minutes, so branches deleted on PR merge disappear without a manual refresh.
- Pull request list, detail, create, edit, merge, close, review, comment, reply, resolve and react now work on Azure DevOps, with a personal access token as an alternative to Entra sign-in.
- Jira, Trello and Asana connections can be added several times, each limited to chosen projects. Jira also signs in with Atlassian (OAuth).
- Tickets gain mine and sprint filters and a place label. Filters are remembered.
- Ticket status can be changed from the detail pane, and Jira fix versions can be edited there.
- Jira tickets show rich descriptions, priority, time tracking and parent.
- Release is guessed from Jira fix versions, and branches are matched to tickets by key, including in other linked projects.
- Each checkout gets a shell terminal beside the agent, with an Agent/Shell tab switch on the workspace and worktree screens.
- The terminal can be maximized and restored in the workspace and worktree detail card.
- The agent input has a Stop button while the agent works, and Up and Down recall earlier messages.
- Suggestion choices in the agent log allow multiple selections.
- The worktrees screen has a narrow layout, and the window can be made narrower.
- Publishing a branch now returns your checkout to its parent branch.

### Changed
- Workspace diffs open in the left pane above the terminal, and the branches pane is a resizable panel.
- Danger buttons are now solid red.
- Deleting a worktree branch asks for confirmation first, and merging one also removes its worktree.
- Pull request and tag actions are hidden for worktree branches.

### Fixed
- Deleting a remote branch that origin already dropped no longer fails with "stale info".
- The terminal session label now sits after the agent picker.
- Commits can run per branch across worktrees.
- The diff pane no longer bounces when scrolled past its end.
- The context menu flips above its button instead of running off screen.
- Choosing an option from the agent input menu no longer submits the prompt form.
- Azure sign-in requests the user_impersonation scope, so consent is granted when needed.
- Deleting a release's tag now reopens the release.
- A shipped release without a tag that is ahead of main is now reopened.

## [0.3.0] - 2026-10-21

### Added
- Show the contents of unchanged files in the project view.
- Show +/- totals on folder rows in the changed files list.
- Offer a rebase after changing a branch target.
- Right-click a changed file or folder for a menu with copy path, open in file explorer (desktop only) and add to .gitignore. Folder rows and the staged/unstaged lists also gain stage and unstage actions.
- Pick the provider, model and effort for each agent session. Agents on a branch always run in that branch's own worktree.
- Close agent sessions from a button on each agent tab. Worktree sessions ask whether to delete the worktree, or merge it first and then delete it.
- Filter branches and commits by author.
- Search the commit list, with matches highlighted in branch names and commit text.
- Show author avatars on branch and commit rows. Gravatar pictures are optional and off by default, in Settings > Avatars.
- Force push when resetting a branch, and remember the delete-origin choice.
- Show progress while cleaning up branches.
- Add motion preferences in Settings.

### Changed
- Large diffs scroll faster because off-screen rows are skipped.
- The branch commit list always has a commit selected.
- Tune the tree row tints and the commit list separator.
- After a commit or push, only the branches that changed are rebuilt, so the branch tree updates faster. The WIP list and badge update at once.
- Removing a worktree stops its agent.
- Tweak the top bar borders and tab padding, and center the changed files header row.

### Fixed
- Branches named like a tag are listed and resolved as branches, so cleanup no longer fails or hits the wrong ref.
- Closing branch history restores the file view.
- Removing a worktree whose folder was already deleted by hand no longer fails.

Skipped: the TODO, graphify and avatar-placement refactor commits. I did not check the code. The commit messages were partly mismatched (e7647dd, 14d89a0), so some entries may be off.

## [0.2.0] - 2026-10-20

### Added
- Right-click a changed file or folder in the workspace to copy its path, open it in the file explorer (desktop only), or add it to .gitignore.
- Stage and unstage actions on folder rows and in the staged/unstaged lists.
- Folder rows in the file list now show +/- totals.
- After changing a branch target, the workspace offers to rebase.

### Changed
- The branch commit list in the workspace always has a commit selected.

## [0.1.3] - 2026-10-19

### Changed
- Image diff comparison mode switch moved into the diff header, with the "Before"/"After" meta on the left of the swipe, onion and difference controls

### Fixed
- Release branches that exist only on origin are now imported

## [0.1.2] - 2026-10-19

### Added
- App version now shows in the menu header.
- Analytics can now be filtered by project; no selection means all projects.

### Changed
- Path dots on branches the path only passes through are now dimmed.
- Dimmed path runs now fade in and out at their ends.
- Tree now shows the checked-out branch or tag as soon as a switch completes.
- Switching projects now returns you to where you left each one: same page, open dialogs and menu, selected branch, and that project's analytics.
- Checked-out row in the tree now has a faint yellow tint.
- Analytics now show lead time in hours.
- Analytics now show total commits in place of the AI-share KPI.

### Fixed
- Branch path line now runs past the sibling branches above it.
- Path line now runs through the Shipped separator.
- Path pulse now stays in sync on WebKit.
- Path pulse now keeps its pace as the path length changes.
- Path pulse now carries across layout changes.
- Analytics now count merges into release branches and squashed PRs.
- Commit animations now wait for a merge to end before playing.

## [0.1.1] - 2026-10-19

### Added
- Release branches can change the branch they were cut from. Trunks can take a parent, and work branches can target any existing branch.
- Branches falling behind are grouped under their parent branch.
- Azure DevOps pull requests are read to place merged branches under the release that shipped them.
- Branches whose ticket key appears in a later pull request squash are shown with a "likely" tag. They are never deleted or cleaned up as merged.
- The push button wiggles when commits are waiting to go to origin.
- The commit link animates when new commits land.
- An empty state is shown when no pull request provider is connected.
- "Move unreleased changelog into x.y.z" release branch action: renames the `Unreleased` section of `CHANGELOG.md` to the release's version, dated today, and commits it on the branch before shipping.

### Changed
- Open releases are sorted newest version first.
- Branch views are cached per project, and a quick overview shows first when nothing is cached, so reopening a project is faster.
- Squash merge checks are persisted per commit pair, so they are not repeated.
- The terminal panel is hidden by default.
- Light mode accent colors are tuned.
- Section Clean up buttons are now a brush icon in line with the group row.
- Branch tree rows sit on a raised background, and Shipped has a thin separator above it.

### Fixed
- Branches squashed by pull requests are now detected, including squashes not titled with the branch name.
- Squashed branches are placed under the release that shipped them.
- Releases shipped by a later patch of their line are marked as shipped.
- Older releases whose branch still exists are now listed.
- Ahead/behind counts are batched per base branch, so they load faster.

## [0.1.0] - 2026-10-19

### Added
- Sign in with GitHub through the OAuth device flow in Settings › Git providers, no token to create; personal access tokens still work.
- Sign in with Azure DevOps from Settings › Git providers using a Microsoft device code. The token is renewed automatically before it expires.
- Close (abandon) a pull request without merging, after a confirmation, optionally deleting its branch locally and on origin, and reopen a closed one. The "Merged" tab is now "Closed" and also lists your closed PRs.
- Edit your own PR comments, review thread replies and review summaries, with "Improve" to polish the wording with AI.
- "Improve reply" on PR review threads: AI fixes spelling, grammar and wording of a started reply, keeping its meaning, tone and language.
- "Update changelog" branch action: AI adds the branch's changes to the `Unreleased` section of `CHANGELOG.md` and commits it on the branch, falling back to the latest tag when the branch has no diff. Shown when the project has a changelog and AI is set up.
- Shipping a release dates the `Unreleased` section of the project's `CHANGELOG.md` and commits it before tagging.
- Stash management: list stashes per branch or project-wide, view their files and diffs, then pop, apply or drop them.
- Image and SVG previews in the file diff. A replaced image can be compared side by side, with a swipe slider, as an onion skin or as a pixel difference.
- Full mode in the file diff to show the whole file around the changes, next to Split and Unified, and a change heatmap beside the diff that doubles as a draggable scrollbar.
- Submodules page: every submodule of the project with its pinned and checked-out commits, uncommitted files and new commits on its remote. Add, clone, update to the pin or pull the latest, pin the checked-out commit, sync or edit the URL and tracked branch, open its repository page on GitHub, GitLab or Azure DevOps, open one as a project, or remove it. "Update all" clones missing submodules and checks each out at its pin; its menu pulls the latest for all, syncs every URL or checks remotes for updates.
- Row actions on stashes and a bulk cleanup to drop several stashes at once.
- "Branches falling behind" group in the branch tree for branches 25 or more commits behind the default branch, with a Clean up action to pick which ones to delete.
- Branch commit list shows origin's commits next to the local branch, with local and origin tips tagged. Unpulled commits can't be reverted or reset until pulled.
- Local-only and origin-only branches get labels in the branch tree.
- 7, 14 and 21 day ranges in analytics, and a richer release tooltip.
- The app checks for new releases on launch and offers to download, install and restart.
- macOS (universal `.dmg`) and Windows (`-setup.exe`) builds on every release, next to the Linux AppImage.

### Changed
- Review summaries show as threads labeled Approved, Requested changes or Reviewed, with the text reviewers submit with their vote. Every review thread, comment, review and review request now loads, not just the first 60.
- Branch cleanups run in the background and stay visible in the tree when you change screen or project. Branches are deleted four at a time.
- Branch tree opens only the sections on the checked-out path. Row actions are now icon-only and fill the row height.
- Analytics, Tickets empty state and worktree detail are centered, and the detail column is capped at 1040px.
- The PR list pane has a fixed width.
- Analytics remembers the selected time range and defaults to 14 days.

### Fixed
- Tab and segment labels no longer widen and shift nearby controls when they turn bold.
- "New PR from …" stays busy while the PR is being created, even after leaving the page and coming back.
- Branches merged on origin are detected even when the local base branch lags behind.
- An open release is dropped when its branch is deleted.

## [0.0.6] - 2026-10-18

### Added
- Tags shown on commits, and commit history for the trunk.
- Linux AppImage published on version tags.

## [0.0.5] - 2026-10-18

### Added
- Checkout, branch-from and delete actions for tags.

## [0.0.4] - 2026-10-18

### Added
- Tag branch action, with push to origin.

### Fixed
- Squashed branches are deleted last, locally and on origin.

## [0.0.3] - 2026-10-18

### Added
- Next release version suggested from changes, with branch names generated from it.
- Force push for rebased branches, and retagging of shipped releases.
- Gitnetix logo and app icons.

## [0.0.2] - 2026-10-18

### Added
- Branch tree view with parent tracking, shipped work placed under its release.
- Branch commit list with per-commit diffs, plus revert, cherry-pick and reset.
- Merge into any local branch, with merge options; branch reset; git file watcher.
- Delete remote branches and clean up merged children.
- Stash action and uncommitted file count per branch.
- Resizable panes and collapsible branches panel.

## [0.0.1] - 2026-10-17

### Added
- First release: projects, releases, feature/fix branches, worktrees, ship + tag.
- WIP view with staging, unstaging, discard and collapsible file sections.
- Branch merge and delete, branch type picker with prefix handling.
- Closable, reorderable project tabs.
- Tooltips with truncation hints.
