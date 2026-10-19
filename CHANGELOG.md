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
- macOS (universal `.dmg`) and Windows (`-setup.exe`) builds on every release, next to the AppImage.
- Prompt to install new releases on launch.
- Shipping a release dates the `Unreleased` section of the project's `CHANGELOG.md` and commits it before tagging.
- Stash management: list, pop, apply and drop.
- Branch tree flags branches falling behind and offers to clean them up, in the background.
- Branch commit list marks the local and origin tips.

### Changed
- Branch tree opens only the sections on the checked-out path.
- Branch row actions are icon-only and fill the row height.
- Cleanup deletes branches four at a time.

### Fixed
- Open release is dropped when its branch is deleted.

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
