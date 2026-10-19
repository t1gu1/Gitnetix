# Changelog

All notable changes to Gitnetix are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

Add entries under `Unreleased` as you go. Shipping a release in Gitnetix renames that
section to `## [x.y.z] - YYYY-MM-DD` and commits it before tagging. The release workflow
copies the version's section (or `Unreleased`, for a tag pushed by hand) into the GitHub
release notes and the in-app update prompt.

## [Unreleased]

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
