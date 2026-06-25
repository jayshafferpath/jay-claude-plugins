---
description: "Phase-1 cleanup: post Story→Epic feature-branch merge. Runs after a Story-container's PR merges into its parent Epic's feature branch. Retains the Story branch and Jira state (kept alive for /promote-to-main), but cascade-rebases siblings and refreshes the Epic feature branch. Refuses if the detected merge target is `main` — use /cleanup-main instead. Re-run /cleanup-main {KEY} once the Story's main-targeting PR lands to finish terminal cleanup."
allowed-tools:
  - Skill
---

# Cleanup (Feature-branch merge)

Explicit entry point for **Phase-1** cleanup: the ticket's PR merged into a parent Epic's feature branch (not `main`). Use this when a Story-container ships to its Epic.

Equivalent to `/cleanup {KEY} --require-phase=feature`. The wrapped command:
- Verifies the PR merged into the parent Epic's feature branch.
- Tags the merge commit as `merged/{KEY}` (load-bearing for `/promote-to-main`).
- Retains the Story branch on disk + remote (it must survive for `/promote-to-main` to rebase it onto main).
- Keeps the Jira ticket in its current in-progress status; applies `ClaudePendingMainPromotion`.
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
