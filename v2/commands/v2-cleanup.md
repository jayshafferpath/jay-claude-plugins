---
description: "v2 — post-merge teardown for a single slice. Verifies the slice landed on main, deletes the slice branch, transitions the slice ticket to Done, cascade-rebases the rest of the linearized chain onto main, and comments on the epic. Run after a slice PR merges."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__getTransitionsForJiraIssue
  - mcp__atlassian__transitionJiraIssue
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(gh *)
  - Bash(append-activity *)
  - Read
  - Write
---

# v2 Cleanup

Post-merge teardown for a single **slice**. Run after a slice PR is squash-merged to `main`.

This is a fork of v1 `/cleanup`. The semantics differ because v2's lifecycle has two PR altitudes (story PRs into a feature branch during Phase 2, slice PRs into main during Phase 3+). This command only handles slice-PR teardown — for story-PR cleanup, see Phase 2's automatic post-merge sweep in `/epic-work`.

## Arguments

`$ARGUMENTS` — required:
- `<SLICE_KEY>` — the Jira key of the slice ticket whose PR just merged.
- `[--no-cascade]` — skip the cascade rebase of remaining chain slices.

If the key is not a `V2Slice` ticket, refuse and point the user at v1's `/cleanup` (or whatever owns that ticket's lifecycle).

---

## Step 1 — Resolve

### 1a — Cloud ID

`mcp__atlassian__getAccessibleAtlassianResources` → `CLOUD_ID`.

### 1b — Slice context

Fetch `<SLICE_KEY>` via `mcp__atlassian__getJiraIssue`. Verify:
- Has `V2Slice` label. If not, refuse: "Not a V2Slice ticket — use v1 /cleanup."
- Has parent epic. Extract `EPIC_KEY` from the parent link.

Parse the slice ticket's summary `[Slice <EPIC_KEY>] <slice-name>` to get `SLICE_NAME`. The local branch is `slice/<EPIC_KEY>/<SLICE_NAME>`.

Determine the repo root:
1. If the slice ticket has a `repo:` label, resolve from there.
2. Otherwise, if the parent epic has a `repo:` label, resolve from there.
3. Otherwise refuse: "No repo: label on slice or epic. Add one and re-run."

Store as `REPO_ROOT`.

### 1c — Slice graph and chain

Query Jira for children of `EPIC_KEY` with `V2Slice`. For each, read "is blocked by" links. Build the in-memory graph.

**Linearize** per the README rule: topo sort, ties broken by ticket creation order. Find the position of `<SLICE_KEY>` in the chain. Everything **after** it is `DOWNSTREAM_SLICES` (in chain order). Everything **before** it doesn't matter for cleanup — those should already be merged or in flight.

If `DOWNSTREAM_SLICES` is empty, mark `CASCADE = false` regardless of `--no-cascade` — there's nothing downstream.

### 1d — Feature branch

`FEATURE_BRANCH = <EPIC_KEY>`. After Phase 3, the feature branch is sealed — no refresh step (in contrast to v1 cleanup, which refreshes the long-lived feature branch). v2 deliberately doesn't touch the feature branch post-Phase-3; if a slice's revert/rework is needed, the feature branch is no longer the source of truth — slice branches are.

---

## Step 2 — Verify Merge to Main

### 2a — Fetch

```bash
cd {REPO_ROOT} && git fetch origin
```

### 2b — PR state

```bash
cd {REPO_ROOT} && gh pr list --head slice/{EPIC_KEY}/{SLICE_NAME} --base main --state all --json number,state,url,mergeCommit --limit 5
```

Find the most recent PR whose `state` is `"MERGED"`. If none, refuse:

```
No merged PR to main found for slice/{EPIC_KEY}/{SLICE_NAME}.

If the slice was abandoned, run /v2-prune <SLICE_KEY> instead.
If the PR is still open, wait for the merge.
```

Store `PR_URL`, `MERGE_SHA = mergeCommit.oid`.

### 2c — Verify reachable from main

```bash
cd {REPO_ROOT} && git merge-base --is-ancestor {MERGE_SHA} origin/main
```

Non-zero → refuse with the same message v1 cleanup uses (main rewritten or merge not local).

---

## Step 3 — Confirm

```
v2 Cleanup {SLICE_KEY}: [Slice {EPIC_KEY}] {SLICE_NAME}

Repo:           {REPO_ROOT}
Branch:         slice/{EPIC_KEY}/{SLICE_NAME}
PR:             {PR_URL} (merged, {MERGE_SHA})
Epic:           {EPIC_KEY}
Chain position: {position}/{total} ({DOWNSTREAM_SLICES count} downstream)

Actions:
  1. Remove worktree on slice branch (if present and clean)
  2. Delete local + remote slice branch
  3. Transition {SLICE_KEY} to Done, add V2SliceMerged label, remove V2SliceReady
  4. Append "Shipped" entry to {SLICE_KEY} activity log
  5. Comment on epic {EPIC_KEY} with progress
{if CASCADE:
  "  6. Cascade-rebase downstream slices onto main: " + comma-separated DOWNSTREAM_SLICES + " (force-push each)"}
{if last slice in chain:
  "  7. Append \"Epic shipped\" entry to " + EPIC_KEY + " activity log, transition epic to Done if all slices are merged"}

Type "confirm" to proceed.
```

Wait for confirm.

---

## Step 4 — Delete Slice Branch

Same procedure as v1 cleanup Step 4: detect current branch, switch off if needed, remove worktree if present (refuse on dirty), `git branch -D`, `git push origin --delete`.

---

## Step 5 — Update Slice Jira

### 5a — Find Done transition

`getTransitionsForJiraIssue` → match (case-insensitive) `Done | Closed | Resolved | Complete | Completed`.

### 5b — Labels

```json
{
  "update": {
    "labels": [
      {"remove": "V2SliceReady"},
      {"add": "V2SliceMerged"}
    ]
  }
}
```

`V2Slice` is durable and stays.

### 5c — Transition

`transitionJiraIssue` if a Done transition was found.

### 5d — Activity log

```bash
append-activity {SLICE_KEY} --heading "Shipped" --body "Slice merged to main.

- PR: {PR_URL}
- Merge commit: \`{MERGE_SHA}\`
- Branch deleted: \`slice/{EPIC_KEY}/{SLICE_NAME}\` (local + remote)
- Chain position: {position}/{total}"
```

---

## Step 6 — Comment on Epic

Append a progress note on the epic so the chain status stays visible:

```bash
append-activity {EPIC_KEY} --heading "Slice shipped" --body "{SLICE_KEY} ([Slice] {SLICE_NAME}) merged. {N}/{total} slices shipped."
```

If this was the **last** slice in the chain (every other slice is now `Done` or has `V2SliceMerged`):
1. Append `"Epic shipped — all slices on main"` activity to the epic.
2. Look for a Done transition on the epic. If available and confirmed, transition the epic. Otherwise leave to the user — the v2 README's `V2EpicReady` label was set at finalize; no auto-transition is required.

Detection rule for "last slice": query Jira for siblings of `<SLICE_KEY>` with `V2Slice`, count how many lack `V2SliceMerged`. If zero (excluding this slice, which we just marked merged), it's the last.

---

## Step 7 — Cascade-Rebase Downstream Chain

Skip if `CASCADE` is false.

### 7a — Iterate

`PREVIOUS_BASE = main`. `PREVIOUS_OLD_BASE = slice/{EPIC_KEY}/{SLICE_NAME}` (the deleted branch — first downstream was based on it).

For each `NEXT_SLICE` in `DOWNSTREAM_SLICES`, in chain order:

1. Resolve `NEXT_BRANCH = slice/{EPIC_KEY}/<next-slice-name>`.
2. Detect worktree (operate inside it if present).
3. Rebase:
   ```bash
   git checkout {NEXT_BRANCH}
   git rebase --onto {PREVIOUS_BASE} {PREVIOUS_OLD_BASE} {NEXT_BRANCH}
   ```
4. On conflict: capture conflicting files, abort, record `{ slice, status: "conflict", files }`, **stop** the cascade, surface to the user. Don't attempt later slices.
5. On success: force-push with lease.
6. **First downstream only**: retarget its PR to `main`:
   ```bash
   gh pr edit <PR_NUMBER> --base main
   ```
7. Append activity log to the downstream slice ticket: "Rebased onto `{PREVIOUS_BASE}` after {SLICE_KEY} merged (v2 cleanup cascade)."
8. Advance: `PREVIOUS_OLD_BASE = NEXT_BRANCH`, `PREVIOUS_BASE = NEXT_BRANCH`.

### 7b — Report

If any conflict: surface "Cascade stopped at {slice}. Resolve manually, then re-run /stack-rebase or /v2-rework {next slice}." Earlier successful rebases stay applied.

---

## Step 8 — Summary

```
v2 Cleanup {SLICE_KEY} — Complete

Branch:         slice/{EPIC_KEY}/{SLICE_NAME} — deleted
PR:             {PR_URL} (merged at {MERGE_SHA})
Jira:           {transition or "labels updated only"}
Epic progress:  {N}/{total} slices shipped{ — epic complete if last}
{if cascade ran:
"Cascade rebase:
  - {slice}: rebased onto {new_base}, pushed
  - {slice}: CONFLICT — chain stopped here
"}
```

---

## Differences from v1 /cleanup

- **No feature-branch refresh.** v2's feature branch is sealed at end of Phase 3; refreshing it post-merge would actively break the slice-branches-as-truth invariant.
- **Label namespace.** Removes `V2SliceReady`, adds `V2SliceMerged` (rather than v1's `Claude*` set).
- **Epic progress comment.** Appends to the epic so the human watching the stack sees progress without checking each ticket.
- **Last-slice detection.** Triggers the epic-level "shipped" note when the chain completes.
- **Linearization rule.** Cascade follows the README's "physical chain from semantic DAG" rule, not v1's stack order (which is also linear, but discovered via `resolve-stack`).

## Error handling

- Slice ticket not `V2Slice` → refuse, redirect to v1 `/cleanup`.
- No merged PR found → refuse, redirect to `/v2-prune`.
- Merge SHA not reachable from main → refuse (rewritten history or merge not local).
- Worktree dirty on slice branch → refuse with the v1 message.
- Cascade rebase conflict → stop the chain, leave earlier successes in place, redirect to manual `/stack-rebase` or `/v2-rework`.
- Cascade force-push fails → warn, continue (local branch is correct).
- Jira Done transition unavailable → labels-only, warn.
- `append-activity` failure → warn but don't roll back.
