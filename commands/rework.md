---
description: "Reset a ticket's branch to its base, clear all progress labels and checklist, then restart the ticket-work lifecycle from scratch. Use when implementation is unsalvageable and a fresh start is faster than fixing."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(rm *)
  - Bash(resolve-stack *)
  - Bash(sync-checklist *)
  - Bash(sync-plan *)
  - Bash(append-activity *)
  - Read
  - Write
  - Skill
---

# Rework

> **Label source of truth**: `cli/lib/labels.js` `PROGRESS_LABELS` is the canonical list this command clears. If a new progress label is introduced, add it there first; the JSON patch below enumerates labels explicitly because Atlassian's API needs the exact list, but the inline list must mirror `labels.js`.

Reset a ticket's branch to its base, clear all progress (labels, checklist, plan), and restart the ticket-work lifecycle from scratch.

Use when the current implementation is unsalvageable — wrong approach, bad assumptions, or so much drift that fixing is slower than starting over.

## Arguments

$ARGUMENTS

Required: a Jira ticket key (e.g., `PROJ-123`). The command assumes you are on the ticket's branch or in its worktree.

---

## Step 1: Initialize

### 1a: Determine Working Directory

Run:
```bash
git rev-parse --show-toplevel
```

Store as `WORK_DIR`.

### 1b: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1c: Resolve Stack Context

Run the **Stack Context Resolution** sub-procedure (`commands/_shared-stack-procedures.md`) with `KEY={TICKET_KEY}` and `REPO_ROOT={WORK_DIR}`. After it runs, also extract from the input ticket's entry in `STACK_ORDER`:
- `BASE_BRANCH` = ticket's `baseBranch`
- `BRANCH_NAME` = ticket's `branch` (or current branch if null)
- `SUMMARY` = ticket's `summary`

### 1d: Verify Branch

Confirm the current branch matches the ticket:
```bash
git rev-parse --abbrev-ref HEAD
```

If it does not match `BRANCH_NAME`, display a warning:
```
Warning: current branch '{CURRENT}' does not match expected '{BRANCH_NAME}'.
Proceeding anyway — will reset '{BRANCH_NAME}'.
```

---

## Step 2: Determine Reset Target

The reset target is the branch this ticket should be rebuilt on top of:

- If `FEATURE_BRANCH` is set on the container AND `BASE_BRANCH` is `main`, set `RESET_TARGET = FEATURE_BRANCH`. A top-of-stack ticket on a feature-branch story should restart on the feature branch head, not main — otherwise rework would silently move the ticket off the feature branch.
- Otherwise, set `RESET_TARGET = BASE_BRANCH`. For downstream stacked tickets this preserves their upstream sibling's work as the base.

## Step 3: Confirm with User

Display what will be destroyed:

```
Rework will reset ticket {TICKET_KEY} to a clean state:

  Branch: {BRANCH_NAME} → hard reset to origin/{RESET_TARGET}
  Labels: all Claude progress labels removed, ClaudeReady re-applied
  Checklist: cleared (Jira comment removed)
  Plan: cleared (Jira comment removed)
  PR: closed if open

This is irreversible. All commits on this branch will be lost.

Type "confirm" to proceed, or anything else to abort.
```

Wait for user input. If the user does not type "confirm" (or similar affirmative like "yes", "do it", "go ahead"):
- Display: "Rework aborted."
- **Stop.**

---

## Step 4: Close Existing PR

Check if a PR exists for this branch:
```bash
gh pr view {BRANCH_NAME} --json url,state 2>/dev/null
```

If a PR exists and its state is not "CLOSED" or "MERGED":
1. Close it with a comment:
   ```bash
   gh pr close {BRANCH_NAME} --comment "Closing for rework — restarting implementation from scratch."
   ```
2. Display: "Closed PR for {BRANCH_NAME}."

If no PR exists or already closed: skip.

---

## Step 5: Reset Branch

### 5a: Fetch Latest

```bash
cd {WORK_DIR} && git fetch origin
```

### 5b: Hard Reset to Reset Target

Reset to the branch chosen in Step 2 (`RESET_TARGET` — the feature branch for top-of-stack tickets on a feature-branch story, otherwise the original base):

```bash
git reset --hard origin/{RESET_TARGET}
```

### 5c: Force Push the Reset

```bash
git push origin {BRANCH_NAME} --force-with-lease
```

If force push fails (e.g., branch doesn't exist on remote yet), that's fine — skip.

### 5d: Clean Working Directory

Remove any local plan files for this ticket:
```bash
rm -f {WORK_DIR}/.claude/plans/jira-{TICKET_KEY}.md
rm -f {WORK_DIR}/.claude/plans/ticket-work-{TICKET_KEY}*.md
rm -f {WORK_DIR}/.claude/plans/pr-review-{TICKET_KEY}*.md
rm -f {WORK_DIR}/pr.md
```

---

## Step 6: Clear Jira State

### 6a: Remove Progress Labels

Run `set-ticket-state` to clear every progress label currently on the ticket and re-mark it `ClaudeReady`. The CLI consults `cli/lib/labels.js` (`PROGRESS_LABELS`) so the enumeration stays canonical.

```bash
set-ticket-state {TICKET_KEY} --to ClaudeReady
```

Note: `ClaudeWork` is never removed (durable tag).

### 6b: Clear Checklist in Jira

```bash
sync-checklist {TICKET_KEY} --clear
```

If `--clear` is not supported, overwrite with an empty checklist:
```bash
sync-checklist {TICKET_KEY} --steps '[]'
```

### 6c: Clear Plan in Jira

```bash
sync-plan {TICKET_KEY} --clear
```

If `--clear` is not supported, skip (the plan comment will be regenerated on next run).

### 6d: Collapse Activity Log and Append Rework Entry

Collapse any prior activity log entries into a single archived "Previous attempts" section, then append the rework notice. This keeps the timeline readable across reworks while preserving a record that prior attempts existed.

```bash
append-activity {TICKET_KEY} --collapse
append-activity {TICKET_KEY} --heading "Reworked" --body "All previous implementation discarded. Branch \`{BRANCH_NAME}\` reset to \`{RESET_TARGET}\`. Restarting from planning phase."
```

---

## Step 7: Restart Ticket Work

Display:
```
Rework complete. Branch reset, state cleared.
Starting fresh ticket-work lifecycle...
```

Use the Skill tool to run skill `ticket-work` with args `{TICKET_KEY}`

---

## Step 8: Summary

If ticket-work completes or reaches a gate, display:

```
Rework: {TICKET_KEY} - Restarted

Branch: {BRANCH_NAME} (reset to {RESET_TARGET})
Previous work: discarded
Status: resumed ticket-work lifecycle
```
