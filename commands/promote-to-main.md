---
description: "Promote a single stacked ticket to main: rebase onto main, open PR. Accepts a ticket key, container key, or feature branch name."
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
  - Bash(resolve-stack *)
  - Bash(ensure-pr *)
  - Bash(post-review-summary *)
  - Bash(append-activity *)
  - Read
  - Write
  - Skill
---

# Promote to Main

Promotes a single ticket's branch to main: rebases onto main (isolating just its changes) and opens a PR to main.

To promote the next ticket in a stack, re-run this command after the prior PR merges.

## Arguments

$ARGUMENTS

Required: a Jira ticket key OR a stack container key (Story or Epic). Since feature branches are now named after the container key, passing a "branch name" is equivalent to passing the container key.
- If a ticket key is given: that ticket is promoted.
- If a container key is given: the next ticket to promote is determined by **git history on the feature branch** — the oldest ticket merged into the feature branch that is not yet on main. Jira's topological order is validated against git's merge order; the command errors out on mismatch.

---

## Step 1: Initialize

### 1a: Resolve Argument to a Jira Key

Set `RESOLVED_KEY` = `$ARGUMENTS` (uppercased). The arg must match `^[A-Z][A-Z0-9_]+-\d+$`; if it doesn't, display "Invalid Jira key: `{ARGUMENTS}`. Pass a ticket or container key (e.g. `EPIC-123`)." and **stop**.

### 1b: Resolve Stack with resolve-stack

Run:
```bash
resolve-stack {RESOLVED_KEY} --fetch
```

Parse the JSON output. Extract:
- `CONTAINER_KEY` = `container.key`
- `FEATURE_BRANCH` = `container.featureBranch`
- `UNMERGED_BLOCKERS` = `container.unmergedBlockers`
- `REPO_ROOT` = `container.repoRoot`
- `STACK_ORDER` = `stack` array (already topologically sorted, with branch names resolved)

If `FEATURE_BRANCH` is null: display "{RESOLVED_KEY} has no Story/Epic container; nothing to promote via feature branch. Use the standard PR workflow." and **stop**.

If `UNMERGED_BLOCKERS` is non-empty: display:

```
Refuse to promote — {CONTAINER_KEY} is blocked by unmerged container(s): {UNMERGED_BLOCKERS}.
Promote and merge those containers first, then re-run.
```
and **stop**.

Filter out tickets from `STACK_ORDER` where `branch` is null — display "Warning: no branch found for {KEY}, skipping" for each.

### 1c: Select Target Ticket

If `{RESOLVED_KEY}` matches a ticket key in `STACK_ORDER` (i.e. a leaf, not the container): that ticket is `CURRENT_TICKET`. Skip to Step 1d.

Otherwise, `{RESOLVED_KEY}` is the container key. **Git history on the feature branch is the authority** for which ticket promotes next:

1. Read the merge order from the feature branch:
   ```bash
   cd {REPO_ROOT}
   git log --oneline --first-parent origin/{FEATURE_BRANCH} --grep="^Merge "
   ```
   Parse each line `^\w+ Merge ([A-Z]+-\d+)` to extract a ticket key. The git command lists newest-first; reverse to get chronological merge order. Call this list `GIT_MERGE_ORDER`.

2. Validate against Jira's topological order: take `STACK_ORDER` and keep only entries whose key appears in `GIT_MERGE_ORDER`, preserving their original order. Call this `JIRA_MERGED_ORDER`. Compare it element-by-element to `GIT_MERGE_ORDER`. On mismatch, display:

   ```
   Mismatch between git merge order and Jira dependency order on {FEATURE_BRANCH}:

     Git:  TICKET-1, TICKET-3, TICKET-2
     Jira: TICKET-1, TICKET-2, TICKET-3

   Refusing to promote — fix the Jira blocker links so they reflect actual merge order, then re-run.
   ```
   and **stop**.

3. Determine the next ticket to promote — the oldest entry in `GIT_MERGE_ORDER` whose ticket in `STACK_ORDER` has `mergedIntoMain === false`. Set `CURRENT_TICKET` to the matching entry from `STACK_ORDER`.

4. If no such ticket exists (every merged ticket is already on main): display "All tickets merged into {FEATURE_BRANCH} are already on main." and **stop**.

If `STACK_ORDER` is empty after filtering: display "No promotable tickets found in {CONTAINER_KEY}." and **stop**.

Display:
```
Promote to Main - {CURRENT_TICKET.key} ({CONTAINER_KEY})
Feature branch: {FEATURE_BRANCH}
Branch: {CURRENT_TICKET.branch}
```

### 1d: Check Ticket Status

Determine the current state of `CURRENT_TICKET`:

1. Check if branch is merged into main:
   ```bash
   git fetch origin && git branch -r --merged origin/main | grep "origin/{BRANCH_NAME}"
   ```
   If yes: display "{KEY} is already merged to main." and **stop**.

2. Check if a PR to main exists:
   ```bash
   gh pr list --head {BRANCH_NAME} --base main --json number,state,url
   ```
   - If PR exists and state is "MERGED": display "{KEY} PR is already merged." and **stop**.
   - If PR exists and state is "OPEN": display "PR already open for {KEY}: {PR_URL}" and **stop**.

3. Otherwise, proceed to Step 2.

---

## Step 2: Rebase onto Main

The goal is to isolate just this ticket's changes on top of main, even though the branch currently contains ancestor tickets' changes from the stacking.

### 2a: Determine Rebase Strategy

- `ONTO` = `origin/main`
- `UPSTREAM_BRANCH` = the point where this ticket's branch diverged from its base:
  - If `CURRENT_TICKET` was selected via `GIT_MERGE_ORDER` (container-key path): use the predecessor in `GIT_MERGE_ORDER` — the entry immediately before `CURRENT_TICKET.key`. If `CURRENT_TICKET` is the first entry (no predecessor), no rebase is needed.
  - Otherwise (leaf ticket-key path): if this ticket has a same-stack blocker, `UPSTREAM_BRANCH` = the blocker's branch name (the changes we want to strip). If this is the first ticket in the stack (no blocker), no rebase is needed — it's already based on the feature branch which should be at or near main.

Look up the branch name for `UPSTREAM_BRANCH` from the corresponding entry in `STACK_ORDER`.

### 2b: Fetch and Checkout

```bash
cd {REPO_ROOT} && git fetch origin
git checkout {BRANCH_NAME}
```

### 2c: Rebase

If this ticket has a same-stack blocker (need to strip ancestor changes):

```bash
git rebase --onto origin/main {UPSTREAM_BRANCH} {BRANCH_NAME}
```

If this is the first ticket (no blocker), rebase onto latest main:

```bash
git rebase origin/main
```

### 2d: Handle Conflicts

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
```

4. **STOP** — do not continue.

After resolving manually, re-run `/promote-to-main {KEY}` to resume.

### 2e: Force Push

After successful rebase:

```bash
git push --force-with-lease origin {BRANCH_NAME}
```

---

## Step 3: Open PR to Main

### 3a: Generate PR Description

1. Make sure we are in the repo root: `cd {REPO_ROOT}`
2. Ensure the ticket branch is checked out: `git checkout {BRANCH_NAME}`
3. Use the Skill tool to run skill `jay-pr-description`
4. Append a stack context section to `./pr.md`:
   ```markdown

   ## Stack Context

   Promoted from feature branch `{FEATURE_BRANCH}` to main.
   Part of {CONTAINER_KEY}.
   ```

### 3b: Create or Update PR

Run:
```bash
ensure-pr {BRANCH_NAME} --base main --body-file ./pr.md
```

Parse the JSON output. Store `pr.number` as `PR_NUMBER` and `pr.url` as `PR_URL`.
If `action` is `"exists"`, the PR was already open — skip to 3d.

### 3c: Copilot Review Comments

After creating the PR, run a single pass to address Copilot review comments:

1. Make sure we are in the repo root: `cd {REPO_ROOT}`
2. Use the Skill tool to run skill `pr-watch` with args `--rounds 1 --auto --interval 30`
3. If pr-watch made changes and pushed, note the updated state.

### 3d: Post PR Review Summary Comment

Run:
```bash
post-review-summary {BRANCH_NAME} --plans-dir .claude/plans --ticket-key {KEY}
```

If output shows `posted: false` with reason `no_plan_file`, skip (nothing to post).

### 3e: Update Jira

1. Append to the activity log:
   ```bash
   append-activity {KEY} --heading "PR to main opened" --body "{PR_URL}. Promoting from feature branch \`{FEATURE_BRANCH}\`."
   ```

---

## Step 4: Done

Display:

```
Promote to Main - {KEY}

Branch: {BRANCH_NAME}
PR: {PR_URL}

Next steps:
  1. Review and merge the PR
  2. To promote the next ticket in the stack, re-run /promote-to-main {CONTAINER_KEY} (or pass the feature branch name or next ticket key directly)
```

**Stop.**

---

## Error Handling

- If a branch doesn't exist for a ticket: skip it with a warning
- If rebase has conflicts: STOP immediately and report — never auto-resolve
- If force-push fails: report the error and stop (branch protection, etc.)
- If `gh pr create` fails: report and stop
- If Jira operations fail: warn but continue (non-critical)
- If the resolved key has no Story/Epic container: refuse to run (this command only applies to stacked feature-branch workflows)
- If the container has unmerged blocker containers: refuse to run and instruct the user to promote the blocker(s) first
