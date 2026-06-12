---
description: "Prune a ticket from the stack: revert its merge from the feature branch, close its PR, and cancel the Jira ticket. Use when work is being abandoned without being shipped."
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

# Prune

Remove a ticket from the stack: revert its merge from the feature branch, close its PR, and cancel the Jira ticket.

Use when a ticket's work is being abandoned and should be pulled out cleanly — different from `/rework` (which restarts implementation) and `/promote-to-main` (which ships it).

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
- `CONTAINER_KEY` = `container.key`
- `FEATURE_BRANCH` = `container.featureBranch` (may be null)
- `REPO_ROOT` = `container.repoRoot`
- `STACK_ORDER` = `stack` array
- Find this ticket's entry in `stack` and extract:
  - `BRANCH_NAME` = ticket's `branch` (may be null)
  - `BASE_BRANCH` = ticket's `baseBranch`
  - `SUMMARY` = ticket's `summary`

If `REPO_ROOT` is null: display "Cannot resolve repo root for {TICKET_KEY}. Ensure a `repo:` label is set on the ticket or its container." and **stop**.

### 1c: Identify Downstream Dependents

A "downstream" ticket is one whose blocker chain in `STACK_ORDER` includes `{TICKET_KEY}`. Walk `STACK_ORDER` and collect every ticket that lists `{TICKET_KEY}` as a same-stack blocker (directly or transitively).

Store this list as `DOWNSTREAM` (each entry: key, summary, status).

---

## Step 2: Detect Merge Status

If `FEATURE_BRANCH` is set, check whether the ticket has been merged into it. Use the merge commit subject convention from `/ticket-work` S4.8: `Merge {TICKET_KEY}: ...`.

```bash
cd {REPO_ROOT} && git fetch origin
MERGE_SHA=$(git log origin/{FEATURE_BRANCH} --grep="^Merge {TICKET_KEY}:" --format="%H" -n 1)
```

- If `MERGE_SHA` is non-empty: set `MERGE_STATE = "merged"`
- If empty: set `MERGE_STATE = "unmerged"`

If `FEATURE_BRANCH` is null (standard workflow): set `MERGE_STATE = "no-feature-branch"`.

---

## Step 3: Detect PR State

```bash
cd {REPO_ROOT} && gh pr view {BRANCH_NAME} --json url,state,number 2>/dev/null
```

- If output parses as JSON: store `pr.url` as `PR_URL`, `pr.state` as `PR_STATE`, `pr.number` as `PR_NUMBER`.
- If no output (no PR): set `PR_STATE = "none"`.

---

## Step 4: Confirm with User

Display the impact summary:

```
Prune {TICKET_KEY}: {SUMMARY}

Repo:           {REPO_ROOT}
Branch:         {BRANCH_NAME}
Feature branch: {FEATURE_BRANCH or "(none)"}
Merge state:    {MERGE_STATE}{ — merge commit MERGE_SHA if merged}
PR:             {PR_STATE} {PR_URL or ""}

Actions:
  1. {if merged: "Revert merge commit MERGE_SHA on " + FEATURE_BRANCH + " and force-push" else: "Skip — nothing merged to revert"}
  2. {if PR_STATE == "OPEN": "Close PR " + PR_URL + " with comment" else: "Skip — PR already closed/missing"}
  3. Transition {TICKET_KEY} in Jira to "Won't Do" / "Cancelled"
  4. Add ClaudePruned label, remove progress labels, append activity log
```

If `DOWNSTREAM` is non-empty, append a warning block:

```
⚠ Downstream tickets depend on {TICKET_KEY}:

  - {DOWNSTREAM_KEY_1}: {SUMMARY_1} ({STATUS_1})
  - {DOWNSTREAM_KEY_2}: {SUMMARY_2} ({STATUS_2})

These tickets were stacked on top of {TICKET_KEY}. Pruning may break their builds
or leave their merges referencing reverted work. Consider /rework or /prune on
these first.
```

Then prompt:

```
Type "confirm" to proceed, or anything else to abort.
```

If the user does not type an affirmative ("confirm", "yes", "do it", "go ahead"):
- Display: "Prune aborted."
- **Stop.**

---

## Step 5: Close the PR

Skip if `PR_STATE` is not `"OPEN"`.

```bash
cd {REPO_ROOT} && gh pr close {BRANCH_NAME} --comment "Pruned from stack — work abandoned. Ticket transitioning to Won't Do."
```

Display: "Closed PR {PR_URL}"

---

## Step 6: Revert Merge on Feature Branch

Skip if `MERGE_STATE` is not `"merged"`.

### 6a: Checkout Feature Branch

```bash
cd {REPO_ROOT} && git checkout {FEATURE_BRANCH} && git pull origin {FEATURE_BRANCH}
```

### 6b: Verify Merge SHA Still Reachable

```bash
git merge-base --is-ancestor {MERGE_SHA} HEAD
```

If the command exits non-zero: the merge is no longer on the feature branch (history rewritten elsewhere). Display: "Merge commit {MERGE_SHA} is not reachable from {FEATURE_BRANCH}. Skipping revert." and proceed to Step 7.

### 6c: Revert the Merge

```bash
git revert -m 1 --no-edit {MERGE_SHA}
```

If the revert produces conflicts:
1. List conflicts: `git diff --name-only --diff-filter=U`
2. Abort: `git revert --abort`
3. Display:
   ```
   CONFLICT reverting {MERGE_SHA} on {FEATURE_BRANCH}.

   Conflicting files:
   - {file1}
   - {file2}

   Revert aborted. Resolve manually:
     cd {REPO_ROOT}
     git checkout {FEATURE_BRANCH}
     git revert -m 1 {MERGE_SHA}
     # resolve conflicts
     git revert --continue
     git push origin {FEATURE_BRANCH}

   Then re-run: /prune {TICKET_KEY}
   ```
4. **Stop.**

### 6d: Update Revert Commit Message

The default revert message is `Revert "Merge {TICKET_KEY}: ..."`. Amend to add a pruned-from marker so future tools can recognize it:

```bash
git commit --amend -m "Revert \"Merge {TICKET_KEY}: {SUMMARY}\"

Pruned from stack — see Jira {TICKET_KEY} for context.

This reverts merge commit {MERGE_SHA}."
```

### 6e: Push

```bash
git push origin {FEATURE_BRANCH}
```

If push fails (branch protection, etc.), report the error and **stop** — Jira state has not been changed yet.

Display: "Reverted merge {MERGE_SHA} on {FEATURE_BRANCH}."

---

## Step 7: Cancel Jira Ticket

### 7a: Find Cancel Transition

Use `mcp__atlassian__getTransitionsForJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`.

From the `transitions` array, find the first transition whose `name` matches (case-insensitive) one of: `Won't Do`, `Wont Do`, `Cancelled`, `Canceled`, `Won't Fix`. Store its `id` as `TRANSITION_ID`.

If no matching transition is found:
- Display: "No cancel-style transition available for {TICKET_KEY}. Available transitions: {names}. Add the ClaudePruned label only and skip status change."
- Set `TRANSITION_ID = null` and continue to 7b.

### 7b: Update Labels

Use `mcp__atlassian__editJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`:

```json
{
  "update": {
    "labels": [
      {"remove": "ClaudeReady"},
      {"remove": "ClaudePlanning"},
      {"remove": "ClaudeExecuting"},
      {"remove": "ClaudeStackReady"},
      {"remove": "ClaudePRApproved"},
      {"remove": "ClaudeNeedsReview"},
      {"remove": "ClaudeFailed"},
      {"add": "ClaudePruned"}
    ]
  }
}
```

Note: `ClaudeWork` is durable and never removed.

### 7c: Transition Status

Skip if `TRANSITION_ID` is null.

Use `mcp__atlassian__transitionJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`, `transition: {"id": TRANSITION_ID}`.

### 7d: Append Activity Log

Build a body summarizing what happened:

```
Pruned from stack.

- Branch: `{BRANCH_NAME}`
- PR: {PR_URL or "(none)"} — {closed | already closed | n/a}
- Feature branch: `{FEATURE_BRANCH or "(none)"}` — {merge {MERGE_SHA} reverted | nothing to revert}
- Status: transitioned to {transition name} {or "(no transition applied)"}
{if DOWNSTREAM non-empty: "- Downstream impact: " + comma-separated keys}
```

Write to a temp file and run:

```bash
append-activity {TICKET_KEY} --heading "Pruned" --body-file <tmp-prune-summary.md>
```

---

## Step 8: Summary

Display:

```
Prune {TICKET_KEY} — Complete

Branch:         {BRANCH_NAME}
Feature branch: {FEATURE_BRANCH or "(none)"}
PR:             {PR_URL or "(none)"} — {closed | already closed | n/a}
Merge revert:   {MERGE_SHA reverted on FEATURE_BRANCH | skipped — nothing to revert}
Jira:           {transition name or "labels updated only"}

{if DOWNSTREAM non-empty:
"⚠ Downstream tickets may now be broken — review:
  - {KEY}: {SUMMARY}
"}
```

---

## Error Handling

- If repo root cannot be resolved: refuse to run — there's nothing to prune locally.
- If revert conflicts: stop immediately and report. Never auto-resolve.
- If `gh pr close` fails: report and continue (PR state is not load-bearing).
- If push to feature branch fails: stop before touching Jira so state stays consistent.
- If Jira transition lookup returns no cancel-style option: fall back to labels-only and warn.
- If the ticket has no merge on the feature branch and no PR and no progress labels: there's nothing to prune — display a notice and stop.
