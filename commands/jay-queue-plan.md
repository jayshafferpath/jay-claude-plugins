---
description: "Phase 1: Find ClaudeReady tickets, gate on stack dependencies, create worktrees, run /jira-start"
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
  - Bash(mkdir *)
  - Read
  - Glob
  - Skill
---

# Queue Phase 1 - Plan

Find tickets labeled `ClaudeReady`, gate on stack dependencies, create worktrees, and run `/jira-start` for each eligible ticket.

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

## Step 2: Find Plannable Tickets

Use `mcp__atlassian__searchJiraIssuesUsingJql`:

```
labels = "ClaudeReady" AND labels NOT IN ("ClaudeWorkPlanning", "ClaudeWorkPlanningDone", "ClaudePlanApproved", "ClaudeWorkExecuting", "ClaudeWorkFinished") AND assignee = currentUser() AND status = "In Progress"
```

If none found, display "Phase 1: No tickets ready for planning." and stop.

## Step 3: Gate on Stack Dependencies

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

## Step 4: Process Each Eligible Ticket (Sequential)

For each eligible ticket:

1. Display: "Planning {KEY}: {SUMMARY} (base: {BASE_BRANCH})"

2. Remove `ClaudeReady` label:
   - `update`: `{"labels": [{"remove": "ClaudeReady"}]}`

3. Fetch latest:
   ```bash
   cd {REPO_ROOT} && git fetch origin
   ```

4. Create worktree:
   - If base is `main`:
     ```bash
     git worktree add -b {KEY} ../{KEY}
     ```
   - If base is another ticket:
     ```bash
     git worktree add -b {KEY} ../{KEY} origin/{BASE_BRANCH}
     ```
   - If branch/worktree already exists, verify and skip creation

5. CD into worktree and run `/jira-start`:
   ```bash
   cd ../{KEY}
   ```
   Use Skill tool: `jira-start` with args `{KEY} --base {BASE_BRANCH}`

6. Post plan summary comment to Jira:
   Read the plan file at `{PLANS_DIR}/jira-{KEY}.md`. Post a comment with:
   - Approach overview
   - Key implementation steps
   - If stacked: "Stacked on {BASE_BRANCH}"
   - Footer: "Awaiting approval. Add label `ClaudePlanApproved` to proceed with implementation."

7. Return to repo root:
   ```bash
   cd {REPO_ROOT}
   ```

## Step 5: Summary

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

- Worktree creation fails: log error, skip ticket, continue
- Stack dependency branch missing: skip ticket, log "will be picked up next pass"
- /jira-start fails: add `ClaudeWorkFailed` label, log error, continue
- Label update fails: warn user, continue (non-blocking)
- Never stop the phase due to a single ticket failure
- Return to `REPO_ROOT` after processing each ticket regardless of success/failure

## Arguments

$ARGUMENTS (unused)
