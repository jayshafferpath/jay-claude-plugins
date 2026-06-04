---
description: "Run Jira tickets through plan, execute, and code review to stack-ready. Feature branches merge locally after review passes. Without feature branch, PR push requires ClaudePRApproved. With args: single ticket. Without args: discover and process queue."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(gh *)
  - Bash(mkdir *)
  - Bash(sync-checklist *)
  - Bash(sync-plan *)
  - Read
  - Write
  - Skill
  - Agent
---

# Ticket Work

Run Jira tickets through: plan → execute → code review → stack-ready.
With a feature branch (`branch:` label on stack container): merges locally into the feature branch after review passes.
Without a feature branch: stops at stack-ready; PR to main requires `ClaudePRApproved` trigger.
Idempotent — reads checklist state and resumes from wherever it left off.

- **With arguments**: Run a single ticket (or expand a Story to its subtasks and run them in parallel).
- **Without arguments**: Discover all eligible tickets from Jira and process them (queue mode).

## Label Reference

- **ClaudeWork**: durable tag marking ticket for Claude (auto-applied on first pickup, never removed)
- **ClaudeReady**: ticket is ready for planning (user-applied or added by promote step)
- **ClaudePlanning**: /jira-start running
- **ClaudePlanNeedsApproval**: plan ready, user: review plan and apply ClaudePlanApproved
- **ClaudePlanApproved**: user approved plan, eligible for execution (user-applied)
- **ClaudeExecuting**: /plan-execute running
- **ClaudeStackReady**: code review complete, stack unblocked. For feature branches: awaiting merge. For standard: awaiting user consent to open PR.
- **ClaudePRApproved**: user approved PR creation, eligible for PR push (user-applied, standard workflow only)
- **ClaudeNeedsReview**: merged to feature branch or PR pushed, user: review and move ticket to Done
- **ClaudeFailed**: execution failed, user: investigate
- **ClaudeStackComplete**: all tickets in stack finished (added to stack container). If feature branch set, triggers Mode C (feature branch PR to main).
- **ClaudeMainPR**: used by `/promote-to-main` — not part of the ticket-work lifecycle
- **branch:{name}**: applied to the stack container (Story/Epic) to designate a root feature branch. User creates this branch manually. All tickets in the stack base off this branch and merge locally into it after review passes.

Note: never remove the `ClaudeWork` label — it is a durable tag indicating Claude owns the ticket.

### Label Inheritance

When a parent Story/Task has `ClaudeReady`, all its subtasks are eligible for planning without needing the label themselves. On first pickup, subtasks are synced to be self-contained:
- **Labels** — parent labels are copied to the subtask (e.g., `ClaudeWork`, `ClaudeReady`, `repo:*`)
- **Assignee** — unassigned subtasks are assigned to the parent's assignee

After this sync, subtasks carry their own labels and assignment. Progress labels (`ClaudePlanning`, `ClaudeExecuting`, etc.) are applied to individual subtasks as they progress.

### Label State Machine

```
ClaudeReady                 -> eligible for planning
ClaudePlanning              -> /jira-start running
ClaudePlanNeedsApproval     -> plan ready, user: review plan and apply ClaudePlanApproved
ClaudePlanApproved          -> user approved, eligible for execution
ClaudeExecuting             -> /plan-execute running
ClaudeStackReady            -> code review done, stack unblocked, awaiting PR consent
ClaudePRApproved            -> user approved PR creation, eligible for PR push
ClaudeNeedsReview           -> PR pushed, user: review PR and move ticket to Done
ClaudeFailed                -> error, user: investigate
ClaudeStackComplete         -> all tickets in stack finished (added to stack container)
```

## Arguments

$ARGUMENTS

Optional: space-separated Jira ticket keys (e.g., `PROJ-123 PROJ-456`). If a key is a parent Story/Task with subtasks, it expands to the eligible subtasks underneath it. If no arguments are provided, runs in queue mode — discovers all eligible tickets and processes them.

### Flags

- `--serial`: Work tickets sequentially using branch checkout instead of worktrees. Stays in the main repo directory and switches branches between tickets. Use when worktrees are impractical (e.g., monorepos with expensive setup, limited disk space, or tooling that doesn't support worktrees).

### Flag Parsing

Parse `$ARGUMENTS` to extract flags before processing ticket keys. Any token starting with `--` is a flag; remaining tokens are ticket keys. Store `SERIAL_MODE = true` if `--serial` is present.

---

# Mode A: Single Ticket (arguments provided)

## A1: Resolve Tickets

Use `mcp__atlassian__getAccessibleAtlassianResources` to get `CLOUD_ID`.

For each key in `$ARGUMENTS`, use `mcp__atlassian__getJiraIssue` to fetch it.

### Completed stack with feature branch — Mode C

If the issue is a **stack container** (Story/Task with subtasks, or Epic) AND has `ClaudeStackComplete` label AND has a `branch:` label: this is a completed feature branch ready for PR to main. Proceed to **Mode C: Feature Branch PR** below.

### Standard ticket resolution

If it is a **parent with subtasks** (issue type is Story/Task and has subtasks), expand to its subtasks via JQL: `parent = {PARENT_KEY}`. Apply exclusion filter (skip subtasks that already have `ClaudePlanning`, `ClaudePlanApproved`, `ClaudeExecuting`, `ClaudeStackReady`, `ClaudePRApproved`, `ClaudeNeedsReview`, or `ClaudeFailed`). If not a parent, use the ticket directly.

### Inherit from Parent (subtasks only)

For each subtask discovered via a parent, sync the parent's labels and assignment onto the subtask. Use `mcp__atlassian__editJiraIssue`:

- **Labels**: Copy all parent labels the subtask doesn't already have (e.g., `ClaudeWork`, `repo:*`, `ClaudeReady`). Skip `ClaudeStackComplete`.
- **Assignee**: If the subtask is unassigned but the parent is assigned, assign the subtask to the same user.

### Single ticket — run directly

If only **one** work item results (single ticket, or a Story with one subtask), proceed to **Single Ticket Lifecycle** below.

### Multiple tickets — parallel agents (or serial)

If **multiple** work items result, run the **Queue Pipeline** (Step Q3 onward) using these tickets instead of JQL discovery. If `SERIAL_MODE`, tickets will be processed sequentially per Q6b.

---

# Mode B: Queue Mode (no arguments)

Run the full queue pipeline: discover → gate → prepare → execute → promote.

Proceed to **Queue Pipeline** below.

---

# Mode C: Feature Branch PR (completed stack with feature branch)

Triggered when a stack container key is passed that has both `ClaudeStackComplete` and a `branch:` label. This opens a PR from the feature branch to main, runs code review, and resolves Copilot comments.

## C1: Initialize

1. `CONTAINER_KEY` = the provided issue key
2. `FEATURE_BRANCH` = value from `branch:` label (minus prefix)
3. Detect `REPO_ROOT`:
   - Look for `repo:` label on the container issue
   - Read `~/.claude/dev-root.json` for `DEV_ROOT`
   - `REPO_ROOT` = `{DEV_ROOT}/{repo_name}`
4. Fetch latest:
   ```bash
   cd {REPO_ROOT} && git fetch origin
   ```
5. Checkout the feature branch:
   ```bash
   cd {REPO_ROOT} && git checkout {FEATURE_BRANCH} && git pull origin {FEATURE_BRANCH}
   ```

## C2: Load or Create Feature Branch Checklist

The checklist file lives at `{REPO_ROOT}/.claude/plans/ticket-work-{CONTAINER_KEY}-pr.md`.

Check if the file already exists:
- **If it exists**: read it and parse the checklist state. Resume from the first unchecked step.
- **If it does not exist**: create it (see below).

### C2a: Create the plans directory

```bash
mkdir -p {REPO_ROOT}/.claude/plans
```

### C2b: Write the checklist file

```markdown
---
ticket: {CONTAINER_KEY}
branch: {FEATURE_BRANCH}
summary: {CONTAINER_SUMMARY}
pr_target: main
work_dir: {REPO_ROOT}
created: {ISO_TIMESTAMP}
---

# {CONTAINER_KEY} - Feature Branch PR Checklist

- [ ] 1. PR description generated
- [ ] 2. PR created as draft
- [ ] 3. PR review plan generated
- [ ] 4. PR review plan executed
- [ ] 5. Copilot review comments resolved
- [ ] 6. PR review summary posted
- [ ] 7. PR marked ready for review
```

## C3: Execute Checklist

Work through each unchecked step in order. After completing each step, immediately update the checklist file.

---

### Step C3.1: PR description generated

**Skip if**: step 1 is already checked `[x]`.

1. Make sure we are in the repo root: `cd {REPO_ROOT}`
2. Ensure we are on the feature branch: `git checkout {FEATURE_BRANCH}`
3. Use the Skill tool to run skill `jay-pr-description`
4. Mark step 1 as `[x]`

---

### Step C3.2: PR created as draft

**Skip if**: step 2 is already checked `[x]`.

1. Check if a PR already exists for this branch:
   ```bash
   gh pr view {FEATURE_BRANCH} --json number,url 2>/dev/null
   ```
2. If no PR exists:
   a. Push the branch:
      ```bash
      cd {REPO_ROOT} && git push -u origin {FEATURE_BRANCH}
      ```
   b. Read the generated PR description (from step C3.1 output or `./pr.md` if it exists)
   c. Create a draft PR targeting `main`:
      ```bash
      gh pr create --draft --base main --title "{PR_TITLE}" --body "{PR_BODY}"
      ```
3. If a PR already exists: ensure latest is pushed:
   ```bash
   cd {REPO_ROOT} && git push
   ```
4. Post a Jira comment on `{CONTAINER_KEY}`: "Draft PR opened for feature branch `{FEATURE_BRANCH}` → main: {PR_URL}"
   - Use `mcp__atlassian__addCommentToJiraIssue`
5. Mark step 2 as `[x]`

---

### Step C3.3: PR review plan generated

**Skip if**: step 3 is already checked `[x]`.

1. Make sure we are in the repo root on the feature branch: `cd {REPO_ROOT}`
2. Use the Skill tool to run skill `pr-review`
3. Mark step 3 as `[x]`

---

### Step C3.4: PR review plan executed

**Skip if**: step 4 is already checked `[x]`.

1. Make sure we are in the repo root: `cd {REPO_ROOT}`
2. Use the Skill tool to run skill `pr-execute-plan`
3. After execution: stage and commit any changes if present, then push:
   ```bash
   cd {REPO_ROOT} && git push origin {FEATURE_BRANCH}
   ```
4. Mark step 4 as `[x]`

---

### Step C3.5: Copilot review comments resolved

**Skip if**: step 5 is already checked `[x]`.

1. Make sure we are in the repo root: `cd {REPO_ROOT}`
2. Use the Skill tool to run skill `pr-watch` with args `--rounds 1 --auto --interval 30`
3. If pr-watch made changes and pushed, note updated HEAD
4. Mark step 5 as `[x]`

---

### Step C3.6: PR review summary posted

**Skip if**: step 6 is already checked `[x]`.

1. Read the PR review plan file from `{REPO_ROOT}/.claude/plans/` (matching `pr-review-*.md`)
2. Build a summary comment:
   ```
   ## Claude Code Review Summary

   ### Issues Found
   - **{issue title}**: {brief description} — **{resolved|open}**
   ...

   ### Resolutions
   - {issue}: {what was changed to fix it}
   ...

   N issues found, M resolved.
   ```
3. Post the comment to the PR:
   ```bash
   gh pr comment {FEATURE_BRANCH} --body "{REVIEW_SUMMARY}"
   ```
4. Mark step 6 as `[x]`

---

### Step C3.7: PR marked ready for review

**Skip if**: step 7 is already checked `[x]`.

1. Mark the PR as ready for review:
   ```bash
   gh pr ready {FEATURE_BRANCH}
   ```
2. Post a Jira comment on `{CONTAINER_KEY}`: "Feature branch PR is ready for human review: {PR_URL}"
   - Use `mcp__atlassian__addCommentToJiraIssue`
3. Mark step 7 as `[x]`

---

## C4: Final Summary

Display:

```
Feature Branch PR - Complete

Container: {CONTAINER_KEY} - {CONTAINER_SUMMARY}
Branch: {FEATURE_BRANCH} → main
PR: {PR_URL}

All review steps completed. PR is ready for human review.
```

---

# Queue Pipeline

Used by both Mode B (full discovery) and Mode A (multiple tickets from argument expansion).

## Q1: Initialize

### Q1a: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID` (skip if already set from Mode A)

### Q1b: Load Dev Root

Read `~/.claude/dev-root.json`:
```json
{
  "root": "/path/to/dev"
}
```
Store the `root` value as `DEV_ROOT`. This is the parent directory containing all repo clones. Repo names from `repo:` labels map directly to subdirectories: `{DEV_ROOT}/{repo_name}`.

## Q2: Discover Eligible Tickets

**Skip if tickets were already resolved from Mode A arguments.**

Search three JQL queries and combine:

### Q2a: Tickets ready for planning

```
labels = "ClaudeReady" AND labels NOT IN ("ClaudePlanNeedsApproval", "ClaudePlanApproved", "ClaudeExecuting", "ClaudeNeedsReview", "ClaudeFailed") AND assignee = currentUser()
```

### Q2b: Subtasks via parent

Find parent Stories/Tasks labeled `ClaudeReady`:

```
labels = "ClaudeReady" AND issueType IN (Story, Task) AND assignee = currentUser()
```

For each parent, fetch subtasks: `parent = {PARENT_KEY}`. Include subtasks that do NOT already have any of: `ClaudePlanning`, `ClaudePlanNeedsApproval`, `ClaudePlanApproved`, `ClaudeExecuting`, `ClaudeStackReady`, `ClaudePRApproved`, `ClaudeNeedsReview`, `ClaudeFailed`.

### Q2c: Tickets ready for execution or PR work

```
labels IN ("ClaudePlanApproved", "ClaudeExecuting", "ClaudePRApproved") AND labels NOT IN ("ClaudeNeedsReview", "ClaudeFailed") AND assignee = currentUser()
```

### Q2d: Deduplicate

Merge all results, removing duplicates by ticket key. If none found, proceed directly to Q7 (Promote).

### Q2e: Inherit from Parent (subtasks only)

For each subtask discovered via a parent, sync the parent's labels and assignment onto the subtask. Use `mcp__atlassian__editJiraIssue`:

- **Labels**: Copy all parent labels the subtask doesn't already have (e.g., `ClaudeWork`, `repo:*`, `ClaudeReady`). Skip `ClaudeStackComplete`.
- **Assignee**: If the subtask is unassigned but the parent is assigned, assign the subtask to the same user.

## Q3: Resolve Repo per Ticket

For each ticket, find the label starting with `repo:` (e.g., `repo:my-backend`). Strip the `repo:` prefix to get the repo name. Set `REPO_ROOT` = `{DEV_ROOT}/{repo_name}`.

- If no `repo:` label: **skip it** and display "Skipping {KEY}: no repo: label found"
- If `REPO_ROOT` directory does not exist: **skip it** and display "Skipping {KEY}: repo directory '{REPO_ROOT}' not found"

## Q4: Gate on Stack Dependencies

For each ticket:

1. Use `mcp__atlassian__getJiraIssue` to get issue links and determine the **stack container**:
   - If the ticket is a **subtask** (has a `parent` field that is a Story/Task, not an Epic): the stack container is the parent Story key. Stack siblings are other subtasks of that parent.
   - Otherwise: the stack container is the ticket's Epic key. Stack siblings are other tickets linked to the same Epic.
2. Find inward "is blocked by" links
3. For each blocker that shares the same stack container:
   - A blocker is "finished" if its Jira status category is "done" (statusCategory.key == "done") OR it has the `ClaudeStackReady` label (code review complete, stack unblocked) OR it has the `ClaudeNeedsReview` label (PR has been pushed)
   - **Feature branch merge gate**: If `FEATURE_BRANCH` is set and the blocker is "finished" per the above, additionally verify the blocker's branch has been merged into the feature branch:
     ```bash
     git merge-base --is-ancestor origin/{BLOCKER_BRANCH} origin/{FEATURE_BRANCH}
     ```
     If this check fails (exit code non-zero), the blocker is NOT considered finished — its code has not yet landed in the feature branch.
   - If ANY same-stack blocker is NOT finished: **skip this ticket**
   - Display: "Skipping {KEY}: waiting on {BLOCKER_KEY} to be merged into {FEATURE_BRANCH}"
4. Detect **feature branch**: fetch the stack container issue, look for a `branch:` label. If found, `FEATURE_BRANCH` = label value (minus `branch:` prefix). Otherwise `FEATURE_BRANCH` = null.
5. Determine base branch:
   - Same-stack blocker exists that is finished AND `FEATURE_BRANCH` is set: base = `FEATURE_BRANCH` (blocker's changes are already in the feature branch)
   - Same-stack blocker exists that is finished AND no feature branch: base = blocker's ticket key
   - No same-stack blocker and `FEATURE_BRANCH` is set: base = `FEATURE_BRANCH`
   - No same-stack blocker and no feature branch: base = `main`

## Q5: Prepare Working Directories (Sequential)

Fetch once per repo, then prepare branches/worktrees sequentially (shared git state requires this):

1. For each unique `REPO_ROOT`, fetch latest:
   ```bash
   cd {REPO_ROOT} && git fetch origin
   ```

2. For each eligible ticket:
   a. Display: "Preparing {MODE} for {KEY}: {SUMMARY} (base: {BASE_BRANCH})" where `{MODE}` is "branch" if `SERIAL_MODE`, otherwise "worktree"

   b. Derive `BRANCH_NAME` = `{TICKET_KEY}` (reuse existing branch if one matches `{KEY}*`)

   c. **If `SERIAL_MODE`**: Create or verify branch (from within `{REPO_ROOT}`):
      - If branch already exists (`git branch --list '{BRANCH_NAME}'` returns non-empty): skip creation
      - If base is `main`:
        ```bash
        cd {REPO_ROOT} && git branch {BRANCH_NAME} origin/main
        ```
      - If base is another ticket:
        ```bash
        cd {REPO_ROOT} && git branch {BRANCH_NAME} origin/{BASE_BRANCH}
        ```

   d. **If not `SERIAL_MODE`**: Create worktree (from within `{REPO_ROOT}`):
      - If base is `main`:
        ```bash
        cd {REPO_ROOT} && git worktree add -b {BRANCH_NAME} {REPO_ROOT}/../{KEY}
        ```
      - If base is another ticket:
        ```bash
        cd {REPO_ROOT} && git worktree add -b {BRANCH_NAME} {REPO_ROOT}/../{KEY} origin/{BASE_BRANCH}
        ```
      - If branch/worktree already exists, verify and skip creation

## Q6: Launch Ticket Work

### Q6a: Parallel Mode (default, not `SERIAL_MODE`)

All eligible tickets are independent (gating ensures no two same-stack tickets are eligible simultaneously). Launch ALL as **parallel Agent tool calls in a single message**.

For each eligible ticket, launch an Agent with:
- `description`: "Work {KEY}"
- `prompt`: Use the template below, substituting all variables.

**Agent Prompt Template (Parallel):**

```
Run the ticket lifecycle for Jira ticket {KEY} - {SUMMARY}.

cd {REPO_ROOT}/../{KEY}

Use the Skill tool to run skill "ticket-work" with args "{KEY}"

ticket-work is idempotent — it will resume from the current checklist state
and run through to the next gate (approval) or completion.
```

Wait for all agents to complete before proceeding.

### Q6b: Serial Mode (`SERIAL_MODE = true`)

Process tickets **one at a time, sequentially** in the main repo directory. Order tickets by stack dependency (upstream first), then by ticket key.

For each eligible ticket, **in order**:

1. Checkout the ticket's branch:
   ```bash
   cd {REPO_ROOT} && git checkout {BRANCH_NAME}
   ```
2. Display: "Working ticket {KEY}: {SUMMARY} (branch: {BRANCH_NAME}, base: {BASE_BRANCH})"
3. Use the Skill tool to run skill `ticket-work` with args `{KEY} --serial`
4. After the ticket reaches a gate (approval needed) or completes, stash or commit any work and continue to the next ticket.

If a ticket stops at a gate (plan approval, PR approval), continue to the next ticket. The stopped ticket will resume on next run.

## Q7: Promote Downstream Tickets

Find done tickets and promote unblocked downstream work.

### Q7a: Find Done Tickets

Use `mcp__atlassian__searchJiraIssuesUsingJql`:

```
labels = "ClaudeWork" AND statusCategory = Done AND assignee = currentUser()
```

If none found, skip to Q8.

### Q7b: Promote

For each done ticket:

1. Use `mcp__atlassian__getJiraIssue` to get outward "blocks" links
2. Determine the **stack container** (subtask → parent Story key, otherwise → Epic key)
3. For each blocked ticket sharing the same stack container:
   - Get blocked ticket via `mcp__atlassian__getJiraIssue`
   - Check if ALL of its same-stack "is blocked by" dependencies are "finished" (status category "done" OR has `ClaudeStackReady` label OR has `ClaudeNeedsReview` label)
   - **Feature branch merge gate**: If `FEATURE_BRANCH` is set, additionally verify each finished blocker's branch has been merged into the feature branch:
     ```bash
     git merge-base --is-ancestor origin/{BLOCKER_BRANCH} origin/{FEATURE_BRANCH}
     ```
     If this check fails for any blocker, that dependency is NOT considered met.
   - If all dependencies met (including merge gate) AND blocked ticket does NOT already have any of: `ClaudePlanning`, `ClaudePlanNeedsApproval`, `ClaudePlanApproved`, `ClaudeExecuting`, `ClaudeStackReady`, `ClaudePRApproved`, `ClaudeNeedsReview`, `ClaudeFailed`:
     - Verify blocked ticket is assigned to current user
     - If not assigned: skip and display "Skipping promotion of {BLOCKED_KEY}: not assigned to me"
     - Add `ClaudeReady` label: `update`: `{"labels": [{"add": "ClaudeReady"}]}`
     - Display: "Promoted {BLOCKED_KEY} (unblocked by {KEY}) - ready for planning"

### Q7c: Detect Stack Completion

For each done ticket:

1. Determine the **stack container** (subtask → parent Story key, otherwise → Epic key)
2. Search for all items in that stack container:
   - Story: `parent = {STORY_KEY}`
   - Epic: `"Epic Link" = {EPIC_KEY} OR parent = {EPIC_KEY}`
3. Check if EVERY item has status category "done"
4. If yes, and the stack container does NOT already have `ClaudeStackComplete`:
   - Add `ClaudeStackComplete`: `update`: `{"labels": [{"add": "ClaudeStackComplete"}]}`
   - Post a comment: "All tickets in this stack have been completed by Claude."
   - Display: "Stack complete: {CONTAINER_TYPE} {CONTAINER_KEY}"
5. If `ClaudeStackComplete` was just added AND the container has a `branch:` label (feature branch set):
   - Display: "Feature branch stack complete — running Mode C (Feature Branch PR) for {CONTAINER_KEY}"
   - Run **Mode C: Feature Branch PR** for this container (pass the container key through)

## Q8: Summary

Display combined results:

```
Queue Processing Complete

Worked ({N}):
  - {KEY}: {SUMMARY} (base: {BASE}, dir: {WORK_DIR})

Promoted ({N}):
  - {BLOCKED_KEY}: unblocked by {KEY}

Stacks Completed:
  - {CONTAINER_TYPE} {CONTAINER_KEY}: all {N} tickets finished

Skipped (dependency not ready):
  - {KEY}: waiting on {BLOCKER_KEY}

Awaiting Plan Approval:
  - {KEY}: plan ready, add ClaudePlanApproved to proceed

Awaiting PR Approval:
  - {KEY}: stack ready, add ClaudePRApproved to open PR
```

---

# Single Ticket Lifecycle

Runs one ticket through all steps. Used directly (Mode A, single ticket) or via agent delegation from the Queue Pipeline.

## S1: Detect Environment

### S1a: Determine Mode and Working Directory

Check if `--serial` flag is present in arguments. Set `SERIAL_MODE = true` if so.

Run:
```bash
git rev-parse --show-toplevel
```

Store as `CURRENT_ROOT`.

#### If `SERIAL_MODE`:

- Set `REPO_ROOT` = `CURRENT_ROOT`
- Set `WORK_DIR` = `CURRENT_ROOT` (all work happens in the main repo)
- Detect `BRANCH_NAME` from the current branch: `git rev-parse --abbrev-ref HEAD`
  - If the current branch matches the ticket key pattern (`{TICKET_KEY}*`), we're already on the right branch.
  - Otherwise, we'll need to checkout/create the branch in S2.

#### If not `SERIAL_MODE` (worktree mode):

Determine if we are already in the correct worktree:

- Extract the basename of `CURRENT_ROOT` (e.g., `/path/to/repos/PROJ-123` → `PROJ-123`)
- If the basename **matches the ticket key**: we are already in the ticket's worktree.
  - Set `WORK_DIR` = `CURRENT_ROOT`
  - Set `REPO_ROOT` = parent's git main worktree. Detect with:
    ```bash
    git worktree list --porcelain
    ```
    The first entry (marked `bare` or without `branch`) is the main worktree. Store its path as `REPO_ROOT`.
    If `CURRENT_ROOT` IS the main worktree (not a linked worktree), then `REPO_ROOT` = `CURRENT_ROOT` and we still need to create the ticket worktree (proceed to S2).
  - Detect `BRANCH_NAME` from the current branch: `git rev-parse --abbrev-ref HEAD`
- If the basename **does not match**: we are in the main repo (or a different worktree).
  - Set `REPO_ROOT` = `CURRENT_ROOT`
  - Set `WORK_DIR` = `{REPO_ROOT}/../{TICKET_KEY}`
  - If a checklist file already exists at `{WORK_DIR}/.claude/plans/ticket-work-{TICKET_KEY}.md`, read `BRANCH_NAME` from its `branch:` frontmatter field

### S1b: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### S1c: Fetch Ticket Data

- Use `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
- Store: summary, status, labels, issue links, epic/parent key
- **Ensure `ClaudeWork` label**: If the ticket does not already have the `ClaudeWork` label, add it using `mcp__atlassian__editJiraIssue` with `update`: `{"labels": [{"add": "ClaudeWork"}]}`. This ensures every ticket processed by ticket-work is durably tagged.
- Derive `BRANCH_NAME`: `BRANCH_NAME` = `{TICKET_KEY}` (e.g., `NEV-123`)
  - If a branch already exists for this ticket (check with `git branch --list '{TICKET_KEY}*'`), use the existing branch name instead to avoid creating duplicates
- Determine the **stack container**:
  - If the ticket is a **subtask** (has a `parent` field that is a Story/Task, not an Epic): the stack container is the parent Story key. Stack siblings are other subtasks of that parent.
  - Otherwise: the stack container is the ticket's Epic key. Stack siblings are other tickets linked to the same Epic.
- Detect **feature branch** (from stack container labels):
  - Fetch the stack container issue (parent Story or Epic) via `mcp__atlassian__getJiraIssue`
  - Look for a label starting with `branch:` (e.g., `branch:feature-user-auth`)
  - If found, strip the `branch:` prefix → `FEATURE_BRANCH` (e.g., `feature-user-auth`)
  - If not found: `FEATURE_BRANCH` = `null` (standard workflow, tickets base off `main`)
- Determine `BASE_BRANCH`:
  - Check same-stack "is blocked by" links
  - A blocker is "finished" if its Jira status category is "done" OR has `ClaudeStackReady` label OR has `ClaudeNeedsReview` label
  - **Feature branch merge gate**: If `FEATURE_BRANCH` is set and a blocker is "finished" per the above, additionally verify the blocker's branch has been merged into the feature branch:
    ```bash
    git merge-base --is-ancestor origin/{BLOCKER_BRANCH} origin/{FEATURE_BRANCH}
    ```
    If this check fails (exit code non-zero), the blocker is NOT considered finished — do not start work. Display: "Blocked: {BLOCKER_KEY} not yet merged into {FEATURE_BRANCH}" and **stop**.
  - If a blocker exists and is finished (including merge gate) AND `FEATURE_BRANCH` is set: `BASE_BRANCH` = `FEATURE_BRANCH` (blocker's changes are already in the feature branch)
  - If a blocker exists and is finished (including merge gate) AND no feature branch: `BASE_BRANCH` = blocker's ticket key
  - Otherwise if `FEATURE_BRANCH` is set: `BASE_BRANCH` = `FEATURE_BRANCH`
  - Otherwise: `BASE_BRANCH` = `main`
- Determine `PR_TARGET`:
  - If `FEATURE_BRANCH` is set: `PR_TARGET` = `FEATURE_BRANCH`
  - Otherwise: `PR_TARGET` = `BASE_BRANCH`

## S2: Ensure Working Directory Ready

### S2a: Serial Mode (`SERIAL_MODE = true`)

Fetch and checkout the branch in the main repo:

```bash
cd {REPO_ROOT} && git fetch origin
```

Check if branch already exists:
```bash
git branch --list '{BRANCH_NAME}'
```

- **If branch exists**: checkout it:
  ```bash
  cd {REPO_ROOT} && git checkout {BRANCH_NAME}
  ```
- **If branch does not exist**: create and checkout:
  - If `BASE_BRANCH` is `main`:
    ```bash
    cd {REPO_ROOT} && git checkout -b {BRANCH_NAME} origin/main
    ```
  - If `BASE_BRANCH` is another ticket:
    ```bash
    cd {REPO_ROOT} && git checkout -b {BRANCH_NAME} origin/{BASE_BRANCH}
    ```

After this step, all subsequent work happens in `REPO_ROOT` on the checked-out branch:
```bash
cd {REPO_ROOT}
```

Set `WORK_DIR` = `{REPO_ROOT}`
Set `PLANS_DIR` = `{REPO_ROOT}/.claude/plans`

### S2b: Worktree Mode (not `SERIAL_MODE`)

Check if `WORK_DIR` already exists:

```bash
ls -d {WORK_DIR} 2>/dev/null
```

- **If it exists**: verify it's a valid git worktree. `cd` into it and run `git rev-parse --git-dir`.
- **If it does not exist**: create it from `REPO_ROOT`:
  ```bash
  cd {REPO_ROOT} && git fetch origin
  ```
  Then:
  - If `BASE_BRANCH` is `main`:
    ```bash
    cd {REPO_ROOT} && git worktree add -b {BRANCH_NAME} {WORK_DIR}
    ```
  - If `BASE_BRANCH` is another ticket:
    ```bash
    cd {REPO_ROOT} && git worktree add -b {BRANCH_NAME} {WORK_DIR} origin/{BASE_BRANCH}
    ```
  - If the branch already exists but the worktree doesn't:
    ```bash
    cd {REPO_ROOT} && git worktree add {WORK_DIR} {BRANCH_NAME}
    ```

After this step, all subsequent work happens inside `WORK_DIR`:
```bash
cd {WORK_DIR}
```

Set `PLANS_DIR` = `{WORK_DIR}/.claude/plans`

## S3: Load or Create Checklist

The checklist file lives at `{WORK_DIR}/.claude/plans/ticket-work-{TICKET_KEY}.md`.

Check if the file already exists:
- **If it exists**: read it and parse the checklist state (`[x]` vs `[ ]`). Resume from the first unchecked step.
- **If it does not exist**: create it, seeding from current Jira + artifact state (see below).

### S3a: Create the plans directory

```bash
mkdir -p {WORK_DIR}/.claude/plans
```

### S3b: Seed checklist from current state

When creating a **new** checklist (file didn't exist), infer which steps are already done. This ensures compatibility when a previous run already progressed the ticket.

Use the Jira labels (from S1c) and artifact checks to determine initial state:

| Check | Condition | Steps to mark `[x]` |
|-------|-----------|---------------------|
| Plan exists | File `{PLANS_DIR}/jira-{TICKET_KEY}.md` exists and has content | Step 1 |
| Plan approved | Jira label `ClaudePlanApproved` is present, OR label `ClaudeExecuting` / `ClaudeStackReady` / `ClaudePRApproved` / `ClaudeNeedsReview` is present (implies approval already happened) | Steps 1, 2 |
| Plan executed | Jira label `ClaudeStackReady` / `ClaudePRApproved` / `ClaudeNeedsReview` is present, OR label `ClaudeExecuting` is present AND all plan tasks are marked complete in the plan file | Steps 1, 2, 3, 4, 5 |
| PR review plan exists | A PR review plan file exists in `{WORK_DIR}/.claude/plans/` matching `pr-review-*.md` or `pr-{TICKET_KEY}*.md` | Steps 1-6 |
| Stack ready | Jira label `ClaudeStackReady` or `ClaudePRApproved` or `ClaudeNeedsReview` is present | Steps 1-8 |
| PR approved | Jira label `ClaudePRApproved` or `ClaudeNeedsReview` is present | Steps 1-9 |
| PR exists | `gh pr view {BRANCH_NAME} --json number 2>/dev/null` succeeds | Steps 1-11 |

Apply in reverse order (check the most-advanced state first) so you mark the correct set. Steps 12 and 13 are never pre-seeded — they always run fresh if unchecked.

### S3c: Write the checklist file

Write the file using the seeded state:

```markdown
---
ticket: {TICKET_KEY}
branch: {BRANCH_NAME}
summary: {SUMMARY}
base_branch: {BASE_BRANCH}
feature_branch: {FEATURE_BRANCH}
pr_target: {PR_TARGET}
work_dir: {WORK_DIR}
serial: {SERIAL_MODE}
created: {ISO_TIMESTAMP}
---

# {TICKET_KEY} - Work Checklist

- [{STEP1}] 1. Plan generated with /jira-start
- [{STEP2}] 2. Plan approved
- [{STEP3}] 3. Plan executed with /plan-execute
- [{STEP4}] 4. Acceptance criteria verified against Gherkin
- [{STEP5}] 5. Refactoring pass with @refactor agent
- [{STEP6}] 6. PR review plan generated with /pr-review
- [{STEP7}] 7. PR review plan executed with /pr-execute-plan
- [{STEP8}] 8. Stack ready (unblocks downstream) — TERMINAL STATE
- [{STEP9}] 9. PR approved
- [{STEP10}] 10. PR description and title generated with /jay-pr-description
- [{STEP11}] 11. PR pushed as draft
- [ ] 12. Copilot review comments resolved
- [ ] 13. PR review summary posted
```

Where each `{STEPN}` is `x` if seeded as done, or a space if not.

## S4: Execute Checklist

Work through each unchecked step in order. After completing each step, immediately update the checklist file by changing `- [ ]` to `- [x]` for that step. This ensures idempotency if the process is interrupted.

After updating the checklist file, sync the checklist to Jira:
```bash
sync-checklist {TICKET_KEY} {WORK_DIR}
```
This posts/updates a single managed comment on the Jira ticket showing current checklist progress.

---

### Step S4.1: Plan generated with /jira-start

**Skip if**: step 1 is already checked `[x]`.

Check if a plan file already exists at `{PLANS_DIR}/jira-{TICKET_KEY}.md`. If it does and has content, skip running jira-start and just mark this step complete.

Otherwise:
1. Add `ClaudePlanning` label:
   - Use `mcp__atlassian__editJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
   - `update`: `{"labels": [{"add": "ClaudePlanning"}]}`
2. Use the Skill tool to run skill `jira-start` with args `{TICKET_KEY} --base {BASE_BRANCH}`
3. Verify the plan file was created at `{PLANS_DIR}/jira-{TICKET_KEY}.md`
4. Update Jira labels:
   - `update`: `{"labels": [{"remove": "ClaudePlanning"}, {"add": "ClaudePlanNeedsApproval"}]}`
5. Post a Jira comment with a summary of the plan (approach overview, key implementation steps, and if stacked: "Stacked on {BASE_BRANCH}"). Footer: "Awaiting approval. Add label `ClaudePlanApproved` to proceed."
   - Use `mcp__atlassian__addCommentToJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
6. Sync the plan to Jira as a managed comment:
   ```bash
   sync-plan {TICKET_KEY} {WORK_DIR}
   ```
7. Mark step 1 as `[x]` in the checklist file

---

### Step S4.2: Plan approved

**Skip if**: step 2 is already checked `[x]`.

Check the ticket's current labels:
- If `ClaudePlanApproved` is present: mark step 2 as `[x]` and continue.
- If `ClaudePlanNeedsApproval` is present (or no approval label):
  - Display the plan file content (or a summary) so the user can review it
  - Tell the user:
    ```
    Plan is ready for review.

    To approve: add the `ClaudePlanApproved` label in Jira, then re-run `/ticket-work {TICKET_KEY}`.

    Or type "approve" to approve now and continue.
    ```
  - If the user types "approve" or similar affirmative:
    - Use `mcp__atlassian__editJiraIssue` to add `ClaudePlanApproved` and remove `ClaudePlanNeedsApproval`
    - Mark step 2 as `[x]`
  - Otherwise: **stop here**. The command will resume from this step on next run.

---

### Step S4.3: Plan executed with TDD (Red-Green-Refactor)

**Skip if**: step 3 is already checked `[x]`.

Execution follows test-driven development: for each plan task, write a failing test derived from the Gherkin acceptance criteria first (Red), then implement to make it pass (Green), then refactor. Tests are written in the project's native test framework.

1. Update Jira labels:
   - Remove all other `Claude*` workflow labels (except `ClaudeWork`)
   - Add `ClaudeExecuting`
   - `update`: `{"labels": [{"remove": "ClaudePlanApproved"}, {"remove": "ClaudePlanNeedsApproval"}, {"add": "ClaudeExecuting"}]}`
2. Post a Jira comment: "Starting TDD execution."
   - Use `mcp__atlassian__addCommentToJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`

3. **Extract Gherkin scenarios**: Fetch the ticket description using `mcp__atlassian__getJiraIssue`. Extract all Gherkin scenarios (`Given`/`When`/`Then` blocks or fenced `gherkin`/`feature` blocks). These drive the tests.

4. **Detect test framework**: Inspect the project to determine the native test framework:
   - Look for existing test files, `package.json` (jest/vitest/mocha), `pytest.ini`, `go.test`, etc.
   - Identify test file naming conventions (e.g., `*.test.ts`, `*_test.go`, `test_*.py`)
   - Identify test directory structure (e.g., `__tests__/`, `tests/`, colocated)

5. **Read the plan file** at `{PLANS_DIR}/jira-{TICKET_KEY}.md`. Parse the task list.

6. **For each plan task, execute the Red-Green-Refactor cycle:**

   #### 6a: Red — Write Failing Test

   Before implementing the task, write a test that:
   - Maps to the relevant Gherkin scenario steps this task covers
   - Uses the project's native test framework and conventions
   - Describes behavior in terms of the Gherkin `Given`/`When`/`Then` (use scenario names and step descriptions as test names)
   - Exercises the expected behavior that does NOT yet exist

   Test naming convention: `{Scenario Name} - {Given/When/Then step being tested}` or the project's existing naming pattern if one exists.

   Run the test suite to confirm the new test **fails**:
   ```bash
   {TEST_COMMAND} {TEST_FILE}
   ```
   - If the test passes unexpectedly: the behavior already exists. Note this, skip to the next task.
   - If the test fails with the expected reason (not found, not implemented, assertion failure): proceed to Green.
   - If the test fails for an unexpected reason (syntax error, import error): fix the test and re-run.

   Stage and commit the failing test:
   ```bash
   git add {TEST_FILE} && git commit -m "Red: {task title} - failing test for {scenario step}"
   ```

   #### 6b: Green — Implement to Pass

   Implement the minimum code to make the failing test pass. This is where the plan task's actual implementation happens.

   After implementing, run the test:
   ```bash
   {TEST_COMMAND} {TEST_FILE}
   ```
   - If the test passes: proceed to Refactor.
   - If the test still fails: continue implementing until it passes. Do not move on with a red test.

   Also run the full test suite to check for regressions:
   ```bash
   {TEST_COMMAND}
   ```
   - If other tests break: fix the regressions before proceeding.

   Stage and commit:
   ```bash
   git add -A && git commit -m "Green: {task title} - implementation passes"
   ```

   #### 6c: Refactor (optional)

   If the implementation can be improved without changing behavior:
   - Clean up duplication, improve naming, extract helpers
   - Run the full test suite after refactoring to confirm nothing breaks
   - If changes were made, commit:
     ```bash
     git add -A && git commit -m "Refactor: {task title}"
     ```

   #### 6d: Mark task complete in plan file

   Update the plan file to mark this task as `[x]`, then sync the plan to Jira:
   ```bash
   sync-plan {TICKET_KEY} {WORK_DIR}
   ```

7. After all tasks are processed:
   - Run the full test suite one final time to confirm everything passes
   - Run `git status` — if there are uncommitted changes, stage and commit
8. Re-read the plan file to verify tasks are complete
9. Post a Jira comment summarizing execution results:
   "TDD execution finished.\n\nTasks:\n- [x] Task 1 title (N tests)\n- [x] Task 2 title (N tests)\n- [ ] Task 3 title (incomplete)\n\nCompleted N/M tasks. Total tests written: T."
   - Use `mcp__atlassian__addCommentToJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
10. If all tasks complete:
    - Mark step 3 as `[x]` (keep `ClaudeExecuting` label — it will be replaced by `ClaudeStackReady` in step 8)
11. If tasks are incomplete:
    - Update Jira labels: `{"labels": [{"remove": "ClaudeExecuting"}, {"add": "ClaudeFailed"}]}`
    - **Stop here** (user must investigate)

---

### Step S4.4: Acceptance criteria verified (TDD final check)

**Skip if**: step 4 is already checked `[x]`.

TDD execution (S4.3) should have produced tests for every Gherkin scenario. This step confirms full coverage — no scenarios were missed and all tests pass.

1. Fetch the ticket description using `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
2. Extract all Gherkin scenarios from the description (look for `Given`/`When`/`Then` blocks, or fenced code blocks tagged `gherkin` or `feature`)
   - If the ticket has no Gherkin scenarios: mark step 4 as `[x]` and continue (nothing to verify)
3. Run the full test suite and confirm it passes:
   ```bash
   {TEST_COMMAND}
   ```
   - If tests fail: fix the failures, commit, and re-run until green.
4. For each Gherkin scenario, verify a corresponding test exists:
   - Search test files modified on this branch (`git diff {BASE_BRANCH}...HEAD --name-only | grep -E '(test|spec)'`)
   - Match scenario names/steps to test descriptions
   - Build a coverage map:
     ```
     ## Gherkin → Test Coverage

     ### Scenario: {scenario name}
     - [x] Given {step} → {test file}:{test name}
     - [x] When {step} → {test file}:{test name}
     - [x] Then {step} → {test file}:{test name}

     {N}/{M} scenarios fully covered by tests.
     ```
5. If ALL scenarios have corresponding tests and all tests pass:
   - Mark step 4 as `[x]`
   - Post a Jira comment: "TDD verification passed. All {N} Gherkin scenarios are covered by tests. Full suite green."
     - Use `mcp__atlassian__addCommentToJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
6. If a scenario has no corresponding test (was missed during TDD):
   - Write the missing test (Red), implement if needed (Green), commit
   - Re-verify until all scenarios are covered
   - If gaps remain after the fix attempt:
     - Update Jira labels: `{"labels": [{"remove": "ClaudeExecuting"}, {"add": "ClaudeFailed"}]}`
     - Post a Jira comment with the coverage map showing uncovered scenarios
     - **Stop here** (user must investigate)

---

### Step S4.5: Refactoring pass with @refactor agent

**Skip if**: step 5 is already checked `[x]`.

After TDD execution and acceptance verification, run a targeted refactoring pass on the code changed by this ticket. The refactor agent identifies CRAP score hotspots, DRY violations, and structural smells — then implements approved fixes.

1. Make sure we are in the working directory: `cd {WORK_DIR}`
2. Get the list of files changed on this branch:
   ```bash
   git diff {BASE_BRANCH}...HEAD --name-only --diff-filter=ACMR
   ```
3. Launch the refactor agent targeting only the changed files:
   - Use the Agent tool with `subagent_type: "refactor"`
   - Prompt: "Analyze the following files for CRAP score, DRY violations, and refactoring opportunities. These were changed as part of ticket {TICKET_KEY}. Only flag issues introduced or worsened by this branch's changes — don't report pre-existing issues in unchanged code. Implement any refactorings that are clearly beneficial (reduce complexity, eliminate duplication) without changing behavior. Skip anything marginal or subjective. Files: {FILE_LIST}"
4. After the refactor agent completes:
   - Run the full test suite to confirm nothing broke:
     ```bash
     {TEST_COMMAND}
     ```
   - If tests fail: revert the refactoring commits (`git revert --no-commit HEAD~N..HEAD` where N = number of refactor commits), commit, and note in Jira that refactoring was skipped due to test failures.
   - If tests pass: proceed.
5. Mark step 5 as `[x]`

---

### Step S4.6: PR review plan generated with /pr-review

**Skip if**: step 6 is already checked `[x]`.

1. Make sure we are in the working directory: `cd {WORK_DIR}`
2. Use the Skill tool to run skill `pr-review`
3. Mark step 6 as `[x]`

---

### Step S4.7: PR review plan executed with /pr-execute-plan

**Skip if**: step 7 is already checked `[x]`.

1. Make sure we are in the working directory: `cd {WORK_DIR}`
2. Use the Skill tool to run skill `pr-execute-plan`
3. After execution: stage and commit any changes if present
4. Mark step 7 as `[x]`

---

### Step S4.8: Stack ready

**Skip if**: step 8 is already checked `[x]`.

This step marks the ticket as stack-ready, which unblocks downstream tickets without requiring a PR to be opened.

1. Update Jira labels:
   - `update`: `{"labels": [{"remove": "ClaudeExecuting"}, {"add": "ClaudeStackReady"}]}`
2. Post a Jira comment: "Code review complete. Stack unblocked — downstream tickets may begin."
   - Use `mcp__atlassian__addCommentToJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
3. Mark step 8 as `[x]`

**If `FEATURE_BRANCH` is set**: verify all review issues are resolved, then merge into the local feature branch.

   1. **Verify review is clean**: Read the PR review plan file from `{WORK_DIR}/.claude/plans/` (matching `pr-review-*.md` or `pr-{TICKET_KEY}*.md`). Parse all items in the plan:
      - If any issues are marked unresolved or incomplete: set `ClaudeFailed` label, post a Jira comment listing the unresolved issues, and **stop**.
      - Display: "Review has unresolved issues. Fix them and re-run `/ticket-work {TICKET_KEY}`."
      - Only proceed if ALL issues identified by the review have been resolved.
   2. Ensure feature branch is up to date:
      ```bash
      cd {WORK_DIR} && git fetch origin && git checkout {FEATURE_BRANCH} && git pull origin {FEATURE_BRANCH}
      ```
   3. Merge the ticket branch:
      ```bash
      git merge {BRANCH_NAME} --no-ff -m "Merge {TICKET_KEY}: {SUMMARY}"
      ```
   4. If merge conflicts occur:
      - Attempt automatic resolution for trivial conflicts
      - If unresolvable: abort the merge (`git merge --abort`), set `ClaudeFailed` label, and **stop**
      - Display: "Merge conflict merging {BRANCH_NAME} into {FEATURE_BRANCH}. Investigate and re-run."
   5. Push the updated feature branch:
      ```bash
      git push origin {FEATURE_BRANCH}
      ```
   6. Return to the ticket's working directory:
      - If `SERIAL_MODE`: `git checkout {BRANCH_NAME}`
      - If worktree mode: `cd {WORK_DIR}`
   7. Mark steps 9-13 as `[x]` (not applicable for feature branch workflow)
   8. Post a Jira comment: "Merged into feature branch `{FEATURE_BRANCH}`."
      - Use `mcp__atlassian__addCommentToJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
   9. Update Jira labels:
      - `update`: `{"labels": [{"remove": "ClaudeStackReady"}, {"add": "ClaudeNeedsReview"}]}`
   10. Display:
       ```
       Ticket {TICKET_KEY} - Merged to Feature Branch

       Branch: {BRANCH_NAME} → {FEATURE_BRANCH}
       All review issues resolved. Merged locally and pushed.
       ```
   11. Proceed to S6 (promote downstream), then stop.

**If `FEATURE_BRANCH` is null (standard workflow)**: terminal state. Display:
   ```
   Ticket {TICKET_KEY} - Stack Ready (terminal)

   Branch: {BRANCH_NAME}
   Code review complete. Downstream tickets are unblocked.
   To open the PR later: add `ClaudePRApproved` in Jira, then re-run `/ticket-work {TICKET_KEY}`.
   ```
   Proceed to S6 (promote downstream), then stop.

---

### Step S4.9: PR approved

**Skip if**: step 9 is already checked `[x]`.

Check the ticket's current labels:
- If `ClaudePRApproved` is present: mark step 9 as `[x]` and continue.
- If `ClaudeStackReady` is present (or no PR approval label):
  - Tell the user:
    ```
    Awaiting PR approval.

    To approve: add the `ClaudePRApproved` label in Jira, then re-run `/ticket-work {TICKET_KEY}`.

    Or type "approve pr" to approve now and continue.
    ```
  - If the user types "approve pr" or similar affirmative:
    - Use `mcp__atlassian__editJiraIssue` to add `ClaudePRApproved` and remove `ClaudeStackReady`
    - Mark step 9 as `[x]`
  - Otherwise: **stop here**. The command will resume from this step on next run.

---

### Step S4.10: PR description and title generated with /jay-pr-description

**Skip if**: step 10 is already checked `[x]`.

1. Make sure we are in the working directory: `cd {WORK_DIR}`
2. Use the Skill tool to run skill `jay-pr-description`
3. Mark step 10 as `[x]`

---

### Step S4.11: PR pushed as draft

**Skip if**: step 11 is already checked `[x]`.

1. Check if a PR already exists for this branch:
   ```bash
   gh pr view {BRANCH_NAME} --json number,url 2>/dev/null
   ```
2. If no PR exists:
   a. Push the branch:
      ```bash
      cd {WORK_DIR} && git push -u origin {BRANCH_NAME}
      ```
   b. Read the generated PR description file (from step S4.10 output or `./pr.md` if it exists)
   c. Create a draft PR targeting `{PR_TARGET}`:
      ```bash
      gh pr create --draft --base {PR_TARGET} --title "{PR_TITLE}" --body "{PR_BODY}"
      ```
      Use the title and body from the pr-description output.
3. If a PR already exists: just ensure the latest is pushed:
   ```bash
   cd {WORK_DIR} && git push
   ```
4. Update Jira labels:
   - `update`: `{"labels": [{"remove": "ClaudePRApproved"}, {"add": "ClaudeNeedsReview"}]}`
5. Mark step 11 as `[x]`

---

### Step S4.12: Copilot review comments resolved

**Skip if**: step 12 is already checked `[x]`.

After pushing the PR, Copilot may leave review comments. This step runs a single automated pass to address and resolve them.

1. Make sure we are in the working directory: `cd {WORK_DIR}`
2. Use the Skill tool to run skill `pr-watch` with args `--rounds 1 --auto --interval 30`
3. If pr-watch made changes and pushed, update `HEAD_SHA`
4. Mark step 12 as `[x]`

---

### Step S4.13: Post PR review summary comment

**Skip if**: step 13 is already checked `[x]`.

1. Read the PR review plan file from `{WORK_DIR}/.claude/plans/` (matching `pr-review-*.md` or `pr-{TICKET_KEY}*.md`)
2. Build a summary comment in the following format:
   ```
   ## Claude Code Review Summary

   ### Issues Found
   - **{issue title}**: {brief description} — **{resolved|open}**
   ...

   ### Resolutions
   - {issue}: {what was changed to fix it}
   ...

   N issues found, M resolved.
   ```
3. Post the comment to the PR:
   ```bash
   gh pr comment {BRANCH_NAME} --body "{REVIEW_SUMMARY}"
   ```
4. Mark step 13 as `[x]`

---

## S5: Final Summary

Display:

```
Ticket {TICKET_KEY} - Complete

Directory: {WORK_DIR}
Branch: {BRANCH_NAME} (base: {BASE_BRANCH})
Feature branch: {FEATURE_BRANCH or "none"}
Mode: {serial | worktree}
PR: {PR_URL}

All steps completed. PR is ready for human review.
```

## S6: Continue to Next Ticket in Stack

After reaching stack-ready (step 8) or completing all steps, check if there are downstream tickets in the same stack that are now unblocked and eligible for work.

### S6a: Find Downstream Tickets

1. Use `mcp__atlassian__getJiraIssue` to get the completed ticket's outward "blocks" links
2. Determine the **stack container** (subtask → parent Story key, otherwise → Epic key)
3. Filter to blocked tickets that share the same stack container

### S6b: Check Eligibility

For each downstream ticket in the same stack:

1. Use `mcp__atlassian__getJiraIssue` to fetch the blocked ticket
2. Verify it is assigned to the current user — if not, skip it
3. Check ALL of its same-stack "is blocked by" dependencies are "finished" (status category "done" OR has `ClaudeStackReady` label OR has `ClaudeNeedsReview` label)
4. **Feature branch merge gate**: If `FEATURE_BRANCH` is set, additionally verify each finished blocker's branch has been merged into the feature branch:
   ```bash
   git merge-base --is-ancestor origin/{BLOCKER_BRANCH} origin/{FEATURE_BRANCH}
   ```
   If this check fails for any blocker, that dependency is NOT considered met — skip the downstream ticket.
5. Skip tickets that already have any of: `ClaudePlanning`, `ClaudePlanApproved`, `ClaudeExecuting`, `ClaudeStackReady`, `ClaudePRApproved`, `ClaudeNeedsReview`, `ClaudeFailed`

### S6c: Promote and Run Next Ticket

If exactly **one** eligible downstream ticket is found:

1. Add `ClaudeReady` label if not already present:
   - Use `mcp__atlassian__editJiraIssue` with `update`: `{"labels": [{"add": "ClaudeReady"}]}`
2. Inherit labels/assignee from parent (same logic as Q2e) if it's a subtask
3. Display: "Moving to next ticket in stack: {NEXT_KEY} - {NEXT_SUMMARY} (base: {TICKET_KEY})"
4. Run the **Single Ticket Lifecycle** (S1 onward) for `{NEXT_KEY}`, which will use the just-completed ticket's branch as its base

If **multiple** eligible downstream tickets are found:

1. Promote all of them (add `ClaudeReady` label, inherit from parent)
2. Run the **Queue Pipeline** (Q3 onward) with these tickets

If **no** eligible downstream tickets are found:

1. Check for stack completion (same logic as Q7c)
2. Display: "No more eligible tickets in this stack."

## Error Handling

- If any step fails, the checklist preserves progress. Re-running the command will resume from the failed step.
- Worktree already exists: reuse it (don't recreate).
- Branch already exists: check it out in the worktree.
- PR already exists: push updates to it rather than creating a new one.
- Plan file already exists: skip /jira-start (don't overwrite existing plan).
- On failure at step S4.3 (execution): Jira label is set to `ClaudeFailed`. User must investigate, fix, remove `ClaudeFailed` label, then re-run.
- In queue mode: never stop due to a single ticket failure. Each agent handles its own error state.
