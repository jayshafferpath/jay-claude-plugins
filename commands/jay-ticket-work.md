---
description: "Run a single Jira ticket end-to-end: plan, execute, PR, review, push. Idempotent — resumes from where it left off."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(pwd *)
  - Bash(gh *)
  - Bash(mkdir *)
  - Read
  - Write
  - Skill
  - Agent
  - Glob
---

# Jay Ticket Work - Single Ticket Lifecycle

Run a single Jira ticket through the full lifecycle: plan → execute → PR → review → push.
Idempotent — reads the checklist file and resumes from wherever it left off.

## Arguments

$ARGUMENTS

Required: a single Jira ticket key (e.g., `PROJ-123`). Extract the ticket key from `$ARGUMENTS`. If no ticket key is provided, display an error and stop.

## Step 1: Detect Environment

### 1a: Determine Current Worktree

Run:
```bash
git rev-parse --show-toplevel
```

Store as `CURRENT_ROOT`. Then determine if we are already in the correct worktree:

- Extract the basename of `CURRENT_ROOT` (e.g., `/Users/jayshaffer/dev/employer-backend-root/PROJ-123` → `PROJ-123`)
- If the basename **matches the ticket key**: we are already in the ticket's worktree.
  - Set `WORKTREE_DIR` = `CURRENT_ROOT`
  - Set `REPO_ROOT` = parent's git main worktree. Detect with:
    ```bash
    git worktree list --porcelain
    ```
    The first entry (marked `bare` or without `branch`) is the main worktree. Store its path as `REPO_ROOT`.
    If `CURRENT_ROOT` IS the main worktree (not a linked worktree), then `REPO_ROOT` = `CURRENT_ROOT` and we still need to create the ticket worktree (proceed to Step 2).
- If the basename **does not match**: we are in the main repo (or a different worktree).
  - Set `REPO_ROOT` = `CURRENT_ROOT`
  - Set `WORKTREE_DIR` = `{REPO_ROOT}/../{TICKET_KEY}`

### 1b: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1c: Fetch Ticket Data

- Use `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
- Store: summary, status, labels, issue links, epic/parent key
- Determine `BASE_BRANCH`:
  - Check same-Epic "is blocked by" links
  - If a blocker exists and its status category is "done": `BASE_BRANCH` = blocker's ticket key
  - Otherwise: `BASE_BRANCH` = `main`

## Step 2: Ensure Worktree Exists

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

## Step 3: Load or Create Checklist

The checklist file lives at `{WORKTREE_DIR}/.claude/plans/jay-ticket-work-{TICKET_KEY}.md`.

Check if the file already exists:
- **If it exists**: read it and parse the checklist state (`[x]` vs `[ ]`). Resume from the first unchecked step.
- **If it does not exist**: create it, seeding from current Jira + artifact state (see below).

### 3a: Create the plans directory

```bash
mkdir -p {WORKTREE_DIR}/.claude/plans
```

### 3b: Seed checklist from current state

When creating a **new** checklist (file didn't exist), infer which steps are already done. This ensures compatibility when the queue or a previous run already progressed the ticket.

Use the Jira labels (from Step 1c) and artifact checks to determine initial state:

| Check | Condition | Steps to mark `[x]` |
|-------|-----------|---------------------|
| Plan exists | File `{PLANS_DIR}/jira-{TICKET_KEY}.md` exists and has content | Step 1 |
| Plan approved | Jira label `ClaudePlanApproved` is present, OR label `ClaudeExecuting` / `ClaudeNeedsReview` is present (implies approval already happened) | Steps 1, 2 |
| Plan executed | Jira label `ClaudeNeedsReview` is present, OR label `ClaudeExecuting` is present AND all plan tasks are marked complete in the plan file | Steps 1, 2, 3 |
| PR exists | `gh pr view {TICKET_KEY} --json number 2>/dev/null` succeeds | Steps 1, 2, 3, 4, 5 |
| PR review plan exists | A PR review plan file exists in `{WORKTREE_DIR}/.claude/plans/` matching `pr-review-*.md` or `pr-{TICKET_KEY}*.md` | Steps 1-6 |

Apply in reverse order (check the most-advanced state first) so you mark the correct set. Steps 7 and 8 are never pre-seeded — they always run fresh if unchecked.

### 3c: Write the checklist file

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
```

Where each `{STEPN}` is `x` if seeded as done, or a space if not.

## Step 4: Execute Checklist

Work through each unchecked step in order. After completing each step, immediately update the checklist file by changing `- [ ]` to `- [x]` for that step. This ensures idempotency if the process is interrupted.

---

### Step 4.1: Plan generated with /jira-start

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
5. Mark step 1 as `[x]` in the checklist file

---

### Step 4.2: Plan approved

**Skip if**: step 2 is already checked `[x]`.

Check the ticket's current labels:
- If `ClaudePlanApproved` is present: mark step 2 as `[x]` and continue.
- If `ClaudePlanNeedsApproval` is present (or no approval label):
  - Display the plan file content (or a summary) so the user can review it
  - Tell the user:
    ```
    Plan is ready for review.

    To approve: add the `ClaudePlanApproved` label in Jira, then re-run `/jay-ticket-work {TICKET_KEY}`.

    Or type "approve" to approve now and continue.
    ```
  - If the user types "approve" or similar affirmative:
    - Use `mcp__atlassian__editJiraIssue` to add `ClaudePlanApproved` and remove `ClaudePlanNeedsApproval`
    - Mark step 2 as `[x]`
  - Otherwise: **stop here**. The command will resume from this step on next run.

---

### Step 4.3: Plan executed with /plan-execute

**Skip if**: step 3 is already checked `[x]`.

1. Update Jira labels:
   - Remove all other `Claude*` workflow labels (except `ClaudeWork`)
   - Add `ClaudeExecuting`
   - `update`: `{"labels": [{"remove": "ClaudePlanApproved"}, {"remove": "ClaudePlanNeedsApproval"}, {"add": "ClaudeExecuting"}]}`
2. Use the Skill tool to run skill `plan-execute` with args `jira-{TICKET_KEY}`
3. After execution completes:
   - Run `git status` in the worktree
   - If there are uncommitted changes: stage relevant files and commit
4. Re-read the plan file to verify tasks are complete
5. If all tasks complete:
   - Update Jira labels: `{"labels": [{"remove": "ClaudeExecuting"}, {"add": "ClaudeNeedsReview"}]}`
   - Mark step 3 as `[x]`
6. If tasks are incomplete:
   - Update Jira labels: `{"labels": [{"remove": "ClaudeExecuting"}, {"add": "ClaudeFailed"}]}`
   - Post Jira comment listing incomplete tasks
   - **Stop here** (user must investigate)

---

### Step 4.4: PR description and title generated with /pr-description

**Skip if**: step 4 is already checked `[x]`.

1. Make sure we are in the worktree: `cd {WORKTREE_DIR}`
2. Use the Skill tool to run skill `pr-description`
3. Mark step 4 as `[x]`

---

### Step 4.5: PR pushed as draft

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
   b. Read the generated PR description file (from step 4.4 output or `./pr.md` if it exists)
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

### Step 4.6: PR review plan generated with /pr-review

**Skip if**: step 6 is already checked `[x]`.

1. Make sure we are in the worktree: `cd {WORKTREE_DIR}`
2. Use the Skill tool to run skill `pr-review`
3. Mark step 6 as `[x]`

---

### Step 4.7: PR review plan executed with /pr-execute-plan

**Skip if**: step 7 is already checked `[x]`.

1. Make sure we are in the worktree: `cd {WORKTREE_DIR}`
2. Use the Skill tool to run skill `pr-execute-plan`
3. After execution: stage and commit any changes if present
4. Mark step 7 as `[x]`

---

### Step 4.8: Changes pushed to PR

**Skip if**: step 8 is already checked `[x]`.

1. Push all changes:
   ```bash
   cd {WORKTREE_DIR} && git push
   ```
2. Mark step 8 as `[x]`
3. Display the PR URL:
   ```bash
   gh pr view {TICKET_KEY} --json url -q '.url'
   ```

## Step 5: Final Summary

Display:

```
Ticket {TICKET_KEY} - Complete

Worktree: {WORKTREE_DIR}
Branch: {TICKET_KEY} (base: {BASE_BRANCH})
PR: {PR_URL}

All 8 steps completed. PR is ready for human review.
```

## Error Handling

- If any step fails, the checklist preserves progress. Re-running the command will resume from the failed step.
- Worktree already exists: reuse it (don't recreate).
- Branch already exists: check it out in the worktree.
- PR already exists: push updates to it rather than creating a new one.
- Plan file already exists: skip /jira-start (don't overwrite existing plan).
- On failure at step 4.3 (execution): Jira label is set to `ClaudeFailed`. User must investigate, fix, remove `ClaudeFailed` label, then re-run.
