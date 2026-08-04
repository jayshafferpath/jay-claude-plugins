---
description: "Manually re-run the per-ticket research drift check on a Jira ticket. Diffs the cited code against the ticket's research baseline SHA and updates the Implementation Notes if drift is detected."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(append-activity *)
  - Read
  - Glob
  - Grep
  - Agent
---

# Refresh Research

Manually trigger the drift check that `/ticket-work` runs at S3.5 — diff each cited line range in the ticket's `Implementation Notes` against current HEAD, and refresh the block (with a Jira comment summarizing what changed) if drift is found.

Use this when:
- You've rebased or pulled changes and want fresh Implementation Notes before resuming `/ticket-work`.
- The ticket has been sitting in the queue for a while and upstream code has likely moved.
- You suspect the cited patterns are no longer accurate but haven't started execution yet.

This command does **not** mutate code — it only reads the working tree, edits the Jira ticket description, and posts a comment.

## Arguments

$ARGUMENTS

Required: a Jira ticket key (e.g., `PROJ-123`). The command assumes the relevant repo(s) are accessible from the current working directory or the additional working directories.

---

## Step 1: Initialize

### 1a: Determine Working Directory

Run:
```bash
git rev-parse --show-toplevel
```

Store as `WORK_DIR`. If the cited repos differ from `WORK_DIR`, the agent will resolve each per-citation repo via the additional working directories.

### 1b: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1c: Fetch the Ticket

Use `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`.

Store the ticket description as `TICKET_DESCRIPTION`.

---

## Step 2: Locate Implementation Notes

Search `TICKET_DESCRIPTION` for an `h2. Implementation Notes` block.

**If not found**, display:
```
{TICKET_KEY} has no Implementation Notes block — nothing to refresh.

This usually means the ticket was created before per-ticket research was added to /planner. To add notes, the ticket would need to be re-decomposed (or you can add an Implementation Notes block manually and re-run this command).
```

**Stop.**

---

## Step 3: Run the Drift Check

Run:

```bash
drift-check {TICKET_KEY} --repo-root {WORK_DIR}
```

Parse the JSON output (see `commands/ticket-work.md` S3.5a/b for the field semantics). The CLI now runs the **full** check battery by default — line-range citations *plus* symbol presence, path existence for files-likely-to-change and tests-likely-to-extend, TDD Reference resolution, and per-repo sidecar presence. The same JSON also passes through `constraintsRaw` for the manual constraints pass below.

- **`status === "no-notes"`**: stop and display "{TICKET_KEY} has no Implementation Notes block — nothing to refresh." (Already handled in Step 2.)
- **`status === "current"`** (no drift): proceed to **Step 3.5** (Constraints pass). If that pass also returns no drift, append an activity-log entry `Drift check passed (manual) — research baseline still current.` and display a confirmation to the user.
- **`status === "drifted"`**: re-run per-ticket research from `agents/planner.md` Phase 5.0, replace the Implementation Notes block, and post the diff comment per `commands/ticket-work.md` S3.5c "Drift detected" branch. The diff comment must call out **every** drifted check type — citations whose symbols moved/were removed, files-likely-to-change that no longer exist, TDD anchor mismatches, and missing sidecars — not just line-range diffs.

### Step 3.5: Constraints pass (LLM verification)

The CLI cannot tell whether a listed constraint (anti-pattern, in-flight migration, "avoid X" rule) is still applicable — the prose names a condition that needs to be re-evaluated against current code, not a structural fact. After the structural pass:

1. If `constraintsRaw` is null or only contains "none surfaced", skip this step.
2. Otherwise, for each constraint bullet:
   - Identify the cited region or repo-area the constraint refers to (often implicit from prose like "avoid sync DB calls in `src/api/*`").
   - Read the relevant code at HEAD via `Read` / `Grep`.
   - Decide: **still applicable**, **already resolved** (the migration landed, the anti-pattern is gone), or **scope changed** (the constraint still holds but the surface area has shifted).
3. If **any** constraint is `already resolved` or `scope changed`, treat the ticket as drifted even if the structural pass returned `current`:
   - Compose an updated `*Constraints:*` subsection (drop resolved items; rewrite scope-changed items with the new boundary).
   - Replace just the `*Constraints:*` subsection in Jira via `mcp__atlassian__editJiraIssue`.
   - Post a Jira comment summarizing what changed and why (use the same `mcp__atlassian__addCommentToJiraIssue` shape as S3.5c).

---

## Step 4: Report

Output a concise summary to the user:

**No drift:**
```
{TICKET_KEY}: research baseline is current.

Baseline: {repo}@{sha}{, ...}
Citations checked: {N}
```

**Drift:**
```
{TICKET_KEY}: drift detected and refreshed.

Old baseline: {repo}@{old_sha}{, ...}
New baseline: {repo}@{new_sha}{, ...}
Citations updated: {N_drifted}/{N_total}

Jira comment posted with full diff. Re-review the Implementation Notes before resuming /ticket-work.
```

If any drifted citation could not be replaced confidently, surface that inline:
```
Note: {N} citation(s) could not be re-pinned to a clear successor. See Jira comment for details and decide whether to proceed.
```
