---
description: "Promote stacked tickets to main one at a time: rebase onto main, open PR, wait for merge, advance to next."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - mcp__atlassian__searchJiraIssuesUsingJql
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(gh *)
  - Read
  - Write
  - Skill
---

# Promote to Main

Walks a stack in dependency order and promotes each ticket's branch to main one at a time.

Each ticket is: rebased onto main (isolating just its changes), PR opened to main, then waits for merge before advancing to the next ticket.

## Arguments

$ARGUMENTS

Required: a stack container key (Story or Epic), OR any ticket key within the stack. If a ticket key is given, the stack container is inferred.

Optional flags:
- `--continue`: skip discovery and advance to the next un-promoted ticket (use after a PR was merged)
- `--all`: don't stop after opening one PR — keep going until all are promoted or one blocks

---

## Step 1: Initialize

### 1a: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1b: Resolve Stack Container

Use `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={ARGUMENT_KEY}`.

- If it's a Story/Task with subtasks or an Epic: it IS the container. `CONTAINER_KEY` = `{ARGUMENT_KEY}`.
- If it's a subtask: `CONTAINER_KEY` = parent Story key.
- If it's a regular issue with an Epic link: `CONTAINER_KEY` = Epic key.

### 1c: Detect Feature Branch

Fetch the container issue labels. Look for `branch:*` label.
- If found: `FEATURE_BRANCH` = label value (strip `branch:` prefix)
- If not found: display "No feature branch label found on {CONTAINER_KEY}. Nothing to promote." and **stop**.

### 1d: Load Dev Root

Read `~/.claude/dev-root.json` → `DEV_ROOT`. Resolve `REPO_ROOT` from the container's `repo:` label (or the first ticket's `repo:` label).

---

## Step 2: Build Stack Order

### 2a: Find All Tickets in Stack

- If container is a Story/Task: search `parent = {CONTAINER_KEY}`
- If container is an Epic: search `"Epic Link" = {CONTAINER_KEY} OR parent = {CONTAINER_KEY}`

Store all ticket keys.

### 2b: Walk Dependencies to Build Order

For each ticket, fetch issue links and find "is blocked by" / "blocks" relationships within the stack (same container).

Build a topologically sorted list based on "is blocked by" links:
- Tickets with no same-stack blockers come first
- Each subsequent ticket is ordered after all its blockers

Store as `STACK_ORDER` — a list of `{KEY, SUMMARY, BRANCH_NAME}`.

### 2c: Resolve Branch Names

For each ticket in `STACK_ORDER`:
1. Check for existing branch: `git branch --list '{KEY}*'` (in `REPO_ROOT`)
2. If found, store as `BRANCH_NAME`
3. If not found: display "Warning: no branch found for {KEY}, skipping" and remove from list

### 2d: Display Stack

```
Promote to Main - Stack Order ({CONTAINER_KEY})
Feature branch: {FEATURE_BRANCH}

  1. {KEY-1}: {SUMMARY-1} (branch: {BRANCH-1}) — {status}
  2. {KEY-2}: {SUMMARY-2} (branch: {BRANCH-2}) — {status}
  3. {KEY-3}: {SUMMARY-3} (branch: {BRANCH-3}) — {status}
```

Where `{status}` is one of:
- `merged` — branch is already merged into main
- `pr-open` — PR to main exists and is open
- `pending` — not yet promoted

---

## Step 3: Find Next Ticket to Promote

For each ticket in `STACK_ORDER`, determine its status:

1. Check if branch is merged into main:
   ```bash
   git fetch origin && git branch -r --merged origin/main | grep "origin/{BRANCH_NAME}"
   ```
   If yes: status = `merged`

2. Check if a PR to main exists:
   ```bash
   gh pr list --head {BRANCH_NAME} --base main --json number,state,url
   ```
   - If PR exists and state is "MERGED": status = `merged`
   - If PR exists and state is "OPEN": status = `pr-open`

3. Otherwise: status = `pending`

Find the first ticket with status `pending`. If none found:
- If all are `merged`: display "All tickets in stack are merged to main." and **stop**.
- If one is `pr-open`: display "Waiting for PR to merge: {KEY} — {PR_URL}" and **stop** (unless `--all` flag).

Store the first `pending` ticket as `CURRENT_TICKET`.

---

## Step 4: Rebase onto Main

The goal is to isolate just this ticket's changes on top of main, even though the branch currently contains ancestor tickets' changes from the stacking.

### 4a: Determine Rebase Strategy

- `ONTO` = `origin/main`
- `UPSTREAM` = the point where this ticket's branch diverged from its base:
  - If this ticket has a same-stack blocker: `UPSTREAM` = the blocker's branch name (the changes we want to strip)
  - If this is the first ticket in the stack (no blocker): no rebase needed — it's already based on main (or feature branch which should be at or near main)

### 4b: Fetch and Checkout

```bash
cd {REPO_ROOT} && git fetch origin
git checkout {BRANCH_NAME}
```

### 4c: Rebase

If this ticket has a same-stack blocker (need to strip ancestor changes):

```bash
git rebase --onto origin/main {UPSTREAM_BRANCH} {BRANCH_NAME}
```

If this is the first ticket (no blocker), rebase onto latest main:

```bash
git rebase origin/main
```

### 4d: Handle Conflicts

If the rebase encounters conflicts:

1. Run `git diff --name-only --diff-filter=U` to list conflicting files
2. Abort the rebase: `git rebase --abort`
3. Display:

```
CONFLICT rebasing {BRANCH_NAME} onto main

Conflicting files:
- path/to/file1.ts
- path/to/file2.ts

Rebase aborted. Resolve manually:
  cd {REPO_ROOT}
  git checkout {BRANCH_NAME}
  git rebase --onto origin/main {UPSTREAM_BRANCH} {BRANCH_NAME}
  # resolve conflicts
  git rebase --continue
  
Then re-run: /promote-to-main {CONTAINER_KEY} --continue
```

4. **STOP** — do not continue.

### 4e: Force Push

After successful rebase:

```bash
git push --force-with-lease origin {BRANCH_NAME}
```

---

## Step 5: Open PR to Main

### 5a: Check for Existing PR

```bash
gh pr list --head {BRANCH_NAME} --base main --json number,url
```

If a PR already exists, skip to 5e.

### 5b: Generate PR Description with /jay-pr-description

1. Make sure we are in the repo root: `cd {REPO_ROOT}`
2. Ensure the ticket branch is checked out: `git checkout {BRANCH_NAME}`
3. Use the Skill tool to run skill `jay-pr-description`
4. Read the generated PR description file (`./pr.md`)

### 5c: Create PR

Using the title and body from `pr.md`:

```bash
gh pr create --base main --title "{PR_TITLE}" --body "{PR_BODY}"
```

Use a HEREDOC for the body. Append a stack context section to the body:

```markdown
{PR_BODY_FROM_pr.md}

## Stack Context

Promoted from feature branch `{FEATURE_BRANCH}` to main.
Part of {CONTAINER_KEY} — ticket {N} of {TOTAL} being promoted.
```

### 5d: Copilot Review Comments

After creating the PR, run a single pass to address Copilot review comments:

1. Make sure we are in the repo root: `cd {REPO_ROOT}`
2. Use the Skill tool to run skill `pr-watch` with args `--rounds 1 --auto --interval 30`
3. If pr-watch made changes and pushed, note the updated state.

### 5e: Store PR Info

```bash
gh pr view {BRANCH_NAME} --json number,url
```

Store `PR_NUMBER` and `PR_URL`.

### 5f: Post PR Review Summary Comment

1. If a PR review plan file exists in `.claude/plans/` (matching `pr-review-*.md` or `pr-{KEY}*.md`), read it.
2. Build a summary comment:
   ```
   ## Claude Code Review Summary

   ### Issues Found
   - **{issue title}**: {brief description} — **{resolved|open}**
   ...

   ### Resolutions
   - {issue}: {what was changed to fix it}
   ...

   N issues found, M resolved.
   ```
3. Post the comment to the PR:
   ```bash
   gh pr comment {BRANCH_NAME} --body "{REVIEW_SUMMARY}"
   ```
   Use a HEREDOC for the body.
4. If no review plan file exists, skip this step.

### 5g: Update Jira

1. Add comment: "PR to main opened: {PR_URL}. Promoting from feature branch `{FEATURE_BRANCH}`."
   - Use `mcp__atlassian__addCommentToJiraIssue`

---

## Step 6: Wait or Continue

### If `--all` flag is set:

Check if the PR was just created (not yet merged). Display:

```
PR opened for {KEY}: {PR_URL}

Waiting for merge before promoting next ticket.
To continue after merge: /promote-to-main {CONTAINER_KEY} --continue --all
```

**Stop.**

### If `--all` flag is NOT set (default):

Display:

```
Promote to Main - {KEY}

Branch: {BRANCH_NAME}
PR: {PR_URL}
Stack position: {N} of {TOTAL}

Next steps:
  1. Review and merge the PR
  2. Run: /promote-to-main {CONTAINER_KEY} --continue
```

**Stop.**

---

## Step 7: Post-Merge Cleanup (on `--continue`)

When re-run with `--continue`, before finding the next pending ticket (Step 3), check the most recently promoted ticket:

1. Find the last ticket in `STACK_ORDER` with status `pr-open`
2. Check if its PR has been merged:
   ```bash
   gh pr view {BRANCH_NAME} --json state -q .state
   ```
3. If merged:
   - Update Jira: transition ticket to Done if not already (or post comment: "Merged to main.")
   - Display: "{KEY} merged to main ✓"
   - Continue to Step 3 to find next pending ticket
4. If NOT merged:
   - Display: "PR for {KEY} is still open: {PR_URL}. Merge it first, then re-run with --continue."
   - **Stop.**

---

## Summary (on completion)

When all tickets are merged (Step 3 finds none pending):

```
Promote to Main - Complete

Stack: {CONTAINER_KEY}
Feature branch: {FEATURE_BRANCH}

All {N} tickets promoted to main:
  1. {KEY-1}: merged ✓
  2. {KEY-2}: merged ✓
  3. {KEY-3}: merged ✓

The feature branch `{FEATURE_BRANCH}` can now be deleted:
  git push origin --delete {FEATURE_BRANCH}
  git branch -d {FEATURE_BRANCH}
```

---

## Error Handling

- If a branch doesn't exist for a ticket: skip it with a warning
- If rebase has conflicts: STOP immediately and report — never auto-resolve
- If force-push fails: report the error and stop (branch protection, etc.)
- If `gh pr create` fails: report and stop
- If Jira operations fail: warn but continue (non-critical)
- If the feature branch label is missing: refuse to run (this command only applies to feature branch workflows)
