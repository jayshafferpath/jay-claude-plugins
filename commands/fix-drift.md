---
description: "Detect drift between Jira acceptance criteria and the current branch implementation, then fix the code to match the ticket and resume the ticket-work lifecycle."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(gh *)
  - Bash(resolve-stack *)
  - Bash(sync-checklist *)
  - Bash(sync-plan *)
  - Bash(append-activity *)
  - Read
  - Write
  - Edit
  - Agent
  - Skill
---

# Fix Drift

Detect drift between a Jira ticket's acceptance criteria and the current branch implementation, fix the code to close gaps, then resume the standard ticket-work lifecycle.

Use when implementation has diverged from what the ticket specifies — missing scenarios, extra behavior not in ACs, or incorrect behavior.

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

Store as `WORK_DIR`. All subsequent work happens here.

### 1b: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1c: Resolve Stack Context

Run the **Stack Context Resolution** sub-procedure (defined in `commands/ticket-work.md`) with `KEY={TICKET_KEY}` and `REPO_ROOT={WORK_DIR}`. After it runs, also extract from the input ticket's entry in `STACK_ORDER`:
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
Proceeding with current branch.
```

---

## Step 2: Gather Acceptance Criteria

### 2a: Fetch Ticket

Use `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`.

### 2b: Extract Acceptance Criteria

From the ticket description, extract:
- All Gherkin scenarios (`Given`/`When`/`Then` blocks, or fenced `gherkin`/`feature` blocks)
- Any bullet-point acceptance criteria (lines starting with `- [ ]`, `* `, or numbered lists under an "Acceptance Criteria" heading)

Store as `ACCEPTANCE_CRITERIA` — the authoritative list of what the implementation must satisfy.

If no acceptance criteria are found:
- Display: "No acceptance criteria found in ticket {TICKET_KEY}. Nothing to drift-check against."
- **Stop.**

---

## Step 3: Analyze Current Implementation

### 3a: Get Branch Diff

```bash
git diff {BASE_BRANCH}...HEAD --stat
```

Store file list as `CHANGED_FILES`.

```bash
git diff {BASE_BRANCH}...HEAD
```

Store full diff as `BRANCH_DIFF`.

### 3b: Get Test Files

```bash
git diff {BASE_BRANCH}...HEAD --name-only | grep -E '(test|spec)'
```

Store as `TEST_FILES`. Read each test file to understand what behaviors are currently tested.

### 3c: Get Source Files

Read the key source files from `CHANGED_FILES` (non-test files) to understand the actual implementation.

---

## Step 4: Drift Analysis

Compare `ACCEPTANCE_CRITERIA` against the actual implementation and tests. Categorize each AC item into one of:

1. **Satisfied** — implementation and tests correctly cover this criterion
2. **Partially satisfied** — implementation exists but is incomplete or tests are missing
3. **Missing** — no implementation exists for this criterion
4. **Incorrectly implemented** — implementation exists but doesn't match the AC's intent

Build a drift report:

```
## Drift Report: {TICKET_KEY}

### Satisfied ({N}/{TOTAL})
- ✓ {AC item} — covered by {file}:{description}

### Partially Satisfied ({N}/{TOTAL})
- ~ {AC item} — {what's missing or incomplete}

### Missing ({N}/{TOTAL})
- ✗ {AC item} — no implementation found

### Incorrectly Implemented ({N}/{TOTAL})
- ✗ {AC item} — {what's wrong}
```

Display the drift report to the user.

If all items are **Satisfied**:
- Display: "No drift detected. Implementation matches all acceptance criteria."
- **Stop.**

---

## Step 5: Fix Drift

For each criterion that is **Missing**, **Partially Satisfied**, or **Incorrectly Implemented**, fix the implementation using TDD (same Red-Green-Refactor approach as ticket-work S4.3):

### 5a: Plan Fixes

For each gap, determine:
- What test needs to be written or updated (Red)
- What code needs to change (Green)
- Order of fixes (independent fixes can be done in any order; dependent fixes in dependency order)

### 5b: Execute TDD Fixes

For each fix:

1. **Red** — Write or update a test that captures the missing/incorrect behavior:
   ```bash
   {TEST_COMMAND} {TEST_FILE}
   ```
   Confirm the test fails for the expected reason. Commit:
   ```bash
   git add {TEST_FILE} && git commit -m "Red: drift fix - {AC description}"
   ```

2. **Green** — Implement the minimum code to make the test pass:
   ```bash
   {TEST_COMMAND} {TEST_FILE}
   ```
   Confirm it passes. Run full suite to check for regressions:
   ```bash
   {TEST_COMMAND}
   ```
   Commit:
   ```bash
   git add -A && git commit -m "Green: drift fix - {AC description}"
   ```

3. **Refactor** (optional) — Clean up if needed, run tests, commit:
   ```bash
   git add -A && git commit -m "Refactor: drift fix - {AC description}"
   ```

### 5c: Verify Full Coverage

After all fixes are applied, re-run the drift analysis (Step 4 logic) against the updated implementation.

- If all criteria are now **Satisfied**: proceed to Step 6.
- If gaps remain: attempt one more fix pass. If still unresolved after second pass, display remaining gaps and **stop** with:
  ```
  Unable to fully resolve drift. Remaining gaps:
  - {AC item}: {reason}

  Manual intervention required.
  ```

---

## Step 6: Squash and Push

Apply the Stage Squash Protocol for the drift fix commits — `stage-squash` derives the start SHA automatically (most recent `[{TICKET_KEY}]` stage commit, falling back to the merge-base with `origin/{BASE_BRANCH}`):

```bash
stage-squash {TICKET_KEY} --label "fix: drift alignment with acceptance criteria" --base {BASE_BRANCH} --branch {BRANCH_NAME}
```

---

## Step 7: Resume Ticket Work

Append a drift-fix summary to the ticket's activity log:
```bash
append-activity {TICKET_KEY} --heading "Drift fixed" --body "{N} acceptance criteria were out of alignment (M missing, P partial, Q incorrect). All criteria now satisfied. Resuming ticket-work lifecycle."
```

Then resume the ticket-work lifecycle from the current checklist state:
- Use the Skill tool to run skill `ticket-work` with args `{TICKET_KEY}`

---

## Step 8: Summary

Display:

```
Drift Fix Complete: {TICKET_KEY}

Criteria: {TOTAL} total, {FIXED} fixed, {ALREADY_SATISFIED} already satisfied
Commit: [{TICKET_KEY}] fix: drift alignment with acceptance criteria
Branch: {BRANCH_NAME}

Resumed ticket-work lifecycle from current state.
```
