---
description: "Phase-1 cleanup: post feature-branch merge. Runs after a ticket's PR merges into a feature branch rather than main — a Story-container into its parent Epic's branch, or a leaf into its container's. Retains the branch and Jira state (kept alive for /promote-to-main), but cascade-rebases siblings and refreshes the feature branch. Refuses if the detected merge target is `main` — use /cleanup-main instead. Re-run /cleanup-main {KEY} once the main-targeting PR lands to finish terminal cleanup."
allowed-tools:
  - Skill
---

# Cleanup (Feature-branch merge)

Explicit entry point for **Phase-1** cleanup: the ticket's PR merged into a feature branch rather than `main`. Use this both when a Story-container ships to its parent Epic's branch and when a leaf ticket ships to its container's branch — neither has reached main, so both keep their branch and Jira state.

Equivalent to `/cleanup {KEY} --require-phase=feature`. The wrapped command:
- Verifies the PR merged into the parent Epic's feature branch.
- Tags the merge commit as `merged/{KEY}` (load-bearing for `/promote-to-main`).
- Retains the Story branch on disk + remote (it must survive for `/promote-to-main` to rebase it onto main).
- Keeps the Jira ticket in its current in-progress status, progress labels untouched (the `merged/{KEY}` tag records that phase 1 ran).
- Cascade-rebases sibling Stories under the same Epic (if any) onto the refreshed Epic feature branch.
- Refreshes the Epic feature branch by resetting to `origin/{EPIC_FEATURE_BRANCH}` and re-merging unmerged ticket branches.
- Refuses if the detected merge target is `main` (wrong phase) and points you at `/cleanup-main`.

For terminal cleanup after the Story lands on `main`, use `/cleanup-main {KEY}`.

## Arguments

`$ARGUMENTS`

Required: a Jira ticket key (e.g., `PROJ-123`).

Optional flags (forwarded to `/cleanup`):
- `--no-rebase` — skip sibling cascade-rebase.
- `--no-refresh-feature` — skip Epic feature-branch refresh.
- `--yes` (alias: `--no-confirm`) — skip the interactive confirmation prompt.

## Step 1: Delegate to /cleanup with phase guard

Use the `Skill` tool to run skill `cleanup` with args `{$ARGUMENTS} --require-phase=feature`.

The wrapped command does the phase detection and refuses with a clear pointer if the ticket's PR actually merged into `main` rather than an Epic feature branch.
