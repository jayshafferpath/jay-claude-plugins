---
description: "Clean up a ticket post-merge. Terminal cleanup (PR merged to main): delete branch, transition Jira to Done, cascade-rebase downstream, refresh feature branch. Phase-1 cleanup (Story-container PR merged into parent Epic's feature branch): retain branch and Jira state for /promote-to-main, but still cascade-rebase siblings and refresh the Epic branch. Re-run after the Story's main PR merges to finish terminal cleanup."
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
  - Bash(resolve-stack *)
  - Bash(append-activity *)
  - Read
  - Write
---

# Cleanup

Post-merge teardown for a single ticket: verify its PR landed on its merge target (typically `main`, but the parent Epic's feature branch when the cleaned ticket *is* a Story-container that PR'd to its Epic), delete the local + remote branch, remove progress labels, transition Jira to Done, append a "stack complete" note to the container's activity log if applicable, cascade-rebase any unmerged downstream tickets onto the merge target so their branches don't dangle off the deleted branch, and refresh the long-lived feature branch by resetting it to fresh `origin/{target}` and re-merging the still-unmerged ticket branches.

This is the success-path counterpart to `/prune`. Run it after `/promote-to-main` → review → squash-merge. The cascade rebase replaces a separate `/stack-rebase` invocation in the common post-merge case; pass `--no-rebase` to skip it. The feature-branch refresh prevents the long-lived feature branch from accumulating divergence against `main`; pass `--no-refresh-feature` to skip it.

## Arguments

$ARGUMENTS

Required: a Jira ticket key (e.g., `PROJ-123`). The ticket must have a `repo:` label (or be a subtask of a parent that does) so the repo root can be resolved.

Optional flags:
- `--no-rebase` — skip the post-cleanup cascade rebase of downstream stacked tickets (Step 7). Useful when downstream branches are intentionally being abandoned, or when you'd rather rebase manually later.
- `--no-refresh-feature` — skip the feature-branch refresh (Step 8). Useful if the feature branch carries hand-authored integration commits you don't want clobbered, or if you'd rather refresh manually.

Parse `$ARGUMENTS` into:
- `TICKET_KEY` — the first non-flag token.
- `REBASE_DOWNSTREAM` (boolean) — defaults to `true`, set to `false` if `--no-rebase` is present.
- `REFRESH_FEATURE` (boolean) — defaults to `true`, set to `false` if `--no-refresh-feature` is present.

---

## Step 1: Initialize

### 1a: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1b: Resolve Stack Context

Run:
```bash
resolve-stack {TICKET_KEY} --fetch
```

Parse the JSON output. Extract:
- `CONTAINER_KEY` = `container.key` (may be null for standalone tickets)
- `FEATURE_BRANCH` = `container.featureBranch` (may be null)
- `REPO_ROOT` = `container.repoRoot`
- `PARENT_CONTAINER_KEY` = `container.parentContainerKey` (null when container has no parent)
- `PARENT_FEATURE_BRANCH` = `container.parentFeatureBranch` (null when no parent feature branch)
- `STACK_ORDER` = `stack` array
- Find this ticket's entry in `STACK_ORDER` and extract:
  - `BRANCH_NAME` = ticket's `branch`
  - `SUMMARY` = ticket's `summary`

Determine the **merge target** for this ticket's PR. The same Story-container can be cleaned twice — once after merging into the parent Epic's feature branch (`DEFER_DESTRUCTIVE=true`), and again after `/promote-to-main` lands it on main (terminal cleanup). Pick the target so re-invocation does the right thing:

- If `BRANCH_NAME === FEATURE_BRANCH` AND `PARENT_FEATURE_BRANCH` is non-null:
  - Probe for a merged main-targeting PR first:
    ```bash
    cd {REPO_ROOT} && gh pr list --head {BRANCH_NAME} --base main --state merged --json number,url,mergeCommit --limit 1
    ```
    If one exists, this is the post-promotion second pass: set `MERGE_TARGET = "main"`. Terminal cleanup applies.
  - Otherwise `MERGE_TARGET = PARENT_FEATURE_BRANCH`. The Story-container has only PR'd to the Epic's feature branch so far.
- Otherwise: `MERGE_TARGET = "main"`. Default flow — ticket-branch PRs go to main once promoted.

When `MERGE_TARGET` is not `main`, several downstream steps shift target:
- Step 2 verifies merge into `MERGE_TARGET`, not `main`.
- Step 4a's "switch off the branch" checkout target becomes `MERGE_TARGET` instead of `main`.
- Step 7's cascade rebase rebases onto `MERGE_TARGET` (the Epic feature branch); PR retargets go to `MERGE_TARGET`.
- Step 8's feature-branch refresh resets to `origin/{MERGE_TARGET}` instead of `origin/main`. (The Story's own feature branch — if cleaning a sub-ticket inside the Story stack — doesn't apply here; this only affects when the cleaned ticket *is* the Story-container, which has no sibling feature branch to refresh. Step 8 is a no-op in that case and skips with `feature-refresh-not-applicable`.)

Also derive `DEFER_DESTRUCTIVE`:
- `DEFER_DESTRUCTIVE = true` only when **both** (a) `BRANCH_NAME === FEATURE_BRANCH` (the cleaned ticket is itself a stack-container, e.g. a Story whose feature branch was PR'd into a parent Epic), AND (b) `MERGE_TARGET ≠ "main"`. The Story-container has shipped to its parent Epic's feature branch but not yet to main; deleting its branch now would break `/promote-to-main`, which still needs to rebase the branch onto main. Defer branch deletion and the Jira Done-transition until the same ticket is re-cleaned after its main-targeting PR merges.
- `DEFER_DESTRUCTIVE = false` otherwise. This includes leaf tickets (subtasks under a Story, standalone tickets) whose `MERGE_TARGET` happens to be a Story feature branch — they're not stack-containers themselves and aren't subject to `/promote-to-main`, so terminal cleanup runs immediately when their PR merges into the Story.

When `DEFER_DESTRUCTIVE` is `true`:
- Step 4 is skipped entirely (branch stays alive for `/promote-to-main` to rebase).
- Step 5 still appends an activity-log entry and removes in-progress labels, but does **not** transition the ticket to Done and applies a `ClaudePendingMainPromotion` label so the orchestrator knows a follow-up cleanup is owed.
- Steps 6, 7, and 8 still run — sibling stacks need rebasing onto the refreshed Epic branch even while the just-shipped Story branch is preserved.

If `REPO_ROOT` is null: display "Cannot resolve repo root for {TICKET_KEY}. Ensure a `repo:` label is set on the ticket or its container." and **stop**.

If `BRANCH_NAME` is null: display "No branch on record for {TICKET_KEY}. If this ticket was completed via a different workflow, transition it manually." and **stop**.

### 1c: Identify Downstream Stack

From `STACK_ORDER`, find every entry whose position is **after** this ticket's index AND whose `mergedIntoMain` is `false`. Store the keys (in stack order) as `DOWNSTREAM_KEYS`.

These are the descendant tickets whose branches currently base on `BRANCH_NAME` (or transitively on it) and will be left dangling once we delete the branch. Step 7 will cascade-rebase them onto `MERGE_TARGET`.

If `CONTAINER_KEY` is null (standalone ticket) or `DOWNSTREAM_KEYS` is empty, mark `REBASE_DOWNSTREAM = false` regardless of the flag — there's nothing to rebase.

When `MERGE_TARGET ≠ main`, the cleaned ticket is itself a stack-container (its `BRANCH_NAME === FEATURE_BRANCH`). Its sibling Stories under the same Epic may also block on it. Those siblings live as separate stacks, not in `STACK_ORDER`, so they aren't listed here — the orchestrator picks them up next round when their `unblockedBlockers` clears.

---

## Step 2: Verify Merge to Target

This step is **strict** — refuse to clean up unless we can prove the ticket actually shipped to its `MERGE_TARGET`.

### 2a: Fetch

```bash
cd {REPO_ROOT} && git fetch origin
```

### 2b: PR State

```bash
cd {REPO_ROOT} && gh pr list --head {BRANCH_NAME} --base {MERGE_TARGET} --state all --json number,state,url,mergeCommit --limit 5
```

Find the most recent PR whose `state` is `"MERGED"`. If none exists, display:

```
Refuse to clean up — no merged PR to {MERGE_TARGET} found for {BRANCH_NAME}.

Open PRs and unmerged history are handled by /prune (abandon) or by waiting
for the PR to merge. /cleanup only runs after a successful merge.
```
and **stop**.

Store `PR_NUMBER`, `PR_URL`, and `MERGE_SHA` = `mergeCommit.oid` from the matched PR.

If `MERGE_SHA` is empty/null (rare — happens for some merge strategies on very old PRs): display "Merged PR {PR_URL} has no merge commit SHA on record. Cannot verify against {MERGE_TARGET}; stopping." and **stop**.

### 2c: Verify SHA Reachable from Target

```bash
cd {REPO_ROOT} && git merge-base --is-ancestor {MERGE_SHA} origin/{MERGE_TARGET}
```

If exit code is non-zero: display:

```
Refuse to clean up — merge commit {MERGE_SHA} (PR {PR_URL}) is not reachable
from origin/{MERGE_TARGET}. Either {MERGE_TARGET} has been rewritten or the
merge has not yet landed locally. Investigate before continuing.
```
and **stop**.

---

## Step 3: Confirm with User

Display the impact summary:

```
Cleanup {TICKET_KEY}: {SUMMARY}

Repo:           {REPO_ROOT}
Branch:         {BRANCH_NAME}
PR:             {PR_URL} (merged into {MERGE_TARGET}, {MERGE_SHA})
Container:      {CONTAINER_KEY or "(standalone)"}
Feature branch: {FEATURE_BRANCH or "(none)"}
{if MERGE_TARGET ≠ "main":
  "Parent epic:    " + PARENT_CONTAINER_KEY + " (feature branch: " + PARENT_FEATURE_BRANCH + ")"}

Actions:
{if DEFER_DESTRUCTIVE is false:
  "  1. Delete local branch {BRANCH_NAME} (if present)
  2. Delete remote branch origin/{BRANCH_NAME} (if present)
  3. Transition {TICKET_KEY} in Jira to Done
  4. Remove progress labels (ClaudeReady, ClaudePlanning, ClaudeExecuting, ClaudeStackReady, ClaudePRApproved, ClaudeNeedsReview, ClaudeFailed)
  5. Append \"Shipped\" entry to {TICKET_KEY} activity log"
else:
  "  1. (deferred) Branch {BRANCH_NAME} kept alive — needed for /promote-to-main onto main
  2. (deferred) {TICKET_KEY} stays In Progress — Done transition runs after main-merge cleanup
  3. Remove in-progress labels and apply ClaudePendingMainPromotion
  4. Append \"Shipped to {MERGE_TARGET}\" entry to {TICKET_KEY} activity log"}
{if this is the last unmerged ticket in CONTAINER_KEY:
  "  6. Append \"Stack complete\" entry to " + CONTAINER_KEY + " activity log"}
{if REBASE_DOWNSTREAM is true:
  "  7. Cascade-rebase downstream tickets onto " + MERGE_TARGET + ": " + comma-separated DOWNSTREAM_KEYS + " (force-push each)"}
{else if DOWNSTREAM_KEYS is non-empty AND --no-rebase was passed:
  "  (skipping cascade rebase per --no-rebase; downstream still bases on the deleted branch: " + comma-separated DOWNSTREAM_KEYS + ")"}
{if REFRESH_FEATURE is true AND FEATURE_BRANCH is non-null AND BRANCH_NAME ≠ FEATURE_BRANCH:
  "  8. Refresh feature branch " + FEATURE_BRANCH + ": reset --hard to origin/" + MERGE_TARGET + ", re-merge unmerged ticket branches (" + comma-separated DOWNSTREAM_KEYS + "), force-push"}
{else if FEATURE_BRANCH is non-null AND BRANCH_NAME ≠ FEATURE_BRANCH AND --no-refresh-feature was passed:
  "  (skipping feature-branch refresh per --no-refresh-feature; " + FEATURE_BRANCH + " stays as-is and may diverge from " + MERGE_TARGET + ")"}
{else if BRANCH_NAME == FEATURE_BRANCH:
  "  (no feature-branch refresh applies — the cleaned branch IS the feature branch)"}
```

Then prompt:

```
Type "confirm" to proceed, or anything else to abort.
```

If the user does not type an affirmative ("confirm", "yes", "do it", "go ahead"):
- Display: "Cleanup aborted."
- **Stop.**

---

## Step 4: Delete Branch

If `DEFER_DESTRUCTIVE` is `true`, skip this entire step. The branch must remain on disk and on the remote so `/promote-to-main` can later check it out and rebase it onto main. Display: "Skipping branch delete — {BRANCH_NAME} is being kept alive until {TICKET_KEY} merges to main." and continue to Step 5.

### 4a: Detect Current Branch

```bash
cd {REPO_ROOT} && git branch --show-current
```

If the current branch is `{BRANCH_NAME}`, switch off it first so the delete can proceed:

```bash
git checkout {MERGE_TARGET} && git pull origin {MERGE_TARGET} --ff-only
```

If the checkout fails (uncommitted changes, etc.): display the error and **stop** before touching anything else.

### 4b: Delete Local Branch

```bash
cd {REPO_ROOT} && git branch -D {BRANCH_NAME} 2>/dev/null
```

`-D` is intentional — the branch was merged via squash, so `-d` would refuse. If the branch doesn't exist locally, the command exits non-zero; that's fine — continue.

### 4c: Delete Remote Branch

```bash
cd {REPO_ROOT} && git push origin --delete {BRANCH_NAME} 2>&1
```

If the remote branch is already gone (`remote ref does not exist`), continue silently. For any other error, report it but **continue** — remote branch state is not load-bearing for the rest of cleanup.

Display: "Deleted branch {BRANCH_NAME} (local + remote)."

---

## Step 5: Update Jira

### 5a: Find Done Transition

Skip if `DEFER_DESTRUCTIVE` is `true` — no transition runs until the main-merge cleanup. Set `TRANSITION_ID = null` and continue to 5b.

Otherwise, use `mcp__atlassian__getTransitionsForJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`.

From the `transitions` array, find the first transition whose `name` matches (case-insensitive) one of: `Done`, `Closed`, `Resolved`, `Complete`, `Completed`. Store its `id` as `TRANSITION_ID`.

If no matching transition is found:
- Display: "No done-style transition available for {TICKET_KEY}. Available transitions: {names}. Updating labels only."
- Set `TRANSITION_ID = null` and continue to 5b.

### 5b: Update Labels

Use `mcp__atlassian__editJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`.

If `DEFER_DESTRUCTIVE` is `true`, also add `ClaudePendingMainPromotion` so the orchestrator knows a follow-up cleanup is owed once this ticket merges to main:

```json
{
  "update": {
    "labels": [
      {"remove": "ClaudeReady"},
      {"remove": "ClaudePlanning"},
      {"remove": "ClaudeExecuting"},
      {"remove": "ClaudeStackReady"},
      {"remove": "ClaudePRApproved"},
      {"remove": "ClaudeNeedsReview"},
      {"remove": "ClaudeFailed"},
      {"add": "ClaudePendingMainPromotion"}
    ]
  }
}
```

Otherwise (terminal cleanup) omit the `ClaudePendingMainPromotion` add and additionally remove it in case it was applied on a prior pass:

```json
{
  "update": {
    "labels": [
      {"remove": "ClaudeReady"},
      {"remove": "ClaudePlanning"},
      {"remove": "ClaudeExecuting"},
      {"remove": "ClaudeStackReady"},
      {"remove": "ClaudePRApproved"},
      {"remove": "ClaudeNeedsReview"},
      {"remove": "ClaudeFailed"},
      {"remove": "ClaudePendingMainPromotion"}
    ]
  }
}
```

Note: `ClaudeWork` is durable and never removed. No new terminal label is added — Jira status (Done) is the source of truth for terminal cleanup.

### 5c: Transition Status

Skip if `TRANSITION_ID` is null (covers both "no done-style transition" and `DEFER_DESTRUCTIVE` cases).

Use `mcp__atlassian__transitionJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`, `transition: {"id": TRANSITION_ID}`.

### 5d: Append Ticket Activity Log

If `DEFER_DESTRUCTIVE` is `true`, body:

```
Shipped to {MERGE_TARGET} (Epic feature branch). Awaiting main promotion.

- PR: {PR_URL}
- Merge commit: `{MERGE_SHA}`
- Branch retained: `{BRANCH_NAME}` — kept until /promote-to-main lands it on main
- Status: still In Progress; ClaudePendingMainPromotion applied
```

Otherwise (terminal cleanup) body:

```
Shipped to {MERGE_TARGET}.

- PR: {PR_URL}
- Merge commit: `{MERGE_SHA}`
- Branch deleted: `{BRANCH_NAME}` (local + remote)
- Status: transitioned to {transition name} {or "(no transition applied — labels only)"}
```

Write to a temp file and run:

```bash
append-activity {TICKET_KEY} --heading "Shipped" --body-file <tmp-cleanup-summary.md>
```

---

## Step 6: Container Progress Note

Skip this step if `CONTAINER_KEY` is null (standalone ticket).

### 6a: Detect "Last Unmerged Ticket"

From `STACK_ORDER`, count entries where `mergedIntoMain === false` AND `key !== {TICKET_KEY}`. (The current ticket's `mergedIntoMain` was false at the time `resolve-stack` was called — we just shipped it.)

If the count is `> 0`: skip Step 6 entirely (other tickets in the stack are still in flight).

If the count is `0`: this was the last ticket. Continue to 6b.

### 6b: Append Container Activity Log

Body:

```
Stack complete — all tickets shipped to {MERGE_TARGET}.

- Final ticket: {TICKET_KEY} ({PR_URL})
- Feature branch: `{FEATURE_BRANCH or "(none)"}`
- Tickets in stack: {comma-separated keys from STACK_ORDER}
```

Run:

```bash
append-activity {CONTAINER_KEY} --heading "Stack complete" --body-file <tmp-stack-complete.md>
```

The container itself is not auto-transitioned — leave that to the user or a separate convention.

---

## Step 7: Cascade-Rebase Downstream Stack

Skip this step if `REBASE_DOWNSTREAM` is false (no downstream, standalone ticket, or `--no-rebase` was passed).

This step cascades rebases through every downstream ticket in `DOWNSTREAM_KEYS`, retargeting them onto `MERGE_TARGET` (typically `main`, but the parent Epic's feature branch when cleaning a Story-container) since the branch they were stacked on has just been merged and deleted. It mirrors `/stack-rebase` Scenario A semantics, run inline so post-merge teardown and stack repair are one flow.

### 7a: Refresh Stack View

Re-run:
```bash
resolve-stack {TICKET_KEY} --fetch
```

Recompute `DOWNSTREAM_KEYS` from the fresh output (in case anything changed). If now empty, skip to Step 8.

### 7b: Iterate Downstream Tickets

Initialize:
- `REBASE_RESULTS = []` — accumulate per-ticket outcome (`rebased`, `skipped`, `conflict`, `push-failed`).
- `PREVIOUS_BASE = {MERGE_TARGET}` — what the next branch in the chain should be rebased onto.
- `PREVIOUS_OLD_BASE = {BRANCH_NAME}` — what the first downstream's branch was *originally* based on (the deleted branch). For subsequent iterations, this becomes the previous downstream's branch name.

For each `DOWNSTREAM_TICKET` in `DOWNSTREAM_KEYS`, in stack order:

#### 7b-i: Determine Branch

Look up `DOWNSTREAM_TICKET`'s entry in the refreshed `STACK_ORDER`. Extract `DOWNSTREAM_BRANCH = entry.branch`.

If `DOWNSTREAM_BRANCH` is null: append `{ ticket: DOWNSTREAM_TICKET, status: "skipped", reason: "no branch on record" }` to `REBASE_RESULTS` and continue.

#### 7b-ii: Detect Worktree

```bash
cd {REPO_ROOT} && git worktree list | grep {DOWNSTREAM_BRANCH}
```

If a worktree exists, run subsequent git commands inside it. Otherwise operate on the branch directly inside `REPO_ROOT`.

#### 7b-iii: Rebase

```bash
cd {REPO_ROOT} && git checkout {DOWNSTREAM_BRANCH}
cd {REPO_ROOT} && git rebase --onto {PREVIOUS_BASE} {PREVIOUS_OLD_BASE} {DOWNSTREAM_BRANCH}
```

If the rebase reports conflicts:

1. Capture conflicting files: `git diff --name-only --diff-filter=U`
2. Abort: `git rebase --abort`
3. Append `{ ticket: DOWNSTREAM_TICKET, status: "conflict", files: [...] }` to `REBASE_RESULTS`.
4. **Stop iterating downstream** — do not attempt subsequent tickets, since they transitively depend on this branch's rebased state. Continue to Step 7c with the partial results.

If the rebase succeeds, continue.

#### 7b-iv: Force-Push

```bash
cd {REPO_ROOT} && git push --force-with-lease origin {DOWNSTREAM_BRANCH}
```

If the push fails (branch protection, lease mismatch, etc.): append `{ ticket: DOWNSTREAM_TICKET, status: "push-failed", error: "..." }` to `REBASE_RESULTS` and **continue** to the next ticket — the local branch is still rebased correctly.

Otherwise, append `{ ticket: DOWNSTREAM_TICKET, status: "rebased", new_base: PREVIOUS_BASE }` to `REBASE_RESULTS`.

#### 7b-v: Retarget PR (First Downstream Only)

If this is the first ticket in `DOWNSTREAM_KEYS` (`PREVIOUS_BASE == {MERGE_TARGET}`), its PR currently targets `{BRANCH_NAME}` (which no longer exists on the remote). Retarget it:

```bash
cd {REPO_ROOT} && gh pr list --head {DOWNSTREAM_BRANCH} --state open --json number --limit 1
```

If a PR exists, run:

```bash
cd {REPO_ROOT} && gh pr edit {PR_NUMBER} --base {MERGE_TARGET}
```

If `gh pr edit` fails or no open PR is found, log a warning to `REBASE_RESULTS[*].pr_retarget_warning` but continue.

#### 7b-vi: Append Activity Log

```bash
append-activity {DOWNSTREAM_TICKET} --heading "Branch rebased" --body "Rebased onto \`{PREVIOUS_BASE}\` after {TICKET_KEY} merged to \`{MERGE_TARGET}\` (cleanup cascade)."
```

#### 7b-vii: Advance Iterator

Set `PREVIOUS_OLD_BASE = DOWNSTREAM_BRANCH` and `PREVIOUS_BASE = DOWNSTREAM_BRANCH` for the next iteration.

### 7c: Report Rebase Outcome

If `REBASE_RESULTS` contains any `conflict` entries, display:

```
Cascade rebase stopped at {conflict ticket}: conflicting files
- path/one
- path/two

Remaining downstream not rebased: {keys after the conflict}.

Resolve manually, then re-run: /stack-rebase {conflict ticket}
```

Otherwise, summarize successes and any push warnings inline in the Step 9 summary.

---

## Step 8: Refresh Feature Branch

Skip this step if any of:
- `REFRESH_FEATURE` is `false` (`--no-refresh-feature` was passed).
- `FEATURE_BRANCH` is null (no long-lived feature branch in this container).
- `BRANCH_NAME == FEATURE_BRANCH` (the cleaned branch IS the feature branch — there is nothing left to refresh; the container's stack is already shipped). Set outcome to `feature-refresh-not-applicable` and continue to Step 9.
- Step 7 ended with a `conflict` outcome (the cascade is in a partial state — refreshing the feature branch on top of half-rebased downstream would mask the conflict). Display "Skipping feature-branch refresh — cascade rebase did not complete." and continue to Step 9.

Otherwise, rebuild the feature branch as `origin/{MERGE_TARGET}` plus a clean re-merge of every still-unmerged ticket branch. This avoids the patch-id failure mode of `git rebase origin/{MERGE_TARGET}` against squash-merged commits.

### 8a: Detect Local-Only Commits on Feature Branch

We must not silently destroy hand-authored integration commits that aren't part of any ticket branch. Compute the set of commits reachable from `FEATURE_BRANCH` but *not* reachable from `origin/{MERGE_TARGET}` or from any branch in `DOWNSTREAM_KEYS`:

```bash
cd {REPO_ROOT} && git fetch origin
cd {REPO_ROOT} && git log {FEATURE_BRANCH} --not origin/{MERGE_TARGET} {space-separated DOWNSTREAM_BRANCH names from STACK_ORDER} --oneline
```

If the output is non-empty, display:

```
Refuse to refresh feature branch {FEATURE_BRANCH} — found commits reachable
from the feature branch that are NOT in origin/{MERGE_TARGET} and NOT in any tracked
ticket branch:

  {commit list}

These would be destroyed by a reset. Resolve manually:
  - Move these commits onto a ticket branch, or
  - Re-run with --no-refresh-feature.

Continuing without refreshing the feature branch.
```

Set the feature-refresh outcome to `skipped-orphans` and continue to Step 9.

### 8b: Detect Dirty Worktrees on Feature Branch

```bash
cd {REPO_ROOT} && git worktree list --porcelain
```

For any worktree whose `branch` is `refs/heads/{FEATURE_BRANCH}`, check its working tree state by running `git -C {worktree_path} status --porcelain`. If any output exists (uncommitted changes), display:

```
Refuse to refresh feature branch {FEATURE_BRANCH} — worktree at {worktree_path}
has uncommitted changes. Force-pushing would create reflog churn there.

Either commit/stash those changes or re-run with --no-refresh-feature.
```

Set the feature-refresh outcome to `skipped-dirty-worktree` and continue to Step 9.

### 8c: Capture Pre-Refresh SHA

```bash
cd {REPO_ROOT} && git rev-parse {FEATURE_BRANCH}
```

Store as `FEATURE_OLD_SHA` — included in the activity log so the prior state is recoverable via reflog or direct SHA reference if anything goes sideways.

### 8d: Reset to origin/{MERGE_TARGET}

Switch to the feature branch and hard-reset to fresh `MERGE_TARGET`:

```bash
cd {REPO_ROOT} && git checkout {FEATURE_BRANCH}
cd {REPO_ROOT} && git reset --hard origin/{MERGE_TARGET}
```

If `git checkout` fails (uncommitted changes in the primary worktree), display the error, set outcome to `skipped-checkout-failed`, and continue to Step 9. Don't risk losing local edits.

### 8e: Re-Merge Unmerged Ticket Branches

For each `DOWNSTREAM_BRANCH` corresponding to a `DOWNSTREAM_KEYS` entry whose Step 7 status was `rebased` (skip `skipped`, `conflict`, `push-failed` entries — `push-failed` is fine to remerge since the local branch is correct, but `conflict` and `skipped` mean the branch state is unreliable):

Actually, refine: re-merge every `DOWNSTREAM_BRANCH` whose Step 7 status is `rebased` OR `push-failed` (both have correct local state). Skip `conflict` and `skipped` entries.

For each eligible branch in stack order:

```bash
cd {REPO_ROOT} && git merge --no-ff {DOWNSTREAM_BRANCH} -m "Merge {DOWNSTREAM_TICKET}: {summary} into {FEATURE_BRANCH}"
```

If a merge reports conflicts (this should be rare since the ticket branches were just rebased onto fresh `MERGE_TARGET`, but ticket-vs-ticket conflicts are possible):

1. Capture conflicting files: `git diff --name-only --diff-filter=U`
2. Abort: `git merge --abort`
3. Display:
   ```
   Conflict merging {DOWNSTREAM_BRANCH} into {FEATURE_BRANCH}.
   Conflicting files:
   - {paths}

   Stopping feature-branch refresh. The feature branch is currently at
   origin/{MERGE_TARGET} + the cleanly-merged tickets so far. To finish manually:
     git checkout {FEATURE_BRANCH}
     git merge --no-ff {DOWNSTREAM_BRANCH}
     # resolve conflicts
     git push --force-with-lease
   ```
4. Record outcome `partial-merge-conflict`, capture the partial merge list, and **stop** the merge loop. Continue to Step 8f to push whatever did merge cleanly.

### 8f: Force-Push the Refreshed Feature Branch

Even on partial completion, push what we have so the remote reflects the refreshed state:

```bash
cd {REPO_ROOT} && git push --force-with-lease origin {FEATURE_BRANCH}
```

If the push fails: warn, set outcome to `pushed-failed` (but local state is correct), and continue.

Otherwise, set outcome to `refreshed` (or `partial-merge-conflict` if step 8e bailed early).

### 8g: Append Activity Log

Append to the container's activity log:

```bash
append-activity {CONTAINER_KEY} --heading "Feature branch refreshed" --body "Reset \`{FEATURE_BRANCH}\` from \`{FEATURE_OLD_SHA}\` to \`origin/{MERGE_TARGET}\` after {TICKET_KEY} merged. Re-merged: {comma-separated re-merged ticket keys}. Outcome: {outcome}."
```

If `CONTAINER_KEY` is null but `FEATURE_BRANCH` is not (unusual but possible), skip the activity log.

---

## Step 9: Summary

Display:

```
Cleanup {TICKET_KEY} — {if DEFER_DESTRUCTIVE: "Phase 1 Complete (awaiting main promotion)" else: "Complete"}

Branch:         {if DEFER_DESTRUCTIVE: BRANCH_NAME + " — retained (needed by /promote-to-main)" else: BRANCH_NAME + " — deleted (local + remote)"}
PR:             {PR_URL} (merged at {MERGE_SHA})
Jira:           {if DEFER_DESTRUCTIVE: "still In Progress; ClaudePendingMainPromotion applied" else: transition name or "labels updated only"}
{if container note appended:
"Container:      " + CONTAINER_KEY + " — stack complete note appended"}
{if REBASE_RESULTS is non-empty:
"Stack rebase:
  - {ticket}: rebased onto {new_base}, pushed
  - {ticket}: rebased onto {new_base}, push-failed ({error})
  - {ticket}: CONFLICT — chain stopped here
  - {remaining tickets}: not rebased (chain stopped)
"
else if DOWNSTREAM_KEYS was non-empty AND --no-rebase was passed:
"Stack rebase:    skipped (--no-rebase) — " + comma-separated DOWNSTREAM_KEYS + " still base on the deleted branch"}
{if feature-branch refresh ran:
"Feature branch:  " + FEATURE_BRANCH + " — " + outcome + " (was " + FEATURE_OLD_SHA[:8] + ", re-merged " + count + " ticket(s))"
else if FEATURE_BRANCH is non-null AND refresh was skipped:
"Feature branch:  " + FEATURE_BRANCH + " — refresh skipped (" + skip_reason + ")"}
{if DEFER_DESTRUCTIVE is true:
"
Next steps:
  - /promote-to-main " + CONTAINER_KEY + " when ready to promote " + TICKET_KEY + " (and the rest of the Epic stack) to main.
  - After " + TICKET_KEY + "'s main-targeting PR merges, re-run /cleanup " + TICKET_KEY + " for the destructive phase: branch delete + Jira Done."}
```

---

## Error Handling

- If repo root cannot be resolved: refuse to run.
- When `DEFER_DESTRUCTIVE` is true: Steps 4 (branch delete) and 5c (Jira transition) are skipped; the ticket stays In Progress with `ClaudePendingMainPromotion` applied. The branch must remain on disk and on the remote because `/promote-to-main` rebases it onto main next. After the main-targeting PR merges, re-run `/cleanup {TICKET_KEY}` — the second invocation will detect the merged main PR via Step 1b's probe and run terminal cleanup.
- If no merged PR to `MERGE_TARGET` is found: refuse to run — direct the user to `/prune` (abandon) or wait for merge.
- If the merge SHA is not reachable from `origin/{MERGE_TARGET}`: refuse — `MERGE_TARGET` may have been rewritten, or the merge isn't local yet.
- If the working tree is dirty when we need to switch off the branch: stop before touching anything.
- If `git branch -D` fails because the branch is absent locally: continue.
- If `git push origin --delete` fails for any reason other than "ref does not exist": warn but continue.
- If the Jira Done transition is unavailable: fall back to labels-only and warn.
- If `append-activity` fails: warn but do not roll back — branch deletion and Jira state are already applied.
- If a downstream rebase conflicts: abort that rebase, stop the cascade, and surface the failing ticket. Earlier successful rebases stay applied; later tickets are left untouched.
- If a downstream force-push fails: warn and continue — local branch is rebased; the user can push manually.
- If `gh pr edit` retargeting fails for the first downstream PR: warn and continue — the rebase itself succeeded; only the PR base needs manual fixup.
- Never auto-resolve merge conflicts during the cascade.
- If the feature branch has commits not reachable from `origin/{MERGE_TARGET}` *and* not in any tracked ticket branch (orphan integration commits): refuse to refresh and log them. The user must move them onto a ticket branch or pass `--no-refresh-feature`.
- If a worktree on the feature branch has uncommitted changes: refuse to refresh — force-pushing would create reflog churn there and confuse the user's in-progress work.
- If the cascade rebase ended with a `conflict` outcome: skip the feature-branch refresh entirely — refreshing on top of a half-rebased downstream would mask the conflict.
- If a re-merge into the feature branch conflicts: abort that merge, push whatever merged cleanly so far, and surface the conflicting branch with manual recovery instructions. Don't attempt subsequent merges.
- If the feature-branch force-push fails: warn — the local branch is the source of truth and the user can push manually.
- The pre-refresh feature-branch SHA is recorded in the activity log and remains in the reflog. Recovery from an unwanted refresh is `git reset --hard {FEATURE_OLD_SHA}` followed by `git push --force-with-lease`.
