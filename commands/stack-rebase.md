---
description: Rebase a stacked PR chain after a base PR is merged or updated
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git fetch *)
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

Run:
```bash
resolve-stack {given_ticket_key} --fetch
```

Parse the JSON output. Extract:
- `CONTAINER_KEY` = `container.key`
- `CONTAINER_TYPE` = `container.type`
- `STACK_CHAIN` = `stack` array (topologically sorted with branch names)
- `REPO_ROOT` = `container.repoRoot`

Find the given ticket's index in `STACK_CHAIN` (from `ticketIndex`).

### Display the Stack

```
Stack detected ({CONTAINER_TYPE}: {CONTAINER_KEY}):
  1. {KEY-1} (root)
  2. {KEY-2} (based on {KEY-1})
  3. {KEY-3} (based on {KEY-2})

Starting rebase from: {given_ticket_key}
```

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
  --downstreams {ticket1}:{branch1},{ticket2}:{branch2},...
```

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

### 4d: Activity Log Per Ticket

For each entry whose `status` is `rebased` or `pushed-failed`:

```bash
append-activity {entry.ticket} --heading "Branch rebased" --body "Rebased onto \`{entry.new_base}\` as part of stack rebase cascade (triggered by {given_ticket_key})."
```

If `status` is `pushed-failed`, also note "(local rebase succeeded but force-push failed: {entry.error})".

## Step 5: PR Retargeting (Scenario A Only)

If Scenario A (base branch merged to main), the first downstream PR needs its target branch changed:

```
PR Retargeting Required:

The following PR needs its target branch updated:
- {FIRST_REBASE_KEY}: change target from {given_ticket_key} -> main

Run:
  gh pr edit {FIRST_REBASE_KEY} --base main

Or update manually in GitHub.
```

If `gh` CLI is available, offer to run it. Otherwise, display the manual instructions.

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