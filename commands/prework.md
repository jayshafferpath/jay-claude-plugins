---
description: "Prepare a Jira ticket for /ticket-work: resolve stack, ensure feature branch + working directory, seed checklist, run drift check, capture Figma design context. Stops before planning."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - mcp__atlassian__atlassianUserInfo
  - mcp__atlassian__getTransitionsForJiraIssue
  - mcp__atlassian__transitionJiraIssue
  - mcp__plugin_figma_figma__get_metadata
  - mcp__plugin_figma_figma__get_screenshot
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
- Claims the ticket: assigns to the current user (with conflict prompt) and transitions to **In Progress**
- Ensures the feature branch exists (when the ticket is part of a Story/Epic stack)
- Ensures the working directory exists (worktree by default, branch checkout with `--serial`)
- Seeds the Jira checklist comment
- Runs the drift check against `Implementation Notes`
- Captures Figma design context (metadata + screenshots) for any frames the ticket references

What it deliberately does NOT do:
- Move the ticket to `ClaudePlanning`
- Generate a plan file, expand AC into EARS, or run codebase research
- Execute, verify, refactor, review, or open a PR

## Arguments

$ARGUMENTS

Required: a single Jira ticket key (e.g., `PROJ-123`).

### Flags

- `--serial`: Use branch checkout in the current repo instead of a worktree. Mirrors `ticket-work --serial`.
- `--force-claim`: Skip the assignee-conflict prompt in Step 1.5 and override the existing assignee. For automation/queue flows.

### Flag Parsing

Parse `$ARGUMENTS` to extract flags. Any token starting with `--` is a flag; the remaining token is the ticket key. Set `SERIAL_MODE = true` if `--serial` is present, `FORCE_CLAIM = true` if `--force-claim` is present. If no ticket key is provided, display "Usage: /prework {TICKET_KEY} [--serial] [--force-claim]" and stop.

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

## Step 1.5: Claim Ticket

Assign the ticket to the current user (with safety checks) and transition it to **In Progress**. Idempotent — safe to re-run.

### 1.5a: Fetch assignee + status

`resolve-stack` does not surface assignee/status. Call `mcp__atlassian__getJiraIssue` once with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`. Extract:

- `currentAssigneeAccountId` (or null)
- `currentAssigneeName` (or null)
- `currentStatus` (e.g. "To Do", "In Progress", "In Review", "Done")

### 1.5b: Get current user

Call `mcp__atlassian__atlassianUserInfo`. Store `account_id` as `MY_ACCOUNT_ID`, `name` as `MY_NAME`.

### 1.5c: Fast-skip

If ALL three are true, skip the rest of Step 1.5 with no further MCP writes:
- `currentAssigneeAccountId == MY_ACCOUNT_ID`
- `currentStatus == "In Progress"`
- `ClaudeWork` label was already present at S1c entry (i.e. S1c did not add it)

### 1.5d: Resolve assignee action

Determine `ASSIGN_ACTION`:

- If `currentAssigneeAccountId` is null → `ASSIGN_ACTION = "assign"`.
- If `currentAssigneeAccountId == MY_ACCOUNT_ID` → `ASSIGN_ACTION = "noop"`.
- Else (assigned to someone else):
  - If `FORCE_CLAIM` is true → `ASSIGN_ACTION = "override"`.
  - Otherwise, prompt the user via `AskUserQuestion`:
    - Question: `"{TICKET_KEY} is currently assigned to {currentAssigneeName}. Override?"`
    - Options:
      - `"Override and assign to me"` → `ASSIGN_ACTION = "override"`
      - `"Keep current assignee"` → `ASSIGN_ACTION = "noop"`
      - `"Cancel prework"` → display "Cancelled" and **stop** the whole command.

### 1.5e: Apply assignee

If `ASSIGN_ACTION` is `"assign"` or `"override"`:

- Call `mcp__atlassian__editJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`, `fields={"assignee": {"accountId": MY_ACCOUNT_ID}}`.
- Set `ASSIGNEE_CHANGED = true`.

Otherwise `ASSIGNEE_CHANGED = false`.

### 1.5f: Transition to In Progress

Define `IN_PROGRESS_OR_LATER = {"In Progress", "In Review", "Code Review", "Done", "Cancelled"}`. (Match case-insensitively.)

If `currentStatus` is in that set → `STATUS_CHANGED = false`, skip transition.

Otherwise:

1. Call `mcp__atlassian__getTransitionsForJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`.
2. Find the transition whose `name` matches `"In Progress"` (case-insensitive).
3. If found, call `mcp__atlassian__transitionJiraIssue` with that `transitionId`. Set `STATUS_CHANGED = true`.
4. If not found, list the available transition names and prompt the user via `AskUserQuestion` to pick one (or cancel). Apply the chosen transition. If the user cancels, set `STATUS_CHANGED = false` and continue (do not stop the whole command — the rest of prework is still useful).

### 1.5g: Activity comment

If `ASSIGNEE_CHANGED` or `STATUS_CHANGED`:

```
append-activity --ticket {TICKET_KEY} --message "Claimed by {MY_NAME}{, transitioned to In Progress if STATUS_CHANGED}"
```

Compose the message conditionally:
- Both changed: `"Claimed by {MY_NAME}, transitioned to In Progress."`
- Only assignee: `"Claimed by {MY_NAME}."`
- Only status: `"Transitioned to In Progress."`

Store `CLAIM_SUMMARY` for Step 5 display:
- If fast-skip in 1.5c: `"already mine, In Progress"`
- If `ASSIGN_ACTION == "noop"` and not status changed: `"kept {currentAssigneeName}"`
- If `ASSIGN_ACTION == "assign"`: `"assigned to me"`
- If `ASSIGN_ACTION == "override"`: `"overrode {currentAssigneeName} → me"`
- Append `", transitioned to In Progress"` if `STATUS_CHANGED`.

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

There is nothing else to gate on: `drift-check` diffs the ticket's recorded research baseline SHA against the code at HEAD, so re-running it on an unchanged tree is a cheap no-op that returns `current`. Running it on every `/prework` is the correct behavior — it re-fires precisely when upstream has moved.

If drift is detected, the sub-procedure refreshes Implementation Notes and posts a Jira comment with the drift report. Otherwise it reports `current` and continues.

Do NOT proceed to S4 (the plan/execute lifecycle).

---

## Step 4.5: Capture Design Context

Pull design context from any Figma frames the ticket references and attach them to the ticket so `/ticket-work` execute has visual fidelity.

### Skip conditions

- The ticket's `h2. Implementation Notes` already contains an `h3. Designs` subsection **and** every screenshot it lists exists under `{WORK_DIR}/.designs/{TICKET_KEY}/` → skip (already captured). If the subsection is present but its screenshots are missing from disk (fresh worktree, cleaned machine), do not skip — re-capture so execute can `Read` them.
- Checklist step 2 (execute) is `[x]` → skip (capture is pre-execute only; refresh manually if frames change later).
- No Figma URLs surface in 4.5a → skip silently.

### 4.5a: Discover Figma URLs

Build `FIGMA_REFS` by scanning two sources:

1. **Ticket description and Implementation Notes**: regex over the body for
   `https?://(?:www\.)?figma\.com/(?:file|design|proto|board)/([A-Za-z0-9]+)(?:/[^\s)?]*)?(?:\?[^\s)]*?node-id=([A-Za-z0-9-]+))?`
   capturing `(file_key, node_id_or_null, full_url)`.
2. **Linked TDD PRD sources**: if the ticket cites a TDD (look for a `docs/tdds/{slug}.md` reference in the description or Implementation Notes), grep its `docs/tdds/{slug}/*.prd.md` files with the same regex.

Dedupe by `(file_key, node_id)`. If empty, skip the rest of Step 4.5.

### 4.5b: Prompt for selection-based capture

The Figma MCP operates on the user's current Figma desktop selection — it cannot target arbitrary URLs headlessly. So this step is interactive.

Display:

```
Found {N} Figma frame(s) referenced by this ticket:
  1. {full_url}  (file: {file_key}, node: {node_id or "none — whole file"})
  2. {full_url}  ...

For each frame:
  - Open it in Figma desktop and select the frame
  - Reply "ready 1" (or "ready N") to capture
  - Reply "skip 1" to skip a single frame
  - Reply "skip all" to skip Step 4.5 entirely
```

Loop until every entry is either captured or skipped.

### 4.5c: Per-frame capture

For each "ready" frame, call the Figma MCP twice on the user's current selection:

- `mcp__plugin_figma_figma__get_metadata` → sparse XML (layer ids, names, types, positions, sizes). Capture as `metadata_xml`.
- `mcp__plugin_figma_figma__get_screenshot` → PNG of the selection. Save to
  `{WORK_DIR}/.designs/{TICKET_KEY}/{file_key}-{node_id_or "root"}.png`.

`mkdir -p {WORK_DIR}/.designs/{TICKET_KEY}` first. Ensure `.designs/` is in the working directory's `.gitignore` (append if missing — same pattern as `.planner-cache/`). Screenshots are per-machine and re-fetchable; they should not commit.

### 4.5d: Attach to Implementation Notes

Append (or refresh) an `h3. Designs` subsection inside the ticket's `h2. Implementation Notes` block. One entry per captured frame:

```
h3. Designs

* {full_url}
  ** Local screenshot: .designs/{TICKET_KEY}/{filename}.png (relative to {WORK_DIR})
  ** Metadata:
  {code:xml}
  {metadata_xml}
  {code}
```

If `h3. Designs` already exists in Implementation Notes, replace it wholesale rather than appending — re-runs refresh, not duplicate. Match `h3\. Designs\s*\n` through to the next `h2\.` heading or the end of the Implementation Notes block.

Use `mcp__atlassian__editJiraIssue` to write back. The screenshot path is relative to the working directory so `/ticket-work` execute can `Read` it.

### 4.5e: Record the capture

Post an activity comment via `append-activity`:

```
Designs captured: {N} frame(s) from Figma. Screenshots in .designs/{TICKET_KEY}/.
```

The `h3. Designs` subsection written in 4.5d plus the `.designs/{TICKET_KEY}/*.png` files are the record that capture ran — that pair is what the skip condition above reads.

If the user skipped every frame, do NOT write an `h3. Designs` subsection at all — leaving it absent is what makes the next `/prework` re-run re-prompt.

Stop here. Do NOT proceed to S4 (the plan/execute lifecycle).

---

## Step 5: Final Summary

Display:

```
Prework complete: {TICKET_KEY} - {SUMMARY}

  Working directory: {WORK_DIR}
  Branch:            {BRANCH_NAME} (base: {BASE_BRANCH})
  Feature branch:    {FEATURE_BRANCH or "none"}
  Mode:              {serial | worktree}
  Claimed:           {CLAIM_SUMMARY}
  Checklist:         seeded in Jira ({steps_done}/{steps_total} done)
  Drift check:       {passed | refreshed | skipped — {reason}}
  Designs:           {N captured | none referenced | skipped by user}

Ready for planning. Run `/ticket-work {TICKET_KEY}{ --serial if SERIAL_MODE}` to continue.
```

---

## Error Handling

- Same as `/ticket-work` for the steps it runs. The Jira checklist preserves progress — re-running is safe and resumes from the first incomplete step within S1–S3.5.
- If `S2.0` reports `Error: Blocker container has no branch yet` or `Error: multiple unmerged blocker containers`, surface the error and **stop** without modifying state.
- If `seed-checklist` fails, do not run drift check; surface the error and stop.
