# Container flows: Feature Branch PR + multi-ticket runner

Reference fragment, not a slash command. `install.sh` skips `_`-prefixed files so
this is never symlinked into `~/.claude/commands/`.

Two flows lifted out of `commands/ticket-work.md` because neither is reachable
from the common single-ticket path, and both were loading into every invocation:

- **Mode C** — entered only when a container key carries `ClaudeStackComplete`.
- **Multi-ticket runner (Q3–Q8)** — entered only from S6b, when a completed
  ticket unblocks two or more downstream tickets.

Design rationale for these procedures: `docs/design-notes.md`.

> Shared sub-procedures referenced below live in `commands/_shared-stack-procedures.md`.

---

# Mode C: Feature Branch PR (completed stack)

Triggered when a stack container key is passed that has `ClaudeStackComplete`. This opens a PR from the feature branch (named after the container key) to its parent's feature branch (when the container is a Story nested under an Epic-with-feature-branch) or to `main` (top-level Epics, standalone Stories). Generates a PR review plan and posts the review summary, then marks the PR ready for human review. CI green and Copilot comment resolution are NOT automatic — run `/cop-fight` on demand after the PR is open.

## C1: Initialize

1. `CONTAINER_KEY` = the provided issue key. Run `resolve-stack {CONTAINER_KEY} --fetch`
   and pick the container perspective from the JSON:

   - **`container.key === CONTAINER_KEY`** (we resolved this container's own stack) —
     take `FEATURE_BRANCH`, `REPO_ROOT`, `PARENT_FEATURE_BRANCH`, and
     `PARENT_CONTAINER_KEY` straight from the `container` block.
   - **`container.key` differs** (the input is a Story member of a larger Epic stack) —
     find `entry = stack.find(s => s.key === CONTAINER_KEY)`, then
     `FEATURE_BRANCH` = `entry.branch`, `REPO_ROOT` = `container.repoRoot`,
     `PARENT_FEATURE_BRANCH` = `container.featureBranch` (the enclosing Epic's branch,
     which this Story PRs into), `PARENT_CONTAINER_KEY` = `container.key`.

2. `PR_BASE` = `PARENT_FEATURE_BRANCH` if non-null, else `main`. When it is the parent's
   branch, this PR merges into the Epic's branch and the Epic's own Mode C run later PRs
   the accumulated work to `main`.

3. `git -C {REPO_ROOT} fetch origin`, then check out the feature branch — two separate
   calls, never chained:
   ```bash
   git -C {REPO_ROOT} checkout {FEATURE_BRANCH}
   ```
   ```bash
   git -C {REPO_ROOT} pull origin {FEATURE_BRANCH}
   ```

4. If `PR_BASE` is not `main`, make sure it exists locally. Try
   `git -C {REPO_ROOT} fetch origin {PR_BASE}:{PR_BASE}`; if that errors (not a
   fast-forwardable ref), retry `git -C {REPO_ROOT} fetch origin {PR_BASE}`. If that also
   fails, display "Parent container {PARENT_CONTAINER_KEY} has no branch on origin. Run
   /ticket-work against {PARENT_CONTAINER_KEY}'s first ticket to bootstrap it." and **stop**.

## C2: Load or Create Feature Branch Checklist

The checklist file lives at `{REPO_ROOT}/.claude/plans/ticket-work-{CONTAINER_KEY}-pr.md`.

Check if the file already exists:
- **If it exists**: read it and parse the checklist state. Resume from the first unchecked step.
- **If it does not exist**: create it (see below).

### C2a: Create the plans directory

```bash
mkdir -p {REPO_ROOT}/.claude/plans
```

### C2b: Write the checklist file

```markdown
---
ticket: {CONTAINER_KEY}
branch: {FEATURE_BRANCH}
summary: {CONTAINER_SUMMARY}
pr_target: {PR_BASE}
work_dir: {REPO_ROOT}
created: {ISO_TIMESTAMP}
---

# {CONTAINER_KEY} - Feature Branch PR Checklist

- [ ] 1. PR description generated
- [ ] 2. PR created as draft
- [ ] 3. PR review plan generated
- [ ] 4. PR review plan executed
- [ ] 5. PR review summary posted
- [ ] 6. PR marked ready for review
```

## C3: Execute Checklist

Run the **PR Push & Review** sub-procedure (`commands/_shared-stack-procedures.md`) with these bindings:

- `WORK_DIR` = `REPO_ROOT`
- `BRANCH` = `FEATURE_BRANCH`
- `BASE` = `PR_BASE`
- `JIRA_KEY` = `CONTAINER_KEY`
- `STORAGE` = the local checklist file at `{REPO_ROOT}/.claude/plans/ticket-work-{CONTAINER_KEY}-pr.md` (read/update with checkbox edits)
- `MARK_READY` = true
- `REVIEW_TRANSITION` = false

Sub-procedure steps map onto the C-flow's local checklist file (it lives outside the per-ticket checklist, so slot numbers don't apply). All five steps P1 ↔ "PR description generated" through P5 ↔ "PR marked ready for review" run. Before starting P1, ensure we are on `{FEATURE_BRANCH}`: `git -C {REPO_ROOT} checkout {FEATURE_BRANCH}`. The sub-procedure handles the rest.

---

## C4: Final Summary

Display:

```
Feature Branch PR - Complete

Container: {CONTAINER_KEY} - {CONTAINER_SUMMARY}
Branch: {FEATURE_BRANCH} → {PR_BASE}
PR: {PR_URL}

All review steps completed. PR is ready for human review.
```

---

# Multi-ticket runner

Entered with an explicit ticket set — either several leaf keys in `$ARGUMENTS`, or
S6b promoting more than one unblocked downstream. There is no JQL discovery mode;
`/orchestrate` owns finding work.

Every path here is serial. `DEV_ROOT` (from `.env` or `~/.claude/.env`) is the
parent directory holding all repo clones, so a `repo:` label maps to
`{DEV_ROOT}/{repo_name}`. Reuse `CLOUD_ID` if Mode A already resolved it.

## Q3: Resolve Repo per Ticket

For each ticket, find the label starting with `repo:` (e.g., `repo:my-backend`). Strip the `repo:` prefix to get the repo name. Set `REPO_ROOT` = `{DEV_ROOT}/{repo_name}`.

- If no `repo:` label: **skip it** and display "Skipping {KEY}: no repo: label found"
- If `REPO_ROOT` directory does not exist: **skip it** and display "Skipping {KEY}: repo directory '{REPO_ROOT}' not found"

## Q4: Gate on Stack Dependencies

For each ticket, run:
```bash
resolve-stack {KEY} --repo-root {REPO_ROOT} --fetch
```

`--fetch` is required for the same reason as S1c: Q4.5's cleanup gate reads `mergedIntoFeature` / `mergedIntoMain` from this output, and stale local origin refs would make it skip a predecessor whose merge has already landed.

Parse the JSON output. Find the ticket's entry in the `stack` array. Use:
- `FEATURE_BRANCH` = `container.featureBranch`
- `CONTAINER_BASE` = `container.baseBranch`
- `UNMERGED_BLOCKERS` = `container.unmergedBlockers`
- `BASE_BRANCH` = ticket's `baseBranch`
- `BRANCH_NAME` = ticket's `branch` (or `{KEY}` if null)

If the ticket's `eligible` is `false`:
- **skip this ticket**
- Display: "Skipping {KEY}: waiting on {unblockedBlockers[0]}"

## Q4.5: Ensure Cleanup Prerequisites

Before preparing any working directory, verify the surviving tickets' stacks have no un-cleaned feature-branch merges. A stale stack view here would be inherited by every agent launched in Q6, so failing once at the queue level beats N parallel failures.

Group the surviving tickets by `(REPO_ROOT, CONTAINER_KEY)` and run the **Ensure Cleanup Prerequisites** sub-procedure **once per group** — tickets in the same stack share one `STACK_ORDER` and one tag set, so per-ticket invocation would repeat the same `git ls-remote` and the same backfills. For each group, pass the group's `STACK_ORDER` and `REPO_ROOT` with `RESOLVED_KEY` set to the first ticket key in the group.

If the sub-procedure halts for a group (a `/cleanup` that could not produce its tag), **skip every ticket in that group**, display its refusal, and continue with the remaining groups — deliberately unlike S1d, which stops outright (see `docs/design-notes.md`).

When a group's stack was refreshed by a backfill, re-bind that group's Q4 fields (`BASE_BRANCH`, `BRANCH_NAME`, `FEATURE_BRANCH`, `CONTAINER_BASE`, `UNMERGED_BLOCKERS`) from the refreshed stack before Q5 consumes them.

## Q5: Prepare Working Directories (Sequential)

Prepare branches/worktrees sequentially (shared git state requires this).

1. For each unique `(REPO_ROOT, FEATURE_BRANCH)` pair where `FEATURE_BRANCH` is set, run S2.0's `ensure-work-dir --feature-branch …` for one ticket in that stack. The CLI fetches origin, no-ops when the branch already exists, and rejects multi-blocker containers with a clear error.

2. For each eligible ticket:
   a. Display: "Preparing {MODE} for {KEY}: {SUMMARY} (base: {BASE_BRANCH})" where `{MODE}` is "branch" if `SERIAL_MODE`, otherwise "worktree"

   b. Run:
   ```bash
   ensure-work-dir {KEY} --repo-root {REPO_ROOT} --base {BASE_BRANCH} [--serial]
   ```
   The CLI handles serial-vs-worktree branching internally and is idempotent (existing branches are checked out / existing worktrees are reused).

## Q6: Launch Ticket Work

Process tickets **one at a time**, ordered by stack dependency (upstream first),
then by ticket key. For each eligible ticket, in order:

1. `git -C {REPO_ROOT} checkout {BRANCH_NAME}` (serial mode only — in worktree mode
   the ticket already has its own directory from Q5).
2. Display: "Working ticket {KEY}: {SUMMARY} (branch: {BRANCH_NAME}, base: {BASE_BRANCH})"
3. Use the Skill tool to run skill `ticket-work` with args `{KEY}` (append
   ` --serial` when `SERIAL_MODE`).
4. When the ticket completes or stops at a gate, commit any stray work and continue
   to the next. A stopped ticket resumes on the next run.

## Q7: Promote Downstream Tickets

Run:

```bash
promote-downstream [--repo-root {REPO_ROOT}]
```

The CLI consults `cli/lib/stack-resolver.js` (`resolveStack` + `isFinished`) — the same engine `resolve-stack` uses — to find done tickets, locate their unblocked downstream dependents, and add `ClaudeReady` to each. It outputs JSON: `{ promoted, skipped, stackComplete }`.

If `promoted` is empty and `stackComplete` is empty, skip to Q8.

For each entry in `stackComplete` (containers whose every member is now finished per `isFinished()` and that don't yet carry `ClaudeStackComplete`):

1. Apply the label and append to the activity log:
   ```bash
   set-ticket-state {CONTAINER_KEY} --add ClaudeStackComplete
   append-activity {CONTAINER_KEY} --heading "Stack complete" --body "All tickets in this stack have been completed by Claude."
   ```
2. If the container is a Story/Epic (i.e. not Standalone): display "Feature branch stack complete — running Mode C (Feature Branch PR) for {CONTAINER_KEY}" and run **Mode C: Feature Branch PR** for this container.

## Q8: Summary

Display combined results:

```
Queue Processing Complete

Worked ({N}):
  - {KEY}: {SUMMARY} (base: {BASE}, dir: {WORK_DIR})

Promoted ({N}):
  - {BLOCKED_KEY}: unblocked by {KEY}

Stacks Completed:
  - {CONTAINER_TYPE} {CONTAINER_KEY}: all {N} tickets finished

Skipped (dependency not ready):
  - {KEY}: waiting on {BLOCKER_KEY}

Awaiting Human Review:
  - {KEY}: stack ready, PR open and waiting on review
```

---
