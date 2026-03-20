---
description: "Phase 3: Find ClaudeWorkFinished tickets, promote downstream, detect stack completion"
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__atlassianUserInfo
  - mcp__atlassian__addCommentToJiraIssue
  - Read
---

# Queue Phase 3 - Promote

Find tickets labeled `ClaudeWorkFinished`, promote unblocked downstream tickets to `ClaudeReady`, and detect stack completion.

## Step 1: Initialize

### 1a: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1b: Get Current User

- Use `mcp__atlassian__atlassianUserInfo`
- Store `account_id` as `MY_ACCOUNT_ID`

## Step 2: Find Finished Tickets

Use `mcp__atlassian__searchJiraIssuesUsingJql`:

```
labels = "ClaudeWorkFinished" AND assignee = currentUser()
```

If none found, display "Phase 3: No finished tickets to process." and stop.

## Step 3: Promote Downstream Tickets

For each finished ticket:

1. Use `mcp__atlassian__getJiraIssue` to get outward "blocks" links
2. Get the ticket's Epic key
3. For each blocked ticket sharing the same Epic:
   - Get blocked ticket via `mcp__atlassian__getJiraIssue`
   - Check if ALL of its same-Epic "is blocked by" dependencies have `ClaudeWorkFinished`
   - If all dependencies met AND blocked ticket has NONE of: `ClaudeReady`, `ClaudeWorkPlanning`, `ClaudeWorkPlanningDone`, `ClaudePlanApproved`, `ClaudeWorkExecuting`, `ClaudeWorkFinished`, `ClaudeWorkFailed`:
     - Verify blocked ticket is assigned to current user AND status is "In Progress"
     - If not assigned or not "In Progress": skip and display "Skipping promotion of {BLOCKED_KEY}: not assigned to me or not In Progress"
     - Otherwise, add `ClaudeReady`: `update`: `{"labels": [{"add": "ClaudeReady"}]}`
     - Display: "Promoted {BLOCKED_KEY} to ClaudeReady (unblocked by {KEY})"

## Step 4: Detect Stack Completion

For each finished ticket:

1. Get the ticket's Epic key
2. Search for all tickets in that Epic:
   ```
   "Epic Link" = {EPIC_KEY} OR parent = {EPIC_KEY}
   ```
3. Check if EVERY ticket in the Epic has `ClaudeWorkFinished`
4. If yes, and the Epic does NOT already have `ClaudeStackComplete`:
   - Add `ClaudeStackComplete` to the Epic:
     `update`: `{"labels": [{"add": "ClaudeStackComplete"}]}`
   - Post a comment on the Epic: "All tickets in this stack have been completed by Claude."
   - Display: "Stack complete: Epic {EPIC_KEY}"

## Step 5: Summary

Display results:

```
Phase 3 Complete

Promoted ({N}):
  - {BLOCKED_KEY}: unblocked by {KEY}

Stacks Completed:
  - Epic {EPIC_KEY}: all {N} tickets finished

Skipped:
  - {BLOCKED_KEY}: not assigned to me or not In Progress
  - {BLOCKED_KEY}: still has unfinished blockers
```

## Error Handling

- Label update fails: warn user, continue (non-blocking)
- Jira comment fails: warn user, continue (non-blocking)
- Never stop the phase due to a single ticket failure

## Arguments

$ARGUMENTS (unused)
