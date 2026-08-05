---
description: Rebase a stacked PR chain after a base PR is merged or updated
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Skill
  - Bash(git fetch *)
  - Bash(git ls-remote *)
  - Bash(git branch *)
  - Bash(git checkout *)
  - Bash(git rebase *)
  - Bash(git push --force-with-lease *)
  - Bash(git worktree *)
  - Bash(git diff *)
  - Bash(gh pr edit *)
  - Bash(resolve-stack *)
  - Bash(append-activity *)
  - Bash(cascade-rebase *)
---

# Stack Rebase - Cascade rebase through a stacked PR chain

Given a ticket key, rebase all downstream stacked tickets (connected via "blocks" links within the same stack container — either an Epic or a parent Story for subtasks).

## Step 1: Resolve Stack

Run the **Stack Context Resolution** sub-procedure (`commands/_shared-stack-procedures.md`) with `KEY={given_ticket_key}` and `FETCH=true`. Treat its `STACK_ORDER` binding as `STACK_CHAIN`.

Find the given ticket's index in `STACK_CHAIN` (the resolver's JSON output already contains `ticketIndex`).

### Display the Stack

```
Stack detected ({CONTAINER_TYPE}: {CONTAINER_KEY}):
  1. {KEY-1} (root)
  2. {KEY-2} (based on {KEY-1})
  3. {KEY-3} (based on {KEY-2})

Starting rebase from: {given_ticket_key}
```

## Step 1.5: Ensure Cleanup Prerequisites

Run the **Ensure Cleanup Prerequisites** sub-procedure (`commands/_shared-stack-procedures.md`) with `STACK_CHAIN` as `STACK_ORDER`, plus `REPO_ROOT` and `RESOLVED_KEY={given_ticket_key}`. Cascade-rebasing a chain whose predecessor merges are untagged is the failure shape behind the NEV-863 data loss — the tag is what lets `feature-refresh.js` replay a squash merge whose branch is already gone.

If the sub-procedure refreshes `STACK_CHAIN`, re-derive `ticketIndex` from the refreshed stack before Step 2 reads `mergedIntoMain` — a backfill can flip that flag, which selects the rebase scenario.

> **Re-entrancy**: the sub-procedure inline-runs `/cleanup` with `--no-rebase`, so cleanup's Step 7 cascade does **not** fire and cannot recurse back into this command. That flag is load-bearing here; do not drop it from the sub-procedure's invocation.

## Step 2: Determine Rebase Scenario

Check the given ticket's entry in `STACK_CHAIN` — use its `mergedIntoMain` field from the resolve-stack output:

- **Scenario A — Branch merged to main**: `mergedIntoMain` is `true`
- **Scenario B — Branch updated (not merged)**: `mergedIntoMain` is `false`

Display: "Scenario: {A or B} — {merged to main / branch updated}"

## Step 3: Identify Tickets to Rebase

From the `STACK_CHAIN`, find all tickets **after** the given ticket. These are the ones that need rebasing.

Store as `REBASE_LIST` (in stack order).

If `REBASE_LIST` is empty, display "No downstream tickets to rebase." and exit.

```
Tickets to rebase:
- {KEY-2}: current base {given_key} -> new base {new_base}
- {KEY-3}: current base {KEY-2} -> (cascading rebase)
```

## Step 4: Execute Rebase Chain

The rebase loop is implemented once in `cli/lib/cascade-rebase.js` (and exposed as the `cascade-rebase` CLI). This step shells out to that CLI rather than re-implementing the loop inline. `/cleanup` Step 7 calls into the same library.

### 4a: Determine Inputs

- `ORIGIN_BRANCH` = the given ticket's branch name (the branch the chain was originally based on, the one that just merged or moved).
- `NEW_ROOT`:
  - **Scenario A** (`mergedIntoMain === true`): `main`
  - **Scenario B** (branch updated, not merged): the given ticket's own branch
- `DOWNSTREAMS` = `REBASE_LIST` projected to `{ ticket, branch }` pairs in stack order.

If `DOWNSTREAMS` is empty, display "No downstream tickets to rebase." and exit.

### 4b: Run Cascade Rebase

```bash
cascade-rebase \
  --repo-root {REPO_ROOT} \
  --origin {ORIGIN_BRANCH} \
  --new-root {NEW_ROOT} \
  --downstreams {ticket1}:{branch1},{ticket2}:{branch2},... \
  --activity-note "as part of stack rebase cascade (triggered by {given_ticket_key})" \
  {--retarget-first-pr main only when Scenario A (mergedIntoMain)}
```

`--activity-note` makes the CLI append a "Branch rebased" entry to each rebased / pushed-failed ticket's activity log. `--retarget-first-pr main` retargets the head-of-chain ticket's open PR base from `{given_ticket_key}` to `main` — only pass it in **Scenario A**; in Scenario B the head-of-chain is still stacked on the (rebased) given ticket's branch, so there's no retargeting to do.

Parse stdout as JSON. Store the `results` array as `REBASE_RESULTS`. Each entry has `{ ticket, branch, status, ... }` where `status` is one of `rebased`, `pushed-failed`, `conflict`, `not-attempted`, or `skipped`.

> **Worktree note**: when a downstream ticket has a worktree, run the CLI from inside that worktree's `REPO_ROOT`. The lib uses `git checkout` against the named branch in the given `repoRoot` and fails if a worktree currently has the branch checked out — cd into the worktree first or detach the worktree.

### 4c: Handle Conflict Reporting

If any entry in `REBASE_RESULTS` has `status === "conflict"`, display:

```
CONFLICT in {entry.ticket} during rebase onto {previous step's NEW_BASE}

Conflicting files:
{entry.files joined as a bullet list}

Rebase aborted. Remaining tickets in stack were NOT rebased:
{remaining tickets with status not-attempted}

Resolve conflicts manually:
  cd ../{entry.ticket}
  git rebase --onto {NEW_BASE} {OLD_BASE} {entry.branch}
  # resolve conflicts
  git rebase --continue
Then re-run: /stack-rebase {entry.ticket}
```

The CLI already aborted the in-progress rebase and skipped subsequent tickets. Do not retry — surface the report and stop the cascade.

### 4d: Surface Side-Effect Warnings

The CLI handled per-ticket activity logs and Scenario-A PR retargeting (when `--retarget-first-pr main` was passed). If any result entry carries `pr_retarget_warning` or `activity_log_warning`, surface it in the Step 6 summary so the user can follow up manually. Otherwise nothing else to do — proceed to Step 6.

## Step 6: Summary

```
Stack Rebase Complete

{CONTAINER_TYPE}: {CONTAINER_KEY}
Trigger: {given_ticket_key} ({scenario description})

Rebased {N} branch(es):
- {KEY-2}: rebased onto {new_base}, pushed
- {KEY-3}: rebased onto {KEY-2}, pushed

PR retargeting:
- {KEY-2}: target changed to main (if Scenario A)
- (none needed) (if Scenario B)

Stack order is now:
  main <- {KEY-2} <- {KEY-3}
```

## Error Handling

- If a branch doesn't exist for a ticket in the chain, skip it and warn
- If rebase has conflicts, STOP the entire chain and report (partial rebases create broken states)
- If force-push fails, warn but continue (the local branch is still rebased)
- If Jira comment fails, warn but continue (non-critical)
- Never auto-resolve merge conflicts — always stop and let the user handle it

## Arguments

$ARGUMENTS — The ticket key that was merged or updated (e.g., NEV-401). Rebase starts from the next ticket in the stack after this one.