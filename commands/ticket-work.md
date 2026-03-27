---
description: "Run Jira tickets end-to-end: plan, execute, PR, review, push. With args: single ticket. Without args: discover and process queue."
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
  - Read
  - Write
  - Skill
  - Agent
---

# Ticket Work

Run Jira tickets through the full lifecycle: plan → execute → PR → review → push.
Idempotent — reads checklist state and resumes from wherever it left off.

- **With arguments**: Run a single ticket (or expand a Story to its subtasks and run them in parallel).
- **Without arguments**: Discover all eligible tickets from Jira and process them (queue mode).

## Label Reference

- **ClaudeWork**: durable tag marking ticket for Claude (user-applied, never removed)
- **ClaudeReady**: ticket is ready for planning (user-applied or added by promote step)
- **ClaudePlanning**: /jira-start running
- **ClaudePlanNeedsApproval**: plan ready, user: review plan and apply ClaudePlanApproved
- **ClaudePlanApproved**: user approved plan, eligible for execution (user-applied)
- **ClaudeExecuting**: /plan-execute running
- **ClaudeNeedsReview**: implementation done, user: review PR and move ticket to Done
- **ClaudeFailed**: execution failed, user: investigate
- **ClaudeStackComplete**: all tickets in an Epic/Story stack finished (added to stack container)

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
ClaudeNeedsReview           -> done, user: review PR and move ticket to Done
ClaudeFailed                -> error, user: investigate
ClaudeStackComplete         -> all tickets in stack finished (added to stack container)
```

## Arguments

$ARGUMENTS

Optional: space-separated Jira ticket keys (e.g., `PROJ-123 PROJ-456`). If a key is a parent Story/Task with subtasks, it expands to the eligible subtasks underneath it. If no arguments are provided, runs in queue mode — discovers all eligible tickets and processes them.

---

# Mode A: Single Ticket (arguments provided)

## A1: Resolve Tickets

Use `mcp__atlassian__getAccessibleAtlassianResources` to get `CLOUD_ID`.

For each key in `$ARGUMENTS`, use `mcp__atlassian__getJiraIssue` to fetch it. If it is a **parent with subtasks** (issue type is Story/Task and has subtasks), expand to its subtasks via JQL: `parent = {PARENT_KEY}`. Apply exclusion filter (skip subtasks that already have `ClaudePlanning`, `ClaudePlanApproved`, `ClaudeExecuting`, `ClaudeNeedsReview`, or `ClaudeFailed`). If not a parent, use the ticket directly.

### Inherit from Parent (subtasks only)

For each subtask discovered via a parent, sync the parent's labels and assignment onto the subtask. Use `mcp__atlassian__editJiraIssue`:

- **Labels**: Copy all parent labels the subtask doesn't already have (e.g., `ClaudeWork`, `repo:*`, `ClaudeReady`). Skip `ClaudeStackComplete`.
- **Assignee**: If the subtask is unassigned but the parent is assigned, assign the subtask to the same user.

### Single ticket — run directly

If only **one** work item results (single ticket, or a Story with one subtask), proceed to **Single Ticket Lifecycle** below.

### Multiple tickets — parallel agents

If **multiple** work items result, run the **Queue Pipeline** (Step Q3 onward) using these tickets instead of JQL discovery.

---

# Mode B: Queue Mode (no arguments)

Run the full queue pipeline: discover → gate → worktree → execute → promote.

Proceed to **Queue Pipeline** below.

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

For each parent, fetch subtasks: `parent = {PARENT_KEY}`. Include subtasks that do NOT already have any of: `ClaudePlanning`, `ClaudePlanNeedsApproval`, `ClaudePlanApproved`, `ClaudeExecuting`, `ClaudeNeedsReview`, `ClaudeFailed`.

### Q2c: Tickets ready for execution

```
labels IN ("ClaudePlanApproved", "ClaudeExecuting") AND labels NOT IN ("ClaudeNeedsReview", "ClaudeFailed") AND assignee = currentUser()
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
   - A blocker is "finished" if its Jira status category is "done" (statusCategory.key == "done")
   - If ANY same-stack blocker is NOT finished: **skip this ticket**
   - Display: "Skipping {KEY}: waiting on {BLOCKER_KEY} to finish"
4. Determine base branch:
   - Same-stack blocker exists that is finished: base = blocker's ticket key
   - No same-stack blocker: base = `main`

## Q5: Prepare Worktrees (Sequential)

Fetch once per repo, then create worktrees sequentially (shared git state requires this):

1. For each unique `REPO_ROOT`, fetch latest:
   ```bash
   cd {REPO_ROOT} && git fetch origin
   ```

2. For each eligible ticket:
   a. Display: "Preparing worktree for {KEY}: {SUMMARY} (base: {BASE_BRANCH})"

   b. Create worktree (from within `{REPO_ROOT}`):
      - If base is `main`:
        ```bash
        cd {REPO_ROOT} && git worktree add -b {KEY} {REPO_ROOT}/../{KEY}
        ```
      - If base is another ticket:
        ```bash
        cd {REPO_ROOT} && git worktree add -b {KEY} {REPO_ROOT}/../{KEY} origin/{BASE_BRANCH}
        ```
      - If branch/worktree already exists, verify and skip creation

## Q6: Launch Ticket Agents (Parallel)

All eligible tickets are independent (gating ensures no two same-stack tickets are eligible simultaneously). Launch ALL as **parallel Agent tool calls in a single message**.

For each eligible ticket, launch an Agent with:
- `description`: "Work {KEY}"
- `prompt`: Use the template below, substituting all variables.

**Agent Prompt Template:**

```
Run the ticket lifecycle for Jira ticket {KEY} - {SUMMARY}.

cd {REPO_ROOT}/../{KEY}

Use the Skill tool to run skill "ticket-work" with args "{KEY}"

ticket-work is idempotent — it will resume from the current checklist state
and run through to the next gate (approval) or completion.
```

Wait for all agents to complete before proceeding.

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
   - Check if ALL of its same-stack "is blocked by" dependencies are "finished"
   - If all dependencies met AND blocked ticket does NOT already have any of: `ClaudePlanning`, `ClaudePlanNeedsApproval`, `ClaudePlanApproved`, `ClaudeExecuting`, `ClaudeNeedsReview`, `ClaudeFailed`:
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

## Q8: Summary

Display combined results:

```
Queue Processing Complete

Worked ({N}):
  - {KEY}: {SUMMARY} (base: {BASE}, worktree: ../{KEY})

Promoted ({N}):
  - {BLOCKED_KEY}: unblocked by {KEY}

Stacks Completed:
  - {CONTAINER_TYPE} {CONTAINER_KEY}: all {N} tickets finished

Skipped (dependency not ready):
  - {KEY}: waiting on {BLOCKER_KEY}

Awaiting Approval:
  - {KEY}: plan ready, add ClaudePlanApproved to proceed
```

---

# Single Ticket Lifecycle

Runs one ticket through all steps. Used directly (Mode A, single ticket) or via agent delegation from the Queue Pipeline.

## S1: Detect Environment

### S1a: Determine Current Worktree

Run:
```bash
git rev-parse --show-toplevel
```

Store as `CURRENT_ROOT`. Then determine if we are already in the correct worktree:

- Extract the basename of `CURRENT_ROOT` (e.g., `/path/to/repos/PROJ-123` → `PROJ-123`)
- If the basename **matches the ticket key**: we are already in the ticket's worktree.
  - Set `WORKTREE_DIR` = `CURRENT_ROOT`
  - Set `REPO_ROOT` = parent's git main worktree. Detect with:
    ```bash
    git worktree list --porcelain
    ```
    The first entry (marked `bare` or without `branch`) is the main worktree. Store its path as `REPO_ROOT`.
    If `CURRENT_ROOT` IS the main worktree (not a linked worktree), then `REPO_ROOT` = `CURRENT_ROOT` and we still need to create the ticket worktree (proceed to S2).
- If the basename **does not match**: we are in the main repo (or a different worktree).
  - Set `REPO_ROOT` = `CURRENT_ROOT`
  - Set `WORKTREE_DIR` = `{REPO_ROOT}/../{TICKET_KEY}`

### S1b: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### S1c: Fetch Ticket Data

- Use `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
- Store: summary, status, labels, issue links, epic/parent key
- Determine the **stack container**:
  - If the ticket is a **subtask** (has a `parent` field that is a Story/Task, not an Epic): the stack container is the parent Story key. Stack siblings are other subtasks of that parent.
  - Otherwise: the stack container is the ticket's Epic key. Stack siblings are other tickets linked to the same Epic.
- Determine `BASE_BRANCH`:
  - Check same-stack "is blocked by" links
  - If a blocker exists and its status category is "done": `BASE_BRANCH` = blocker's ticket key
  - Otherwise: `BASE_BRANCH` = `main`

## S2: Ensure Worktree Exists

Check if `WORKTREE_DIR` already exists:

```bash
ls -d {WORKTREE_DIR} 2>/dev/null
```

- **If it exists**: verify it's a valid git worktree. `cd` into it and run `git rev-parse --git-dir`.
- **If it does not exist**: create it from `REPO_ROOT`:
  ```bash
  cd {REPO_ROOT} && git fetch origin
  ```
  Then:
  - If `BASE_BRANCH` is `main`:
    ```bash
    cd {REPO_ROOT} && git worktree add -b {TICKET_KEY} {WORKTREE_DIR}
    ```
  - If `BASE_BRANCH` is another ticket:
    ```bash
    cd {REPO_ROOT} && git worktree add -b {TICKET_KEY} {WORKTREE_DIR} origin/{BASE_BRANCH}
    ```
  - If the branch already exists but the worktree doesn't:
    ```bash
    cd {REPO_ROOT} && git worktree add {WORKTREE_DIR} {TICKET_KEY}
    ```

After this step, all subsequent work happens inside `WORKTREE_DIR`:
```bash
cd {WORKTREE_DIR}
```

Set `PLANS_DIR` = `{WORKTREE_DIR}/.claude/plans`

## S3: Load or Create Checklist

The checklist file lives at `{WORKTREE_DIR}/.claude/plans/ticket-work-{TICKET_KEY}.md`.

Check if the file already exists:
- **If it exists**: read it and parse the checklist state (`[x]` vs `[ ]`). Resume from the first unchecked step.
- **If it does not exist**: create it, seeding from current Jira + artifact state (see below).

### S3a: Create the plans directory

```bash
mkdir -p {WORKTREE_DIR}/.claude/plans
```

### S3b: Seed checklist from current state

When creating a **new** checklist (file didn't exist), infer which steps are already done. This ensures compatibility when a previous run already progressed the ticket.

Use the Jira labels (from S1c) and artifact checks to determine initial state:

| Check | Condition | Steps to mark `[x]` |
|-------|-----------|---------------------|
| Plan exists | File `{PLANS_DIR}/jira-{TICKET_KEY}.md` exists and has content | Step 1 |
| Plan approved | Jira label `ClaudePlanApproved` is present, OR label `ClaudeExecuting` / `ClaudeNeedsReview` is present (implies approval already happened) | Steps 1, 2 |
| Plan executed | Jira label `ClaudeNeedsReview` is present, OR label `ClaudeExecuting` is present AND all plan tasks are marked complete in the plan file | Steps 1, 2, 3 |
| PR exists | `gh pr view {TICKET_KEY} --json number 2>/dev/null` succeeds | Steps 1, 2, 3, 4, 5 |
| PR review plan exists | A PR review plan file exists in `{WORKTREE_DIR}/.claude/plans/` matching `pr-review-*.md` or `pr-{TICKET_KEY}*.md` | Steps 1-6 |

Apply in reverse order (check the most-advanced state first) so you mark the correct set. Steps 7, 8, and 9 are never pre-seeded — they always run fresh if unchecked.

### S3c: Write the checklist file

Write the file using the seeded state:

```markdown
---
ticket: {TICKET_KEY}
summary: {SUMMARY}
base_branch: {BASE_BRANCH}
worktree: {WORKTREE_DIR}
created: {ISO_TIMESTAMP}
---

# {TICKET_KEY} - Work Checklist

- [{STEP1}] 1. Plan generated with /jira-start
- [{STEP2}] 2. Plan approved
- [{STEP3}] 3. Plan executed with /plan-execute
- [{STEP4}] 4. PR description and title generated with /pr-description
- [{STEP5}] 5. PR pushed as draft
- [{STEP6}] 6. PR review plan generated with /pr-review
- [ ] 7. PR review plan executed with /pr-execute-plan
- [ ] 8. Changes pushed to PR
- [ ] 9. PR review summary posted
```

Where each `{STEPN}` is `x` if seeded as done, or a space if not.

## S4: Execute Checklist

Work through each unchecked step in order. After completing each step, immediately update the checklist file by changing `- [ ]` to `- [x]` for that step. This ensures idempotency if the process is interrupted.

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
6. Mark step 1 as `[x]` in the checklist file

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

### Step S4.3: Plan executed with /plan-execute

**Skip if**: step 3 is already checked `[x]`.

1. Update Jira labels:
   - Remove all other `Claude*` workflow labels (except `ClaudeWork`)
   - Add `ClaudeExecuting`
   - `update`: `{"labels": [{"remove": "ClaudePlanApproved"}, {"remove": "ClaudePlanNeedsApproval"}, {"add": "ClaudeExecuting"}]}`
2. Post a Jira comment: "Starting plan execution."
   - Use `mcp__atlassian__addCommentToJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
3. Use the Skill tool to run skill `plan-execute` with args `jira-{TICKET_KEY}`
4. After execution completes:
   - Run `git status` in the worktree
   - If there are uncommitted changes: stage relevant files and commit
5. Re-read the plan file to verify tasks are complete
6. Post a Jira comment summarizing execution results. List each task with its completion status:
   "Plan execution finished.\n\nTasks:\n- [x] Task 1 title\n- [x] Task 2 title\n- [ ] Task 3 title (incomplete)\n\nCompleted N/M tasks."
   - Use `mcp__atlassian__addCommentToJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
7. If all tasks complete:
   - Update Jira labels: `{"labels": [{"remove": "ClaudeExecuting"}, {"add": "ClaudeNeedsReview"}]}`
   - Mark step 3 as `[x]`
8. If tasks are incomplete:
   - Update Jira labels: `{"labels": [{"remove": "ClaudeExecuting"}, {"add": "ClaudeFailed"}]}`
   - **Stop here** (user must investigate)

---

### Step S4.4: PR description and title generated with /pr-description

**Skip if**: step 4 is already checked `[x]`.

1. Make sure we are in the worktree: `cd {WORKTREE_DIR}`
2. Use the Skill tool to run skill `pr-description`
3. Mark step 4 as `[x]`

---

### Step S4.5: PR pushed as draft

**Skip if**: step 5 is already checked `[x]`.

1. Check if a PR already exists for this branch:
   ```bash
   gh pr view {TICKET_KEY} --json number,url 2>/dev/null
   ```
2. If no PR exists:
   a. Push the branch:
      ```bash
      cd {WORKTREE_DIR} && git push -u origin {TICKET_KEY}
      ```
   b. Read the generated PR description file (from step S4.4 output or `./pr.md` if it exists)
   c. Create a draft PR targeting `{BASE_BRANCH}`:
      ```bash
      gh pr create --draft --base {BASE_BRANCH} --title "{PR_TITLE}" --body "{PR_BODY}"
      ```
      Use the title and body from the pr-description output.
3. If a PR already exists: just ensure the latest is pushed:
   ```bash
   cd {WORKTREE_DIR} && git push
   ```
4. Mark step 5 as `[x]`

---

### Step S4.6: PR review plan generated with /pr-review

**Skip if**: step 6 is already checked `[x]`.

1. Make sure we are in the worktree: `cd {WORKTREE_DIR}`
2. Use the Skill tool to run skill `pr-review`
3. Mark step 6 as `[x]`

---

### Step S4.7: PR review plan executed with /pr-execute-plan

**Skip if**: step 7 is already checked `[x]`.

1. Make sure we are in the worktree: `cd {WORKTREE_DIR}`
2. Use the Skill tool to run skill `pr-execute-plan`
3. After execution: stage and commit any changes if present
4. Mark step 7 as `[x]`

---

### Step S4.8: Changes pushed to PR

**Skip if**: step 8 is already checked `[x]`.

1. Push all changes:
   ```bash
   cd {WORKTREE_DIR} && git push
   ```
2. Mark step 8 as `[x]`

---

### Step S4.9: Post PR review summary comment

**Skip if**: step 9 is already checked `[x]`.

1. Read the PR review plan file from `{WORKTREE_DIR}/.claude/plans/` (matching `pr-review-*.md` or `pr-{TICKET_KEY}*.md`)
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
   gh pr comment {TICKET_KEY} --body "{REVIEW_SUMMARY}"
   ```
4. Mark step 9 as `[x]`

## S5: Final Summary

Display:

```
Ticket {TICKET_KEY} - Complete

Worktree: {WORKTREE_DIR}
Branch: {TICKET_KEY} (base: {BASE_BRANCH})
PR: {PR_URL}

All 9 steps completed. PR is ready for human review.
```

## Error Handling

- If any step fails, the checklist preserves progress. Re-running the command will resume from the failed step.
- Worktree already exists: reuse it (don't recreate).
- Branch already exists: check it out in the worktree.
- PR already exists: push updates to it rather than creating a new one.
- Plan file already exists: skip /jira-start (don't overwrite existing plan).
- On failure at step S4.3 (execution): Jira label is set to `ClaudeFailed`. User must investigate, fix, remove `ClaudeFailed` label, then re-run.
- In queue mode: never stop due to a single ticket failure. Each agent handles its own error state.
