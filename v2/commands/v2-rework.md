---
description: "v2 — reset a story or slice to a clean state and re-drive it through its lifecycle. Story rework: reset story branch to feature branch HEAD, clear V2Story* labels, re-spawn story-worker. Slice rework: delete slice branch, walk slice graph, re-run contributing stories so their commits re-fast-forward. Use when implementation is unsalvageable or after a serious mid-flight failure."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - mcp__atlassian__searchJiraIssuesUsingJql
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(rm *)
  - Bash(gh *)
  - Bash(append-activity *)
  - Read
  - Write
  - Skill
  - Agent
---

# v2 Rework

Reset a v2 ticket to a clean state. The behavior depends on the ticket type:

| Ticket type | What rework does |
|---|---|
| **Story** (`V2Story*` label set) | Reset story branch to feature-branch HEAD, clear `V2Story*` labels, re-spawn `story-worker` from S1. The previous story PR is closed. Slice tickets are not touched (their branches still hold the previous run's commits — those get cleaned up when story-worker re-fast-forwards). |
| **Slice** (`V2Slice` label) | Delete the slice branch, walk the slice graph for contributing stories, reset each contributing story to its feature-branch base, re-run `story-worker` for each. The slice branch gets recreated lazily as stories re-fast-forward. |

This is a fork of v1 `/rework`. The story flavor is the closest analog. The slice flavor is genuinely new — v1 has no concept of a slice.

## Arguments

`$ARGUMENTS` — required: a Jira ticket key. The agent reads the labels to decide the mode.

If the key is neither a v2 story nor a v2 slice, refuse and redirect to v1 `/rework`.

---

## Step 1 — Resolve

### 1a — Cloud ID and ticket

`mcp__atlassian__getAccessibleAtlassianResources` → `CLOUD_ID`. Fetch the ticket via `getJiraIssue`.

### 1b — Determine mode

Read labels:
- Has `V2Slice` → **slice mode**.
- Has any `V2Story*` label, or is a child of a v2 epic without `V2Slice` → **story mode**.
- Otherwise refuse: "Not a v2 ticket — use v1 /rework."

Extract `EPIC_KEY` from the parent link. Verify the epic has `V2Epic*` labels — if not, refuse (mismatched ticket).

### 1c — Repo root

Same as v2-cleanup Step 1b: try the ticket's `repo:` label, fall back to the epic's, refuse if neither exists.

`FEATURE_BRANCH = <EPIC_KEY>`.

---

## Story Mode

### S2 — Resolve story context

- `STORY_KEY = <ticket key>`.
- `STORY_BRANCH = <STORY_KEY>` (story branches are named for the story key).
- `STORY_TYPE` from labels (`V2Verification` → verification; otherwise behavior).

### S3 — Confirm

```
v2 Rework {STORY_KEY}: {summary}

Mode:           Story rework
Repo:           {REPO_ROOT}
Branch:         {STORY_BRANCH} → hard reset to origin/{FEATURE_BRANCH}
Feature branch: {FEATURE_BRANCH}
Epic:           {EPIC_KEY}
Story type:     {STORY_TYPE}

Actions:
  1. Close any open story PR with a rework comment
  2. Hard-reset {STORY_BRANCH} to origin/{FEATURE_BRANCH}, force-push
  3. Clean local plan files for {STORY_KEY}
  4. Remove V2Story* labels (V2StoryExecuting, V2StoryNeedsReview, V2StoryReady, V2StoryFailed)
  5. Append "Reworked" entry to {STORY_KEY} activity log
  6. Re-spawn story-worker from S1

Note: slice branches still hold the previous run's commits. They will be reconciled
as story-worker re-fast-forwards each commit. If the previous run created new slice
tickets that this rework no longer needs, run /v2-prune <SLICE_KEY> manually after.

This is irreversible. All commits on {STORY_BRANCH} will be lost.

Type "confirm" to proceed.
```

Wait for confirm.

### S4 — Close story PR

```bash
gh pr view {STORY_BRANCH} --json url,state 2>/dev/null
```

If a PR exists and is `OPEN`:
```bash
gh pr close {STORY_BRANCH} --comment "Closing for v2 rework — restarting story from scratch."
```

### S5 — Reset story branch

```bash
cd {REPO_ROOT} && git fetch origin
git checkout {STORY_BRANCH} 2>/dev/null || git checkout -b {STORY_BRANCH} origin/{FEATURE_BRANCH}
git reset --hard origin/{FEATURE_BRANCH}
git push origin {STORY_BRANCH} --force-with-lease
```

If the story branch never existed remotely, force-push will fail — that's fine.

### S6 — Clean local plan files

```bash
rm -f {REPO_ROOT}/.claude/plans/v2-story-{STORY_KEY}*.md
rm -f {REPO_ROOT}/.claude/plans/jira-{STORY_KEY}.md
rm -f {REPO_ROOT}/pr.md
```

### S7 — Clear Jira state

```json
{
  "update": {
    "labels": [
      {"remove": "V2StoryExecuting"},
      {"remove": "V2StoryNeedsReview"},
      {"remove": "V2StoryReady"},
      {"remove": "V2StoryFailed"}
    ]
  }
}
```

`V2Verification` is durable (story type doesn't change on rework) and stays.

```bash
append-activity {STORY_KEY} --collapse
append-activity {STORY_KEY} --heading "Reworked" --body "Story branch \`{STORY_BRANCH}\` reset to origin/{FEATURE_BRANCH}. Previous story PR closed. Re-spawning story-worker."
```

### S8 — Re-spawn story-worker

Use the `Agent` tool with `subagent_type: story-worker` and a self-contained prompt:

```
Re-running story {STORY_KEY} after rework.

Inputs:
  STORY_KEY: {STORY_KEY}
  EPIC_KEY: {EPIC_KEY}
  FEATURE_BRANCH: {FEATURE_BRANCH}

Story branch was reset to origin/{FEATURE_BRANCH}. Previous run's commits are gone.
Slice branches still hold the previous run's commits — story-worker should run as
normal and re-fast-forward this story's commits onto whichever slices it picks.
If the slice graph picked this run is different from the previous, the user will
prune obsolete slice tickets manually after.

Run from S1.
```

Surface story-worker's structured result back to the user.

---

## Slice Mode

### L2 — Resolve slice context

- `SLICE_KEY = <ticket key>`.
- Parse summary `[Slice <EPIC_KEY>] <slice-name>` → `SLICE_NAME`.
- Slice branch = `slice/<EPIC_KEY>/<SLICE_NAME>`.

### L3 — Find contributing stories

A "contributing story" is a story whose feature-branch commits carry `Slice: <SLICE_KEY>`. Walk:

```bash
cd {REPO_ROOT} && git log {FEATURE_BRANCH} --not origin/main --grep="^Slice: {SLICE_KEY}$" --format="%H"
```

For each commit, read the `Story:` trailer to extract the contributing story key. Deduplicate. Store as `CONTRIBUTING_STORIES`.

If `CONTRIBUTING_STORIES` is empty, the slice exists in Jira but has no commits — likely a planning artifact. Refuse: "No commits reference this slice. Use /v2-prune to cancel the slice ticket instead."

### L4 — Confirm

```
v2 Rework {SLICE_KEY}: [Slice {EPIC_KEY}] {SLICE_NAME}

Mode:           Slice rework
Repo:           {REPO_ROOT}
Slice branch:   slice/{EPIC_KEY}/{SLICE_NAME} → DELETED (will be recreated)
Epic:           {EPIC_KEY}
Contributing stories ({N}):
{for each story: "  - " + STORY_KEY + " (" + status + ", currently " + label + ")"}

Actions:
  1. Delete slice branch slice/{EPIC_KEY}/{SLICE_NAME} (local + remote)
  2. For each contributing story:
       - Close any open story PR
       - Reset story branch to origin/{FEATURE_BRANCH}
       - Clear V2Story* labels
       - Re-spawn story-worker

The slice branch will be recreated lazily as stories re-fast-forward.

If any contributing story has already merged a slice PR to main, the merged
content stays on main — this rework only affects unmerged work. (To revert
shipped slice content, use /v2-prune <SLICE_KEY>.)

Type "confirm" to proceed.
```

Refuse if any contributing story is in a state v2-rework can't safely reset (e.g., its PR has merged to main). Specifically:
- If `<SLICE_KEY>` itself has `V2SliceMerged`, refuse and redirect to `/v2-prune`.
- If any contributing story has been re-used by other (different) slices that already shipped, warn loudly but allow on user confirmation.

### L5 — Delete slice branch

```bash
cd {REPO_ROOT} && git fetch origin
git branch -D slice/{EPIC_KEY}/{SLICE_NAME} 2>/dev/null
git push origin --delete slice/{EPIC_KEY}/{SLICE_NAME} 2>&1
```

Both can fail (already gone) — continue.

### L6 — Rework each contributing story

For each `STORY_KEY` in `CONTRIBUTING_STORIES`, perform the **Story Mode** flow (S4–S7) inline. Skip S8 (don't re-spawn worker yet — we want all stories reset before any re-runs to avoid one story's worker re-creating the slice branch with stale data).

Append a slice-rework activity comment on each contributing story:
```bash
append-activity {STORY_KEY} --heading "Reworked (slice rework cascade)" --body "Reset as part of v2-rework {SLICE_KEY}. Slice branch was deleted; this story will re-fast-forward when re-driven."
```

### L7 — Comment on slice ticket

```bash
append-activity {SLICE_KEY} --heading "Reworked" --body "Slice branch deleted. Contributing stories reset: {comma-separated CONTRIBUTING_STORIES}. Re-drive via /epic-work {EPIC_KEY}."
```

Don't change slice ticket labels — `V2Slice` is durable, and `V2SliceReady` stays cleared (it was only set after the slice PR opened, which slice-rework implicitly invalidates anyway).

### L8 — Hand off to /epic-work

Don't auto-spawn workers from slice mode. Surface:

```
v2 Rework {SLICE_KEY} — Reset complete

Slice branch deleted: slice/{EPIC_KEY}/{SLICE_NAME}
Stories reset:        {comma-separated CONTRIBUTING_STORIES}

Next: /epic-work {EPIC_KEY}

Phase 2's story loop will re-discover the reset stories as unblocked and re-spawn
story-worker for each. The slice branch will be recreated as commits re-fast-forward.
```

This is deliberate — slice-rework can cascade into 5+ story reruns, and dropping all of them into a single `/epic-work` invocation lets the user inspect the reset state, abort if surprised, and let phase ordering rules apply.

---

## Differences from v1 /rework

- **Mode dispatch.** v1 always operates on a ticket; v2 dispatches to story or slice flow based on labels.
- **Reset target rule.** v1 uses `BASE_BRANCH` (or feature branch for top-of-stack). v2 stories always reset to `origin/<EPIC_KEY>` (the feature branch) — the per-ticket base concept doesn't apply.
- **Label namespace.** Clears `V2Story*` rather than `Claude*`. Does not re-add a "ready" label — story-worker is invoked directly (story mode) or `/epic-work` re-discovers the story (slice mode).
- **Slice flow has no v1 analog.** Walking commit trailers to find contributing stories, then cascading rework to each, is unique to v2.
- **No `sync-checklist` / `sync-plan` calls.** v2 stories don't carry a Jira-side checklist or plan — story-worker writes Implementation Notes in S2 each run. There's nothing to clear.

## Error handling

- Wrong ticket type → refuse, redirect to v1 `/rework`.
- Story branch checkout fails (uncommitted changes in primary worktree) → stop before resetting; user must commit/stash.
- Force-push fails → warn, continue (local state is correct).
- Slice has merged PR (`V2SliceMerged`) → refuse, redirect to `/v2-prune`.
- Slice has zero contributing commits → refuse, redirect to `/v2-prune`.
- Contributing story has shipped via a different slice → warn loudly, allow on confirm.
- `gh pr close` fails → warn, continue.
- `append-activity` fails → warn, don't roll back.
