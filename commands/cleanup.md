---
description: "Auto-dispatching cleanup. Detects merge target and runs the right phase: terminal (PR merged to main) → delete branch, Jira→Done, cascade-rebase, refresh feature branch; phase-1 (PR merged into a feature branch instead of main — a Story-container into its parent Epic's branch, or a leaf into its container's) → retain branch + Jira state for /promote-to-main, cascade-rebase siblings, refresh the feature branch. If you know the phase, prefer the explicit entry points: /cleanup-main (post main-merge) or /cleanup-feature (post feature-branch merge)."
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
  - Bash(cascade-rebase *)
  - Bash(verify-merge *)
  - Bash(cleanup-feature-refresh *)
  - Read
  - Write
---

# Cleanup

> **Label source of truth**: `cli/lib/labels.js` is canonical for the Claude lifecycle label set (`PROGRESS_LABELS`, `DURABLE_LABELS`, `CONTAINER_LABELS`). The JSON patches below enumerate labels explicitly because Atlassian's API needs the exact list — but if a label is added or removed lifecycle-wide, update `labels.js` first and then sync the patches here.

Post-merge teardown for a single ticket: verify its PR landed on its merge target (typically `main`, but the parent Epic's feature branch when the cleaned ticket *is* a Story-container that PR'd to its Epic), delete the local + remote branch, remove progress labels, transition Jira to Done, append a "stack complete" note to the container's activity log if applicable, cascade-rebase any unmerged downstream tickets onto the merge target so their branches don't dangle off the deleted branch, and refresh the long-lived feature branch by resetting it to fresh `origin/{target}` and re-merging the still-unmerged ticket branches.

This is the success-path counterpart to `/prune`. Run it after `/promote-to-main` → review → squash-merge. The cascade rebase replaces a separate `/stack-rebase` invocation in the common post-merge case; pass `--no-rebase` to skip it. The feature-branch refresh prevents the long-lived feature branch from accumulating divergence against `main`; pass `--no-refresh-feature` to skip it.

## Arguments

$ARGUMENTS

Required: a Jira ticket key (e.g., `PROJ-123`). The ticket must have a `repo:` label (or be a subtask of a parent that does) so the repo root can be resolved.

Optional flags:
- `--no-rebase` — skip the post-cleanup cascade rebase of downstream stacked tickets (Step 7). Useful when downstream branches are intentionally being abandoned, or when you'd rather rebase manually later.
- `--no-refresh-feature` — skip the feature-branch refresh (Step 8). Useful if the feature branch carries hand-authored integration commits you don't want clobbered, or if you'd rather refresh manually.
- `--yes` (alias: `--no-confirm`) — skip the interactive confirmation prompt at the end of Step 3. Print the plan, then proceed straight into Step 4. Used by `/orchestrate` so its auto-safe cleanup pass doesn't deadlock on a prompt; humans should generally omit the flag and review the plan first.
- `--require-phase={feature|main}` — assert the detected cleanup phase before proceeding. `feature` accepts only Phase-1 cleanup (merged into a feature branch rather than `main`, container or leaf); `main` accepts only terminal cleanup (PR merged to `main`). If the detected phase doesn't match, refuse with a pointer to the other entry point. Set by `/cleanup-feature` and `/cleanup-main`; humans calling `/cleanup` directly should omit it.

Parse `$ARGUMENTS` into:
- `TICKET_KEY` — the first non-flag token.
- `REBASE_DOWNSTREAM` (boolean) — defaults to `true`, set to `false` if `--no-rebase` is present.
- `REFRESH_FEATURE` (boolean) — defaults to `true`, set to `false` if `--no-refresh-feature` is present.
- `AUTO_CONFIRM` (boolean) — defaults to `false`, set to `true` if `--yes` or `--no-confirm` is present.
- `REQUIRE_PHASE` (string|null) — defaults to `null`. Set to `"feature"` or `"main"` if `--require-phase={feature|main}` is present. Any other value is an arg-parse error: display "Unknown --require-phase value: {value}. Expected `feature` or `main`." and **stop**.

---

## Step 1: Initialize

### 1a: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1b: Resolve Stack Context

Run the **Stack Context Resolution** sub-procedure (`commands/_shared-stack-procedures.md`) with `KEY={TICKET_KEY}` and `FETCH=true`. After it runs, also extract from the input ticket's entry in `STACK_ORDER`:
- `BRANCH_NAME` = ticket's `branch`
- `SUMMARY` = ticket's `summary`

Determine the **merge target** for this ticket's PR. The same Story-container can be cleaned twice — once after merging into the parent Epic's feature branch (`DEFER_DESTRUCTIVE=true`), and again after `/promote-to-main` lands it on main (terminal cleanup). Pick the target so re-invocation does the right thing.

Let `ENTRY = STACK_ORDER.find(s => s.key === TICKET_KEY)`. Prefer `resolve-stack`'s merge flags as the source of truth — they already reflect ancestry against both `origin/main` and the container's feature branch, so leaf tickets (which have `BRANCH_NAME !== FEATURE_BRANCH`) get routed correctly instead of defaulting to `main`.

- If `ENTRY.mergedIntoMain === true`: `MERGE_TARGET = "main"`. Terminal cleanup applies.
- Else if `ENTRY.mergedIntoFeature === true` AND `FEATURE_BRANCH` is non-null:
  - If `BRANCH_NAME === FEATURE_BRANCH` AND `PARENT_FEATURE_BRANCH` is non-null: `MERGE_TARGET = PARENT_FEATURE_BRANCH`. Story-container shipped to the parent Epic's feature branch.
  - Otherwise: `MERGE_TARGET = FEATURE_BRANCH`. Leaf ticket (subtask/Story with no children) shipped to its container's feature branch.
- Else if `BRANCH_NAME === FEATURE_BRANCH` AND `PARENT_FEATURE_BRANCH` is non-null:
  - Story-container fallback for the not-yet-flagged case (pre-tagging window before `resolve-stack` observes the merge). Probe for a merged main-targeting PR first:
    ```bash
    verify-merge {BRANCH_NAME} --base main --cwd {REPO_ROOT}
    ```
    If `merged` is `true` in the output, this is the post-promotion second pass: set `MERGE_TARGET = "main"`. Terminal cleanup applies.
  - Otherwise `MERGE_TARGET = PARENT_FEATURE_BRANCH`.
- Otherwise: `MERGE_TARGET = "main"`. Default flow — ticket-branch PRs go to main once promoted.

When `MERGE_TARGET` is not `main`, several downstream steps shift target:
- Step 2 verifies merge into `MERGE_TARGET`, not `main`.
- Step 4a's "switch off the branch" checkout target becomes `MERGE_TARGET` instead of `main`.
- Step 7's cascade rebase rebases onto `MERGE_TARGET` (the Epic feature branch); PR retargets go to `MERGE_TARGET`.
- Step 8's feature-branch refresh resets to `origin/{MERGE_TARGET}` instead of `origin/main`. When the cleaned ticket *is* the stack-container (`BRANCH_NAME === FEATURE_BRANCH`) there is no sibling feature branch to refresh, so Step 8 is a no-op and skips with `feature-refresh-not-applicable`. When the cleaned ticket is a **leaf** whose PR merged into its container's `FEATURE_BRANCH`, Step 8 does apply: that container branch is the one to refresh, and it now happens with the leaf's own branch still on disk (see `DEFER_DESTRUCTIVE` below), which is the state Step 8a's replay path prefers.

Also derive `DEFER_DESTRUCTIVE`:
- `DEFER_DESTRUCTIVE = true` whenever `MERGE_TARGET ≠ "main"` — regardless of whether the cleaned ticket is a stack-container or a leaf. The ticket has shipped to a feature branch but not to main, so deleting its branch now would break `/promote-to-main`, which still needs it (as the branch to rebase, or as a successor's `UPSTREAM_BRANCH` in the Step 2a rebase fallback), and transitioning it to Done would claim shipped-to-main for code that is still only on a feature branch. Defer branch deletion, the progress-label clear, and the Jira Done-transition until the same ticket is re-cleaned after its main-targeting PR merges.
- `DEFER_DESTRUCTIVE = false` only when `MERGE_TARGET == "main"`.

> **Leaves defer too — they are the ordinary unit of promotion.** An earlier version of this rule also required `BRANCH_NAME === FEATURE_BRANCH`, so a leaf whose PR merged into its container's feature branch ran *terminal* cleanup immediately, on the premise that a leaf is never promoted separately and reaches main implicitly when the Epic branch does. That premise is false: `/promote-to-main` Step 1c accepts a **leaf ticket key** directly ("If `{RESOLVED_KEY}` matches a ticket key in `STACK_ORDER` (i.e. a leaf, not the container)"), and its container-key path promotes leaves one at a time off `GIT_MERGE_ORDER`. Terminal cleanup on a feature-branch merge therefore marked Stories Done before their code reached main and deleted branches that `/promote-to-main` still needed. It was also self-defeating: with the branch gone, the classifier's rule 0 reports `cleaned` (not auto-safe), so nothing ever revisited the ticket to mark it Done once the work genuinely landed.

When `DEFER_DESTRUCTIVE` is `true`:
- Step 4 is skipped entirely (branch stays alive for `/promote-to-main` to rebase).
- Step 5 still appends an activity-log entry, but does **not** transition the ticket to Done and does **not** touch progress labels — the ticket stays in its current in-progress state so `/promote-to-main` still sees live Jira state. The `merged/{TICKET_KEY}` tag written in Step 2d is what tells a later `/cleanup` or `/orchestrate` run that phase-1 already ran and a follow-up cleanup is owed.
- Steps 6, 7, and 8 still run — sibling stacks need rebasing onto the refreshed Epic branch even while the just-shipped Story branch is preserved.

If `REPO_ROOT` is null: display "Cannot resolve repo root for {TICKET_KEY}. Ensure a `repo:` label is set on the ticket or its container." and **stop**.

If `BRANCH_NAME` is null: display "No branch on record for {TICKET_KEY}. If this ticket was completed via a different workflow, transition it manually." and **stop**.

#### Phase guard (`--require-phase`)

If `REQUIRE_PHASE` is non-null, validate against the detected phase before doing any irreversible work. The detected phase is `"feature"` when `DEFER_DESTRUCTIVE` is `true`, otherwise `"main"`.

- If `REQUIRE_PHASE == "feature"` AND `DEFER_DESTRUCTIVE` is `false`:
  ```
  Refuse to run /cleanup-feature on {TICKET_KEY} — detected phase is terminal
  (MERGE_TARGET={MERGE_TARGET}). The PR landed on main, not on a feature
  branch. Use /cleanup-main {TICKET_KEY} instead.
  ```
  and **stop**.
- If `REQUIRE_PHASE == "main"` AND `DEFER_DESTRUCTIVE` is `true`:
  ```
  Refuse to run /cleanup-main on {TICKET_KEY} — detected phase is phase-1
  (MERGE_TARGET={MERGE_TARGET}, a feature branch). The ticket has shipped to
  that branch but not yet to main, so it is not Done and its branch is still
  needed. Use /cleanup-feature {TICKET_KEY} now; re-run /cleanup-main
  {TICKET_KEY} after /promote-to-main lands it on main.
  ```
  and **stop**.

Otherwise (phase matches, or `REQUIRE_PHASE` is null) continue.

> **The detected phase now tracks `MERGE_TARGET` exactly.** `DEFER_DESTRUCTIVE` is true for *every* ticket whose PR landed on a feature branch, container or leaf, so `--require-phase=feature` and `--require-phase=main` partition cleanly on where the PR actually merged. `--require-phase=main` no longer accepts a leaf that merged into a feature branch; that case is `feature` and routes to `/cleanup-feature`. Step 2's `verify-merge` against `MERGE_TARGET` remains the only thing that establishes what the PR landed on, and Step 4d still keys tag retirement on `MERGE_TARGET == "main"`.

### 1c: Identify Downstream Stack

From `STACK_ORDER`, find every entry whose position is **after** this ticket's index AND whose `mergedIntoMain` is `false`. Store the keys (in stack order) as `DOWNSTREAM_KEYS`.

These are the descendant tickets whose branches currently base on `BRANCH_NAME` (or transitively on it) and will be left dangling once we delete the branch. Step 7 will cascade-rebase them onto `MERGE_TARGET`.

If `CONTAINER_KEY` is null (standalone ticket) or `DOWNSTREAM_KEYS` is empty, mark `REBASE_DOWNSTREAM = false` regardless of the flag — there's nothing to rebase.

When `MERGE_TARGET ≠ main` *and* the cleaned ticket is itself a stack-container (`BRANCH_NAME === FEATURE_BRANCH`), its sibling Stories under the same Epic may also block on it. Those siblings live as separate stacks, not in `STACK_ORDER`, so they aren't listed here — the orchestrator picks them up next round when their `unblockedBlockers` clears. A **leaf** with `MERGE_TARGET ≠ main` is an ordinary in-stack entry, so its downstream tickets *are* in `STACK_ORDER` and cascade-rebase normally.

---

## Step 2: Verify Merge to Target

This step is **strict** — refuse to clean up unless we can prove the ticket actually shipped to its `MERGE_TARGET`.

`resolve-stack {TICKET_KEY} --fetch` from Step 1b already ran `git fetch --prune origin` for this repo. Treat origin refs as fresh — only refetch if Step 1b reported the fetch as failed.

```bash
verify-merge {BRANCH_NAME} --base {MERGE_TARGET} --cwd {REPO_ROOT} --strict
```

This single call collapses what was previously two steps: probe for a merged PR via `gh pr list --state merged`, pull the merge commit SHA, and run `git merge-base --is-ancestor` against `origin/{MERGE_TARGET}`. With `--strict`, the CLI exits 2 and populates `refusalReason` whenever any of those checks fails (no merged PR, missing merge SHA, or SHA not an ancestor).

If `refusalReason` is non-null, display the appropriate refusal message and **stop**:

- `no merged PR to {MERGE_TARGET}`:
  ```
  Refuse to clean up — no merged PR to {MERGE_TARGET} found for {BRANCH_NAME}.

  Open PRs and unmerged history are handled by /prune (abandon) or by waiting
  for the PR to merge. /cleanup only runs after a successful merge.
  ```
- `no merge commit SHA`: "Merged PR {prUrl} has no merge commit SHA on record. Cannot verify against {MERGE_TARGET}; stopping."
- `not reachable from origin/{MERGE_TARGET}`:
  ```
  Refuse to clean up — merge commit {mergeSha} (PR {prUrl}) is not reachable
  from origin/{MERGE_TARGET}. Either {MERGE_TARGET} has been rewritten or the
  merge has not yet landed locally. Investigate before continuing.
  ```

Otherwise, store `PR_NUMBER` = `prNumber`, `PR_URL` = `prUrl`, `MERGE_SHA` = `mergeSha` from the JSON.

(This refusal is intentionally stricter than `/prune`'s parallel check at `commands/prune.md:162-168`. `/cleanup` is about to delete the branch and transition Jira to Done — both irreversible — so it requires the merge to be a confirmed ancestor of `origin/{MERGE_TARGET}`. `/prune` is about to *revert* a merge from the feature branch; if the merge isn't reachable there, there's simply nothing to revert and prune can safely skip step 6c and continue with PR close + Jira cancel. The asymmetry reflects what each command is doing, not an oversight.)

### 2d: Tag the Merge Commit on Feature Branch

**Skip if** `MERGE_TARGET == "main"` — the ticket has reached main, so the tag has nothing left to record and Step 4d retires any stale one.

Whenever the cleaned ticket merged into a feature branch rather than main — Phase-1 cleanup of a Story-container, *and* terminal cleanup of a leaf ticket that shipped into its container's feature branch — tag the squash commit so downstream commands can locate the merge without parsing commit messages. The tag name encodes the ticket key. The tag is also the durable record that the ticket shipped to the feature branch: `/orchestrate` and a re-invoked `/cleanup` read it to tell "shipped to the feature branch, awaiting main" apart from "not yet cleaned at all".

Note that this step is **not** Phase-1-only: a leaf ticket runs terminal cleanup immediately yet still merged into a feature branch, so it gets the tag too — and Step 4d does not take it back.

```bash
cd {REPO_ROOT} && git tag -f merged/{TICKET_KEY} {MERGE_SHA}
cd {REPO_ROOT} && git push --force origin refs/tags/merged/{TICKET_KEY}
```

`-f` and `--force` make this idempotent — re-running `/cleanup` on the same ticket repoints the tag harmlessly. The tag is retired only by Step 4d's main-merge pass, so a terminal-cleaned leaf keeps it. The tag is the load-bearing input to the **Ensure Cleanup Prerequisites** sub-procedure (`commands/_shared-stack-procedures.md`); commands that consume clean stack state (`/promote-to-main` Step 1b-final, `/ticket-work` S1d and Q4.5, `/stack-rebase` Step 1.5) backfill via that sub-procedure when this tag is missing on a `mergedIntoFeature` ticket, and refuse only when the backfill itself cannot produce the tag.

If the push fails (network, permissions): warn and continue. The local tag is in place; the remote can be re-pushed manually with `git push --force origin refs/tags/merged/{TICKET_KEY}`. The downstream gate will catch the missing remote tag and re-trigger cleanup.

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
{if MERGE_TARGET ≠ "main" AND PARENT_CONTAINER_KEY is non-null:
  "Parent epic:    " + PARENT_CONTAINER_KEY + " (feature branch: " + PARENT_FEATURE_BRANCH + ")"}
{if MERGE_TARGET ≠ "main":
  "Merged into:    " + MERGE_TARGET + " — not main, so this is a phase-1 cleanup"}

Actions:
{if DEFER_DESTRUCTIVE is false:
  "  1. Delete local branch {BRANCH_NAME} (if present)
  2. Delete remote branch origin/{BRANCH_NAME} (if present)
  3. Transition {TICKET_KEY} in Jira to Done
  4. Remove every progress label currently set on the ticket (the canonical list lives at `cli/lib/labels.js` `PROGRESS_LABELS`; the JSON patch in Step 5b enumerates them explicitly so the API call is unambiguous)
  5. Append \"Shipped\" entry to {TICKET_KEY} activity log"
  + (if MERGE_TARGET == "main":
       "\n     (also retires the merged/{TICKET_KEY} tag — the ticket has reached main)"
     else:
       "\n     (also tags the merge commit merged/{TICKET_KEY} and KEEPS it — {TICKET_KEY} shipped to " + MERGE_TARGET + ", not main, so the tag stays as its durable ship record and Step 8 replay source)")
else:
  "  1. (deferred) Branch {BRANCH_NAME} kept alive — needed for /promote-to-main onto main
  2. (deferred) {TICKET_KEY} stays In Progress — Done transition runs after main-merge cleanup
  3. (deferred) Progress labels left as-is — cleared by the main-merge cleanup
  4. Tag merge commit as merged/{TICKET_KEY} — the durable record that phase 1 ran
  5. Append \"Shipped to {MERGE_TARGET}\" entry to {TICKET_KEY} activity log"}
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

If `AUTO_CONFIRM` is `true` (set by `--yes` / `--no-confirm`):
- Display: "Auto-confirmed via --yes — proceeding without prompt."
- Skip the prompt and continue to Step 4.

Otherwise prompt:

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

### 4d: Delete merged/{TICKET_KEY} Tag

**Skip this step unless `MERGE_TARGET == "main"`.** The tag is retired only once the ticket has actually reached main — that is the condition under which it stops being load-bearing, and it is not the same condition as "terminal cleanup is running".

Keying on `MERGE_TARGET` rather than on "we reached Step 4" is what keeps the tag alive for a ticket that has merged into a feature branch but not into main. Since Step 1b now sets `DEFER_DESTRUCTIVE = true` for every such ticket, Step 4 is skipped wholesale in that case and this guard is a second line of defence rather than the only one — keep it, so a future caller that reaches Step 4d by another path still cannot retire a tag early. Deleting the tag while the ticket is only on a feature branch breaks two things:

1. **The prerequisite gate never converges.** The **Ensure Cleanup Prerequisites** sub-procedure (`commands/_shared-stack-procedures.md`) wants a tag for exactly `mergedIntoFeature === true AND mergedIntoMain === false` — which is this ticket. Step 2d creates the tag, Step 4d deletes it, and the gate's backfill re-runs `/cleanup` forever without ever satisfying itself.
2. **It destroys the Step 8 replay source.** `resolveMergedTag` (`cli/lib/git.js`) makes this tag the fallback that populates `featureMergeSha` (`cli/lib/stack-resolver.js`), which Step 8a calls the load-bearing input for replaying a squash merge whose branch is gone — the NEV-863 failure shape. Step 4b/4c just deleted the branch, so tag plus branch going together in one run leaves only the GitHub PR record; and because Step 8 rewrites the feature branch, that record's `mergeCommit` can become unreachable and prove nothing (see the comment at `cli/lib/stack-resolver.js` on the tag fallback). The ticket's ship record is then unrecoverable.

So: keep the tag whenever the merge target was a feature branch, and retire it only on the main-merge pass.

```bash
cd {REPO_ROOT} && git push origin :refs/tags/merged/{TICKET_KEY} 2>/dev/null
cd {REPO_ROOT} && git tag -d merged/{TICKET_KEY} 2>/dev/null
```

Both fail silently if the tag is absent (e.g. the ticket went straight to main and never had one, or terminal cleanup is being re-run). Either failure mode is fine — continue.

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

Skip if `DEFER_DESTRUCTIVE` is `true` — phase-1 cleanup leaves progress labels alone. The ticket is still in flight (`/promote-to-main` has yet to land it on main), so its progress state must survive; the `merged/{TICKET_KEY}` tag from Step 2d is the durable marker that phase 1 already ran.

Otherwise (terminal cleanup), run `set-ticket-state` to clear every progress label currently on the ticket. The CLI consults `cli/lib/labels.js` (`PROGRESS_LABELS`) so the enumeration stays canonical.

```bash
set-ticket-state {TICKET_KEY} --clear-progress
```

Note: `ClaudeWork` is durable and never removed. No terminal label is added — Jira status (Done) is the source of truth for terminal cleanup.

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
- Merge tagged: `merged/{TICKET_KEY}`
- Status: unchanged (still in progress); progress labels left in place
```

Otherwise (terminal cleanup) body:

```
Shipped to {MERGE_TARGET}.

- PR: {PR_URL}
- Merge commit: `{MERGE_SHA}`
- Branch deleted: `{BRANCH_NAME}` (local + remote)
- Status: transitioned to {transition name} {or "(no transition applied — labels only)"}
{if MERGE_TARGET ≠ "main":
"- Merge tagged: `merged/{TICKET_KEY}` — retained; the branch is gone, so this tag is the ticket's durable ship record and the replay source for feature-branch refreshes"}
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

This step cascades rebases through every downstream ticket in `DOWNSTREAM_KEYS`, retargeting them onto `MERGE_TARGET` (typically `main`, but the parent Epic's feature branch when cleaning a Story-container) since the branch they were stacked on has just been merged and deleted.

> **Shared with `/stack-rebase`**: The rebase loop is implemented once in `cli/lib/cascade-rebase.js` (and exposed as the `cascade-rebase` CLI). Both `/cleanup` Step 7 and `/stack-rebase` Step 4 call into it instead of maintaining parallel inline implementations. The CLI returns JSON results that this step reports through `REBASE_RESULTS`. The per-ticket retarget-PR and activity-log calls (7b-v, 7b-vi) are NOT in the shared CLI — they're command-specific side effects that loop over the CLI's results.

### 7a: Refresh Stack View

Re-run:
```bash
resolve-stack {TICKET_KEY} --fetch
```

Recompute `DOWNSTREAM_KEYS` from the fresh output (in case anything changed). If now empty, skip to Step 8.

### 7b: Run Cascade Rebase

Build the `--downstreams` argument by joining `{ticket}:{branch}` pairs from `DOWNSTREAM_KEYS` (in stack order) with commas. Skip entries whose branch is null — the CLI will record them as `skipped` regardless, but pre-filtering keeps the command line shorter.

```bash
cascade-rebase \
  --repo-root {REPO_ROOT} \
  --origin {BRANCH_NAME} \
  --new-root {MERGE_TARGET} \
  --downstreams {ticket1}:{branch1},{ticket2}:{branch2},... \
  --activity-note "after {TICKET_KEY} merged to \`{MERGE_TARGET}\` (cleanup cascade)" \
  --retarget-first-pr {MERGE_TARGET}
```

`--activity-note` makes the CLI append a "Branch rebased" entry to each rebased / pushed-failed ticket's activity log; `--retarget-first-pr` retargets the head-of-chain ticket's open PR base from the deleted `{BRANCH_NAME}` to `{MERGE_TARGET}` (no-op when no PR is open). Failures during either side effect fold into the result entry as `activity_log_warning` / `pr_retarget_warning` rather than aborting the chain.

Parse stdout as JSON. Store the `results` array as `REBASE_RESULTS`. Each entry has `{ ticket, branch, status, ... }` where `status` is one of `rebased`, `pushed-failed`, `conflict`, `not-attempted`, or `skipped`.

> **Worktree note**: when a downstream ticket has a worktree, run the CLI from inside that worktree's `REPO_ROOT` (the worktree shares the main repo's branch storage). The shared lib uses `git checkout` against the named branch in the given `repoRoot`, which fails if a worktree currently has the branch checked out. If you hit that error, either (a) cd into the worktree and re-run for that ticket, or (b) detach the worktree first.

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

The detection / reset / re-merge / push pipeline is implemented in `cli/lib/feature-refresh.js` and exposed as the `cleanup-feature-refresh` CLI. It rebuilds the feature branch as `origin/{MERGE_TARGET}` plus a clean re-merge of every still-unmerged ticket branch (avoiding the patch-id failure mode of `git rebase origin/{MERGE_TARGET}` against squash-merged commits) and refuses safely on orphans, dirty worktrees, or a partial cascade.

### 8a: Run the refresh

Determine the cascade verdict from `REBASE_RESULTS` (Step 7): if any entry has `status: "conflict"`, set `CASCADE_STATUS = "conflict"`; otherwise `"completed"`. Build the `--downstreams` argument by joining `{ticket}:{branch}:{status}:{summary}:{mergeSha}` quintuples (in stack order) from `STACK_ORDER` entries whose `mergedIntoMain === false`. Use the Step 7 status per ticket if available; default to `rebased`.

For each STACK_ORDER entry:
- `{branch}` — the ticket's `branch` field, or empty string if null (terminal cleanup may have deleted the branch on a prior pass).
- `{mergeSha}` — the ticket's `featureMergeSha` field if set, otherwise empty. This is the load-bearing fallback: when the branch is gone but the squash mergeSha is on record, feature-refresh.js will cherry-pick the merge commit instead of `git merge --no-ff`. **Do NOT skip entries with branch:null and mergeSha set** — those are exactly the entries Step 8 must preserve, and dropping them is what produced the NEV-863 incident.

Only skip an entry from `--downstreams` when both `branch` and `featureMergeSha` are empty AND `mergedIntoFeature === false` (genuinely not in the feature branch yet). When `mergedIntoFeature === true` but no replay source is available, the CLI will refuse with `skipped-unresolvable-predecessor` and the refresh will not run — that refusal needs human investigation, not a silent skip.

```bash
cleanup-feature-refresh \
  --repo-root {REPO_ROOT} \
  --feature-branch {FEATURE_BRANCH} \
  --merge-target {MERGE_TARGET} \
  --downstreams {ticket1}:{branch1}:{status1}:{summary1},... \
  --cascade-status {CASCADE_STATUS}
```

Parse stdout as JSON. The `outcome` field is one of:
- `refreshed` — full success.
- `skipped-orphans` — feature branch carries commits not in `origin/{MERGE_TARGET}` and not in any tracked ticket branch. The CLI returns the orphan commits in `orphans`.
- `skipped-orphan-check-failed` — orphan detection could not complete (a downstream branch ref is missing or `git log`/`git rev-list` failed). `missingRefs` lists refs that did not resolve; `orphanCheckError` carries the underlying git error. **This is the NEV-863 close-fail**: in prior versions a missing ref silently returned "no orphans" and let the reset destroy work. Investigate the missing ref before retrying.
- `skipped-unresolvable-predecessor` — a `mergedIntoFeature` predecessor has neither a live branch nor a `featureMergeSha` to replay. `unresolvable` lists the ticket keys. Re-run `/cleanup {KEY} --yes --no-rebase --no-refresh-feature` on each to backfill its `merged/{KEY}` tag and surface the squash SHA, then retry.
- `skipped-unrecoverable-commits` — pre-reset reachability check found commits on the feature branch that no downstream branch or mergeSha covers. `unrecoverableCommits` lists the SHAs. Reset would destroy these; investigate manually before retrying.
- `skipped-dirty-worktree` — a secondary worktree on the feature branch has uncommitted changes (paths in `dirtyWorktrees`).
- `skipped-checkout-failed` — primary worktree refused checkout (`checkoutError` field has details).
- `skipped-cascade-conflict` — Step 7 conflicted; refusing to refresh on top of a half-rebased cascade.
- `partial-merge-conflict` — replay conflicted on `conflictBranch` (or `conflictTicket` when replayed via cherry-pick); pushed whatever replayed cleanly. `conflictFiles` lists the files; `conflictVia` is `"merge"` or `"cherry-pick"`.
- `pushed-failed` — local refresh succeeded but force-push failed (`pushError` has details).

Store the outcome and `oldSha` (the pre-refresh feature-branch SHA, recoverable via reflog if anything goes sideways).

### 8b: Display the appropriate refusal / status

Map the outcome to a human-readable message:

- `skipped-orphans`:
  ```
  Refuse to refresh feature branch {FEATURE_BRANCH} — found commits reachable
  from the feature branch that are NOT in origin/{MERGE_TARGET} and NOT in any tracked
  ticket branch:

    {one orphan per line}

  These would be destroyed by a reset. Resolve manually:
    - Move these commits onto a ticket branch, or
    - Re-run with --no-refresh-feature.

  Continuing without refreshing the feature branch.
  ```
- `skipped-dirty-worktree`: "Refuse to refresh — worktree at {dirtyWorktrees[0]} has uncommitted changes. Either commit/stash those changes or re-run with --no-refresh-feature."
- `skipped-cascade-conflict`: "Skipping feature-branch refresh — cascade rebase did not complete."
- `skipped-checkout-failed`: display `checkoutError`, note that local edits weren't touched.
- `partial-merge-conflict`:
  ```
  Conflict merging {conflictBranch} into {FEATURE_BRANCH}.
  Conflicting files:
  - {one file per line}

  Stopping feature-branch refresh. The feature branch is at
  origin/{MERGE_TARGET} + the cleanly-merged tickets so far. To finish manually:
    git checkout {FEATURE_BRANCH}
    git merge --no-ff {conflictBranch}
    # resolve conflicts
    git push --force-with-lease
  ```
- `pushed-failed`: warn — local branch is the source of truth; user can push manually. Show `pushError`.
- `refreshed`: continue silently to Step 8c.

### 8c: Append Activity Log

Append to the container's activity log:

```bash
append-activity {CONTAINER_KEY} --heading "Feature branch refreshed" --body "Reset \`{FEATURE_BRANCH}\` from \`{oldSha}\` to \`origin/{MERGE_TARGET}\` after {TICKET_KEY} merged. Re-merged: {comma-separated re-merged ticket keys}. Outcome: {outcome}."
```

If `CONTAINER_KEY` is null but `FEATURE_BRANCH` is not (unusual but possible), skip the activity log.

---

## Step 9: Summary

Display:

```
Cleanup {TICKET_KEY} — {if DEFER_DESTRUCTIVE: "Phase 1 Complete (awaiting main promotion)" else: "Complete"}

Branch:         {if DEFER_DESTRUCTIVE: BRANCH_NAME + " — retained (needed by /promote-to-main)" else: BRANCH_NAME + " — deleted (local + remote)"}
PR:             {PR_URL} (merged at {MERGE_SHA})
Jira:           {if DEFER_DESTRUCTIVE: "unchanged — still in progress, awaiting main promotion" else: transition name or "labels updated only"}
{if DEFER_DESTRUCTIVE:
"Merge tag:      merged/" + TICKET_KEY + " — phase 1 recorded"
else if MERGE_TARGET ≠ "main":
"Merge tag:      merged/" + TICKET_KEY + " — retained (shipped to " + MERGE_TARGET + ", not main)"
else:
"Merge tag:      retired (ticket reached main)"}
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
"Feature branch:  " + FEATURE_BRANCH + " — " + outcome + " (was " + oldSha[:8] + ", re-merged " + count + " ticket(s))"
else if FEATURE_BRANCH is non-null AND refresh was skipped:
"Feature branch:  " + FEATURE_BRANCH + " — refresh skipped (" + skip_reason + ")"}
{if DEFER_DESTRUCTIVE is true:
"
Next steps:
  - /promote-to-main " + TICKET_KEY + " to promote just this ticket, or /promote-to-main " + CONTAINER_KEY + " to take the stack's next unpromoted ticket in merge order.
  - After " + TICKET_KEY + "'s main-targeting PR merges, re-run /cleanup " + TICKET_KEY + " for the destructive phase: branch delete + Jira Done."}
```

### Machine-readable outcome line

After the human-readable summary, print a single structured line that callers (`/promote-to-main`, `/orchestrate`) can grep for. Format is one line, key=value pairs separated by spaces, prefix `[cleanup-outcome]`:

```
[cleanup-outcome] ticket={TICKET_KEY} phase={"phase-1"|"terminal"} branch={"retained"|"deleted"} merge_target={MERGE_TARGET} feature_refresh={"refreshed"|"partial-merge-conflict"|"pushed-failed"|"skipped"|"n/a"} stack_rebase={"completed"|"conflict"|"skipped"|"n/a"} status={"ok"|"partial"}
```

Field rules:
- `phase=phase-1` when `DEFER_DESTRUCTIVE` is true; otherwise `phase=terminal`.
- `branch=retained` only in Phase 1; `deleted` in terminal.
- `status=ok` when nothing in this run reported a failure; `partial` if any sub-step (rebase, push, refresh) bailed cleanly without aborting the whole command.

`/promote-to-main` parses this line to decide whether the inline `/cleanup` produced terminal state (safe to advance) or Phase 1 state (must wait for main-merge before re-attempting). Without it, `/promote-to-main` had no signal to distinguish the two and could loop in pathological cases.

---

## Error Handling

- If repo root cannot be resolved: refuse to run.
- The `merged/{TICKET_KEY}` tag's lifecycle keys on **whether the ticket has reached main**, not on which phase is running: Step 2d writes it whenever `MERGE_TARGET ≠ "main"`, and only Step 4d's `MERGE_TARGET == "main"` pass retires it. Any ticket that merged into a feature branch keeps its tag — it has not reached main, so the tag remains its durable ship record and the `featureMergeSha` source. Retiring it early both starves the **Ensure Cleanup Prerequisites** gate (which would re-trigger `/cleanup` indefinitely) and destroys the Step 8 squash-replay source implicated in NEV-863.
- When `DEFER_DESTRUCTIVE` is true: Steps 4 (branch delete), 5b (label clear), and 5c (Jira transition) are skipped; the ticket keeps its current status and progress labels, and the `merged/{TICKET_KEY}` tag from Step 2d records that phase 1 ran. The branch must remain on disk and on the remote because `/promote-to-main` rebases it onto main next. After the main-targeting PR merges, re-run `/cleanup {TICKET_KEY}` — the second invocation will detect the merged main PR via Step 1b's probe and run terminal cleanup.
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
- The pre-refresh feature-branch SHA is recorded in the activity log and remains in the reflog. Recovery from an unwanted refresh is `git reset --hard {oldSha}` followed by `git push --force-with-lease`.
