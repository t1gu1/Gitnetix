# Branch test list

Every branch, commit and worktree behavior Gitnetix must keep, written as plain test cases. Each case says what to do and what should happen, and points to the automated test that checks it, when there is one.

## How this file works

Each case is one row: an ID, what to do, what should happen, a status, and the test that checks it.

- IDs start with the section prefix (`WT`, `BR`, `SA`, `CM`, `AI`, `UI`) and a number. A number is never reused or renumbered, even when a case is removed. Other files and test names point to it.
- Automated tests carry the ID in their name. `BR-03` is `br03_rebase_on_parent_from_the_node_button` in `crates/core/tests/branch_regression.rs`. Cases older than this file point to their existing test as `file.rs::test_name`.
- The tests drive the app through the same RPC calls the UI makes (`rpc::call`, see `crates/core/src/rpc.rs` for the list), on throwaway repos with a bare `origin`. They never touch a real project.

| Status | Meaning |
| --- | --- |
| Auto | Checked by a test on every `cargo test` run. |
| Auto, real AI | Checked by an ignored test that calls the machine's real AI. Run on demand, it spends AI usage. |
| Auto, UI script | Checked by `scripts/ui-branch-check.mjs` in a headless browser. Run on demand. |
| Manual | Checked by hand in the app (or with a headless browser). The row says when it was last checked. |
| To automate | Written down, no test yet. |
| Not built | The expected behavior does not exist in the app yet. |
| Fails | A test exists and fails: an open bug, listed under "Findings". |

### Running the tests

From the repo root:

```sh
cargo test -p gitnetix-core --test branch_regression           # the branch suite, about 10 s
cargo test -p gitnetix-core --test branch_regression br03      # one case
cargo test -p gitnetix-core                                    # every core test, about 2 min
cargo test -p gitnetix-core --test ai_conflict_edges -- --ignored --test-threads=2   # real AI cases, about 2 min
pnpm check:ui-branches                                         # UI cases in a headless browser, about 1 min
```

The real AI cases use the `claude` CLI (installed and signed in). Set `GITNETIX_TEST_AI=codex` (or another provider id) to use another one.

The UI script builds `gitnetix-server`, makes a throwaway repo with one branch per state, and runs the server and Vite on free ports in a temp folder. It never touches your projects and stops only the processes it started. It needs Playwright with Chromium (`npx -y playwright install chromium` once). `--out <dir>` saves the screenshots there.

`file_history.rs::history_follows_renames_and_blame_names_each_line` fails about one run in three on an unchanged tree. If it is the only failure, run it again on its own before suspecting a change.

### Adding a case

Add a row at the end of its section with the next free number and the status `To automate`. A short sentence in each column is enough. Steps can be loose; the expected result is what matters.

### Turning a case into a test

These rules keep the suite consistent. Follow them when a case moves from `To automate` to `Auto`.

1. Read the UI code that runs the action (`src/screens/BranchMenu.tsx`, `Workspace.tsx`, `UpdateChildren.tsx`, `NewItem.tsx`, `CommitMenu.tsx`) and note the RPC calls it sends, in order, with their parameters. The test sends the same ones.
2. Add one `#[tokio::test]` to `crates/core/tests/branch_regression.rs`, named `<id>_<what_it_checks>` (`br05_…`), with a doc comment starting with the ID. Use the `env()` helper: a repo on `main` pushed to a bare origin, AI conflict resolution off.
3. Set the repo up with plain `git` (`sh`, `commit_file`), act through `e.call(...)`, and check both git itself (`rev`, `git_out`, `is_ancestor`) and what the map gets (`e.view(branch)`).
4. Cases about what the map shows (UI-*) go in `scripts/ui-branch-check.mjs`: add a branch in that state to the scenario repo, then a line to `expected` or a `check(...)`. Cases that need a real AI go in `crates/core/tests/ai_conflict_edges.rs`, marked `#[ignore = "uses the machine's real AI"]`. AI picks the wording, so check the facts that must hold (no markers left, both changes kept), never exact text.
5. A suggested action (`SA-*`) is picked in the UI by `primary()` in `src/screens/BranchMenu.tsx`. The test checks the branch view flags that function reads and the call the button sends. When `primary()` changes, update the SA table to match.
6. When a test fails because the app is wrong, keep the test as it is: set the case to `Fails` and add a line under "Findings". Do not loosen the test until it passes.
7. Run the whole suite, then set the row's status to `Auto` and fill in its test name.

## Worktrees (WT)

| ID | Case | Expected | Status | Test |
| --- | --- | --- | --- | --- |
| WT-01 | New branch from main with "where: worktree", commit twice in the worktree, main moves on, rebase it, squash merge with "delete branch". | The main checkout stays on main. The rebase runs inside the worktree. main gets one `squash \| feat/wt` commit holding both files, plus the merge commit. The branch and the worktree folder are gone. | Auto | `branch_regression.rs::wt01_worktree_create_commit_rebase_and_squash_merge` |
| WT-02 | Open an existing branch in a worktree, leave an untracked file there, close the worktree, then force it. | Closing is refused and the file stays. Forced, the folder goes and the branch stays. | Auto | `branch_regression.rs::wt02_open_an_existing_branch_in_a_worktree_and_remove_it` |
| WT-03 | Merge a worktree's branch with "delete branch" while a build still writes in the worktree. | The merge lands and the branch is deleted. | Auto | `worktree_merge.rs::merge_deletes_the_branch_while_a_build_still_writes_in_its_worktree` |
| WT-04 | Squash, rebase, and squash + rebase merges of worktree branches, with delete and push. A branch whose origin has a commit it never had. A worktree with untracked work. | Each branch is deleted locally and on origin, last. The branch with unseen origin commits stays everywhere. The branch with untracked work is merged and pushed but kept. | Auto | `release_flow.rs::squash_and_rebase_merges_delete_the_branch_last` |
| WT-05 | Create a worktree in a project that lists ignored files to copy. | Only the listed ignored files are copied, never through a symlink the branch holds. | Auto | `worktree_files.rs::new_worktrees_get_the_listed_ignored_files_only`, `worktree_files.rs::files_are_never_copied_through_a_link_the_branch_holds` |
| WT-06 | Remove a worktree whose path points at another folder. | Only the worktree goes. | Auto | `release_flow.rs::removing_a_worktree_never_deletes_another_folder` |
| WT-07 | Create a worktree in a repo with submodules. | The worktree gets the submodules. | Auto | `submodules.rs::worktree_gets_submodules` |
| WT-08 | Click Continue on a branch open in a worktree. | The worktree is removed and the branch is checked out in the main checkout. Refused while the worktree has uncommitted changes. | To automate | |

## Branches (BR)

| ID | Case | Expected | Status | Test |
| --- | --- | --- | --- | --- |
| BR-01 | New branch from main ("switch"), commit, switch back, delete. Then a second branch, pushed, deleted with "on origin too". | The new branch is checked out with parent main. Deleting the unmerged branch is refused, forced it goes. The pushed, merged branch goes locally and on origin without force. | Auto | `branch_regression.rs::br01_create_switch_and_delete_a_branch` |
| BR-02 | Two new files. Stage one and commit. Then Stage & commit. Push, commit again, push again. | The first commit holds only the staged file. Stage & commit leaves nothing behind. The first push sets the upstream. The next commit shows 1 to push, and the push sends it. | Auto | `branch_regression.rs::br02_stage_commit_and_push_a_new_branch` |
| BR-03 | Pushed branch, main moves on, click the update button on its node line (rebase onto its parent). Push, then force push. | The branch sits on main, still checked out. The result says it needs a force push. The plain push is refused, the force push replaces origin's copy. | Auto | `branch_regression.rs::br03_rebase_on_parent_from_the_node_button` |
| BR-04 | main → feat/a → feat/b → feat/c, each made from its parent with New branch. main moves on. Rebase feat/a, then "Update the branches under it". | feat/b stays under feat/a after feat/a's rebase. Each child is rebased onto its updated parent, parents first. `main..feat/c` is exactly a, b, c, each once. The checked-out branch stays checked out with a clean tree. A child made with a plain `git switch -c` has no declared parent and sits under main. | Auto | `branch_regression.rs::br04_group_update_rebases_each_child_onto_its_updated_parent` |
| BR-05 | Rebase a branch onto another branch, local or only on origin. | It lands on that branch. Its target (parent) does not change. | Auto | `rebase_onto.rs::rebases_onto_another_branch_and_keeps_the_target`, `rebase_onto.rs::rebases_onto_a_branch_only_on_origin` |
| BR-06 | A rebase stops on a conflict left to the user. Abort it. Run it again, resolve, continue. | While stopped the map shows the branch as checked out, in a rebase onto that branch. Abort puts it back. Continue finishes and keeps a message that starts with `#`. | Auto | `rebase_onto.rs::a_stopped_rebase_stays_on_its_branch_and_aborts`, `continues_a_stopped_rebase_once_resolved`, `continuing_keeps_a_message_that_looks_like_a_comment` |
| BR-07 | Rebase a branch checked out nowhere. Once cleanly, once with conflicts. | It rebases in a throwaway worktree. With conflicts it goes back to where it was. | Auto | `rebase_onto.rs::rebases_a_branch_checked_out_nowhere_in_a_throwaway_worktree`, `a_branch_checked_out_nowhere_goes_back_when_conflicts_are_left` |
| BR-08 | A rebase finishes but the uncommitted changes it set aside conflict when they come back. | The result lists those files. | Auto | `rebase_onto.rs::a_finished_rebase_reports_the_uncommitted_changes_it_could_not_put_back` |
| BR-09 | Switch branches with uncommitted changes the switch would overwrite. | Refused, then works with stash or carry. Carried changes that conflict keep their stash. | Auto | `switch_with_changes.rs` (2 tests) |
| BR-10 | Switch while a rebase or merge is stuck. | With abort, the stuck operation is aborted first and the tree goes back to before it. | Auto | `switch_in_progress.rs` (2 tests) |
| BR-11 | Pull with uncommitted changes, and a pull on a diverged branch. | Refused, then works with stash or carry. Changes the pull does not touch stay. | Auto | `pull_with_changes.rs` (5 tests), `release_flow.rs::diverged_pull_and_merge_past_uncommitted_work` |
| BR-12 | Rename a branch, on origin too. Another clone follows the rename. | The new name exists everywhere. The other clone is offered to follow it. | Auto | `release_flow.rs::rename_on_origin_and_follow_it_elsewhere` |
| BR-13 | Merge a branch into its parent with delete. Also the checked-out branch. | It merges and goes. The checkout switches to the base. | Auto | `release_flow.rs::merge_and_delete_branches`, `merge_and_delete_the_checked_out_branch_switches_to_its_base` |
| BR-14 | Merge by squash, by rebase, then push. A target that moved meanwhile. | Each mode lands. A rebase merge never rewinds a target that moved. | Auto | `release_flow.rs::merge_by_squash_rebase_and_push`, `rebase_merge_never_rewinds_a_target_that_moved_meanwhile` |
| BR-15 | Point a branch at any branch with "Target". | The map files it under that branch. | Auto | `release_flow.rs::a_branch_can_target_any_branch`, `release_flow.rs::branch_tree_parents_remote_and_sync` |
| BR-16 | Clean up merged branches. | All are deleted on origin in one push. What the cleanup refuses stays. | Auto | `release_flow.rs::cleanup_deletes_on_origin_in_one_push_and_keeps_what_it_refuses` |
| BR-17 | Delete a branch whose worktree holds work. | origin's copy stays. | Auto | `release_flow.rs::deleting_a_branch_keeps_origin_while_its_worktree_holds_work` |
| BR-18 | Force push when origin has a teammate's commit. | Refused: only the branch's own copy is replaced. | Auto | `release_flow.rs::force_push_only_replaces_the_branchs_own_copy` |
| BR-19 | Commit a file that still has conflict markers. | Refused. | Auto | `commit_guard.rs::commit_with_conflict_markers_is_refused` |
| BR-20 | Stage, unstage, discard files and single lines. | Each file and line moves to the side it was sent to. | Auto | `release_flow.rs::stage_unstage_discard`, `line_staging.rs::picked_lines_move_between_sides` |
| BR-21 | Stash a branch's changes, list, apply, drop. | The changes come back where they were. | Auto | `release_flow.rs::stash_flow` |

## Suggested actions (SA)

The selected branch's card has one main button: the action the user most likely wants next. `primary()` in `src/screens/BranchMenu.tsx` picks it, top rule first. The tests check the branch view flags each rule reads, and the call the button sends.

| ID | Branch state | Expected button | Status | Test |
| --- | --- | --- | --- | --- |
| SA-01 | Checked out, behind its parent, nothing to pull or push. | Rebase ("Replay … on top of main"). | Auto, UI script | `branch_regression.rs::br03_rebase_on_parent_from_the_node_button` |
| SA-02 | origin moved on (a teammate pushed), the branch has nothing of its own. | Reset to origin. The reset checks again and refuses if a commit appeared since. | Auto, UI script | `branch_regression.rs::sa02_origin_moved_on_offers_reset_to_origin` |
| SA-03 | origin was force pushed over the branch, whose own commits were all on origin before. | Reset to origin. A new local commit turns it off. | Auto | `release_flow.rs::origin_force_pushed_over_the_branch` |
| SA-04 | Rebased or reset after a push. | Force push. A plain push is refused. | Auto, UI script | `branch_regression.rs::br03_…`, `branch_regression.rs::cm03_…`, `release_flow.rs::reset_back_after_push_force_pushes` |
| SA-05 | Own commits, and origin has a teammate's commit (diverged). | Pull. Force push is refused. | Auto | `release_flow.rs::pull_and_tracking` |
| SA-06 | Commits not pushed yet. | Push. | Auto | `branch_regression.rs::br02_stage_commit_and_push_a_new_branch` |
| SA-07 | Uncommitted changes in the checkout, and SA-11 does not apply. | Commit, before anything that moves the branch. | To automate | |
| SA-08 | Merged into its parent, not checked out. | Delete. | Auto | `release_flow.rs::merged_branches_are_flagged` |
| SA-09 | Open in a worktree. | Continue. | Auto, UI script | `scripts/ui-branch-check.mjs` |
| SA-10 | Not checked out, nothing else to do. | Switch. | Auto, UI script | `scripts/ui-branch-check.mjs` |
| SA-11 | Same as SA-02, but with uncommitted changes (an edit, a new file). | Reset to origin anyway. The tip says the changes come back. The changes are stashed, the branch reset, the changes put back on top and the stash dropped. If putting them back conflicts with origin's copy, the files are left in conflict and the stash is kept. | Auto, UI script | `branch_regression.rs::sa11_reset_to_origin_puts_uncommitted_changes_back`, `scripts/ui-branch-check.mjs` (clicks the button) |

## Commits (CM)

| ID | Case | Expected | Status | Test |
| --- | --- | --- | --- | --- |
| CM-01 | Tag a commit by its SHA. Check the tag out. Delete it. | The tag is created and pushed to origin. Checking it out detaches HEAD on its commit. Delete removes it locally and on origin. | Auto | `release_flow.rs::pull_and_tracking` |
| CM-02 | Reset a branch to an older commit, soft, then mixed, then hard. | Soft: the change is staged. Mixed: unstaged. Hard: gone. HEAD on the commit each time. | Auto | `branch_regression.rs::cm02_reset_soft_mixed_hard`, `release_flow.rs::commit_actions` |
| CM-03 | Reset a pushed branch back one commit from the commit list, then push. | The map suggests Force push. A plain push is refused. The force push moves origin back too. | Auto | `branch_regression.rs::cm03_reset_a_pushed_branch_then_force_push` |
| CM-04 | The active commit of a branch is highlighted. Push, reset back one, then commit. | In step, the newest commit is both the local and origin tip. Reset back, the reset target is the local tip and origin's tip shows "not pulled yet". A new commit is the local tip and "not pushed". | Auto, UI script (UI-03) | `branch_regression.rs::cm04_commit_list_marks_the_local_and_origin_tips` |
| CM-05 | Revert a commit, cherry-pick one onto the checked-out branch. | Revert undoes its change. Cherry-pick brings it over. | Auto | `release_flow.rs::commit_actions` |
| CM-06 | Reset forward onto commits that are on origin. | The branch moves forward to them. | Auto | `release_flow.rs::reset_forward_onto_pushed_commits` |
| CM-07 | Reset while a rebase is paused. | Refused. | Auto | `release_flow.rs::reset_is_refused_while_a_rebase_is_paused` |
| CM-08 | The commit list on a long branch. | Unpushed commits are flagged. A larger limit reaches older history. The list ends where the branch left its base. | Auto | `release_flow.rs::commits_flag_unpushed`, `commits_limit_reaches_older_history`, `branch_commits_end_where_it_left_its_base` |

## AI conflict resolution (AI)

Two kinds of tests. A fake AI (a shell script on PATH) checks the plumbing on every run: `conflict_resolution.rs::ai_resolves_conflicts_and_the_operation_goes_through` covers a rebase, merge, cherry-pick, stash apply and a file changed on one side and deleted on the other. `rebase_ai.rs::ai_carries_a_rebase_through_binary_conflicts_and_an_abort_stops_it` covers binary files and abort. The cases below need a real AI, because what matters is whether it settles odd conflicts. Each one rebases `feat/x` onto `main` with AI on.

| ID | Conflict | Expected | Status | Test |
| --- | --- | --- | --- | --- |
| AI-01 | Same line changed on both sides (main renames a constant, the branch changes its value). | `REQUEST_TIMEOUT = 45`: both changes kept, no markers. | Auto, real AI | `ai_conflict_edges.rs::ai01_same_line_changed_on_both_sides` |
| AI-02 | A Markdown file that shows conflict markers as an example in a code block, with a real conflict below it. | The example stays as it was. Only the real conflict is resolved, both new lines kept. | Auto, real AI | `ai_conflict_edges.rs::ai02_file_whose_text_holds_conflict_markers`, and without AI `app.rs::resolve_answer_tests::markers_a_side_already_holds_are_text` |
| AI-03 | main rewrote a file's code into a new file and deleted it. The branch edited the old file. | AI keeps or deletes it, and the rebase goes through. (If the new file is close to the old one, git sees a rename and there is no conflict.) | Auto, real AI | `ai_conflict_edges.rs::ai03_changed_here_deleted_there` |
| AI-04 | Both sides add the same new file with different content. | The file holds both sides' entries. | Auto, real AI | `ai_conflict_edges.rs::ai04_both_sides_add_the_same_file` |
| AI-05 | main converted a file to CRLF line endings (every line changed). The branch edited one line. | The branch's edit is kept, no markers. | Auto, real AI | `ai_conflict_edges.rs::ai05_line_endings_changed_on_one_side` |
| AI-06 | Two branch commits each conflict with main on the same line. | AI settles each step. The last value wins and both commits stay. | Auto, real AI | `ai_conflict_edges.rs::ai06_every_commit_of_the_rebase_conflicts` |
| AI-07 | "Update the branches under it" where AI cannot settle a child's conflict. | That child is aborted and left as it was. The branches under it are skipped. The toast names them. | To automate | The logic is in `src/screens/UpdateChildren.tsx` |

## UI checks (UI)

Checks of the redesigned branch map. `pnpm check:ui-branches` runs them (see "Running the tests"): it selects each branch of the scenario repo and reads its card.

| ID | Case | Expected | Status |
| --- | --- | --- | --- |
| UI-01 | Select each branch on the map and read the card's main button. | Behind its parent and checked out: Rebase. origin moved on: Reset to origin, with uncommitted changes too. Reset after a push: Force push. In a worktree: Continue. Not checked out: Switch. | Auto, UI script |
| UI-02 | A branch whose target is another work branch. | Its tile sits to the right of its parent's, joined by a line. The card says "Merges into feat/local". | Auto, UI script |
| UI-03 | The checked-out branch's commit rows. | Its newest local commit is highlighted (`.map-crow[data-on]`). | Auto, UI script |
| UI-04 | A branch merged into main. | It shows under the trunk with a MERGED tag and a "Clean up merged" button. | Auto, UI script |
| UI-05 | Rebase a parent from its node line, then accept "Update the branches under it". | The dialog lists the children, parents first. Each one is updated, and pushed when asked. | Manual, not checked yet |
| UI-06 | An AI rebase running on a branch. | The branch's button spins, the card shows "AI rebasing onto … n of m", and a lock covers branches being rebased onto. | Manual, not checked yet |

## Findings

Problems found while running these cases. Keep the line when it is fixed, and say so.

| ID | Date | Case | Finding | State |
| --- | --- | --- | --- | --- |
| F-1 | 2026-11-20 | AI-02 | AI cannot resolve a conflict in a file that shows conflict markers as an example (a doc about git). `conflict_regions` in `crates/core/src/app.rs` takes the example for a conflict. The first pass then refuses any answer that keeps the example. The second pass asks AI to resolve the example itself and refuses every answer that keeps its markers. After 3 tries the file is left in conflict with "No usable answer after 3 tries". | Fixed 2026-11-20: marker blocks a side already holds word for word are text (`real_conflicts` in `app.rs`), and AI is told to leave them. Limit: an example inside a conflicting side still hides that conflict, which is then left to the user. |
| F-2 | 2026-11-20 | SA-11 | Reset to origin with uncommitted changes (stash, reset, apply back) does not exist. | Built 2026-11-20 |
| F-3 | 2026-11-20 | UI-01 | A branch reset back after a push shows "↓1 to pull" in red, while its button says Force push. Pulling would bring back the commit the user dropped on purpose. | Open, wording |
