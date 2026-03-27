---
description: "Phase 1: Find ClaudeWork tickets In Progress, gate on stack dependencies, create worktrees, run /jira-start"
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git rev-parse *)
  - Bash(git fetch *)
  - Bash(git worktree *)
  - Bash(cd *)
  - Read
  - Skill
  - Agent
---

# Queue Phase 1 - Plan

Find tickets labeled `ClaudeWork` with status "In Progress", gate on stack dependencies, create worktrees, and run `/jira-start` for each eligible ticket.

## Step 1: Initialize

### 1a: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1b: Load Repo Map

Read `~/.claude/repo-map.json`. This maps short names to repo paths:
```json
{
  "employer-backend": "/Users/jayshaffer/dev/employer-backend-root/employer-backend",
  "orchestrator": "/Users/jayshaffer/dev/claude-orchestrator"
}
```
Store as `REPO_MAP`.

## Step 2: Find Plannable Tickets

**If ticket keys were provided in $ARGUMENTS:** Use `mcp__atlassian__getJiraIssue` to fetch each specified ticket directly. Skip the JQL search entirely.

**Otherwise:** Use `mcp__atlassian__searchJiraIssuesUsingJql`:

```
labels = "ClaudeWork" AND labels NOT IN ("ClaudePlanNeedsApproval", "ClaudePlanApproved", "ClaudeExecuting", "ClaudeNeedsReview", "ClaudeFailed") AND assignee = currentUser() AND status = "In Progress"
```

If none found, display "Phase 1: No tickets ready for planning." and stop.

### 2b: Resolve Repo per Ticket

For each ticket, find the label starting with `repo:` (e.g., `repo:employer-backend`). Strip the `repo:` prefix and look up the result in `REPO_MAP` to get `REPO_ROOT` for that ticket.

- If a ticket has no `repo:` label: **skip it** and display "Skipping {KEY}: no repo: label found"
- If the `repo:` value is not in `REPO_MAP`: **skip it** and display "Skipping {KEY}: repo '{value}' not found in repo-map.json"

### 2c: Resolve Plans Directory per Ticket

For each ticket, `$PLANS_DIR` is always the worktree's `.claude/plans/`:
- `{REPO_ROOT}/../{KEY}/.claude/plans/`

## Step 3: Gate on Stack Dependencies

For each ticket:

1. Use `mcp__atlassian__getJiraIssue` to get issue links
2. Get the ticket's Epic/parent key
3. Find inward "is blocked by" links
4. For each blocker sharing the same Epic:
   - A blocker is considered "finished" if its Jira status category is "done" (statusCategory.key == "done")
   - If ANY same-Epic blocker is NOT finished: **skip this ticket**
   - Display: "Skipping {KEY}: waiting on {BLOCKER_KEY} to finish"
5. Determine base branch:
   - Same-Epic blocker exists that is finished: base = blocker's ticket key
   - No same-Epic blocker: base = `main`

## Step 4: Prepare Worktrees (Sequential)

Fetch once per repo, then create all worktrees sequentially (shared git state requires this):

1. For each unique `REPO_ROOT`, fetch latest:
   ```bash
   cd {REPO_ROOT} && git fetch origin
   ```

2. For each eligible ticket (using that ticket's `REPO_ROOT`):
   a. Display: "Preparing worktree for {KEY}: {SUMMARY} (base: {BASE_BRANCH})"

   b. Add `ClaudePlanning` label:
      - `update`: `{"labels": [{"add": "ClaudePlanning"}]}`

   c. Create worktree (from within `{REPO_ROOT}`):
      - If base is `main`:
        ```bash
        cd {REPO_ROOT} && git worktree add -b {KEY} {REPO_ROOT}/../{KEY}
        ```
      - If base is another ticket:
        ```bash
        cd {REPO_ROOT} && git worktree add -b {KEY} {REPO_ROOT}/../{KEY} origin/{BASE_BRANCH}
        ```
      - If branch/worktree already exists, verify and skip creation

## Step 5: Launch Planning Agents (Parallel)

All eligible tickets now have isolated worktrees. Launch ALL as **parallel Agent tool calls in a single message**.

For each eligible ticket, launch an Agent with:
- `description`: "Plan {KEY}"
- `prompt`: Use the template below, substituting all variables

**Agent Prompt Template:**

```
Plan Jira ticket {KEY} - {SUMMARY}.

SETUP:
- Repo root: {REPO_ROOT}
- Worktree: {REPO_ROOT}/../{KEY}
- Run: cd {REPO_ROOT}/../{KEY}
- Plans directory: {PLANS_DIR}
- Base branch: {BASE_BRANCH}
- Cloud ID: {CLOUD_ID}

STEPS:

1. Run /jira-start:
   Use the Skill tool to run skill "jira-start" with args "{KEY} --base {BASE_BRANCH}"
   IMPORTANT: Do NOT promote labels during this step. Label promotion happens in step 3.

2. Verify plan file exists:
   Read the plan file at {PLANS_DIR}/jira-{KEY}.md. If the file does not exist or is empty,
   treat this as a CRITICAL FAILURE (see below).

3. Promote label (only after plan file is verified on disk):
   Use mcp__atlassian__editJiraIssue with cloudId={CLOUD_ID}, issueIdOrKey={KEY},
   update: {"labels": [{"remove": "ClaudePlanning"}, {"add": "ClaudePlanNeedsApproval"}]}

4. Post plan summary comment to Jira:
   Use the plan file content from step 2. Use mcp__atlassian__addCommentToJiraIssue
   with cloudId={CLOUD_ID}, issueIdOrKey={KEY}, and a comment body containing:
   - Approach overview
   - Key implementation steps
   - If stacked: "Stacked on {BASE_BRANCH}"
   - Footer: "Awaiting approval. Add label `ClaudePlanApproved` to proceed with implementation."

IF ANY CRITICAL STEP FAILS:
   Use mcp__atlassian__editJiraIssue with cloudId={CLOUD_ID}, issueIdOrKey={KEY},
   update: {"labels": [{"remove": "ClaudePlanning"}, {"remove": "ClaudePlanNeedsApproval"}, {"add": "ClaudeFailed"}]}
   Post a Jira comment explaining the failure.
```

Wait for all agents to complete before proceeding to Step 6.

## Step 6: Summary

Display results:

```
Phase 1 Complete

Planned ({N}):
  - {KEY}: {SUMMARY} (base: {BASE}, worktree: ../{KEY})

Skipped (dependency not ready):
  - {KEY}: waiting on {BLOCKER_KEY}

Awaiting Approval:
  - {KEY}: plan ready, add ClaudePlanApproved to proceed
```

## Error Handling

- Worktree creation fails (Step 4): log error, exclude ticket from Step 5, continue
- Stack dependency branch missing: skip ticket, log "will be picked up next pass"
- Agent planning fails (Step 5): agent handles labeling `ClaudeFailed` and commenting
- Label update fails: warn user, continue (non-blocking)
- Never stop the phase due to a single ticket failure

## Arguments

$ARGUMENTS

Optional: space-separated Jira ticket keys (e.g., `PROJ-123 PROJ-456`). When provided, skip the JQL search in Step 2 and operate only on the specified tickets. All other steps (repo resolution, dependency gating, worktree creation, planning) still apply. If a specified ticket doesn't meet eligibility criteria (missing `ClaudeWork` label, wrong status, etc.), skip it with a warning.
