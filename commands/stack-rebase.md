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

## Step 3: Determine Rebase Scenario

Check the given ticket's entry in `STACK_CHAIN` — use its `mergedIntoMain` field from the resolve-stack output:

- **Scenario A — Branch merged to main**: `mergedIntoMain` is `true`
- **Scenario B — Branch updated (not merged)**: `mergedIntoMain` is `false`

Display: "Scenario: {A or B} — {merged to main / branch updated}"

## Step 4: Identify Tickets to Rebase

From the `STACK_CHAIN`, find all tickets **after** the given ticket. These are the ones that need rebasing.

Store as `REBASE_LIST` (in stack order).

If `REBASE_LIST` is empty, display "No downstream tickets to rebase." and exit.

```
Tickets to rebase:
- {KEY-2}: current base {given_key} -> new base {new_base}
- {KEY-3}: current base {KEY-2} -> (cascading rebase)
```

## Step 5: Execute Rebase Chain

For each ticket in `REBASE_LIST`, in order:

### 5a: Determine Bases

- `OLD_BASE`: The ticket this branch was originally based on
  - For the first ticket in REBASE_LIST: this is the given ticket key
  - For subsequent tickets: this is the previous ticket in REBASE_LIST
- `NEW_BASE`:
  - **Scenario A (merged)** and this is the first in REBASE_LIST: `main`
  - **All other cases**: The previous ticket in REBASE_LIST (or `main` if the previous was also merged)

### 5b: Check for Worktree

Check if a worktree exists for this ticket:

```bash
git worktree list | grep {ticket_key}
```

If a worktree exists, operate inside it. Otherwise, operate on the branch directly.

### 5c: Fetch and Rebase

```bash
git fetch origin
git checkout {ticket_key}
git rebase --onto {NEW_BASE} {OLD_BASE} {ticket_key}
```

### 5d: Handle Conflicts

If the rebase encounters conflicts:

1. Run `git diff --name-only --diff-filter=U` to list conflicting files
2. Abort the rebase: `git rebase --abort`
3. Display:

```
CONFLICT in {ticket_key} during rebase onto {NEW_BASE}

Conflicting files:
- path/to/file1.ts
- path/to/file2.ts

Rebase aborted. Remaining tickets in stack were NOT rebased:
- {KEY-next}
- {KEY-next+1}

Resolve conflicts manually:
  cd ../{ticket_key}
  git rebase --onto {NEW_BASE} {OLD_BASE} {ticket_key}
  # resolve conflicts
  git rebase --continue
Then re-run: /stack-rebase {ticket_key}
```

4. STOP processing — do not continue to subsequent tickets

### 5e: Push

After a successful rebase, push the updated branch:

```bash
git push --force-with-lease origin {ticket_key}
```

If force-push fails (e.g., branch protection), warn the user and continue to the next ticket.

### 5f: Append to Activity Log

```bash
append-activity {ticket_key} --heading "Branch rebased" --body "Rebased onto \`{NEW_BASE}\` as part of stack rebase cascade (triggered by {given_ticket_key})."
```

### 5g: Continue

Proceed to the next ticket in REBASE_LIST.

## Step 6: PR Retargeting (Scenario A Only)

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

## Step 7: Summary

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