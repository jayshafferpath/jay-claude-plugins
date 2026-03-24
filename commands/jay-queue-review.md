---
description: "Phase 2.5: Find ClaudeUserReviewDone tickets, run /pr-review for self-review"
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git rev-parse *)
  - Bash(git add *)
  - Bash(git commit *)
  - Bash(cd *)
  - Read
  - Glob
  - Skill
  - Agent
---

# Queue Phase 2.5 - Review

Find tickets labeled `ClaudeUserReviewDone`, run `/pr-review` for self-review, and mark as `ClaudeReviewComplete`.

This phase runs after the user has finished iterating on the PR. The user signals readiness by adding the `ClaudeUserReviewDone` label.

## Step 1: Initialize

### 1a: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1b: Get Repository Root

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
```

## Step 2: Find Review-Ready Tickets

Use `mcp__atlassian__searchJiraIssuesUsingJql`:

```
labels = "ClaudeUserReviewDone" AND labels NOT IN ("ClaudeReviewComplete") AND assignee = currentUser()
```

If none found, display "Phase 2.5: No tickets ready for review." and stop.

## Step 3: Launch Review Agents (Parallel)

All eligible tickets are independent. Launch ALL as **parallel Agent tool calls in a single message**.

For each eligible ticket, launch an Agent with:
- `description`: "Review {KEY}"
- `prompt`: Use the template below, substituting all variables

**Agent Prompt Template:**

```
Run self-review for Jira ticket {KEY} - {SUMMARY}.

SETUP:
- Run: cd {REPO_ROOT}/../{KEY}
- Cloud ID: {CLOUD_ID}

STEPS:

1. Remove ClaudeUserReviewDone label, add ClaudeReviewing label:
   Use mcp__atlassian__editJiraIssue with cloudId={CLOUD_ID}, issueIdOrKey={KEY},
   update: {"labels": [{"remove": "ClaudeUserReviewDone"}, {"add": "ClaudeReviewing"}]}

2. Run self-review:
   Use the Skill tool to run skill "pr-review"

3. If the review plan identifies issues that need fixing:
   Use the Skill tool to run skill "pr-execute-plan" to fix them

4. After review completes successfully:
   a. Stage and commit any fixes with message "fix: address pr-review findings for {KEY}"
   b. Mark review complete:
      Use mcp__atlassian__editJiraIssue with cloudId={CLOUD_ID}, issueIdOrKey={KEY},
      update: {"labels": [{"remove": "ClaudeReviewing"}, {"remove": "ClaudeWorkFinished"}, {"add": "ClaudeReviewComplete"}]}
   c. Post a Jira comment summarizing the review findings and any fixes applied.

IF ANY CRITICAL STEP FAILS:
   Use mcp__atlassian__editJiraIssue with cloudId={CLOUD_ID}, issueIdOrKey={KEY},
   update: {"labels": [{"remove": "ClaudeReviewing"}, {"add": "ClaudeWorkFailed"}]}
   Post a Jira comment explaining the failure.
```

Wait for all agents to complete before proceeding to Step 4.

## Step 4: Summary

Display results:

```
Phase 2.5 Complete

Reviewed ({N}):
  - {KEY}: {SUMMARY} - {PASS/FIXED/FAILED}

```

## Error Handling

- Agent review fails: agent handles labeling `ClaudeWorkFailed` and commenting
- Label update fails: warn user, continue (non-blocking)
- Never stop the phase due to a single ticket failure

## Arguments

$ARGUMENTS (unused)
