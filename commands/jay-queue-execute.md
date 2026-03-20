---
description: "Phase 2: Find ClaudePlanApproved tickets, gate on dependencies, launch parallel execution agents"
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__atlassianUserInfo
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(cd *)
  - Bash(jq *)
  - Read
  - Glob
  - Skill
  - Agent
---

# Queue Phase 2 - Execute

Find tickets labeled `ClaudePlanApproved`, gate on stack dependencies, and launch parallel agents to execute each plan.

## Step 1: Initialize

### 1a: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1b: Get Current User

- Use `mcp__atlassian__atlassianUserInfo`
- Store `account_id` as `MY_ACCOUNT_ID`

### 1c: Get Repository Root

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
```

### 1d: Resolve Plans Directory

Resolve `$PLANS_DIR` using the cascade:
1. Check `./.claude/settings.local.json` for `plans.directory`
2. Check `~/.claude/settings.json` for `plans.directory`
3. Default: `.claude/plans/`

## Step 2: Find Approved Tickets

Use `mcp__atlassian__searchJiraIssuesUsingJql`:

```
labels = "ClaudePlanApproved" AND labels NOT IN ("ClaudeWorkExecuting", "ClaudeWorkFinished") AND assignee = currentUser()
```

If none found, display "Phase 2: No approved plans to execute." and stop.

## Step 3: Gate on Stack Dependencies

Same logic as Phase 1 gating:

For each ticket:

1. Use `mcp__atlassian__getJiraIssue` to get issue links
2. Get the ticket's Epic/parent key
3. Find inward "is blocked by" links
4. For each blocker sharing the same Epic:
   - Check if it has `ClaudeWorkFinished` label
   - If ANY same-Epic blocker lacks `ClaudeWorkFinished`: **skip this ticket**
   - Display: "Skipping {KEY}: waiting on {BLOCKER_KEY} to finish"
5. Determine base branch:
   - Same-Epic blocker exists with `ClaudeWorkFinished`: base = blocker's ticket key
   - No same-Epic blocker: base = `main`

## Step 4: Launch Execution Agents (Parallel)

All eligible tickets are independent (gating ensures no two same-stack tickets are eligible simultaneously). Launch ALL as **parallel Agent tool calls in a single message**.

For each eligible ticket, launch an Agent with:
- `description`: "Execute {KEY}"
- `prompt`: Use the template below, substituting all variables

**Agent Prompt Template:**

```
Execute the implementation plan for Jira ticket {KEY} - {SUMMARY}.

SETUP:
- Run: cd {REPO_ROOT}/../{KEY}
- Plan file: {PLANS_DIR}/jira-{KEY}.md
- Base branch: {BASE_BRANCH}
- Cloud ID: {CLOUD_ID}

STEPS:

1. Remove ClaudePlanApproved label:
   Use mcp__atlassian__editJiraIssue with cloudId={CLOUD_ID}, issueIdOrKey={KEY},
   update: {"labels": [{"remove": "ClaudePlanApproved"}]}

2. Add ClaudeWorkExecuting label:
   Use mcp__atlassian__editJiraIssue with cloudId={CLOUD_ID}, issueIdOrKey={KEY},
   update: {"labels": [{"remove": "ClaudeWorkPlanningDone"}, {"add": "ClaudeWorkExecuting"}]}

3. Execute the plan:
   Use the Skill tool to run skill "plan-execute" with args "jira-{KEY}"

4. After plan execution completes successfully:
   a. Stage relevant files (NOT .env, credentials, or secrets)
   b. Commit with a descriptive message

5. Mark finished:
   Use mcp__atlassian__editJiraIssue with cloudId={CLOUD_ID}, issueIdOrKey={KEY},
   update: {"labels": [{"remove": "ClaudeWorkExecuting"}, {"add": "ClaudeWorkFinished"}]}

IF ANY CRITICAL STEP FAILS:
   Use mcp__atlassian__editJiraIssue with cloudId={CLOUD_ID}, issueIdOrKey={KEY},
   update: {"labels": [{"remove": "ClaudeWorkExecuting"}, {"remove": "ClaudeWorkPlanningDone"}, {"remove": "ClaudePlanApproved"}, {"add": "ClaudeWorkFailed"}]}
   Post a Jira comment explaining the failure.
```

Wait for all agents to complete before proceeding to Step 5.

## Step 5: Summary

Display results:

```
Phase 2 Complete

Executed ({N}):
  - {KEY}: {SUMMARY} - {SUCCESS/FAILED}

Skipped (dependency not ready):
  - {KEY}: waiting on {BLOCKER_KEY}
```

## Error Handling

- Agent execution fails: agent handles labeling `ClaudeWorkFailed` and commenting
- Label update fails: warn user, continue (non-blocking)
- Never stop the phase due to a single ticket failure

## Arguments

$ARGUMENTS (unused)
