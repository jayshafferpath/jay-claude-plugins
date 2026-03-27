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
---

# Stack Rebase - Cascade rebase through a stacked PR chain

Given a ticket key, rebase all downstream stacked tickets (connected via "blocks" links within the same stack container — either an Epic or a parent Story for subtasks).

## Step 1: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Extract `id` from first resource — store as `CLOUD_ID`

## Step 2: Build the Stack Chain

Starting from the given ticket key, walk the full stack in both directions:

### 2a: Walk Upstream

1. Use `mcp__atlassian__getJiraIssue` to get the ticket with issue links
2. Determine the **stack container**:
   - If the ticket is a **subtask** (has a `parent` field that is a Story/Task, not an Epic): the stack container is the parent Story key (`CONTAINER_KEY`). Stack siblings are other subtasks of that parent.
   - Otherwise: the stack container is the ticket's Epic key (`CONTAINER_KEY`). Stack siblings are other tickets linked to the same Epic.
3. Follow "is blocked by" links where the blocker shares the same stack container
4. Repeat until you find a ticket with no same-stack blocker — this is the **stack root**

### 2b: Walk Downstream from Root

1. Starting from the stack root, follow outward "blocks" links where the blocked ticket shares the same stack container
2. Build an ordered list: `[root, next, next, ...]`
3. Store as `STACK_CHAIN`

### 2c: Display the Stack

```
Stack detected ({CONTAINER_TYPE}: {CONTAINER_KEY}):
  1. {KEY-1} (root)
  2. {KEY-2} (based on {KEY-1})
  3. {KEY-3} (based on {KEY-2})

Starting rebase from: {given_ticket_key}
```

## Step 3: Determine Rebase Scenario

Check whether the given ticket's branch has been merged into main:

```bash
git fetch origin
git branch -r --merged origin/main | grep origin/{given_ticket_key}
```

- **Scenario A — Branch merged to main**: The branch appears in merged list
- **Scenario B — Branch updated (not merged)**: The branch exists but is not merged

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

### 5f: Comment on Jira

Use `mcp__atlassian__addCommentToJiraIssue`:
- `cloudId`: CLOUD_ID
- `issueIdOrKey`: {ticket_key}
- `contentFormat`: `"markdown"`
- `commentBody`: "Branch rebased onto `{NEW_BASE}` as part of stack rebase cascade (triggered by {given_ticket_key})."

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