---
description: "Terminal cleanup: post PR merged to main. Deletes the local + remote branch, transitions the Jira ticket to Done, removes progress labels, cascade-rebases any unmerged downstream tickets onto main, and refreshes the long-lived feature branch. Refuses if the detected merge target is the parent Epic's feature branch — use /cleanup-feature instead, and re-run /cleanup-main after the main-targeting PR lands."
allowed-tools:
  - Skill
---

# Cleanup (Main merge)

Explicit entry point for **terminal** cleanup: the ticket's PR merged into `main`. Use this for any ticket — leaf, standalone, or Story-container — once `/promote-to-main` has landed it there. A ticket whose PR merged only into a feature branch is *not* ready for this phase; it will be refused with a pointer to `/cleanup-feature`.

Equivalent to `/cleanup {KEY} --require-phase=main`. The wrapped command:
- Verifies the PR merged into `main` and the merge commit is reachable from `origin/main`.
- Deletes the local and remote branch.
- Removes progress labels and transitions the Jira ticket to Done (or labels-only if no Done transition exists).
- Appends a "Shipped" entry to the ticket's activity log; if it was the last unmerged ticket in its container, appends a "Stack complete" entry to the container.
- Cascade-rebases any unmerged downstream stacked tickets onto `main`.
- Refreshes the long-lived feature branch by resetting to `origin/main` and re-merging still-unmerged ticket branches.
- Retires the `merged/{KEY}` tag (if present) — but only when the verified merge target really is `main`, since the tag is a ticket's durable ship record and the `featureMergeSha` replay source for feature-branch refreshes.
- Refuses if the detected merge target is the parent Epic's feature branch (wrong phase) and points you at `/cleanup-feature`.

For Phase-1 cleanup after a Story-container ships to its Epic feature branch, use `/cleanup-feature {KEY}`.

## Arguments

`$ARGUMENTS`

Required: a Jira ticket key (e.g., `PROJ-123`).

Optional flags (forwarded to `/cleanup`):
- `--no-rebase` — skip downstream cascade-rebase.
- `--no-refresh-feature` — skip feature-branch refresh.
- `--yes` (alias: `--no-confirm`) — skip the interactive confirmation prompt.

## Step 1: Delegate to /cleanup with phase guard

Use the `Skill` tool to run skill `cleanup` with args `{$ARGUMENTS} --require-phase=main`.

The wrapped command does the phase detection and refuses with a clear pointer if the ticket's PR actually merged into an Epic feature branch rather than `main`.
