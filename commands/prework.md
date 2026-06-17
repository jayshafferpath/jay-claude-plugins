---
description: "Prepare a Jira ticket for /ticket-work: resolve stack, ensure feature branch + working directory, seed checklist, run drift check. Stops before planning."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(gh *)
  - Bash(mkdir *)
  - Bash(resolve-stack *)
  - Bash(ensure-work-dir *)
  - Bash(seed-checklist *)
  - Bash(drift-check *)
  - Bash(sync-checklist *)
  - Bash(set-ticket-state *)
  - Bash(append-activity *)
  - Read
  - Write
  - Skill
---

# Prework

Run the pre-execution setup for a Jira ticket so it is ready for `/ticket-work` to pick up at planning. Stops before any plan is generated.

This command is the S1 → S3.5 prefix of `/ticket-work` lifted into a standalone entry point. It is idempotent — re-running on a ticket that already has a working directory, seeded checklist, and drift check applied is a no-op.

What it does:
- Resolves stack context (`resolve-stack`) and gates on unmerged blockers
- Ensures `ClaudeWork` label is present
- Ensures the feature branch exists (when the ticket is part of a Story/Epic stack)
- Ensures the working directory exists (worktree by default, branch checkout with `--serial`)
- Seeds the Jira checklist comment
- Runs the drift check against `Implementation Notes`

What it deliberately does NOT do:
- Move the ticket to `ClaudePlanning`
- Run `/jira-start` or generate a plan
- Execute, verify, refactor, review, or open a PR

## Arguments

$ARGUMENTS

Required: a single Jira ticket key (e.g., `PROJ-123`).

### Flags

- `--serial`: Use branch checkout in the current repo instead of a worktree. Mirrors `ticket-work --serial`.

### Flag Parsing

Parse `$ARGUMENTS` to extract flags. Any token starting with `--` is a flag; the remaining token is the ticket key. Set `SERIAL_MODE = true` if `--serial` is present. If no ticket key is provided, display "Usage: /prework {TICKET_KEY} [--serial]" and stop.

---

## Step 1: Detect Environment

Run **S1: Detect Environment** from `commands/ticket-work.md` (sub-steps S1a, S1b, S1c) verbatim. After it runs the following are bound:

- `SERIAL_MODE`, `CURRENT_ROOT`, `REPO_ROOT`, `WORK_DIR`
- `CLOUD_ID`
- `CONTAINER_KEY`, `CONTAINER_TYPE`, `CONTAINER_SUMMARY`, `FEATURE_BRANCH`, `CONTAINER_BASE`, `UNMERGED_BLOCKERS`, `PARENT_CONTAINER_KEY`, `PARENT_FEATURE_BRANCH`, `STACK_ORDER`
- `BRANCH_NAME`, `BASE_BRANCH`, `PR_TARGET`, `SUMMARY`, `labels` (from the ticket's entry in `STACK_ORDER`)

If `eligible` is `false` and `unblockedBlockers` is non-empty, display "Blocked: waiting on {unblockedBlockers[0]}" and **stop**.

Ensure `ClaudeWork` label is present (S1c step).

---

## Step 2: Ensure Working Directory

Run **S2: Ensure Working Directory Ready** from `commands/ticket-work.md` (sub-steps S2.0, S2a/S2b) verbatim. After it runs:
- The feature branch exists locally and on origin (if `FEATURE_BRANCH` is set)
- `WORK_DIR` and `PLANS_DIR` are bound
- The branch / worktree exists per `SERIAL_MODE`

---

## Step 3: Seed Checklist

Run **S3: Load or Resume Checklist** from `commands/ticket-work.md` verbatim. After it runs the Jira checklist comment exists with steps in either `seeded` or `jira` state, and the in-memory `steps` array reflects current checklist progress.

---

## Step 4: Drift Check

Run **S3.5: Drift Check** from `commands/ticket-work.md` verbatim, including its skip conditions:
- No `h2. Implementation Notes` block on the ticket → skip
- Checklist already shows step 2 (execute) as `[x]` → skip
- `ClaudeDriftChecked` label present and added after the most recent push to `BASE_BRANCH` → skip

If drift is detected, the sub-procedure refreshes Implementation Notes, posts a Jira comment with the drift report, and adds `ClaudeDriftChecked`. Otherwise it adds `ClaudeDriftChecked` and continues.

Do NOT proceed to S4 (the plan/execute lifecycle). Stop here.

---

## Step 5: Final Summary

Display:

```
Prework complete: {TICKET_KEY} - {SUMMARY}

  Working directory: {WORK_DIR}
  Branch:            {BRANCH_NAME} (base: {BASE_BRANCH})
  Feature branch:    {FEATURE_BRANCH or "none"}
  Mode:              {serial | worktree}
  Checklist:         seeded in Jira ({steps_done}/{steps_total} done)
  Drift check:       {passed | refreshed | skipped — {reason}}

Ready for planning. Run `/ticket-work {TICKET_KEY}{ --serial if SERIAL_MODE}` to continue.
```

---

## Error Handling

- Same as `/ticket-work` for the steps it runs. The Jira checklist preserves progress — re-running is safe and resumes from the first incomplete step within S1–S3.5.
- If `S2.0` reports `Error: Blocker container has no branch yet` or `Error: multiple unmerged blocker containers`, surface the error and **stop** without modifying state.
- If `seed-checklist` fails, do not run drift check; surface the error and stop.
