---
description: "v2 — abandon a story or slice without shipping it. Story prune: revert each of the story's feature-branch merges, close story PR, cancel Jira, drop the story branch. Slice prune: revert the slice's commits from the feature branch, drop the slice branch, close slice PR, cancel Jira, comment on contributing stories. Use when work is being abandoned."
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

# v2 Prune

Abandon a v2 ticket. Two flavors based on ticket type:

| Ticket type | What prune does |
|---|---|
| **Story** | Revert each of the story's merges from the feature branch (the story PR may have squash-merged multiple commits — find by `Story:` trailer). Close the story PR. Cancel the Jira story. Drop the story branch. Comment on slice tickets that lost commits. |
| **Slice** | Revert every commit on the feature branch with `Slice: <SLICE_KEY>`. Delete the slice branch (if it exists). Close the slice PR (if open — usually only relevant in Phase 3+). Cancel the Jira slice. Comment on contributing stories. |

This is a fork of v1 `/prune`. The semantics differ because v2 doesn't have a single "ticket merge to feature branch" pattern — stories merge as squashed PRs, slices accumulate from many commits.

## Arguments

`$ARGUMENTS` — required: a Jira ticket key. Mode is dispatched by labels.

If the key is not a v2 story or slice, refuse and redirect to v1 `/prune`.

---

## Step 1 — Resolve

### 1a — Cloud ID and ticket

`mcp__atlassian__getAccessibleAtlassianResources` → `CLOUD_ID`. Fetch the ticket.

### 1b — Determine mode

- Has `V2Slice` → **slice mode**.
- Has any `V2Story*` label, or is a child of a v2 epic without `V2Slice` → **story mode**.
- Otherwise refuse.

Extract `EPIC_KEY` and verify it's a v2 epic.

### 1c — Repo root and feature branch

Same resolution as v2-cleanup. `FEATURE_BRANCH = <EPIC_KEY>`.

---

## Story Mode

### S2 — Resolve story context

- `STORY_KEY = <ticket key>`.
- `STORY_BRANCH = <STORY_KEY>`.

### S3 — Detect merge to feature branch

Story PRs squash-merge into the feature branch. The merge commit subject convention is `Merge pull request #N from .../{STORY_KEY}` (gh) or a squashed subject — easier to detect by the `Story:` trailer carried by every commit on the feature branch from this story:

```bash
cd {REPO_ROOT} && git fetch origin
cd {REPO_ROOT} && git log origin/{FEATURE_BRANCH} --not origin/main --grep="^Story: {STORY_KEY}$" --format="%H"
```

Store SHAs as `STORY_COMMITS_ON_FEATURE`. Order: oldest first.

If empty, the story never merged to the feature branch — likely abandoned mid-flight before merging. `MERGE_STATE = "unmerged"`. Otherwise `MERGE_STATE = "merged"`.

### S4 — Detect affected slices

For each commit in `STORY_COMMITS_ON_FEATURE`, read the `Slice:` trailer and dedupe → `AFFECTED_SLICES`. These slices' branches contain copies of these commits — they need to be notified (and possibly pruned themselves if this story was their only contributor).

For each slice in `AFFECTED_SLICES`, query Jira for other stories that contributed to it (commits on the feature branch with `Slice: <SLICE_KEY>` whose `Story:` is not `<STORY_KEY>`). Store as `slice.other_contributors`. If empty, this story was the slice's only contributor.

### S5 — Detect PR state

```bash
cd {REPO_ROOT} && gh pr view {STORY_BRANCH} --json url,state,number 2>/dev/null
```

### S6 — Confirm

```
v2 Prune {STORY_KEY}: {summary}

Mode:           Story prune
Repo:           {REPO_ROOT}
Branch:         {STORY_BRANCH}
Feature branch: {FEATURE_BRANCH}
Merge state:    {MERGE_STATE} ({N} commits on feature branch)
PR:             {PR_STATE} {PR_URL}

Affected slices ({M}):
{for each slice:
"  - {SLICE_KEY} ({slice_name}) — {C} commits from this story"
"    " + (slice.other_contributors empty ? "⚠ ONLY contributor — slice will have zero commits after prune; consider /v2-prune " + SLICE_KEY + " too"
                                          : "still has commits from: " + comma-separated other contributors)}

Actions:
  1. {if MERGE_STATE == "merged": "Revert " + N + " story commit(s) on " + FEATURE_BRANCH + " (in reverse order) and force-push" else: "Skip — nothing merged to revert"}
  2. {if PR_STATE == "OPEN": "Close PR " + PR_URL + " with prune comment" else: "Skip — PR already closed/missing"}
  3. Delete story branch {STORY_BRANCH} (local + remote)
  4. Transition {STORY_KEY} to "Won't Do", remove V2Story* labels, add V2StoryAbandoned
  5. Append "Pruned" entry to {STORY_KEY} activity log
  6. Comment on each affected slice ticket noting which commits were reverted

Note: slice branches still hold the cherry-picked copies of these commits. They
will diverge from the feature branch after prune — re-run /epic-work or
/v2-rework <SLICE_KEY> to reconcile, or /v2-prune the slice if it should be
cancelled outright.

Type "confirm" to proceed.
```

Wait for confirm.

### S7 — Close PR

If `PR_STATE == "OPEN"`:
```bash
gh pr close {STORY_BRANCH} --comment "Pruned — story abandoned. Ticket transitioning to Won't Do."
```

### S8 — Revert merges on feature branch

Skip if `MERGE_STATE == "unmerged"`.

```bash
cd {REPO_ROOT} && git checkout {FEATURE_BRANCH} && git pull origin {FEATURE_BRANCH}
```

Verify each SHA is reachable:
```bash
git merge-base --is-ancestor {SHA} HEAD
```

Revert in **reverse chronological order** (newest first) so each revert applies to the most recent state:

```bash
for SHA in (reverse of STORY_COMMITS_ON_FEATURE):
  git revert --no-edit {SHA}
```

If any revert is a merge commit (rare for squash-merged story PRs but possible if the story had its own merge inside): use `git revert -m 1 --no-edit {SHA}`. Detect with `git rev-list --parents -n 1 {SHA}` — more than one parent SHA after the commit hash means it's a merge.

On revert conflict:
1. Capture conflicting files, abort with `git revert --abort`.
2. Surface the conflict, instruct manual recovery (revert each remaining commit by hand, push, re-run).
3. **Stop** — don't proceed to PR close / Jira changes.

### S9 — Amend revert commits with prune marker

Each revert commit gets a brief amend so future tools can recognize them as prune-driven:

```bash
git commit --amend -m "$(git log -1 --format=%B)
Pruned from stack — see Jira {STORY_KEY} for context."
```

(One per revert. Skip if the loop produced a single combined revert.)

### S10 — Push

```bash
git push origin {FEATURE_BRANCH}
```

If push fails: stop before touching Jira so state stays consistent.

### S11 — Delete story branch

Same as v1: detect current branch, switch off if needed, `git branch -D`, `git push origin --delete`.

### S12 — Cancel Jira story

Find a Won't Do / Cancelled / Won't Fix transition. Update labels:

```json
{
  "update": {
    "labels": [
      {"remove": "V2StoryExecuting"},
      {"remove": "V2StoryNeedsReview"},
      {"remove": "V2StoryReady"},
      {"remove": "V2StoryFailed"},
      {"add": "V2StoryAbandoned"}
    ]
  }
}
```

`V2Verification` stays.

Transition. Then:

```bash
append-activity {STORY_KEY} --heading "Pruned" --body "Story abandoned.

- Branch: \`{STORY_BRANCH}\` — deleted
- PR: {PR_URL} — closed
- Feature branch: \`{FEATURE_BRANCH}\` — {N} commits reverted
- Affected slices: {comma-separated AFFECTED_SLICES}
- Status: transitioned to {transition}"
```

### S13 — Comment on affected slices

For each slice in `AFFECTED_SLICES`:

```bash
append-activity {SLICE_KEY} --heading "Story pruned" --body "Story {STORY_KEY} pruned. {C} commit(s) it contributed have been reverted on \`{FEATURE_BRANCH}\`. Slice branch \`slice/{EPIC_KEY}/{SLICE_NAME}\` still holds the cherry-picked copies and now diverges from the feature branch. Reconcile via /v2-rework {SLICE_KEY} or /v2-prune {SLICE_KEY} as appropriate.{ if other contributors: \" Slice still has commits from: \" + other_contributors }{ else: \" ⚠ Slice has no other contributors — it has effectively been emptied.\" }"
```

### S14 — Summary

```
v2 Prune {STORY_KEY} — Complete

Branch:         {STORY_BRANCH} — deleted
Feature branch: {FEATURE_BRANCH} — {N} commits reverted, pushed
PR:             {PR_URL} — closed
Jira:           {transition or "labels updated only"}
Affected slices ({M}):
  - {SLICE_KEY}: {C} commits reverted{; orphaned if no other contributors}
```

---

## Slice Mode

### L2 — Resolve slice context

- `SLICE_KEY = <ticket key>`.
- Parse summary → `SLICE_NAME`. Slice branch = `slice/<EPIC_KEY>/<SLICE_NAME>`.

### L3 — Find slice's commits on feature branch

```bash
cd {REPO_ROOT} && git fetch origin
cd {REPO_ROOT} && git log origin/{FEATURE_BRANCH} --not origin/main --grep="^Slice: {SLICE_KEY}$" --format="%H"
```

Store as `SLICE_COMMITS_ON_FEATURE` (oldest first). For each, extract `Story:` trailer → dedupe `CONTRIBUTING_STORIES`.

### L4 — Detect downstream slices

A slice is "downstream" if its Jira "is blocked by" links transitively include `<SLICE_KEY>`. Walk the slice graph. Store as `DOWNSTREAM_SLICES`.

### L5 — Detect slice PR state

```bash
cd {REPO_ROOT} && gh pr view slice/{EPIC_KEY}/{SLICE_NAME} --json url,state,number 2>/dev/null
```

If the slice has `V2SliceMerged`, refuse: "Slice already shipped to main. Use a manual revert PR if you want to undo, then /v2-cleanup the revert."

### L6 — Confirm

```
v2 Prune {SLICE_KEY}: [Slice {EPIC_KEY}] {SLICE_NAME}

Mode:           Slice prune
Repo:           {REPO_ROOT}
Slice branch:   slice/{EPIC_KEY}/{SLICE_NAME}
Feature branch: {FEATURE_BRANCH} ({N} slice commits to revert)
PR:             {PR_STATE} {PR_URL}

Contributing stories ({S}):
{for each story: "  - " + STORY_KEY + " (" + status + ")"}

Downstream slices ({D}):
{for each: "  - " + SLICE_KEY + " (depends on this slice — its branch will diverge after prune)"}

Actions:
  1. Revert {N} slice commit(s) on {FEATURE_BRANCH} (in reverse order) and force-push
  2. Delete slice branch slice/{EPIC_KEY}/{SLICE_NAME} (local + remote)
  3. {if PR_STATE == "OPEN": "Close PR " + PR_URL + " with prune comment" else: "Skip — PR closed/missing"}
  4. Transition {SLICE_KEY} to "Won't Do", remove V2SliceReady, add V2SliceAbandoned
  5. Append "Pruned" entry to {SLICE_KEY} activity log
  6. Comment on each contributing story noting commits reverted
  7. Comment on each downstream slice flagging the divergence

⚠ Contributing stories will retain their commits on their story branches but lose
the slice attribution. To re-route those commits to a different slice, run
/v2-rework <STORY_KEY> per story.

Type "confirm" to proceed.
```

### L7 — Revert slice commits on feature branch

Same procedure as Story Mode S8–S10: checkout feature branch, verify each SHA reachable, revert in reverse chronological order, amend with prune marker, push. Stop on conflict.

### L8 — Delete slice branch

Same procedure as v2-cleanup Step 4 (worktree detection, refuse on dirty, `branch -D`, `push origin --delete`).

### L9 — Close slice PR

If `PR_STATE == "OPEN"`:
```bash
gh pr close slice/{EPIC_KEY}/{SLICE_NAME} --comment "Pruned — slice abandoned."
```

### L10 — Cancel Jira slice

Find Won't Do transition. Labels:

```json
{
  "update": {
    "labels": [
      {"remove": "V2SliceReady"},
      {"add": "V2SliceAbandoned"}
    ]
  }
}
```

`V2Slice` stays.

Transition.

```bash
append-activity {SLICE_KEY} --heading "Pruned" --body "Slice abandoned.

- Slice branch: \`slice/{EPIC_KEY}/{SLICE_NAME}\` — deleted
- PR: {PR_URL or "(none)"} — closed
- Feature branch: {N} commits reverted
- Contributing stories: {comma-separated CONTRIBUTING_STORIES}
- Downstream slices flagged for divergence: {comma-separated DOWNSTREAM_SLICES}
- Status: transitioned to {transition}"
```

### L11 — Comment on contributing stories

For each story in `CONTRIBUTING_STORIES`:

```bash
append-activity {STORY_KEY} --heading "Slice pruned" --body "Slice {SLICE_KEY} ({SLICE_NAME}) was pruned. {C} commit(s) this story contributed to that slice have been reverted on \`{FEATURE_BRANCH}\`. The story branch still has the original commits with their Slice: trailer pointing at the now-cancelled slice. Run /v2-rework {STORY_KEY} to re-route to a different slice, or /v2-prune {STORY_KEY} if the story is also being abandoned."
```

### L12 — Comment on downstream slices

For each slice in `DOWNSTREAM_SLICES`:

```bash
append-activity {SLICE_KEY} --heading "Upstream slice pruned" --body "{SLICE_KEY_PRUNED} (an upstream dependency in the slice graph) was pruned. This slice's branch \`slice/{EPIC_KEY}/{SLICE_NAME}\` was based on it and now diverges from the chain. Re-run /epic-work {EPIC_KEY} or rebase manually."
```

Also remove the now-stale "is blocked by" Jira link from the downstream slice → pruned slice. Use `mcp__atlassian__searchJiraIssuesUsingJql` plus link removal — if the MCP doesn't support direct link removal, leave a note for the user to remove manually.

### L13 — Summary

Mirror Story Mode summary structure with slice fields.

---

## Differences from v1 /prune

- **Mode dispatch.** Same as v2-rework — story vs slice flavors based on labels.
- **Multi-commit revert.** v1 prune handles a single squash-merge commit (the ticket → feature-branch merge). v2 stories may have multiple feature-branch commits (one per slice they touched), all of which need reverting. Slices similarly accumulate commits from multiple stories.
- **Slice attribution comments.** v2 specifically comments on the *other* affected entity (story-prune comments on slices, slice-prune comments on stories) so the human running cleanup knows what to reconcile.
- **Label namespace.** `V2*Abandoned` rather than `ClaudePruned`.
- **Downstream-slice divergence.** Slice prune flags downstream slices in the graph as needing manual reconciliation — there's no analog in v1's purely-linear stack.
- **Refuse on shipped slice.** Slice prune refuses if `V2SliceMerged` is set; user must do a manual revert PR.

## Error handling

- Wrong ticket type → refuse.
- Story has no commits on feature branch and no PR and no progress labels → refuse, nothing to prune.
- Slice already shipped (`V2SliceMerged`) → refuse, manual revert PR required.
- Revert conflict → abort, stop, surface manual recovery steps. Don't touch Jira.
- Push to feature branch fails → stop before Jira changes.
- `gh pr close` fails → warn, continue.
- Jira transition unavailable → labels-only, warn.
- `append-activity` failures → warn, don't roll back.
- Linked-issue removal not supported via MCP → leave a note for manual cleanup.
