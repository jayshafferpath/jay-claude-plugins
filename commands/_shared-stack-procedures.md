# Shared stack sub-procedures

Reference fragment, not a slash command. `install.sh` skips `_`-prefixed files so
this is never symlinked into `~/.claude/commands/`.

Three sub-procedures shared across `ticket-work`, `cleanup`, `promote-to-main`,
`prune`, `rework`, `stack-rebase`, `fix-drift`, `orchestrate`, and
`triage-tickets`. They live here rather than inside any one command so that
citing them does not pull an entire lifecycle file into context.

Design rationale for these procedures: `docs/design-notes.md`.

---

# Shared sub-procedure: Stack Context Resolution

Captures the standard "run `resolve-stack` and bind its container fields to local
variables" boilerplate so each command can reference it instead of re-listing the
bindings inline.

## Inputs

- `KEY` — the ticket or container key to resolve.
- `REPO_ROOT` — optional; passed to `resolve-stack --repo-root {REPO_ROOT}` when set.
- `FETCH` — when truthy, append `--fetch` so origin refs are refreshed *and pruned*.

## Procedure

1. Run `resolve-stack {KEY}` (with `--repo-root` and/or `--fetch` flags as supplied).
2. Parse the JSON output. Bind these names from the result:
   - `CONTAINER_KEY` ← `container.key` (null for standalone tickets)
   - `CONTAINER_TYPE` ← `container.type`
   - `CONTAINER_SUMMARY` ← `container.summary`
   - `FEATURE_BRANCH` ← `container.featureBranch`
   - `CONTAINER_BASE` ← `container.baseBranch` (`main` or a blocker container's branch)
   - `UNMERGED_BLOCKERS` ← `container.unmergedBlockers`
   - `PARENT_CONTAINER_KEY` ← `container.parentContainerKey` (null when none)
   - `PARENT_FEATURE_BRANCH` ← `container.parentFeatureBranch`
   - `REPO_ROOT` ← `container.repoRoot`
   - `STACK_ORDER` ← the `stack` array (already topologically sorted, with
     `branch`/`baseBranch`/`prTarget`/`mergedIntoMain`/`mergedIntoFeature`/`eligible`
     populated per entry)
3. When the caller cares about the input ticket specifically, locate its entry:
   `entry = STACK_ORDER.find(s => s.key === KEY)`.

When `container` is `null` (standalone ticket with no Story/Epic container), the
ticket-specific fields still come from `stack[0]` and the container-level
bindings are null. Each caller decides how to handle the standalone case.

**Container keys resolve to themselves.** Passing an Epic key — or a Story key
with no enclosing Epic — returns that issue as `container`, with `STACK_ORDER`
holding its members. The container is *not* a member of its own stack, so
`STACK_ORDER.find(s => s.key === KEY)` is `null` and `ticketIndex` falls back to
`0`; use the container bindings rather than a stack entry in that case. A Story
*under* an Epic still resolves to the Epic even when it has subtasks of its own
— that is the nested-container case, disambiguated by comparing `container.key`
to the key you passed (see `commands/_container-flows.md`).

Pass `FETCH=true` whenever the caller will act on `mergedIntoFeature` /
`mergedIntoMain` — those flags are computed against local origin refs and go
stale (see design notes).

The prune matters as much as the fetch, and `stack[*].branch` needs it too.
`findBranch` falls back to remote-tracking refs, which are a local cache: GitHub
deletes the head branch on squash-merge and terminal cleanup deletes it
explicitly, but `origin/{KEY}` lingers until something prunes. A phantom branch
suppresses the branch-absence signal that `classify-actions` rule 0 reads as
"cleanup already ran", so a finished ticket re-emits as an auto-safe cleanup on
every pass and never converges. `--fetch` therefore runs `git fetch --prune`
inside the resolver, which is also the only layer that knows the repo root when
the caller did not pass `--repo-root`.

A branch held by a **locked worktree** is a local ref, not a remote-tracking one,
so no prune clears it — it resolves only once the worktree is released.

> **Field semantics live in `cli/lib/stack-resolver.js`** — `resolveStack()` and
> `isFinished()` are the source of truth. If the field set changes, update the
> resolver and this sub-procedure together; do not let callers redefine the
> meaning locally.

---

# Shared sub-procedure: Ensure Cleanup Prerequisites

Enforces that every ticket merged into a feature branch has been cleaned up
before any downstream command consumes the stack state. Cleanup creates a
`merged/{TICKET_KEY}` tag on the merge commit (see `commands/cleanup.md` Step
2d); commands that traverse merged history refuse to run when the tag is missing.

The gate is self-healing: if a ticket is merged-into-feature but lacks its tag,
this sub-procedure inline-runs `/cleanup --yes --no-rebase --no-refresh-feature`
to backfill it. It halts only when `/cleanup` itself cannot produce the tag (PR
not merged, MERGE_SHA unreachable) — those failures need human investigation.

## Inputs

- `STACK_ORDER` — the topologically sorted stack from **Stack Context Resolution**.
- `REPO_ROOT` — passed to `git ls-remote` for tag probes.
- `RESOLVED_KEY` — the original argument the calling command was invoked with
  (used in error messages so the user knows what to re-run).

## Procedure

1. **Bulk-fetch existing tags** in one network round trip:
   ```bash
   git -C {REPO_ROOT} ls-remote origin 'refs/tags/merged/*'
   ```
   Parse each line `<sha>\trefs/tags/merged/{KEY}` into a set
   `EXISTING_TAGS = { KEY, ... }`. If the command fails (network), display the
   error and **stop** — we cannot reason about prerequisites without the tag list.

2. **Build `MISSING_TAGS`** by walking `STACK_ORDER`. An entry needs a tag when:
   - `entry.mergedIntoFeature === true`, AND
   - `entry.mergedIntoMain === false` (terminal cleanup deletes the tag), AND
   - `entry.key ∉ EXISTING_TAGS`.

   If `MISSING_TAGS` is empty, return — prerequisites satisfied.

3. **Inline backfill** for each entry in `MISSING_TAGS`, in stack order:
   - Display: `Auto-fixing missing cleanup for {entry.key}…`
   - Use the `Skill` tool to run skill `cleanup` with args
     `{entry.key} --yes --no-rebase --no-refresh-feature`. Keep `--no-rebase` —
     it prevents cleanup's cascade from re-entering the caller (see design notes).
   - Re-probe: `git -C {REPO_ROOT} ls-remote origin refs/tags/merged/{entry.key}`.
   - If still empty, display and **stop** the calling command:

     ```
     Prerequisite cleanup failed for {entry.key}: tag merged/{entry.key} was not created.

     /cleanup {entry.key} did not produce the expected tag — this typically means:
       - the ticket's PR has not actually merged yet, or
       - the merge commit is not reachable from origin/<merge-target>, or
       - the ticket has no branch on record.

     Investigate /cleanup {entry.key} manually, then re-run the original command:
       <calling command> {RESOLVED_KEY}
     ```

4. **Refresh `STACK_ORDER`** by re-running **Stack Context Resolution** with the
   same `KEY` and `FETCH=true`. Cleanup may have shifted
   `mergedIntoFeature`/`mergedIntoMain` or moved branches, so the caller must not
   reuse the pre-backfill stack view.

5. Return.

`git ls-remote origin 'refs/tags/merged/*'` is a single network call returning
every tag the gate cares about — pre-filter once at step 1 rather than probing
per-ticket. A stack with no `mergedIntoFeature: true` entries short-circuits at
step 2 with no work.

## Callers

- `/promote-to-main` — Step 1b-final, before the tag walk.
- `/ticket-work` S1d — after stack resolution, before `ensure-work-dir` and the
  S2.5 rebase consume `BASE_BRANCH`.
- Multi-ticket runner Q4.5 (`commands/_container-flows.md`) — once per
  `(REPO_ROOT, CONTAINER_KEY)` group. Skips the offending group rather than
  stopping the whole queue.
- `/stack-rebase` Step 1.5 — before the scenario check and cascade rebase.

`/orchestrate` deliberately does **not** call this — it runs its own tag sweep
and dispatches cleanup as a visible action. `/prework` is not wired here because
it never resolves stack context. Both rationales are in `docs/design-notes.md`.

---

# Shared sub-procedure: PR Push & Review

Called from `/ticket-work` S4.8–S4.10 (per-ticket PR flow), Mode C's C3
(feature-branch PR flow, in `commands/_container-flows.md`), and
`/promote-to-main`. Captures the common shape — generate description, push as
draft, sanity-review, post review summary.

CI green and Copilot comment resolution are **not** part of this sub-procedure.
The user runs `/cop-fight` on demand after the PR opens.

## Inputs

| Param | Per-ticket (S4) | Mode C |
|---|---|---|
| `WORK_DIR` | the ticket's worktree or repo root | the container's `REPO_ROOT` |
| `BRANCH` | `BRANCH_NAME` (ticket branch) | `FEATURE_BRANCH` |
| `BASE` | `PR_TARGET` | `PR_BASE` |
| `JIRA_KEY` | `TICKET_KEY` | `CONTAINER_KEY` |
| `STORAGE` | Jira checklist via `sync-checklist` | local file `{REPO_ROOT}/.claude/plans/ticket-work-{CONTAINER_KEY}-pr.md` |
| `MARK_READY` | `false` (PR stays draft until human marks ready) | `true` (run `gh pr ready {BRANCH}` at the end) |
| `REVIEW_TRANSITION` | `true` — on push, move `{JIRA_KEY}`'s Jira status to "In Review" | `false` |
| `DRAFT` | `true` | `true` (P5 then flips to ready) |

Treat `STORAGE` as a black box: each step ends with "mark step N done in
`STORAGE`". Why the two flows store state differently is in `docs/design-notes.md`.

## Steps

### Step P1: PR description generated
**Skip if**: step is already marked done in `STORAGE`.

1. `cd {WORK_DIR}`
2. For Mode C only: `git checkout {BRANCH}` first.
3. Use the Skill tool to run skill `jay-pr-description`.
4. Mark step P1 done in `STORAGE`.

### Step P2: PR created
**Skip if**: step is already marked done in `STORAGE`, OR a draft/open PR for
`{BRANCH}` → `{BASE}` already exists (probe with
`gh pr list --head {BRANCH} --base {BASE} --state open --json number,url --limit 1`);
if so, capture its URL into `PR_URL` and continue.

1. `cd {WORK_DIR}`
2. Run `ensure-pr {BRANCH} --base {BASE} --body-file ./pr.md`, appending
   `--draft` when `DRAFT` is true. Parse the JSON output, store `pr.url` as `PR_URL`.
3. If `REVIEW_TRANSITION` is true, move the ticket's Jira status to "In Review":

   ```bash
   transition-jira {JIRA_KEY} --event review
   ```

   Best-effort: when the workflow offers no matching transition the CLI says so
   and exits 0 — the PR itself remains ground truth. Do **not** change progress
   labels here; the ticket keeps whichever `PROGRESS_LABELS` state it carries.
4. `append-activity {JIRA_KEY} --heading "Draft PR opened" --body "{BRANCH} → {BASE}: {PR_URL}"`
5. Mark step P2 done in `STORAGE`.

### Step P3: PR review plan generated
**Skip if**: step is already marked done in `STORAGE`.

1. `cd {WORK_DIR}`
2. Run the `/jay-pr-review` command.
3. Mark step P3 done in `STORAGE`.

### Step P4: PR review summary posted
**Skip if**: step is already marked done in `STORAGE`.

1. `cd {WORK_DIR}`
2. Run `post-review-summary {BRANCH} --plans-dir .claude/plans --ticket-key {JIRA_KEY}`.
3. If output `posted: true`, mark step P4 done. If `posted: false` with reason
   `no_plan_file`, mark done anyway (nothing to post).

### Step P5: PR marked ready for review (Mode C only)
**Skip if**: step is already marked done in `STORAGE`, OR `MARK_READY` is false.

1. Run `gh pr ready {BRANCH}`.
2. `append-activity {JIRA_KEY} --heading "Feature branch PR ready" --body "Ready for human review: {PR_URL}"`
3. Mark step P5 done in `STORAGE`.
