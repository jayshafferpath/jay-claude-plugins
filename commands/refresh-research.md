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

Apply the protocol from `commands/ticket-work.md` **S3.5: Drift Check**:

- **S3.5a**: Parse the existing Implementation Notes block. Extract `IMPL_NOTES_BASELINE` (per-repo SHA map) and `IMPL_NOTES_CITATIONS` (list of `{repo, path, start, end, baseline_sha}` records).
- **S3.5b**: For each citation, in the citation's `{repo}` working dir, run `git log --oneline -L {start},{end}:{path} {baseline_sha}..HEAD`. Detect line-range edits, file removal (path missing at HEAD), and renames (`git log --follow`). Mark drifted citations.
- **S3.5c**: Decide:
  - **No drift** → Append an activity log entry: `Drift check passed (manual) — research baseline still current.` Display a confirmation to the user. Do **not** add `ClaudeDriftChecked` (this command is independent of the ticket-work session lifecycle and shouldn't pre-empt the automatic check there).
  - **Drift** → Re-run per-ticket research (Phase 5.0 from `agents/planner.md`) at current HEAD, compose a new Implementation Notes block, replace it in the ticket description via `mcp__atlassian__editJiraIssue`, and post a Jira comment via `mcp__atlassian__addCommentToJiraIssue` showing old vs new baselines, drifted citations, and replacements. The comment format and warnings (e.g., "Plan was approved against the prior baseline") follow the same shape as S3.5c in ticket-work.

For full detail on parsing, diffing, comment format, and edge cases, **follow `commands/ticket-work.md` S3.5 verbatim** — this command is a manual entry point into that same protocol.

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
