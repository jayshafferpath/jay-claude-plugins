---
description: "Process Jira work queue: plan, execute, promote (stack-aware) - runs all three phases"
allowed-tools:
  - Skill
---

# Claude Queue - Full Lifecycle Orchestrator

Run all three queue phases in sequence: Plan, Execute, Promote. Each phase is idempotent and safe to run repeatedly via `/loop`.

## Label State Machine

```
ClaudeWork (+ In Progress)  -> eligible for planning
ClaudePlanning              -> /jira-start running
ClaudePlanNeedsApproval     -> plan ready, user: review plan and apply ClaudePlanApproved
ClaudePlanApproved          -> user approved, eligible for execution
ClaudeExecuting             -> /plan-execute running
ClaudeNeedsReview           -> done, user: review PR and move ticket to Done
ClaudeFailed                -> error, user: investigate
ClaudeStackComplete         -> all tickets in stack finished (added to Epic)
```

## Execution

### Phase 1 - Plan

Use the Skill tool to run `jay-queue-plan`. If $ARGUMENTS were provided, pass them through as args.

Wait for it to complete before continuing.

### Phase 2 - Execute

Use the Skill tool to run `jay-queue-execute`. If $ARGUMENTS were provided, pass them through as args.

Wait for it to complete before continuing.

### Phase 3 - Promote

Use the Skill tool to run `jay-queue-promote`. If $ARGUMENTS were provided, pass them through as args.

Wait for it to complete before continuing.

### Final Summary

Combine the output from all three phases into a single summary:

```
Queue Processing Complete

Phase 1 - Planned ({N}):
  - {KEY}: {SUMMARY} (base: {BASE}, worktree: ../{KEY})

Phase 2 - Executed ({N}):
  - {KEY}: {SUMMARY}

Phase 3 - Promoted ({N}):
  - {BLOCKED_KEY}: unblocked by {KEY}

Stacks Completed:
  - Epic {EPIC_KEY}: all {N} tickets finished

Skipped (dependency not ready):
  - {KEY}: waiting on {BLOCKER_KEY}

Awaiting Approval:
  - {KEY}: plan ready, add ClaudePlanApproved to proceed
```

## Arguments

$ARGUMENTS

Optional: space-separated Jira ticket keys (e.g., `PROJ-123 PROJ-456`). When provided, all three phases operate only on the specified tickets instead of searching Jira. Each phase still applies its own eligibility checks.
