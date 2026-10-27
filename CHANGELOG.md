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
- Voice dictation in any text box with a shortcut (or the mic on phones), transcribed locally with Whisper and a downloaded-once model checked against its SHA-256.
- Dictation splits speech by language, transcribes each stretch in its own language, and saves the main one as the spoken language. A new "Spoken" generation language option follows it.
- Dictation uses voice activity detection, the project's names, branch and changed files as vocabulary, and an optional rewrite into clear text. The rewrite can be turned off in settings.
- Dedicated French dictation model, downloaded on first French use.
- Dictation settings pane for the shortcut, the allowed dictation languages and the microphone permission.
- Phone microphone dictation through the companion API, which now answers HTTPS on its existing port.
- Syntax colors in diffs, loaded per language without blocking the UI.
- Colour swatch before hex values in diff lines.
- Code view for SVG diffs.
- `a11y` branch kind (alias `accessibility`).
- Ctrl/Cmd +, - and 0 shortcuts to zoom the desktop app.

### Changed
- Branch views refresh faster and show their progress, reusing saved views for branches that did not move.
- Dictation runs on the Metal GPU on Apple Silicon.
- Desktop dictation records with the native microphone, so it works on Linux installs without webview audio codecs.
- Dictation can be cancelled from the footer or the field mic, including while text is being written out.
- The field mic shows its shortcut beside the icon on desktop.
- Dictation vocabulary and rewrite name the user's other projects.
- Text-only AI completions start faster.
- Changelog templates list highlights first, and old defaults are migrated.
- The New Item type picker puts Release where Build was; a typed `build/` prefix still works.

### Fixed
- SVG diffs stay sharp.
- Closing the selected worktree returns to the worktree list.
- Close options show for worktree runs with nothing to merge.
- Agent input no longer overlaps on mobile in hidden panes.

Skipped: the social card refresh (website only). Not checked: whether the "Changelog templates" and "Release" picker lines match real user-visible wording.

## [0.9.3] - 2026-10-26

### Added
- Open the pairing QR scanner from the More menu on mobile.

## [0.9.2] - 2026-10-26

### Added
- Settings › Terminal sets the tab a branch's terminal opens on until one is picked there: Agent (the default) or Shell. Branches with an agent session open on Agent.
- Message an agent while it works: your messages wait in a queue and go out together when its run ends. If it had asked you questions, it asks them again after answering, unless you told it not to ask questions. Stopping the agent puts the queued messages back in the prompt box.
- Scan QR code button on the pairing screen on iOS and Android: it opens the camera and pairs with the desktop from the scanned link.
- Pair from a photo of the QR code when the camera is unavailable.
- The app can be installed to a home screen with its own icon and name.
- Attach files and pick the agent in the new item modal.

### Fixed
- The Agent or Shell tab picked in a terminal is remembered per branch instead of for every branch and worktree. Worktrees open on Agent every time you come back to them.
- Localhost links open on the desktop host when you use the app remotely.

## [0.9.1] - 2026-10-26

### Added
- Ship dialog can update and date the changelog as the release ships, when AI is on for releases and the project has a `CHANGELOG.md`. A Settings toggle controls the default.
- Delete tag action in the commit menu.
- Images sent to an agent, and images it shows, preview on hover or focus in the agent log.
- Click a sent image to open it full size.
- Pulling a diverged branch now offers to rebase or merge.

### Changed
- Main tabs in the top bar are reordered.

### Fixed
- Shipping a release is refused only when uncommitted changes touch release files.

## [0.9.0] - 2026-10-26

### Added
- Project commands menu in the terminal for Cargo, Go, Make, just, Docker, Compose, Gradle, Maven, .NET, CMake, Python, Ruby, Godot, LÖVE, Odin and shell scripts, plus package.json scripts. Commands whose program is not installed are hidden.
- Hide and show command sections per project. Hidden sections fold into a small pill.
- Rename branches and open releases, locally and on origin when asked.
- Rebase a worktree onto its base and resolve conflicts from the worktree actions.
- Right-click actions menu and an actions button on worktree rows.
- Worktree rows show how many commits they are behind base.
- Copy workspace name action for worktrees.
- Setting to expand the terminal by default in worktrees.
- AI answers fit in conflict resolution, and modify/delete conflicts can be resolved.
- Claude runs cut off by quit are resumed on next start.
- Finished worktree agent runs show as done instead of waiting.
- First task is pinned to the top of the agent log.
- Phone notification when an agent is waiting or failed.
- Analytics: click a day bar to see its commits by person and type, and a release bar to see its features, fixes and merged branches.
- Pairing QR code in the settings menu panel.
- Appearance settings open from the theme row in the menu.
- Theme picker on the website header and home page.

### Changed
- Worktree detail layout is wider, up to 1400px.
- Page header is hidden on wide layouts in tickets, pull requests and other tabbed pages; the back button shows only on narrow layouts.
- The dev app restarts on Rust changes only when idle.

### Fixed
- Terminal always shows at least one command section, and the folded pill is tidier.
- Opening a worktree focuses the agent tab.
- Rename is refused mid-rebase, and a failed CHANGELOG.md commit after a rename is reported instead of failing the rename.
- Upstream tracking is correct after a local branch rename.
- Deleted or pruned worktrees no longer break the rebase check.
- Merging with branch delete no longer fails with "Directory not empty" when a build is still writing in the worktree.
- Authors sharing an email or name are merged into one person.
- Child processes started from the AppImage no longer fail on bundled library variables.
- Pinch zoom and double-tap zoom are blocked on mobile.
- Day range bar in analytics lines up with the page content width.

## [0.8.0] - 2026-10-25

### Added
- Selectable color themes beyond light and dark, with an Appearance pane in Settings showing swatches.
- Attach files to a new agent session by button, paste or drop.
- New worktrees clone their submodules at the branch's pinned commits.
- Commit or discard uncommitted work before continuing on a branch.

### Changed
- The header toggle switches to the same theme's other mode when one exists, and the menu theme picker lists every theme.
- Removing a worktree is refused when a submodule holds commits that are not on any remote, unless forced.
- Codex and Copilot now receive the picked model and reasoning effort, and Gemini receives the model.

### Fixed
- Lettered question lists in agent replies are detected as answer groups when any list in the reply is a question.

## [0.7.1] - 2026-10-25

### Changed
- Website now served from the gitnetix.app custom domain.

## [0.7.0] - 2026-10-25

### Added
- Ctrl+Enter (⌘+Enter on macOS) in the commit summary or description commits.
- Settings › Animations has three more switches: Page fade, List entrances and Dialog pop.
- Notifications can be clicked away, and show a check or a cross on success and errors.
- Mobile: a More menu in the tab bar opens the pages that do not fit as tabs.
- Files and images can be attached to agent messages and new agent starts, up to 25 MB each.
- Agent sessions take an optional ticket, linked to the branch before the agent starts.
- Each project stores defaults for the finish, new branch, new agent, ship, delete origin and cleanup origin dialogs.
- The website has a Compare page with Gitnetix, GitKraken, Fork and Sourcetree side by side.

### Changed
- A refreshed look across the app: softer corners, layered shadows on menus and dialogs, an accent halo on focused fields, thin scrollbars, and buttons that ease into their hover and give a little when pressed.
- Smoother motion: pages fade up when opened and the page tabs' underline slides to the open page; dialogs, context menus, notifications and the agent panel animate in; new branches, files, commits and agent replies fade in as they appear; analytics bars grow from the axis.
- Panes with nothing selected yet (pull request, ticket, worktree, submodule, release notes) show an icon, a title and what to do next.
- The welcome and pairing screens were redrawn: the logo, a drop zone that lights up while folders are dragged over it, and numbered pairing steps.
- Light theme: branch tree group headers are much lighter and the checked-out branch gets a warm amber tint; segmented controls show a white selected chip.
- Mobile: the open tab's icon sits in an accent pill, and the page bar scrolls to keep the open page's tab in view.
- Disconnect from this desktop is a quieter red text button instead of a solid one.
- The branch tree filter is a full-width bar with an author segment.
- Pull request load errors show the empty-state view.
- The website's release page lists each release's changes inline and has a "See all release notes" link.
- The worktrees list is grouped by project, with a new-session button on each header and status and base branch shown under each branch name.
- Planning a branch into a release also plans its ticket into that release.
- Suggestions picked in the agent prompt box queue there instead of sending on their own.
- The agent question Send button sits below all questions.
- Task routing pickers wrap below their label when the pane is narrow.
- The website's home page comparison shows the app's branch pane.
- The default finish action in the finish dialog is now merge, not continue.
- The terminal's open bar highlights on hover toward the collapse button.
- Release version chips on the website use the accent color.

### Fixed
- The worktree list no longer says "None currently running" for a project that simply has no worktree yet.
- A double line no longer shows under the page tabs.
- Branch path dots stay lined up across elbows in the branch tree.
- Icon buttons stay square at touch height on mobile.
- Scrollbars no longer show through dialogs.
- The terminal no longer uses the WebGL renderer on Linux, where it failed to draw.
- The terminal starts the login shell from the system account instead of an inherited SHELL.

## [0.6.2] - 2026-10-24

### Fixed
- A release is now forgotten once its branch is gone everywhere, so it no longer lingers in the app.

## [0.6.1] - 2026-10-23

### Added
- Azure: PR checks now show a "waiting" status for policies not yet running, and the PR screen shows "Checks waiting".

### Changed
- Azure: only build policies with a current pipeline run count as running; other unmet policies report as waiting.
- Azure: PR statuses come from the latest iteration, as on Azure's PR page, and the newest status per name wins.
- Azure: pending code coverage statuses are hidden, since the pipeline's own policy carries the result.
- The PR screen blocks merge while any check is waiting, as it does for running checks.

### Fixed
- Azure: the merge strategy policy no longer appears in PR checks.

## [0.6.0] - 2026-10-23

### Added
- Agents started on a branch linked to a Jira, Trello or Asana ticket get the ticket's title, description and acceptance criteria in their first prompt, with a copy in the checkout's git dir to read again later. Agent templates can place it with `{ticket}`.
- `tickets.get` API method (and `tickets_get` MCP tool): one ticket with its full description, by key or by branch.
- Replies with several questions show as one group of buttons per question, lettered when the reply letters them, with a single Send.
- Merge, rebase, cherry-pick, revert and stash apply now resolve conflicts automatically and carry on. If a file cannot be resolved, the operation is aborted, the checkout is left unchanged, and the error gives the reason. Turn it off in the Menu.
- Logs page under Menu: the last 2000 operations and errors, with copy and clear actions. The conflict toast and merge dialog link to it.
- Switching branch while the main checkout is stopped mid-rebase, merge, cherry-pick or revert asks to abort that operation first. `workspace.switch` accepts `abort` to do it before the checkout.
- Merging a branch with uncommitted changes asks for confirmation first.
- The website install script falls back to a user-level install when permission is denied.
- Offer grouped answer buttons for agent questions, one group per question with a single Send
- Resolve merge, rebase, cherry-pick, revert and stash conflicts automatically and carry on, with a Menu toggle to turn it off
- Add an in-app Logs page under Menu to view, copy and clear recent operations and errors
- Include the linked Jira, Trello or Asana ticket in the agent prompt when a branch has one
- Add `tickets.get` RPC method and `tickets_get` MCP tool to fetch one ticket by key or branch
- Ask before merging a branch with uncommitted changes
- Offer to abort a stuck rebase, merge, cherry-pick or revert before switching branch
- Add user-level install fallback on the website when permission is denied

### Changed
- Commits are refused while staged changes still contain conflict markers, and the affected files are listed.
- Conflict resolution sends only the conflicted excerpts instead of the whole file, so big files resolve faster.
- Mirror the app workspace layout in the website hero demo
- Send only the conflicted excerpt to AI conflict resolution so big files resolve faster
- Roll the branch back to its old tip when a squash merge fails

### Fixed
- Squash rolls the branch back to its old tip when the merge that follows fails.
- Block commits that still contain conflict markers and list the affected files
- Preserve CRLF line endings and keep the stash after AI conflict resolution

## [0.5.2] - 2026-10-23

### Added
- Interactive hero demo on the website: pick branches, open file diffs, send prompts and commit in a playable copy of the Workspace screen
- Animated path to the checked-out branch in the website hero demo

## [0.5.1] - 2026-10-23

### Added
- Website: dedicated remote section with the phone mockup.
- Website: worktree mockup now mirrors the agent pane.

### Changed
- Author is credited as Guillaume Huard Hughes, linking to the A Dev Journey home page, in the README and website footers.
- README intro rewritten, with a new tagline and a link to the project website.

### Fixed
- Website: comparison panel now uses border-box sizing.
- Website: spine gradient fades in from the top edge.
- Website: CI builds now show the release tag as the latest version.

## [0.5.0] - 2026-10-23

### Added
- Website built with Astro, deployed to GitHub Pages, with one release notes page per version.

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
- Publishing a branch now returns checkout to its parent branch.

### Changed
- Workspace diffs open in the left pane above the terminal, and the branches pane is a resizable panel.
- Danger buttons are now solid red.
- Deleting a worktree branch asks for confirmation first, and merging one also removes its worktree.
- Pull request and tag actions are hidden for worktree branches.

### Removed
- Removed the hide-branches toggle from the workspace; the branches pane is always shown.
- Removed status counts from worktrees and moved the session button down.

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
- Deleting a release tag now reopens that release.
- An untagged shipped release that is ahead of main is now reopened.

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
