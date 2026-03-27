---
description: "Phase 2: Find ClaudePlanApproved tickets, gate on dependencies, launch parallel execution agents"
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git rev-parse *)
  - Bash(git add *)
  - Bash(git commit *)
  - Bash(git status *)
  - Bash(cd *)
  - Read
  - Skill
  - Agent
---

# Queue Phase 2 - Execute

Find tickets labeled `ClaudePlanApproved`, gate on stack dependencies, and launch parallel agents to execute each plan.

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

## Step 2: Find Eligible Tickets

**If ticket keys were provided in $ARGUMENTS:** Use `mcp__atlassian__getJiraIssue` to fetch each specified ticket directly. Skip the JQL search entirely.

**Otherwise:** Use `mcp__atlassian__searchJiraIssuesUsingJql`:

```
labels IN ("ClaudePlanApproved", "ClaudeExecuting") AND labels NOT IN ("ClaudeNeedsReview", "ClaudeFailed") AND assignee = currentUser()
```

This picks up both fresh approvals AND tickets whose execution was interrupted mid-way (still labeled `ClaudeExecuting`). Classify each ticket:
- **Resuming**: has `ClaudeExecuting` label (was interrupted)
- **Fresh**: has `ClaudePlanApproved` label

If none found, display "Phase 2: No approved or resumable plans to execute." and stop.

### 2b: Resolve Repo per Ticket

For each ticket, find the label starting with `repo:` (e.g., `repo:employer-backend`). Strip the `repo:` prefix and look up the result in `REPO_MAP` to get `REPO_ROOT` for that ticket.

- If a ticket has no `repo:` label: **skip it** and display "Skipping {KEY}: no repo: label found"
- If the `repo:` value is not in `REPO_MAP`: **skip it** and display "Skipping {KEY}: repo '{value}' not found in repo-map.json"

### 2c: Resolve Plans Directory per Ticket

For each ticket, `$PLANS_DIR` is always the worktree's `.claude/plans/`:
- `{REPO_ROOT}/../{KEY}/.claude/plans/`

## Step 3: Gate on Stack Dependencies

Same gating logic as Phase 1 Step 3: for each ticket, check same-Epic "is blocked by" links. A blocker is "finished" if its Jira status category is "done". Skip tickets with unfinished blockers. Determine base branch from the finished blocker's key, or `main` if none.

## Step 4: Launch Execution Agents (Parallel)

All eligible tickets are independent (gating ensures no two same-stack tickets are eligible simultaneously). Launch ALL as **parallel Agent tool calls in a single message**.

For each eligible ticket, launch an Agent with:
- `description`: "Execute {KEY}" (or "Resume {KEY}" if resuming)
- `prompt`: Use the template below, substituting all variables. Set `{MODE}` to `"resuming"` if the ticket had `ClaudeExecuting`, otherwise `"fresh"`.

**Agent Prompt Template:**

```
Execute the implementation plan for Jira ticket {KEY} - {SUMMARY}.
This execution is IDEMPOTENT — it may be a fresh run or a resume of an interrupted one.

SETUP:
- Repo root: {REPO_ROOT}
- Worktree: {REPO_ROOT}/../{KEY}
- Run: cd {REPO_ROOT}/../{KEY}
- Plan file: {PLANS_DIR}/jira-{KEY}.md
- Base branch: {BASE_BRANCH}
- Cloud ID: {CLOUD_ID}
- Mode: {MODE} (either "fresh" or "resuming")

STEPS:

1. Update labels (idempotent — safe to re-run):
   Use mcp__atlassian__editJiraIssue with cloudId={CLOUD_ID}, issueIdOrKey={KEY},
   update: {"labels": [{"remove": "ClaudePlanApproved"}, {"remove": "ClaudePlanNeedsApproval"}, {"add": "ClaudeExecuting"}]}

2. Pre-flight check (resume awareness):
   - Read the plan file at {PLANS_DIR}/jira-{KEY}.md
   - Check which tasks are already marked completed (e.g., [x] or status: done)
   - If ALL tasks are already completed: skip to step 4 (commit & finish)
   - If SOME tasks are completed: note which ones; plan-execute will pick up from where it left off
   - Check git status in the worktree for any uncommitted work from a previous run
     - If there are uncommitted changes, stage and commit them with message "WIP: resumed execution for {KEY}" before continuing

3. Execute the plan:
   Use the Skill tool to run skill "plan-execute" with args "jira-{KEY}"
   (plan-execute tracks per-task completion, so it will skip already-done tasks)

4. After plan execution completes successfully:
   a. Run git status — if there are no staged/unstaged changes, skip commit (already committed)
   b. If there are changes: stage relevant files (NOT .env, credentials, or secrets) and commit with a descriptive message

5. Verify plan completion:
   - Re-read the plan file at {PLANS_DIR}/jira-{KEY}.md
   - Check that ALL tasks are marked completed (e.g., [x] or status: done)
   - If any tasks remain incomplete: do NOT mark ClaudeNeedsReview. Instead, add a Jira comment listing which tasks are incomplete and apply ClaudeFailed label. Stop here.

6. Mark finished (only if step 5 confirms all tasks complete):
   Use mcp__atlassian__editJiraIssue with cloudId={CLOUD_ID}, issueIdOrKey={KEY},
   update: {"labels": [{"remove": "ClaudeExecuting"}, {"add": "ClaudeNeedsReview"}]}

IF ANY CRITICAL STEP FAILS:
   Use mcp__atlassian__editJiraIssue with cloudId={CLOUD_ID}, issueIdOrKey={KEY},
   update: {"labels": [{"remove": "ClaudeExecuting"}, {"add": "ClaudeFailed"}]}
   Post a Jira comment explaining the failure, including which tasks completed and which didn't.
```

Wait for all agents to complete before proceeding to Step 5.

## Step 5: Summary

Display results:

```
Phase 2 Complete

Executed ({N}):
  - {KEY}: {SUMMARY} - {SUCCESS/FAILED} (fresh)

Resumed ({N}):
  - {KEY}: {SUMMARY} - {SUCCESS/FAILED} (resumed)

Skipped (dependency not ready):
  - {KEY}: waiting on {BLOCKER_KEY}
```

## Error Handling

- Agent execution fails: agent handles labeling `ClaudeFailed` and commenting
- Label update fails: warn user, continue (non-blocking)
- Never stop the phase due to a single ticket failure

## Arguments

$ARGUMENTS

Optional: space-separated Jira ticket keys (e.g., `PROJ-123 PROJ-456`). When provided, skip the JQL search in Step 2 and operate only on the specified tickets. All other steps (repo resolution, dependency gating, execution) still apply. If a specified ticket doesn't meet eligibility criteria, skip it with a warning.
