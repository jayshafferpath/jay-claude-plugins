---
description: "Clean up a ticket post-merge: verify it landed on main, delete its branch, transition Jira to Done, append container progress note. Use after a ticket's PR is merged."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__getTransitionsForJiraIssue
  - mcp__atlassian__transitionJiraIssue
  - mcp__atlassian__searchJiraIssuesUsingJql
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(gh *)
  - Bash(resolve-stack *)
  - Bash(append-activity *)
  - Read
  - Write
---

# Cleanup

Post-merge teardown for a single ticket: verify its PR landed on `main`, delete the local + remote branch, remove progress labels, transition Jira to Done, and (if this was the last unmerged ticket in its container) append a "stack complete" note to the container's activity log.

This is the success-path counterpart to `/prune`. Run it after `/promote-to-main` → review → squash-merge.

## Arguments

$ARGUMENTS

Required: a Jira ticket key (e.g., `PROJ-123`). The ticket must have a `repo:` label (or be a subtask of a parent that does) so the repo root can be resolved.

---

## Step 1: Initialize

### 1a: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1b: Resolve Stack Context

Run:
```bash
resolve-stack {TICKET_KEY} --fetch
```

Parse the JSON output. Extract:
- `CONTAINER_KEY` = `container.key` (may be null for standalone tickets)
- `FEATURE_BRANCH` = `container.featureBranch` (may be null)
- `REPO_ROOT` = `container.repoRoot`
- `STACK_ORDER` = `stack` array
- Find this ticket's entry in `STACK_ORDER` and extract:
  - `BRANCH_NAME` = ticket's `branch`
  - `SUMMARY` = ticket's `summary`

If `REPO_ROOT` is null: display "Cannot resolve repo root for {TICKET_KEY}. Ensure a `repo:` label is set on the ticket or its container." and **stop**.

If `BRANCH_NAME` is null: display "No branch on record for {TICKET_KEY}. If this ticket was completed via a different workflow, transition it manually." and **stop**.

---

## Step 2: Verify Merge to Main

This step is **strict** — refuse to clean up unless we can prove the ticket actually shipped.

### 2a: Fetch

```bash
cd {REPO_ROOT} && git fetch origin
```

### 2b: PR State

```bash
cd {REPO_ROOT} && gh pr list --head {BRANCH_NAME} --base main --state all --json number,state,url,mergeCommit --limit 5
```

Find the most recent PR whose `state` is `"MERGED"`. If none exists, display:

```
Refuse to clean up — no merged PR to main found for {BRANCH_NAME}.

Open PRs and unmerged history are handled by /prune (abandon) or by waiting
for the PR to merge. /cleanup only runs after a successful merge to main.
```
and **stop**.

Store `PR_NUMBER`, `PR_URL`, and `MERGE_SHA` = `mergeCommit.oid` from the matched PR.

If `MERGE_SHA` is empty/null (rare — happens for some merge strategies on very old PRs): display "Merged PR {PR_URL} has no merge commit SHA on record. Cannot verify against main; stopping." and **stop**.

### 2c: Verify SHA Reachable from Main

```bash
cd {REPO_ROOT} && git merge-base --is-ancestor {MERGE_SHA} origin/main
```

If exit code is non-zero: display:

```
Refuse to clean up — merge commit {MERGE_SHA} (PR {PR_URL}) is not reachable
from origin/main. Either main has been rewritten or the merge has not yet
landed locally. Investigate before continuing.
```
and **stop**.

---

## Step 3: Confirm with User

Display the impact summary:

```
Cleanup {TICKET_KEY}: {SUMMARY}

Repo:           {REPO_ROOT}
Branch:         {BRANCH_NAME}
PR:             {PR_URL} (merged, {MERGE_SHA})
Container:      {CONTAINER_KEY or "(standalone)"}
Feature branch: {FEATURE_BRANCH or "(none)"}

Actions:
  1. Delete local branch {BRANCH_NAME} (if present)
  2. Delete remote branch origin/{BRANCH_NAME} (if present)
  3. Transition {TICKET_KEY} in Jira to Done
  4. Remove progress labels (ClaudeReady, ClaudePlanning, ClaudeExecuting, ClaudeStackReady, ClaudePRApproved, ClaudeNeedsReview, ClaudeFailed)
  5. Append "Shipped" entry to {TICKET_KEY} activity log
{if this is the last unmerged ticket in CONTAINER_KEY:
  "  6. Append \"Stack complete\" entry to " + CONTAINER_KEY + " activity log"}
```

Then prompt:

```
Type "confirm" to proceed, or anything else to abort.
```

If the user does not type an affirmative ("confirm", "yes", "do it", "go ahead"):
- Display: "Cleanup aborted."
- **Stop.**

---

## Step 4: Delete Branch

### 4a: Detect Current Branch

```bash
cd {REPO_ROOT} && git branch --show-current
```

If the current branch is `{BRANCH_NAME}`, switch off it first so the delete can proceed:

```bash
git checkout main && git pull origin main --ff-only
```

If the checkout fails (uncommitted changes, etc.): display the error and **stop** before touching anything else.

### 4b: Delete Local Branch

```bash
cd {REPO_ROOT} && git branch -D {BRANCH_NAME} 2>/dev/null
```

`-D` is intentional — the branch was merged via squash, so `-d` would refuse. If the branch doesn't exist locally, the command exits non-zero; that's fine — continue.

### 4c: Delete Remote Branch

```bash
cd {REPO_ROOT} && git push origin --delete {BRANCH_NAME} 2>&1
```

If the remote branch is already gone (`remote ref does not exist`), continue silently. For any other error, report it but **continue** — remote branch state is not load-bearing for the rest of cleanup.

Display: "Deleted branch {BRANCH_NAME} (local + remote)."

---

## Step 5: Update Jira

### 5a: Find Done Transition

Use `mcp__atlassian__getTransitionsForJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`.

From the `transitions` array, find the first transition whose `name` matches (case-insensitive) one of: `Done`, `Closed`, `Resolved`, `Complete`, `Completed`. Store its `id` as `TRANSITION_ID`.

If no matching transition is found:
- Display: "No done-style transition available for {TICKET_KEY}. Available transitions: {names}. Updating labels only."
- Set `TRANSITION_ID = null` and continue to 5b.

### 5b: Update Labels

Use `mcp__atlassian__editJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`:

```json
{
  "update": {
    "labels": [
      {"remove": "ClaudeReady"},
      {"remove": "ClaudePlanning"},
      {"remove": "ClaudePlanNeedsApproval"},
      {"remove": "ClaudePlanApproved"},
      {"remove": "ClaudeExecuting"},
      {"remove": "ClaudeStackReady"},
      {"remove": "ClaudePRApproved"},
      {"remove": "ClaudeNeedsReview"},
      {"remove": "ClaudeFailed"}
    ]
  }
}
```

Note: `ClaudeWork` is durable and never removed. No new terminal label is added — Jira status (Done) is the source of truth.

### 5c: Transition Status

Skip if `TRANSITION_ID` is null.

Use `mcp__atlassian__transitionJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`, `transition: {"id": TRANSITION_ID}`.

### 5d: Append Ticket Activity Log

Build a short body:

```
Shipped to main.

- PR: {PR_URL}
- Merge commit: `{MERGE_SHA}`
- Branch deleted: `{BRANCH_NAME}` (local + remote)
- Status: transitioned to {transition name} {or "(no transition applied — labels only)"}
```

Write to a temp file and run:

```bash
append-activity {TICKET_KEY} --heading "Shipped" --body-file <tmp-cleanup-summary.md>
```

---

## Step 6: Container Progress Note

Skip this step if `CONTAINER_KEY` is null (standalone ticket).

### 6a: Detect "Last Unmerged Ticket"

From `STACK_ORDER`, count entries where `mergedIntoMain === false` AND `key !== {TICKET_KEY}`. (The current ticket's `mergedIntoMain` was false at the time `resolve-stack` was called — we just shipped it.)

If the count is `> 0`: skip Step 6 entirely (other tickets in the stack are still in flight).

If the count is `0`: this was the last ticket. Continue to 6b.

### 6b: Append Container Activity Log

Body:

```
Stack complete — all tickets shipped to main.

- Final ticket: {TICKET_KEY} ({PR_URL})
- Feature branch: `{FEATURE_BRANCH or "(none)"}`
- Tickets in stack: {comma-separated keys from STACK_ORDER}
```

Run:

```bash
append-activity {CONTAINER_KEY} --heading "Stack complete" --body-file <tmp-stack-complete.md>
```

The container itself is not auto-transitioned — leave that to the user or a separate convention.

---

## Step 7: Summary

Display:

```
Cleanup {TICKET_KEY} — Complete

Branch:         {BRANCH_NAME} — deleted (local + remote)
PR:             {PR_URL} (merged at {MERGE_SHA})
Jira:           {transition name or "labels updated only"}
{if container note appended:
"Container:      " + CONTAINER_KEY + " — stack complete note appended"}
```

---

## Error Handling

- If repo root cannot be resolved: refuse to run.
- If no merged PR to main is found: refuse to run — direct the user to `/prune` (abandon) or wait for merge.
- If the merge SHA is not reachable from `origin/main`: refuse — main may have been rewritten, or the merge isn't local yet.
- If the working tree is dirty when we need to switch off the branch: stop before touching anything.
- If `git branch -D` fails because the branch is absent locally: continue.
- If `git push origin --delete` fails for any reason other than "ref does not exist": warn but continue.
- If the Jira Done transition is unavailable: fall back to labels-only and warn.
- If `append-activity` fails: warn but do not roll back — branch deletion and Jira state are already applied.
