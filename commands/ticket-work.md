---
description: "Run Jira tickets through plan, execute, and code review to stack-ready. Feature branches merge locally after review passes. Without feature branch, a draft PR to main opens automatically. With args: single ticket. Without args: discover and process queue."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(gh *)
  - Bash(mkdir *)
  - Bash(sync-checklist *)
  - Bash(sync-plan *)
  - Bash(resolve-stack *)
  - Bash(ensure-pr *)
  - Bash(post-review-summary *)
  - Bash(seed-checklist *)
  - Bash(append-activity *)
  - Bash(set-ticket-state *)
  - Bash(transition-jira *)
  - Read
  - Write
  - Skill
  - Agent
---

# Ticket Work

Run Jira tickets through: plan → execute → code review → stack-ready.
Tickets in a Story/Epic stack: merge locally into the container's feature branch (named after the container key, e.g. `EPIC-123`) after review passes.
Standalone tickets (no Story/Epic container): run through stack-ready and straight on to open a draft PR against `main`.
Idempotent — reads checklist state and resumes from wherever it left off.

- **With arguments**: Run a single ticket (or expand a Story to its subtasks and run them in parallel).
- **Without arguments**: Discover all eligible tickets from Jira and process them (queue mode).

## Shell command shape

Every command block in this skill is one Bash tool call. Never chain with `&&`, `||`, or `;`. The permission engine can't statically match compound commands, so chaining breaks per-tool allowlist rules (e.g. `Bash(stage-squash:*)`) and forces prompts.

- For git operations that need a specific directory, use `git -C {DIR} <cmd>` — never `cd {DIR} && git <cmd>`.
- A standalone `cd {WORK_DIR}` step is one call; do not append the next step onto it with `&&`. Bash cwd persists across tool calls in a session, so subsequent commands run in `{WORK_DIR}` without any further cd.
- For non-git CLIs (e.g. `stage-squash`, `append-activity`, `ensure-pr`) that must run inside a repo, do the `cd {WORK_DIR}` once as its own step (or rely on the session's persistent cwd) and invoke the CLI on its own line.

## Label Reference

The canonical lifecycle label set lives in `cli/lib/labels.js` (`DURABLE_LABELS`, `PROGRESS_LABELS`, `CONTAINER_LABELS`). Progress flow is: `ClaudeReady` → `ClaudePlanning` → `ClaudeExecuting` → `ClaudeStackReady` → cleanup; `ClaudeFailed` is the failure side-channel and `ClaudeStackComplete` is the container-level rollup that triggers Mode C. `ClaudeWork` is durable and never removed. Use `set-ticket-state` for every progress transition — it consults `PROGRESS_LABELS` to clear the previous state automatically. It does **not** touch the Jira workflow status.

A state earns a label only when another process (a peer agent, a JQL query, a human handing work back) has no cheaper way to see it. Anything derivable from git, the GitHub PR, or the checklist is read from that source instead:

- **"Out for review"** is not a label — an open PR is the signal, and the Jira *status* is its JQL-queryable stand-in. On PR push run `transition-jira {KEY} --event review`; it is best-effort, so a workflow with no matching transition leaves the status alone and still succeeds. `resolve-stack` surfaces `entry.inReview` / `entry.openPr` for readers, and `isReviewStatus(statusName)` is the Jira-only fallback.
- **"Drift checked"** is not a label — `drift-check` compares the research baseline SHA against the code at HEAD, so re-running it is idempotent and cheap.
- **"Phase-1 cleanup ran"** is not a label — the `merged/{KEY}` git tag created by `/cleanup` Step 2d is the durable record.
- **"Cancelled"** is not a label — `/prune` moves the Jira status instead.

### Complexity Tiers

Two independent gates decide which lifecycle steps run for a ticket. They look at different signals at different points and can fire independently:

- **Gate 1 — skip plan + collapse execute.** Decided **pre-execute** at S3.4 from AC and Implementation Notes signals. When fired, S4.1 (`/plan-ticket` plan) is skipped and S4.2 runs in **no-plan mode** (single-batch test authoring instead of per-task Red-Green-Refactor). Expressed via the `complexity:trivial` label.
- **Gate 2 — skip refactor + code review pass.** Decided **post-execute** at S4.3.5 from the actual diff size. When fired, S4.4 (`@refactor` agent) and S4.5 (`/jay-pr-review` plan) are skipped. Set in-memory only — no Jira label.

The decisions are separate because Gate 1 needs to commit before any code is written (planner ceremony costs time up front) while Gate 2 can only be made honestly once the code exists (the AC may have looked small but produced a 500-line refactor).

CI green and Copilot review comments are NOT driven by the pipeline anymore. After the PR opens, run `/cop-fight` on demand to drive CI green and judge Copilot comments. The ticket-work lifecycle stops once the PR is pushed and the review summary is posted.

Tickets carry an optional `complexity:trivial` or `complexity:standard` label (see `COMPLEXITY_LABELS` in `cli/lib/labels.js`; `getComplexity(labels)` resolves it, defaulting to `standard`). The label is Gate 1's output — set either by the human at intake or, if absent, by **S3.4 Classify Complexity** below.

When `complexity:trivial`:
- S4.1, S4.4, S4.5 are pre-marked done at seed time with a ` (skipped: trivial)` label suffix by `seed-checklist`, so the checklist-driven loop in S4 walks past them.
- S4.2 detects the absence of a plan in Jira and runs **no-plan mode** (see S4.2).

When `complexity:standard` and S4.3.5 fires Gate 2 mid-flight, the per-step `Skip if` directive in S4.4–S4.5 carries a ` (skipped: output trivial)` suffix instead.

Step numbering stays stable across tiers.

Feature branches are derived automatically: every Story/Epic container is a feature branch named after its Jira key (e.g. `EPIC-123`), or after the value of a `branch:<name>` label on the container if set. The tooling creates the branch on first use, basing it on `main` (or on a blocker container's branch — see `resolve-stack` output `container.baseBranch`).

### Activity Log Comment

All narrative status updates go into a single managed Jira comment (marker `[claude-activity-log]`) — one per ticket, append-only. Use the `append-activity` CLI to record progress instead of `mcp__atlassian__addCommentToJiraIssue`. Each call adds a timestamped entry with a heading and a compacted body (1-5 bullet recap, not full narration).

Usage:
```bash
append-activity {TICKET_KEY} --heading "<short title>" --body "<compact summary>"
```

For multi-line bodies, write to a temp file and use `--body-file`. Subagents launched from this command should call `append-activity` once at the end of their work with a compacted summary of what they did.

### Label Inheritance

When a parent Story/Task has `ClaudeReady`, its subtasks are eligible for planning without needing the label themselves. On first pickup `discover-queue --apply-inheritance` (Mode B) or the Mode A inheritance step copies parent labels (minus `ClaudeStackComplete`) plus the parent's assignee onto each subtask via the `buildParentInheritancePatch` rule in `cli/lib/queue.js`. After this sync, subtasks carry their own labels and progress labels apply per-subtask.

## Code Style

The **Code Style** section in `~/.claude/CLAUDE.md` is the source of truth. S4.2 (execute) and S4.4 (refactor) apply it verbatim. Project-local conventions (existing patterns in the touched files, CLAUDE.md, linter config) always win when they conflict.

## Arguments

$ARGUMENTS

Optional: space-separated Jira ticket keys (e.g., `PROJ-123 PROJ-456`). If a key is a parent Story/Task with subtasks, it expands to the eligible subtasks underneath it. If no arguments are provided, runs in queue mode — discovers all eligible tickets and processes them.

### Flags

- `--serial`: Work tickets sequentially using branch checkout instead of worktrees. Stays in the main repo directory and switches branches between tickets. Use when worktrees are impractical (e.g., monorepos with expensive setup, limited disk space, or tooling that doesn't support worktrees).

### Flag Parsing

Parse `$ARGUMENTS` to extract flags before processing ticket keys. Any token starting with `--` is a flag; remaining tokens are ticket keys. Store `SERIAL_MODE = true` if `--serial` is present.

---

# Mode A: Single Ticket (arguments provided)

## A1: Resolve Tickets

Use `mcp__atlassian__getAccessibleAtlassianResources` to get `CLOUD_ID`.

For each key in `$ARGUMENTS`, use `mcp__atlassian__getJiraIssue` to fetch it.

### Completed stack — Mode C

If the issue is a **stack container** (Story/Task with subtasks, or Epic) AND has `ClaudeStackComplete` label: this is a completed feature branch ready for PR to main. Proceed to **Mode C: Feature Branch PR** below.

### Epic — pick the next unblocked ticket and run it serially

If the issue type is `Epic` (and Mode C did not trigger above), do **not** expand to all descendants and fan out in parallel. Epics always advance one ticket at a time.

1. Run the **Stack Context Resolution** sub-procedure with `KEY={EPIC_KEY}` and `FETCH=true`. This produces `STACK_ORDER` (topologically sorted) and the container fields.
2. Walk `STACK_ORDER` in order and pick the **first** entry where:
   - `entry.eligible === true`, AND
   - the entry does not already carry any progress label from `PROGRESS_LABELS` (`ClaudePlanning`, `ClaudeExecuting`, `ClaudeStackReady`, `ClaudeFailed`), AND
   - `entry.inReview !== true` — `resolve-stack` sets this (and populates `entry.openPr`) when the ticket has an open PR or a review-state Jira status. Those tickets are out for review, not waiting for work.
   Call this `NEXT_KEY`.
3. If no entry qualifies:
   - If every entry is finished (per `isFinished()` — i.e. `mergedIntoFeature` or `mergedIntoMain` for each), the Epic is effectively complete. Display "Epic {EPIC_KEY} has no unblocked work — all tickets finished. Run `/ticket-work {EPIC_KEY}` again once `ClaudeStackComplete` is set, or apply the label manually to trigger Mode C." and **stop**.
   - Otherwise, display "Epic {EPIC_KEY} has no eligible tickets — every remaining ticket is blocked or already in flight. First blocker: {first non-eligible entry's key} (waiting on {its `unblockedBlockers[0]`})." and **stop**.
4. Inherit labels/assignee from the Epic onto `NEXT_KEY` if it's a subtask whose parent is the Epic (or the Epic-descended Story) — same rules as the "Inherit from Parent" block below; reuse `buildParentInheritancePatch` semantics from `cli/lib/queue.js`.
5. Force `SERIAL_MODE = true` and set `EPIC_SINGLE_MODE = true` for the rest of this invocation, regardless of whether `--serial` was passed. `EPIC_SINGLE_MODE` tells S6 to stop instead of auto-advancing — Epic entry runs exactly one ticket per invocation; re-run `/ticket-work {EPIC_KEY}` to pick the next.
6. Display: "Epic {EPIC_KEY}: working next unblocked ticket {NEXT_KEY} - {NEXT_SUMMARY} (serial mode, single-ticket-per-invocation)."
7. Proceed to **Single Ticket Lifecycle** below using `{NEXT_KEY}` as `TICKET_KEY`. Do **not** fall through to the "parent with subtasks" expansion path — Epics never run the Queue Pipeline from Mode A.

### Standard ticket resolution

If it is a **parent with subtasks** (issue type is Story/Task and has subtasks), expand to its subtasks via JQL: `parent = {PARENT_KEY}`. Apply exclusion filter (skip subtasks that already have `ClaudePlanning`, `ClaudeExecuting`, `ClaudeStackReady`, or `ClaudeFailed` — this is `SUBTASK_EXCLUSION_LABELS` in `cli/lib/labels.js`). If not a parent, use the ticket directly.

### Inherit from Parent (subtasks only)

For each subtask discovered via a parent, sync the parent's labels (minus `ClaudeStackComplete`) and assignee onto the subtask. The implementation lives in `cli/lib/queue.js` (`buildParentInheritancePatch`) and is exposed via `discover-queue --apply-inheritance` for the Mode B/Q2 path; Mode A's lighter discovery loop should apply the same patch by calling `mcp__atlassian__editJiraIssue` directly with the same rules. Reuse those rules verbatim — do not redefine them here.

### Single ticket — run directly

If only **one** work item results (single ticket, or a Story with one subtask), proceed to **Single Ticket Lifecycle** below. `SERIAL_MODE` is irrelevant when there's only one ticket — there is no parallelism to suppress — but it is still propagated into the lifecycle (`SERIAL_MODE` controls per-ticket worktree-vs-branch handling in S2a/S2b regardless of how many tickets ran). Do not strip `--serial` when handing off.

### Multiple tickets — parallel agents (or serial)

If **multiple** work items result, run the **Queue Pipeline** (Step Q3 onward) using these tickets instead of JQL discovery. `SERIAL_MODE` propagates: it controls Q6a vs Q6b dispatch, and each spawned per-ticket invocation inherits the flag (Q6b passes `--serial` to the child invocations explicitly so worktree-vs-branch handling stays consistent across the queue).

---

# Mode B: Queue Mode (no arguments)

Run the full queue pipeline: discover → gate → prepare → execute → promote.

Proceed to **Queue Pipeline** below.

---

# Shared sub-procedure: Stack Context Resolution

This sub-procedure is referenced from `ticket-work`, `cleanup`, `promote-to-main`, `prune`, `rework`, `stack-rebase`, `fix-drift`, and `orchestrate`. It captures the standard "run `resolve-stack` and bind its container fields to local variables" boilerplate so each command can reference it instead of re-listing the bindings inline.

## Inputs

- `KEY` — the ticket or container key to resolve.
- `REPO_ROOT` — optional; passed to `resolve-stack --repo-root {REPO_ROOT}` when set.
- `FETCH` — when truthy, append `--fetch` so origin refs are refreshed.

## Procedure

1. Run `resolve-stack {KEY}` (with `--repo-root` and/or `--fetch` flags as supplied).
2. Parse the JSON output. Bind these names from the result:
   - `CONTAINER_KEY` ← `container.key` (null for standalone tickets)
   - `CONTAINER_TYPE` ← `container.type`
   - `CONTAINER_SUMMARY` ← `container.summary`
   - `FEATURE_BRANCH` ← `container.featureBranch`
   - `CONTAINER_BASE` ← `container.baseBranch` (`main` or a blocker container's branch — used by S2.0)
   - `UNMERGED_BLOCKERS` ← `container.unmergedBlockers`
   - `PARENT_CONTAINER_KEY` ← `container.parentContainerKey` (null when none)
   - `PARENT_FEATURE_BRANCH` ← `container.parentFeatureBranch`
   - `REPO_ROOT` ← `container.repoRoot`
   - `STACK_ORDER` ← the `stack` array (already topologically sorted, `branch`/`baseBranch`/`prTarget`/`mergedIntoMain`/`mergedIntoFeature`/`eligible` populated per entry)
3. When the caller cares about the input ticket specifically, locate its entry: `entry = STACK_ORDER.find(s => s.key === KEY)`.

When `container` is `null` (standalone ticket with no Story/Epic container), the ticket-specific fields still come from `stack[0]` and the container-level bindings are null. Each caller decides how to handle the standalone case.

> **Field semantics live in `cli/lib/stack-resolver.js`** — `resolveStack()` and `isFinished()` are the source of truth. If the field set changes, update the resolver and this sub-procedure together; do not let callers redefine the meaning locally.

---

# Shared sub-procedure: Ensure Cleanup Prerequisites

This sub-procedure enforces that every ticket merged into a feature branch has been cleaned up before any downstream command consumes the stack state. Cleanup creates a `merged/{TICKET_KEY}` tag on the merge commit (see `commands/cleanup.md` Step 2d); commands that traverse merged history (`/promote-to-main` Step 1c, `/ticket-work` Q5/S2.5, `/stack-rebase`) refuse to run when the tag is missing.

The gate is self-healing: if a ticket is merged-into-feature but lacks its tag, this sub-procedure inline-runs `/cleanup --yes --no-rebase --no-refresh-feature` to backfill the tag. It only halts when `/cleanup` itself cannot produce the tag (PR not merged, MERGE_SHA unreachable, etc.) — those failures need human investigation.

## Inputs

- `STACK_ORDER` — the topologically sorted stack from the **Stack Context Resolution** sub-procedure.
- `REPO_ROOT` — passed to `git ls-remote` for tag probes.
- `RESOLVED_KEY` — the original argument the calling command was invoked with (used in error messages so the user knows what to re-run).

## Procedure

1. **Bulk-fetch existing tags** in one network round trip:
   ```bash
   git -C {REPO_ROOT} ls-remote origin 'refs/tags/merged/*'
   ```
   Parse each line `<sha>\trefs/tags/merged/{KEY}` into a set `EXISTING_TAGS = { KEY, ... }`. If the command fails (network), display the error and **stop** — we cannot reason about prerequisites without the tag list.

2. **Build `MISSING_TAGS`** by walking `STACK_ORDER`. An entry needs a tag when:
   - `entry.mergedIntoFeature === true`, AND
   - `entry.mergedIntoMain === false` (terminal cleanup deletes the tag — main-merged tickets shouldn't have one), AND
   - `entry.key ∉ EXISTING_TAGS`.

   If `MISSING_TAGS` is empty, return — prerequisites satisfied.

3. **Inline backfill** for each entry in `MISSING_TAGS`, in stack order:
   - Display: `Auto-fixing missing cleanup for {entry.key}…`
   - Use the `Skill` tool to run skill `cleanup` with args `{entry.key} --yes --no-rebase --no-refresh-feature`.
     - `--yes` skips the confirmation prompt.
     - `--no-rebase --no-refresh-feature` keep the cleanup focused on tag creation. Cascade work is the calling command's responsibility (or `/orchestrate`'s) — this sub-procedure just unblocks the stack gate.
     - **`--no-rebase` is load-bearing for re-entrancy, not just scope.** `/cleanup` Step 7 shells out to `cascade-rebase`, the same library `/stack-rebase` Step 4 uses. Since `/stack-rebase` gates on this sub-procedure at its Step 1.5, dropping `--no-rebase` would let cleanup's cascade re-enter the caller. Keep the flag.
   - Re-probe the tag: `git -C {REPO_ROOT} ls-remote origin refs/tags/merged/{entry.key}`.
   - If still empty, `/cleanup` refused to create the tag (typically because its own Step 2 verification failed — no merged PR found, or MERGE_SHA not reachable from `origin/{MERGE_TARGET}`). Display:

     ```
     Prerequisite cleanup failed for {entry.key}: tag merged/{entry.key} was not created.

     /cleanup {entry.key} did not produce the expected tag — this typically means:
       - the ticket's PR has not actually merged yet, or
       - the merge commit is not reachable from origin/<merge-target>, or
       - the ticket has no branch on record.

     Investigate /cleanup {entry.key} manually, then re-run the original command:
       <calling command> {RESOLVED_KEY}
     ```

     and **stop** the calling command.

4. **Refresh `STACK_ORDER`** by re-running the **Stack Context Resolution** sub-procedure with the same `KEY` and `FETCH=true`. Cleanup may have shifted `mergedIntoFeature`/`mergedIntoMain` flags or moved branches, so the caller should not reuse the pre-backfill stack view.

5. Return.

## Performance note

`git ls-remote origin 'refs/tags/merged/*'` is a single network call that returns every tag the gate cares about — pre-filter `EXISTING_TAGS` once at step 1 instead of probing per-ticket. For a stack with no `mergedIntoFeature: true` entries, the sub-procedure short-circuits at step 2 with no work.

## Callers

- `/promote-to-main` — Step 1b-final, before the tag walk.
- `/ticket-work` S1d — after stack resolution, before `ensure-work-dir` and the S2.5 rebase consume `BASE_BRANCH`.
- `/ticket-work` Q4.5 — once per `(REPO_ROOT, CONTAINER_KEY)` group, before Q5 prepares working directories. Skips the offending group rather than stopping the whole queue.
- `/stack-rebase` Step 1.5 — before the scenario check and cascade rebase.
- `/orchestrate` — **does not call this sub-procedure.** It runs its own equivalent tag sweep at Step 3a (`git ls-remote origin 'refs/tags/merged/*'` → `phaseOneDone`) and feeds that into `classifyTicket`, which dispatches `cleanup-phase-1` / `cleanup-terminal` as first-class actions. That's a deliberate difference in kind: the orchestrator *surfaces and queues* cleanup as a visible action for the user to see before it runs, whereas this sub-procedure *silently backfills* to unblock a single command. Converging them would mean either hiding cleanups from the orchestrator's queue display or making this gate interactive. If they do converge later, `cli/lib/classify-actions.js` is the place to share the detection, not the prose.

## Non-callers

`/prework` (`commands/prework.md`) reaches `ensure-work-dir` at its Step 2 without resolving stack context at all, so it has no `STACK_ORDER` to gate on and is not wired here. It's a pre-planning setup step whose output is consumed by `/ticket-work`, which gates at S1d — so the un-cleaned state gets caught before any implementation work begins. Adding the gate to `/prework` would require adding stack resolution to it first.

Note that this set of call sites is a convention, not an enforced invariant: any future command that consumes `STACK_ORDER` must opt in explicitly. The alternative — putting the gate inside `resolve-stack` so every consumer inherits it — was considered and rejected, because it would turn a read-only resolver into something that mutates git state and pushes tags as a side effect of being asked a question.

---

# Shared sub-procedure: PR Push & Review

This sub-procedure is parameterized and called from both **S4.8–S4.10** (per-ticket PR flow) and **C3** (Mode C feature-branch PR flow). It captures the common shape — generate description, push as draft, sanity-review, post review summary — so changes to that shape only need to be made once. CI green and Copilot comment resolution are NOT part of this sub-procedure; the user runs `/cop-fight` on demand after the PR opens.

## Inputs

| Param | Per-ticket (S4) | Mode C |
|---|---|---|
| `WORK_DIR` | the ticket's worktree or repo root | the container's `REPO_ROOT` |
| `BRANCH` | `BRANCH_NAME` (ticket branch) | `FEATURE_BRANCH` |
| `BASE` | `PR_TARGET` | `PR_BASE` |
| `JIRA_KEY` | `TICKET_KEY` | `CONTAINER_KEY` |
| `STORAGE` | Jira checklist via `sync-checklist` | local file `{REPO_ROOT}/.claude/plans/ticket-work-{CONTAINER_KEY}-pr.md` |
| `MARK_READY` | `false` (PR stays draft until human marks ready) | `true` (run `gh pr ready {BRANCH}` at the end) |
| `REVIEW_TRANSITION` | `true` — on push, move `{JIRA_KEY}`'s Jira status to "In Review" | `false` (Mode C does not touch the ticket's Jira state — the container's `ClaudeStackComplete` is independent) |
| `DRAFT` | `true` (per-ticket PRs open as draft) | `true` (Mode C feature-branch PRs also open as draft, then P5 flips to ready) |

> **Storage divergence note**: the per-ticket flow's resume state lives in Jira (the checklist on the ticket itself, accessed via `sync-checklist`). Mode C's resume state lives in a local file because the container itself doesn't have a per-step checklist of its own — its checklist is the *roll-up* of its subtasks. The intent is for both flows to converge on Jira-comment storage in the future; for now, treat `STORAGE` as a black box: each step ends with "mark step N done in `STORAGE`".

## Steps

### Step P1: PR description generated
**Skip if**: step is already marked done in `STORAGE`.

1. `cd {WORK_DIR}`
2. For Mode C only: `git checkout {BRANCH}` first.
3. Use the Skill tool to run skill `jay-pr-description`.
4. Mark step P1 done in `STORAGE`.

### Step P2: PR created
**Skip if**: step is already marked done in `STORAGE`, OR a draft/open PR for `{BRANCH}` → `{BASE}` already exists (probe with `gh pr list --head {BRANCH} --base {BASE} --state open --json number,url --limit 1`); if so, capture its URL into `PR_URL` and continue.

1. `cd {WORK_DIR}`
2. Run `ensure-pr {BRANCH} --base {BASE} --body-file ./pr.md`, appending `--draft` when `DRAFT` is true. Parse the JSON output, store `pr.url` as `PR_URL`.
3. If `REVIEW_TRANSITION` is true, move the ticket's Jira workflow status to "In Review" — the open PR is the review signal, and the status is its JQL-queryable stand-in (there is no review label):

   ```bash
   transition-jira {JIRA_KEY} --event review
   ```

   Best-effort by design: when the workflow offers no matching transition the CLI says so and exits 0 — the PR itself remains the ground truth. Do **not** change progress labels here; the ticket keeps whichever `PROGRESS_LABELS` state it already carries.
4. Append to the activity log: `append-activity {JIRA_KEY} --heading "Draft PR opened" --body "{BRANCH} → {BASE}: {PR_URL}"`.
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
3. If output `posted: true`, mark step P4 done. If `posted: false` with reason `no_plan_file`, mark done anyway (nothing to post).

### Step P5: PR marked ready for review (Mode C only)
**Skip if**: step is already marked done in `STORAGE`, OR `MARK_READY` is false.

1. Run `gh pr ready {BRANCH}`.
2. Append to the activity log: `append-activity {JIRA_KEY} --heading "Feature branch PR ready" --body "Ready for human review: {PR_URL}"`.
3. Mark step P5 done in `STORAGE`.

> **Note**: CI green and Copilot review comment resolution are not part of this sub-procedure. After the PR opens, run `/cop-fight` on demand to drive CI to green and judge Copilot comments. See `commands/cop-fight.md`.

---

# Mode C: Feature Branch PR (completed stack)

Triggered when a stack container key is passed that has `ClaudeStackComplete`. This opens a PR from the feature branch (named after the container key) to its parent's feature branch (when the container is a Story nested under an Epic-with-feature-branch) or to `main` (top-level Epics, standalone Stories). Generates a PR review plan and posts the review summary, then marks the PR ready for human review. CI green and Copilot comment resolution are NOT automatic — run `/cop-fight` on demand after the PR is open.

## C1: Initialize

1. `CONTAINER_KEY` = the provided issue key
2. Run:
   ```bash
   resolve-stack {CONTAINER_KEY} --fetch
   ```
   Parse the JSON output. Decide which "container" perspective applies:

   - **Resolver returned `container.key === CONTAINER_KEY`** (top-level Epic/Story whose own stack we resolved): use the `container` block directly.
     - `FEATURE_BRANCH` = `container.featureBranch`
     - `REPO_ROOT` = `container.repoRoot`
     - `PARENT_FEATURE_BRANCH` = `container.parentFeatureBranch`
     - `PARENT_CONTAINER_KEY` = `container.parentContainerKey`

   - **Resolver returned a different `container.key`** (the input key is itself a Story member of a larger Epic stack — common when a Story-with-subtasks lives under an Epic): use the input ticket's entry within `stack[]`.
     - Find `entry = stack.find(s => s.key === CONTAINER_KEY)`.
     - `FEATURE_BRANCH` = `entry.branch` (will equal `CONTAINER_KEY` for a Story-container)
     - `REPO_ROOT` = `container.repoRoot`
     - `PARENT_FEATURE_BRANCH` = `container.featureBranch` (the enclosing Epic's branch — this is what the Story PRs into)
     - `PARENT_CONTAINER_KEY` = `container.key`
3. Compute the PR target:
   - `PR_BASE` = `PARENT_FEATURE_BRANCH` if non-null, else `main`
   - When `PR_BASE` is the parent's feature branch, this Story's PR will target the Epic's branch and merge into it. The Epic's own Mode C run will eventually PR the accumulated work to `main`.
4. Fetch latest:
   ```bash
   git -C {REPO_ROOT} fetch origin
   ```
5. Checkout the feature branch (two calls — never chain):
   ```bash
   git -C {REPO_ROOT} checkout {FEATURE_BRANCH}
   ```
   ```bash
   git -C {REPO_ROOT} pull origin {FEATURE_BRANCH}
   ```
6. If `PR_BASE` is not `main`, ensure the parent feature branch exists locally and is up to date. Try the fast path first; if it fails, fall back:
   ```bash
   git -C {REPO_ROOT} fetch origin {PR_BASE}:{PR_BASE}
   ```
   If that call errors (parent branch not on origin as a fast-forwardable ref), retry:
   ```bash
   git -C {REPO_ROOT} fetch origin {PR_BASE}
   ```
   If that fails (parent branch not on origin), display: "Parent container {PARENT_CONTAINER_KEY} has no branch on origin. Run /ticket-work against {PARENT_CONTAINER_KEY}'s first ticket to bootstrap it." and **stop**.

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

Run the **Shared sub-procedure: PR Push & Review** (defined above) with these bindings:

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

# Queue Pipeline

Used by both Mode B (full discovery) and Mode A (multiple tickets from argument expansion).

## Q1: Initialize

### Q1a: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID` (skip if already set from Mode A)

### Q1b: Load Dev Root

`DEV_ROOT` is set via `.env` or `~/.claude/.env`. It is the parent directory containing all repo clones. Repo names from `repo:` labels map directly to subdirectories: `{DEV_ROOT}/{repo_name}`.

## Q2: Discover Eligible Tickets

**Skip if tickets were already resolved from Mode A arguments.**

Run:

```bash
discover-queue --apply-inheritance
```

Parse the JSON output:
- `tickets[]` — deduped list of eligible tickets (each entry has `key`, `summary`, `labels`, `issueType`, `parentKey`, `assignee`, `via`, `parentSeed`).
- `parents[]` — parent Stories/Tasks that seeded the parent-expansion path (used for diagnostics).
- `subtaskExpansions[]` — `{ child, parent, patch }` records the CLI applied (Q2e inheritance).
- `inheritanceApplied` — count of subtasks whose labels/assignee were synced from a parent.

The CLI runs three JQL queries internally (sourced from `cli/lib/queue.js` `QUEUE_QUERIES`): `readyForPlanning`, `readyParents` (then expanded into eligible subtasks via `parent = {KEY}`, filtering out anything carrying `SUBTASK_EXCLUSION_LABELS` from `cli/lib/labels.js`), and `inFlight`. Q2e inheritance is applied automatically when `--apply-inheritance` is set: parent labels (minus `ClaudeStackComplete`) plus the parent's assignee (when the subtask is unassigned) are copied onto each parent-discovered subtask.

If `tickets` is empty, proceed directly to Q7 (Promote).

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

If the sub-procedure halts for a group (a `/cleanup` that could not produce its tag), **skip every ticket in that group** and display its refusal, then continue with the remaining groups. One stack blocked on a human should not stall the rest of the queue — this is a deliberate departure from the single-ticket path at S1d, which stops outright because it has only one stack to work on.

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

### Q6a: Parallel Mode (default, not `SERIAL_MODE`)

All eligible tickets are independent (gating ensures no two same-stack tickets are eligible simultaneously). Launch ALL as **parallel Agent tool calls in a single message**.

For each eligible ticket, launch an Agent with:
- `description`: "Work {KEY}"
- `prompt`: Use the template below, substituting all variables.

**Agent Prompt Template (Parallel):**

```
Run the ticket lifecycle for Jira ticket {KEY} - {SUMMARY}.

cd {REPO_ROOT}/../{KEY}

Use the Skill tool to run skill "ticket-work" with args "{KEY}"

ticket-work is idempotent — it will resume from the current checklist state
and run through to the next gate (approval) or completion.
```

Wait for all agents to complete before proceeding.

### Q6b: Serial Mode (`SERIAL_MODE = true`)

Process tickets **one at a time, sequentially** in the main repo directory. Order tickets by stack dependency (upstream first), then by ticket key.

For each eligible ticket, **in order**:

1. Checkout the ticket's branch:
   ```bash
   git -C {REPO_ROOT} checkout {BRANCH_NAME}
   ```
2. Display: "Working ticket {KEY}: {SUMMARY} (branch: {BRANCH_NAME}, base: {BASE_BRANCH})"
3. Use the Skill tool to run skill `ticket-work` with args `{KEY} --serial`
4. After the ticket reaches a gate (approval needed) or completes, stash or commit any work and continue to the next ticket.

If a ticket stops at a gate (PR approval), continue to the next ticket. The stopped ticket will resume on next run.

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

# Single Ticket Lifecycle

Runs one ticket through all steps. Used directly (Mode A, single ticket) or via agent delegation from the Queue Pipeline.

## S1: Detect Environment

### S1a: Determine Mode and Working Directory

Check if `--serial` flag is present in arguments. Set `SERIAL_MODE = true` if so.

Run:
```bash
git rev-parse --show-toplevel
```

Store as `CURRENT_ROOT`.

#### If `SERIAL_MODE`:

- Set `REPO_ROOT` = `CURRENT_ROOT`
- Set `WORK_DIR` = `CURRENT_ROOT` (all work happens in the main repo)
- Detect `BRANCH_NAME` from the current branch: `git rev-parse --abbrev-ref HEAD`
  - If the current branch matches the ticket key pattern (`{TICKET_KEY}*`), we're already on the right branch.
  - Otherwise, we'll need to checkout/create the branch in S2.

#### If not `SERIAL_MODE` (worktree mode):

Determine if we are already in the correct worktree:

- Extract the basename of `CURRENT_ROOT` (e.g., `/path/to/repos/PROJ-123` → `PROJ-123`)
- If the basename **matches the ticket key**: we are already in the ticket's worktree.
  - Set `WORK_DIR` = `CURRENT_ROOT`
  - Set `REPO_ROOT` = parent's git main worktree. Detect with:
    ```bash
    git worktree list --porcelain
    ```
    The first entry (marked `bare` or without `branch`) is the main worktree. Store its path as `REPO_ROOT`.
    If `CURRENT_ROOT` IS the main worktree (not a linked worktree), then `REPO_ROOT` = `CURRENT_ROOT` and we still need to create the ticket worktree (proceed to S2).
  - Detect `BRANCH_NAME` from the current branch: `git rev-parse --abbrev-ref HEAD`
- If the basename **does not match**: we are in the main repo (or a different worktree).
  - Set `REPO_ROOT` = `CURRENT_ROOT`
  - Set `WORK_DIR` = `{REPO_ROOT}/../{TICKET_KEY}`
  - `BRANCH_NAME` will be resolved from `resolve-stack` output in S1c

### S1b: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### S1c: Resolve Stack Context

Run the **Stack Context Resolution** sub-procedure (defined below) with `KEY={TICKET_KEY}`, `REPO_ROOT={CURRENT_ROOT}`, and `FETCH=true`. The fetch matters for S1d: the cleanup gate decides which predecessors need a tag from `mergedIntoFeature` / `mergedIntoMain`, and those flags are computed against local origin refs. Resolving without `--fetch` can report a predecessor as unmerged when its merge already landed, silently skipping the backfill the gate exists to perform. (The gate's own tag probe uses `git ls-remote`, which always reads the remote directly and needs no fetch.)

After the sub-procedure runs, also extract from the ticket's `stack[]` entry:
- `BRANCH_NAME` = ticket's `branch` (or `{TICKET_KEY}` if null)
- `BASE_BRANCH` = ticket's `baseBranch`
- `PR_TARGET` = ticket's `prTarget`
- `SUMMARY` = ticket's `summary`
- `labels` = ticket's `labels` array

(`FEATURE_BRANCH`, `CONTAINER_KEY`, `CONTAINER_BASE`, `UNMERGED_BLOCKERS`, `REPO_ROOT`, etc. come from the sub-procedure.)

If the ticket's `eligible` is `false` and `unblockedBlockers` is non-empty:
- Display: "Blocked: waiting on {unblockedBlockers[0]}" and **stop**.

- **Ensure `ClaudeWork` label**: If the ticket does not already have the `ClaudeWork` label, add it using `mcp__atlassian__editJiraIssue` with `update`: `{"labels": [{"add": "ClaudeWork"}]}`.

### S1d: Ensure Cleanup Prerequisites

Run the **Ensure Cleanup Prerequisites** sub-procedure (defined above) with `STACK_ORDER` and `REPO_ROOT` from S1c and `RESOLVED_KEY={TICKET_KEY}`. Any predecessor already merged into the feature branch but missing its `merged/{KEY}` tag gets backfilled before this ticket's branch or rebase base is computed.

This runs **before** S2 rather than after it because the sub-procedure's final step refreshes `STACK_ORDER`, which can shift `BASE_BRANCH`. `ensure-work-dir` (S2a/S2b) and the S2.5 rebase both consume `BASE_BRANCH`, so they must see the post-backfill value. Re-bind the S1c ticket-entry fields (`BRANCH_NAME`, `BASE_BRANCH`, `PR_TARGET`) from the refreshed stack before continuing.

When no predecessor is missing a tag the sub-procedure short-circuits after a single `git ls-remote` and no refresh happens — the common case costs one network call.

## S2: Ensure Working Directory Ready

### S2.0: Ensure Feature Branch Exists (skip if `FEATURE_BRANCH` is null)

Before any per-ticket branch/worktree creation, make sure the feature branch exists locally and on origin. Skip this step entirely for standalone tickets (`FEATURE_BRANCH` null).

Read `CONTAINER_BASE` = `container.baseBranch` and `UNMERGED_BLOCKERS` = `container.unmergedBlockers` from the `resolve-stack` output (S1c). Then run:

```bash
ensure-work-dir --feature-branch {FEATURE_BRANCH} --container-base {CONTAINER_BASE} --repo-root {REPO_ROOT} \
  --unmerged-blockers {UNMERGED_BLOCKERS}    # comma-separated; omit flag if empty
```

This is a no-op when the feature branch already exists on origin. Otherwise it creates and pushes it (validating that the parent's branch exists on origin first). On `Error: Blocker container has no branch yet` or `Error: multiple unmerged blocker containers`, **stop** and surface the error to the user.

### S2a/S2b: Ensure Working Directory

Run:

```bash
ensure-work-dir {TICKET_KEY} --repo-root {REPO_ROOT} --base {BASE_BRANCH} \
  --branch {BRANCH_NAME}                     # optional override
  [--serial]                                 # add when SERIAL_MODE
```

Parse the JSON: `{ workDir, branch, mode, created, fetched }`. Set `WORK_DIR = workDir` and `PLANS_DIR = {WORK_DIR}/.claude/plans` (used only for the PR review plan at S4.5).

In serial mode the branch is checked out in `{REPO_ROOT}`; in worktree mode the worktree is created at `{REPO_ROOT}/../{TICKET_KEY}`.

### S2.5: Rebase onto origin/{BASE_BRANCH}

Every `/ticket-work` invocation (initial pickup or resume) rebases the ticket branch onto the latest `origin/{BASE_BRANCH}` before loading the checklist. This keeps the ticket synced with whatever it's stacked on — `main` for top-of-stack tickets, the container's feature branch for mid-stack work, or a sibling ticket's branch for chained tickets.

**Skip if** `ensure-work-dir` reported `created: true` for this branch in S2 (a freshly created branch is already at base — no rebase needed).

1. `cd {WORK_DIR}`
2. Fetch the base:
   ```bash
   git fetch origin {BASE_BRANCH}
   ```
3. Check whether a rebase is needed (the branch tip is already a descendant of `origin/{BASE_BRANCH}`):
   ```bash
   git merge-base --is-ancestor origin/{BASE_BRANCH} HEAD
   ```
   If exit 0, skip the rebase — already up to date.
4. Otherwise rebase:
   ```bash
   git rebase origin/{BASE_BRANCH}
   ```
5. **On conflict**: abort and surface to the user.
   ```bash
   git rebase --abort
   ```
   Move the ticket to `ClaudeFailed`:
   ```bash
   set-ticket-state {TICKET_KEY} --to ClaudeFailed
   append-activity {TICKET_KEY} --heading "Rebase conflict" --body "Conflict rebasing \`{BRANCH_NAME}\` onto \`origin/{BASE_BRANCH}\`. Resolve manually and remove \`ClaudeFailed\` to retry."
   ```
   **Stop** — the user must resolve the conflict and re-run.
6. **On success with new commits applied**: force-with-lease push so origin reflects the rebased branch:
   ```bash
   git push --force-with-lease origin {BRANCH_NAME}
   ```
   Skip the push if the rebase was a no-op (no commits replayed).

## S3: Load or Resume Checklist

The checklist lives as a managed Jira comment (tagged with `[claude-checklist-sync]` marker). No local checklist file is created.

Run:
```bash
seed-checklist {TICKET_KEY} --work-dir {WORK_DIR} --branch {BRANCH_NAME} --base-branch {BASE_BRANCH} --pr-target {PR_TARGET} --summary "{SUMMARY}" {--serial if SERIAL_MODE} --jira-source
```

Parse the JSON output:
- If `source` is `"jira"`: the checklist was read from an existing Jira comment. Resume from the first unchecked step.
- If `source` is `"seeded"`: the checklist was freshly created (seeded from Jira labels and git stage commits) and written to Jira. Start from the first unchecked step. The output also includes `complexity: "trivial" | "standard"` derived from the ticket's labels — same value `getComplexity()` would have returned. When the checklist was seeded for a trivial ticket, steps 1, 4, 5, and 6 are pre-marked done with a ` (skipped: trivial)` label suffix.

Store the `steps` array in memory for step tracking throughout S4.

## S3.4: Classify Complexity

Tickets carry an optional `complexity:trivial` or `complexity:standard` label that drives which steps in S4 actually run (see "Complexity Tiers" in the Label Reference section). This step ensures every ticket has a tier label before S4 begins. **Skip entirely if** the ticket already has either label.

1. Re-read the ticket's current labels (the labels read at S1c are stale if the human just added one). Use `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`.
2. If `labels` contains `complexity:trivial` or `complexity:standard`, skip the rest of S3.4 and continue to S3.5.
3. Otherwise classify. Read the ticket's description (specifically the `Acceptance Criteria` / Gherkin scenarios and the `Implementation Notes` block, when present). Decide tier using this rubric:
   - **trivial** — Gate 1 fires. Skip plan, run execute in no-plan mode. Eligible when **any** of:
     - Implementation Notes is **complete** — has a non-empty `*Existing patterns to extend:*` AND a non-empty `*Files likely to change:*` AND (when AC has Gherkin scenarios) a non-empty `*Tests likely to extend:*`. The planner already did the design work; a separate `/plan-ticket` pass would only restate it. File count is **not** capped — what matters is whether the design surface is enumerated, not its width.
     - AC has zero Gherkin scenarios (nothing branchy to plan against).
     - AC is a single Gherkin scenario with ≤3 `Then` clauses.
     - Mechanical edit: rename, typo, doc tweak, copy change, dependency bump that doesn't touch interfaces.

     **Bias-toward-standard veto**: if any of the words `migration`, `auth`, `permission`, `schema`, `rollout`, `feature flag`, `security`, `compliance` appear in the AC or summary, choose **standard** regardless of the above. Also choose **standard** if Implementation Notes lists `*Files likely to change:*` with more than 6 entries — at that width, the order of operations and bundling decisions become load-bearing and worth a plan even when the surface is enumerated.
   - **standard**: anything else. When in doubt between trivial and standard, choose **standard**. Misclassifying as trivial loses real review surface; misclassifying as standard only costs ceremony.
4. Apply the chosen label via `mcp__atlassian__editJiraIssue` with `update`: `{"labels": [{"add": "complexity:trivial"}]}` (or `complexity:standard`).
5. Append to the activity log:
   ```bash
   append-activity {TICKET_KEY} --heading "Complexity classified: {tier}" --body "Auto-classified as `complexity:{tier}` based on AC and Implementation Notes. Override by editing the label on the ticket and re-running."
   ```
6. **If the tier was just set to `trivial` AND the checklist was loaded from Jira (`source: "jira"`) without trivial-skip suffixes**: the checklist was seeded against the wrong tier. Re-run `seed-checklist {TICKET_KEY} ... --jira-source` after first deleting the existing checklist comment via `clearChecklistFromJira` (or via direct `mcp__atlassian__addCommentToJiraIssue` flow if the helper isn't exposed) so the new tier-aware seed takes effect. In practice this is an edge case — most tickets get classified before the first checklist exists. If the checklist already has progress on it (any step done that's not 1/4/5/6), do **not** re-seed; instead, fall through and let the per-step skip conditions handle it.

## Stage Squash Protocol

Each lifecycle stage (S4.1 through S4.5) produces exactly one squash commit on the ticket branch when it completes. Implementation lives in `cli/lib/stage-squash.js` (exposed as the `stage-squash` CLI).

**After a stage completes successfully**, run:

```bash
stage-squash {TICKET_KEY} --label "<stage>" --base {BASE_BRANCH} --branch {BRANCH_NAME}
```

The CLI:
- Derives `STAGE_START_SHA` automatically — most recent `[{TICKET_KEY}]` commit, falling back to the merge-base with `origin/{BASE_BRANCH}` when no stage commit exists yet.
- Returns `{action: "noop"}` if no new commits exist since that SHA — safe to call unconditionally.
- Otherwise `git reset --soft {STAGE_START_SHA} && git commit -m "[{TICKET_KEY}] <stage>"` and force-with-lease pushes to origin.
- Override the SHA derivation explicitly via `--stage-start-sha <sha>` for unusual resumes.

**Stage commit labels** (passed to `--label`):
- S4.1: `plan: generated`
- S4.2: `execute: TDD implementation`
- S4.3: `verify: acceptance criteria`
- S4.4: `refactor: code cleanup`
- S4.5: `review: PR review plan generated`

## S3.5: Drift Check (Implementation Notes refresh)

Before executing the checklist, verify that the ticket's `Implementation Notes` (created by `planner` Phase 5.0) still match the code. If the cited code has moved or changed since the research SHA, re-run the per-ticket research and update the ticket.

**Skip entirely if:**
- The ticket has no `h2. Implementation Notes` block (e.g., older tickets created before this protocol). Continue to S4.
- The checklist already shows step 2 (S4.2 execute) as `[x]`. Drift detection is moot once implementation has started.

There is no "already drift-checked" label and none is needed: `drift-check` compares the ticket's recorded research baseline SHA against the code at HEAD, so re-running it on an unchanged tree is a cheap no-op that returns `current`. Running it on every resume is the correct behavior — it re-fires precisely when upstream has moved.

### S3.5a/b: Parse + Verify Implementation Notes

Run:

```bash
drift-check {TICKET_KEY} --repo-root {WORK_DIR}
```

Parse the JSON output. The CLI runs the **full** check battery by default and emits:

```
{ ticket, status, baseline,
  citations[],            // line-range diff per citation (existing behavior)
  patterns[],             // each pattern's symbolStatus + symbolNewPaths
  filesLikelyToChange[],  // each path's existence/rename status at HEAD
  testsLikelyToExtend[],  // same, scoped to test paths
  tddRef,                 // TDD path/anchor still resolves at HEAD
  sidecars[],             // per-repo sidecar presence
  constraintsRaw,         // raw text for the LLM constraints pass below
  drifted, unknown, total, mode: "full" }
```

The CLI extracts the `h2. Implementation Notes` block, parses each subsection (`Research baseline`, `*Existing patterns to extend:*`, `*Files likely to change:*`, `*Tests likely to extend:*`, `*Constraints:*`) plus the upstream `h2. TDD Reference`, and runs all structural verifiers in one pass. Top-level `status` is `"drifted"` if **any** sub-check drifted.

If `status` is `no-notes`, this protocol is moot — continue to S4.

### S3.5b.i: Constraints pass (LLM verification)

The CLI cannot tell whether listed constraints are still applicable. After parsing the JSON:

1. If `constraintsRaw` is null or only contains "none surfaced", skip this step.
2. Otherwise, for each constraint bullet, read the cited region at HEAD via `Read` / `Grep` and decide: **still applicable**, **already resolved**, or **scope changed**.
3. If any constraint is `already resolved` or `scope changed`, treat the ticket as drifted even if the structural pass returned `current` — fold those changes into the refresh in S3.5c.

### S3.5c: Decide

**No drift** (`status === "current"` AND constraints pass found nothing):
- Append a brief activity log entry: `Drift check passed — research baseline {sha} still current.` Continue to S4.

**Drift detected**:
- Re-run per-ticket research using the same protocol as `planner` Phase 5.0a–5.0c, scoped to this ticket. Use the current `git rev-parse HEAD` per repo as the new baseline.
- Compose a new Implementation Notes block, taking into account every drifted check type:
  - For each `patterns[].symbolStatus === "drifted"` with `symbolNewPaths`, re-pin the citation to the new path. If `reason === "symbol removed"` and there's no obvious replacement, drop the bullet and call it out below.
  - For each `filesLikelyToChange[].pathStatus === "drifted"`, update the path (use `newPath` if present) or drop the entry if the surface no longer exists.
  - Same for `testsLikelyToExtend[]`.
  - If `tddRef.status === "drifted"`, refresh the `h2. TDD Reference` block with the current anchor / path. If the TDD has been substantially restructured, surface a question to the user before regenerating notes — the planner may need a re-run.
  - For sidecars with `status === "unknown"` whose reason mentions removal, flag in the comment but don't block (sidecars in the owner repo are expected to be `unknown` here).
  - Apply any constraints adjustments from S3.5b.i.
- Update the ticket description via `mcp__atlassian__editJiraIssue`: replace the existing `h2. Implementation Notes` block (and `h2. TDD Reference` if drifted) with the new content. Preserve every other section.
- Post a Jira comment (use `mcp__atlassian__addCommentToJiraIssue`, not `append-activity`) showing:
  ```
  h3. Drift detected — Implementation Notes refreshed

  Old baseline: {old_repo}@{old_sha}{, ...}
  New baseline: {new_repo}@{new_sha}{, ...}

  *Citations that drifted:*
  * `{path}#L{start}-L{end}` — {summary, e.g. "lines moved", "file renamed to {new_path}"}

  *Patterns with missing/moved symbols:*
  * `{symbol}` — {moved to {newPaths[0]} | removed (no replacement found)}

  *Cited files removed or renamed:*
  * `{path}` (Files likely to change | Tests likely to extend) — {reason, with newPath if known}

  *TDD/sidecar issues:*
  * TDD anchor {anchor} no longer resolves — refreshed to {new_anchor}
  * Sidecar {repo}.research.md missing in this repo

  *Constraints updated:*
  * {constraint} — {already resolved | scope changed to {new scope}}

  *New citations replacing them:*
  * `{new_path}#L{new_start}-L{new_end}` — `{symbol}` — {why this is the right replacement}

  Implementation Notes block updated above. Re-review before approving the plan.
  ```
  Omit any subsection whose list is empty.
- If the ticket already has `ClaudeExecuting` or later (plan was generated against stale notes), warn in the comment: `Plan was generated against the prior baseline. Consider re-reviewing the plan against the new Implementation Notes; if the plan needs to change, run /rework.`
- Leave the ticket's progress label as it is. The refreshed `Research baseline` SHA in the Implementation Notes is the record that this refresh happened — a subsequent `drift-check` against that new baseline returns `current`.

If the agent cannot confidently produce a replacement citation for a drifted entry (e.g., the pattern was removed and there's no obvious successor), include it as `*Citations dropped (no clear replacement):*` and surface a question to the user in the activity log so they can decide whether to proceed.

### S3.5d: Continue

Whether drift was found or not, proceed to S4.

---

## S4: Execute Checklist

Work through each unchecked step in order. After completing each step:

1. Mark it as done in the in-memory steps array and sync to Jira:
   ```bash
   sync-checklist {TICKET_KEY} --steps '{JSON_STEPS_ARRAY}'
   ```
2. Push the branch to origin:
   ```bash
   git push origin {BRANCH_NAME}
   ```

This ensures the remote always has the latest committed state, supporting idempotent resume from any machine.

Additionally, apply the Stage Squash Protocol at each stage boundary (record HEAD before, squash after). The push happens **after** the squash, so the remote receives the clean squashed commit.

---

### Step S4.1: Plan generated with /plan-ticket

**Skip if**: `complexity == trivial` (`seed-checklist` pre-marks step 1 done with the ` (skipped: trivial)` suffix — never call `/plan-ticket` for trivial tickets), OR step 1 is already checked `[x]`, OR a plan already exists in Jira (check via `sync-plan {TICKET_KEY} --read` returning data), OR git log contains `[{TICKET_KEY}] plan:` stage commit.

1. Move the ticket to `ClaudePlanning`:
   ```bash
   set-ticket-state {TICKET_KEY} --to ClaudePlanning
   ```
2. Use the Skill tool to run skill `plan-ticket` with args `{TICKET_KEY} --base {BASE_BRANCH}`. The skill reads AC + Implementation Notes from Jira, composes a 3-7 task implementation checklist, and syncs it to Jira via `sync-plan --file` itself. No local plan file persists after the skill returns.
3. Append a plan summary to the activity log:
   ```bash
   append-activity {TICKET_KEY} --heading "Plan generated" --body-file <tmp-summary.md>
   ```
   The body should contain: approach overview (1-2 sentences), key implementation steps as bullets, and if stacked: "Stacked on {BASE_BRANCH}". Derive these from the synced plan via `sync-plan {TICKET_KEY} --read`.
4. Mark step 1 as done in the steps array and sync checklist to Jira.
5. Apply Stage Squash Protocol: `stage-squash {TICKET_KEY} --label "plan: generated" --base {BASE_BRANCH} --branch {BRANCH_NAME}`.

---

### Step S4.2: Plan executed with TDD (Red-Green-Refactor)

**Skip if** any of:
- step 2 is already checked `[x]` in the Jira checklist, OR
- the Jira plan's task list already shows every task marked done (verify via `sync-plan {TICKET_KEY} --read` and inspecting `sections[*].tasks[*].done`), OR
- git log on the current branch already contains an `[{TICKET_KEY}] execute:` stage commit (the squash from a prior completed S4.2 run).

This step has two modes depending on whether S4.1 ran:

- **Standard mode** (plan exists in Jira): full Red-Green-Refactor cycle per plan task, as described in steps 6a–6d below.
- **No-plan mode** (Gate 1 fired — `complexity == trivial`, S4.1 was skipped, no plan in Jira): collapse to a single batch. Make the code change, write one batch of tests covering any Gherkin scenarios in the AC (still required — Gate 1 does **not** waive AC coverage), run the suite, commit once. Skip the per-task R-G-R ceremony.

Detect mode by reading the plan from Jira (`sync-plan {TICKET_KEY} --read`). If the plan is empty or absent, run **no-plan mode** (steps 6'a–6'c). Otherwise run **standard mode** (steps 6a–6d).

Tests are written in the project's native test framework.

0. (`stage-squash` derives `STAGE_START_SHA` automatically when run at the end of the stage; nothing to record up front.) If resuming mid-stage, derive from git log per protocol.

1. Update Jira labels — move the ticket to `ClaudeExecuting`. The CLI clears every other progress label automatically (sourced from `cli/lib/labels.js`):
   ```bash
   set-ticket-state {TICKET_KEY} --to ClaudeExecuting
   ```
2. Append to the activity log:
   ```bash
   append-activity {TICKET_KEY} --heading "TDD execution started" --body "Beginning Red-Green-Refactor cycle for plan tasks."
   ```

3. **Extract Gherkin scenarios**: Fetch the ticket description using `mcp__atlassian__getJiraIssue`. Extract all Gherkin scenarios (`Given`/`When`/`Then` blocks or fenced `gherkin`/`feature` blocks). These drive the tests.

4. **Detect test framework**: Inspect the project to determine the native test framework:
   - Look for existing test files, `package.json` (jest/vitest/mocha), `pytest.ini`, `go.test`, etc.
   - Identify test file naming conventions (e.g., `*.test.ts`, `*_test.go`, `test_*.py`)
   - Identify test directory structure (e.g., `__tests__/`, `tests/`, colocated)

5. **Read the execution plan from Jira:**
   ```bash
   sync-plan {TICKET_KEY} --read
   ```
   Parse the JSON output — it contains `sections` with `tasks` arrays. Each task has `label` and `done` fields.

6. **For each plan task, execute the Red-Green-Refactor cycle:**

   #### 6a: Red — Write Failing Test

   Before implementing the task, write a test that:
   - Maps to the relevant Gherkin scenario steps this task covers
   - Uses the project's native test framework and conventions
   - Describes behavior in terms of the Gherkin `Given`/`When`/`Then` (use scenario names and step descriptions as test names)
   - Exercises the expected behavior that does NOT yet exist

   Test naming convention: `{Scenario Name} - {Given/When/Then step being tested}` or the project's existing naming pattern if one exists.

   Run the test suite to confirm the new test **fails**:
   ```bash
   {TEST_COMMAND} {TEST_FILE}
   ```
   - If the test passes unexpectedly: the behavior already exists. Note this, skip to the next task.
   - If the test fails with the expected reason (not found, not implemented, assertion failure): proceed to Green.
   - If the test fails for an unexpected reason (syntax error, import error): fix the test and re-run.

   Stage and commit the failing test:
   ```bash
   git add {TEST_FILE} && git commit -m "Red: {task title} - failing test for {scenario step}"
   ```

   #### 6b: Green — Implement to Pass

   Implement the minimum code to make the failing test pass. This is where the plan task's actual implementation happens.

   **Before writing**: apply the **Code Style** section in `~/.claude/CLAUDE.md`. Project-local conventions in the surrounding files win when they conflict.

   After implementing, run the test:
   ```bash
   {TEST_COMMAND} {TEST_FILE}
   ```
   - If the test passes: proceed to Refactor.
   - If the test still fails: continue implementing until it passes. Do not move on with a red test.

   Also run the full test suite to check for regressions:
   ```bash
   {TEST_COMMAND}
   ```
   - If other tests break: fix the regressions before proceeding.

   Stage and commit:
   ```bash
   git add -A && git commit -m "Green: {task title} - implementation passes"
   ```

   #### 6c: Refactor (optional)

   If the implementation can be improved without changing behavior:
   - Clean up duplication, improve naming, extract helpers
   - Run the full test suite after refactoring to confirm nothing breaks
   - If changes were made, commit:
     ```bash
     git add -A && git commit -m "Refactor: {task title}"
     ```

   #### 6d: Mark task complete in Jira

   Mark the task as done in the Jira plan comment:
   ```bash
   sync-plan {TICKET_KEY} --mark-done "{task_label}"
   ```

6'. **No-plan mode (Gate 1 fired)** — replaces 6a–6d entirely when no plan exists:

   #### 6'a: Make the change

   Implement the AC directly. Do not split into per-task commits; the entire ticket is one logical change.

   **Before writing**: apply the **Code Style** section in `~/.claude/CLAUDE.md`. Project-local conventions in the surrounding files win when they conflict.

   #### 6'b: Add Gherkin-driven tests (if any scenarios exist)

   If the AC has Gherkin scenarios, write tests covering them as a single batch — one test per scenario, named after the scenario. Skip this sub-step entirely when the AC has zero scenarios (pure copy/doc/dep-bump tickets).

   Test contract: every Gherkin scenario in the AC must have a corresponding test. This is preserved across both modes — Gate 1 cuts the R-G-R ceremony, not the coverage requirement.

   #### 6'c: Run suite and commit once

   Run the full test suite:
   ```bash
   {TEST_COMMAND}
   ```
   - If anything fails (new tests or regressions): fix until green. Do not commit red.
   - Once green: `git add -A && git commit -m "{TICKET_KEY}: {summary}"`.

   No `sync-plan --mark-done` calls — there's no plan to update.

7. After all tasks are processed:
   - Run the full test suite one final time to confirm everything passes
   - Run `git status` — if there are uncommitted changes, stage and commit
8. Re-read the plan from Jira (`sync-plan {TICKET_KEY} --read`) to verify tasks are complete
9. Append a TDD execution summary to the activity log. Body should be a compacted recap (per-task one-liners + totals):
   ```
   - [x] Task 1 title (N tests)
   - [x] Task 2 title (N tests)
   - [ ] Task 3 title (incomplete)

   Completed N/M tasks. Total tests written: T.
   ```
   Write the body to a temp file and run:
   ```bash
   append-activity {TICKET_KEY} --heading "TDD execution finished" --body-file <tmp-summary.md>
   ```
10. If all tasks complete:
    - Mark step 2 as done and sync checklist to Jira.
    - Apply Stage Squash Protocol: `stage-squash {TICKET_KEY} --label "execute: TDD implementation" --base {BASE_BRANCH} --branch {BRANCH_NAME}`.
    - (Keep `ClaudeExecuting` label — it will be replaced by `ClaudeStackReady` in step 6)
11. If tasks are incomplete:
    - Move the ticket to `ClaudeFailed`: `set-ticket-state {TICKET_KEY} --to ClaudeFailed`
    - **Stop here** (user must investigate)

---

### Step S4.3: Acceptance criteria verified (TDD final check)

**Skip if**: step 3 is already checked `[x]`.

TDD execution (S4.2) should have produced tests for every Gherkin scenario. This step confirms full coverage — no scenarios were missed and all tests pass.

0. (`stage-squash` derives `STAGE_START_SHA` automatically when run at the end of the stage; nothing to record up front.)

1. Fetch the ticket description using `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`
2. Extract all Gherkin scenarios from the description (look for `Given`/`When`/`Then` blocks, or fenced code blocks tagged `gherkin` or `feature`)
   - If the ticket has no Gherkin scenarios: mark step 3 as `[x]` and continue (nothing to verify)
3. Run the full test suite and confirm it passes:
   ```bash
   {TEST_COMMAND}
   ```
   - If tests fail: fix the failures, commit, and re-run until green.

**Lightweight path** (`complexity == trivial` AND suite is green AND ≤1 Gherkin scenario in the AC): the coverage-map ceremony is unnecessary — the batch in S4.2 step 6'b directly mirrors the scenarios. Skip steps 4–6 below, mark step 3 done, apply Stage Squash Protocol with label `verify: acceptance criteria`, and append `append-activity {TICKET_KEY} --heading "TDD verification passed (lightweight)" --body "Full suite green. AC covered by S4.2 batch tests."`.

Otherwise continue to step 4.

4. For each Gherkin scenario, verify a corresponding test exists:
   - Search test files modified on this branch (`git diff {BASE_BRANCH}...HEAD --name-only | grep -E '(test|spec)'`)
   - Match scenario names/steps to test descriptions
   - Build a coverage map:
     ```
     ## Gherkin → Test Coverage

     ### Scenario: {scenario name}
     - [x] Given {step} → {test file}:{test name}
     - [x] When {step} → {test file}:{test name}
     - [x] Then {step} → {test file}:{test name}

     {N}/{M} scenarios fully covered by tests.
     ```
5. If ALL scenarios have corresponding tests and all tests pass:
   - Mark step 3 as done and sync checklist to Jira.
   - Apply Stage Squash Protocol: `stage-squash {TICKET_KEY} --label "verify: acceptance criteria" --base {BASE_BRANCH} --branch {BRANCH_NAME}`.
   - Append to the activity log:
     ```bash
     append-activity {TICKET_KEY} --heading "TDD verification passed" --body "All {N} Gherkin scenarios are covered by tests. Full suite green."
     ```
6. If a scenario has no corresponding test (was missed during TDD):
   - Write the missing test (Red), implement if needed (Green), commit
   - Re-verify until all scenarios are covered
   - If gaps remain after the fix attempt:
     - Move the ticket to `ClaudeFailed`: `set-ticket-state {TICKET_KEY} --to ClaudeFailed`
     - Append the coverage map (showing uncovered scenarios) to the activity log:
       ```bash
       append-activity {TICKET_KEY} --heading "TDD verification failed" --body-file <coverage-map.md>
       ```
     - **Stop here** (user must investigate)

---

### Step S4.3.5: Output-size check (Gate 2)

**Skip if**: `complexity == trivial` (S4.4–S4.5 are already pre-marked skipped at seed time), OR step 4 is already checked `[x]` (which implies S4.3.5 ran on a prior invocation or refactor already happened).

This step inspects the actual diff produced by S4.2 and decides whether to skip the refactor + code-review pass (S4.4–S4.5). It runs only for `complexity:standard` tickets. The decision is set in-memory via the `OUTPUT_TRIVIAL` flag — no Jira label.

1. `cd {WORK_DIR}`
2. Collect diff signals:
   ```bash
   git diff {BASE_BRANCH}...HEAD --shortstat
   git diff {BASE_BRANCH}...HEAD --name-only
   ```
3. Compute `OUTPUT_TRIVIAL = true` when **all** of:
   - Total changed LOC (insertions + deletions) ≤ 50, excluding test files and lockfiles (`*.test.*`, `*_test.*`, `*.spec.*`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `go.sum`).
   - ≤2 non-test files changed.
   - No changed file matches a risk pattern: `migrations/`, `auth/`, `security/`, `iam/`, `infrastructure/`, `terraform/`, `*.sql`, `*.tf`, files in directories named `permissions/` or `compliance/`.
4. Otherwise `OUTPUT_TRIVIAL = false`.
5. If `OUTPUT_TRIVIAL` is true:
   - Mark steps 4, 5 done with `(skipped: output trivial)` suffix via `sync-checklist`.
   - Append to the activity log:
     ```bash
     append-activity {TICKET_KEY} --heading "Gate 2: output trivial — review pass skipped" --body "Diff is {LOC} LOC across {N} non-test file(s). Skipping S4.4 (@refactor) and S4.5 (/jay-pr-review). Run /cop-fight after the PR opens to drive CI green and judge Copilot comments."
     ```
6. If `OUTPUT_TRIVIAL` is false, do nothing — the loop continues into S4.4 normally.

### Step S4.4: Refactoring pass with @refactor agent

**Skip if**: `complexity == trivial` (pre-marked done — small surface, low ROI), OR step 4 is already checked `[x]`.

After TDD execution and acceptance verification, run a targeted refactoring pass on the code changed by this ticket. The refactor agent identifies CRAP score hotspots, DRY violations, and structural smells — then implements approved fixes.

0. (`stage-squash` derives `STAGE_START_SHA` automatically when run at the end of the stage; nothing to record up front.)

1. Make sure we are in the working directory: `cd {WORK_DIR}`
2. Get the list of files changed on this branch:
   ```bash
   git diff {BASE_BRANCH}...HEAD --name-only --diff-filter=ACMR
   ```
3. Launch the refactor agent targeting only the changed files:
   - Use the Agent tool with `subagent_type: "refactor"`
   - Prompt: "Analyze the following files for CRAP score, DRY violations, and refactoring opportunities. These were changed as part of ticket {TICKET_KEY}. Only flag issues introduced or worsened by this branch's changes — don't report pre-existing issues in unchanged code. Implement any refactorings that are clearly beneficial (reduce complexity, eliminate duplication) without changing behavior. Skip anything marginal or subjective. Files: {FILE_LIST}\n\nAdditionally, evaluate the diff against the **Code Style** principles in `~/.claude/CLAUDE.md` (Functions & Control Flow, Error Handling, Logging & Instrumentation, Types & Data Modeling, Configuration & Environment, Testing, Infrastructure as Code, Naming & Style, Refactoring & PR Hygiene). Apply style fixes when they're clear improvements and don't change behavior. Project-local conventions in the surrounding files win when they conflict with the guide. Do not enlarge the diff opportunistically — fix what's broken or stylistically off in *this branch's* changes."
4. After the refactor agent completes:
   - Run the full test suite to confirm nothing broke:
     ```bash
     {TEST_COMMAND}
     ```
   - If tests fail: revert the refactoring commits (`git revert --no-commit HEAD~N..HEAD` where N = number of refactor commits), commit, and note in Jira that refactoring was skipped due to test failures.
   - If tests pass: proceed.
5. Mark step 4 as done and sync checklist to Jira.
6. Apply Stage Squash Protocol: `stage-squash {TICKET_KEY} --label "refactor: code cleanup" --base {BASE_BRANCH} --branch {BRANCH_NAME}`.

---

### Step S4.5: PR review plan generated with /jay-pr-review

**Skip if**: `complexity == trivial` (pre-marked done — trivial tickets do not run a pre-PR review plan), OR step 5 is already checked `[x]`.

0. Record `STAGE_START_SHA` (Stage Squash Protocol).

1. Make sure we are in the working directory: `cd {WORK_DIR}`
2. Ensure plans directory exists: `mkdir -p {PLANS_DIR}`
3. Pin the review base so `/jay-pr-review` diffs against the ticket's actual stacked base, not `main`. At this point in the lifecycle no PR exists yet (it's created later at S4.9), so the resolver would otherwise fall through to `origin/HEAD` and pick `main`. `/jay-pr-review` reads `git config branch.<BRANCH>.base` as its highest-priority hook. Use the `origin/{BASE_BRANCH}` form so the value resolves even when the local branch ref doesn't exist (worktree mode, branches that have only been fetched):
   ```bash
   git config branch.{BRANCH_NAME}.base origin/{BASE_BRANCH}
   ```
4. Run the `/jay-pr-review` command
5. Mark step 5 as done and sync checklist to Jira.
6. Apply Stage Squash Protocol: `stage-squash {TICKET_KEY} --label "review: PR review plan generated" --base {BASE_BRANCH} --branch {BRANCH_NAME}`.

The plan written to `{PLANS_DIR}/pr-review-{TICKET_KEY}*.md` is a sanity check before opening the PR. Its findings are NOT auto-applied here. After the PR opens, the user runs `/cop-fight` on demand to drive CI to green and judge Copilot review comments against the live PR.

---

### Step S4.6: Stack ready

S4.6 has two sub-steps. S4.6a always runs and is the only thing that "marks the ticket as stack-ready". S4.6b only runs when the ticket sits inside a Story/Epic stack with a `FEATURE_BRANCH` — it opens the integration PR into that feature branch and moves the ticket's Jira status to "In Review". The ticket keeps `ClaudeStackReady`; the open PR is what records that it is out for review.

#### Step S4.6a: Mark stack ready

**Skip if**: step 6 is already checked `[x]`.

This sub-step marks the ticket stack-ready, which unblocks downstream tickets without requiring a PR to be opened. It runs for every ticket — feature-branch and standalone alike.

1. Update Jira labels — move the ticket to `ClaudeStackReady`:
   ```bash
   set-ticket-state {TICKET_KEY} --to ClaudeStackReady
   ```
2. Append to the activity log:
   ```bash
   append-activity {TICKET_KEY} --heading "Stack ready" --body "Code review complete. Stack unblocked — downstream tickets may begin."
   ```
3. Mark step 6 as done and sync checklist to Jira.

After S4.6a:
- If `FEATURE_BRANCH` is null (standalone workflow): continue to S4.8 (S4.7 is retired and always skipped) to open the draft PR against `main`. Do **not** run S4.6b.
- If `FEATURE_BRANCH` is set: continue to S4.6b.

#### Step S4.6b: Merge into feature branch (feature-branch workflow only)

**Skip if**: `FEATURE_BRANCH` is null. Feature-branch tickets stop after S4.6b; the container's Mode C checklist takes over from there. Slots 8–10 (the S4.8–S4.10 PR push-and-review steps) are stamped done by S4.6b after the integration PR opens, because the work they describe is owned by Mode C, not by the per-ticket lifecycle. Slot 7 is the retired approval gate and is already pre-marked done at seed time.

1. **Verify review is clean**: Read the PR review plan file from `{PLANS_DIR}/` (matching `pr-review-*.md` or `pr-{TICKET_KEY}*.md`). Parse all items in the plan:
   - If any issues are marked unresolved or incomplete: run `set-ticket-state {TICKET_KEY} --to ClaudeFailed`, append the unresolved-issues list to the activity log (`append-activity {TICKET_KEY} --heading "Review issues unresolved" --body-file <issues.md>`), and **stop**.
   - Display: "Review has unresolved issues. Fix them and re-run `/ticket-work {TICKET_KEY}`."
   - Only proceed if ALL issues identified by the review have been resolved.

2. **Open a PR from `{BRANCH_NAME}` into `{FEATURE_BRANCH}`** by running the **Shared sub-procedure: PR Push & Review** with these bindings:
   - `WORK_DIR` = `WORK_DIR`
   - `BRANCH` = `BRANCH_NAME`
   - `BASE` = `FEATURE_BRANCH`
   - `JIRA_KEY` = `TICKET_KEY`
   - `STORAGE` = the Jira checklist on `{TICKET_KEY}` (use `sync-checklist {TICKET_KEY}` to read/write)
   - `MARK_READY` = true (the integration PR opens ready-for-review; the user will run `/cop-fight` on demand after the PR is open if CI fixes or Copilot review handling is needed)
   - `REVIEW_TRANSITION` = true (P2 moves `{TICKET_KEY}`'s Jira status to "In Review"; `ClaudeStackReady` stays put)

   Run sub-procedure steps **P1, P2, P4, P5** (skip P3 — review work was owned by S4.5 against this same ticket diff). The mapping reuses the per-ticket checklist's existing PR-related slots; rather than introducing new steps, the existing 8–10 slots are repurposed for the feature-branch PR:
   - S4.8 (PR description) ↔ P1
   - S4.9 (push as draft) ↔ P2
   - S4.10 (review summary) ↔ P4
   - Mark-ready (P5) is a final inline step here, not a separate checklist entry.

3. After the sub-procedure completes, **stop the per-ticket lifecycle**. Do not proceed to S4.8 — those steps are the standalone-ticket flow targeting `main`. Feature-branch tickets terminate here at "PR open and ready for human review against `{FEATURE_BRANCH}`". Slots 8–10 were already marked done inside the sub-procedure; slot 7 is the retired approval gate and was pre-marked done at seed time.

4. Display:
   ```
   Ticket {TICKET_KEY} - Feature Branch PR Open

   Branch: {BRANCH_NAME} → {FEATURE_BRANCH}
   PR: {PR_URL}

   All review issues resolved. PR is ready for human review and merge.
   After merge, `/cleanup` will create the merged/{TICKET_KEY} tag and
   `/promote-to-main` becomes available for the stack.
   ```

5. Proceed to S6 (promote downstream), then stop.

> **Migration note (legacy local merges)**: tickets that previously ran S4.6b (formerly S4.7b) under the old local-merge flow already have their work on `{FEATURE_BRANCH}` and have no PR to open. The new flow only applies to tickets reaching S4.6b after this rewrite lands. To finish a legacy in-flight stack, run it through the old workflow manually — checkout the ticket branch, merge into the feature branch locally, then `/promote-to-main` it (the Step 1c tag walk in `/promote-to-main` will skip commits with no `merged/*` tag, so legacy local merges are simply not promotable through the new gate without a backfill).

---

### Step S4.7: PR approval gate (retired)

**Always skip.** This step is retired — there is no PR-approval gate. `seed-checklist` pre-marks slot 7 done with a ` (skipped: retired)` suffix, so the S4 loop never opens it. The slot is retained only to keep step numbering stable for the S4.8–S4.10 names, the S4.6b slot mapping, and historical Jira checklists.

Standalone tickets flow straight from S4.6a into S4.8 and open their draft PR against `main` without waiting for a human label. The draft state *is* the checkpoint: nothing merges until a human marks the PR ready and approves it on GitHub.

---

### Steps S4.8–S4.10: PR Push & Review (shared sub-procedure)

**Skip if** `FEATURE_BRANCH` is non-null. Feature-branch tickets terminate at S4.6b — the integration PR into `{FEATURE_BRANCH}` was already opened there using these same checklist slots (8–10) for its sub-procedure mapping. S4.8–S4.10 below describe the **standalone-ticket** path: the PR opens against `main` (`PR_TARGET`) as a draft, entered directly from S4.6a with no approval gate in between.

S4.8 through S4.10 are an instance of the **Shared sub-procedure: PR Push & Review** (defined earlier in this file). Use these bindings:

- `WORK_DIR` = `WORK_DIR`
- `BRANCH` = `BRANCH_NAME`
- `BASE` = `PR_TARGET`
- `JIRA_KEY` = `TICKET_KEY`
- `STORAGE` = the Jira checklist on `{TICKET_KEY}` (use `sync-checklist {TICKET_KEY}` to read/write)
- `MARK_READY` = false (per-ticket PRs stay draft until the human marks them ready)
- `REVIEW_TRANSITION` = true (P2 creates the draft PR and moves `{TICKET_KEY}`'s Jira status to "In Review"; `ClaudeStackReady` stays put)

The mapping is:
- S4.8 ↔ P1 (PR description)
- S4.9 ↔ P2 (push as draft)
- S4.10 ↔ P4 (post review summary)

S4 does **not** run P3 / P5 — those are Mode-C-only (review plan generation and ready-for-review flip). The per-ticket flow handled review at S4.5 already; the Mode C flow re-runs review at the feature-branch level for the integrated diff.

After P4, mark steps 8–10 as done in the Jira checklist (a single `sync-checklist` call may cover them).

CI green and Copilot review comment resolution are NOT run by the pipeline. After the PR opens, run `/cop-fight` on demand (see `commands/cop-fight.md`).

---

## S5: Final Summary

Display:

```
Ticket {TICKET_KEY} - Complete

Directory: {WORK_DIR}
Branch: {BRANCH_NAME} (base: {BASE_BRANCH})
Feature branch: {FEATURE_BRANCH or "none"}
Mode: {serial | worktree}
PR: {PR_URL}

All steps completed. PR is ready for human review.
```

## S6: Continue to Next Ticket in Stack

After reaching stack-ready (step 6) or completing all steps, check if there are downstream tickets in the same stack that are now unblocked and eligible for work.

**Skip S6 entirely if `EPIC_SINGLE_MODE` is true.** When `/ticket-work` was entered with an Epic key, this invocation runs exactly one ticket; the user re-runs `/ticket-work {EPIC_KEY}` to advance to the next. Display: "Epic single-ticket invocation complete. Re-run `/ticket-work {EPIC_KEY}` to pick up the next unblocked ticket." and **stop** before S6a.

### S6a: Find Eligible Downstream Tickets

Run `resolve-stack {TICKET_KEY} --repo-root {REPO_ROOT}` to refresh the stack state after this ticket completed.

From the `stack` array, find tickets that come after the current ticket and have `eligible == true`. These are the downstream tickets now unblocked.

Filter out:
- Tickets not assigned to the current user
- Tickets that already have any progress label (`ClaudePlanning`, `ClaudeExecuting`, `ClaudeStackReady`, `ClaudeFailed`)
- Tickets already out for review (an open PR, or a review-state Jira status per `isReviewStatus()`)

### S6b: Promote and Run Next Ticket

If exactly **one** eligible downstream ticket is found:

1. Add `ClaudeReady` label if not already present:
   - Use `mcp__atlassian__editJiraIssue` with `update`: `{"labels": [{"add": "ClaudeReady"}]}`
2. Inherit labels/assignee from parent (same logic as Q2e) if it's a subtask
3. Display: "Moving to next ticket in stack: {NEXT_KEY} - {NEXT_SUMMARY} (base: {TICKET_KEY})"
4. Run the **Single Ticket Lifecycle** (S1 onward) for `{NEXT_KEY}`, which will use the just-completed ticket's branch as its base

If **multiple** eligible downstream tickets are found:

1. Promote all of them (add `ClaudeReady` label, inherit from parent)
2. Run the **Queue Pipeline** (Q3 onward) with these tickets

If **no** eligible downstream tickets are found:

1. Check for stack completion (same logic as Q7c)
2. Display: "No more eligible tickets in this stack."

## Error Handling

- If any step fails, the Jira checklist preserves progress. Re-running the command will resume from the failed step (read from Jira).
- Worktree already exists: reuse it (don't recreate).
- Branch already exists: check it out in the worktree.
- PR already exists: push updates to it rather than creating a new one.
- Plan already exists in Jira: skip /plan-ticket (don't overwrite existing plan).
- On failure at step S4.2 (execution): Jira label is set to `ClaudeFailed`. User must investigate, fix, remove `ClaudeFailed` label, then re-run.
- In queue mode: never stop due to a single ticket failure. Each agent handles its own error state.
- If interrupted mid-stage (squash not yet applied): on resume, Claude detects uncommitted stage work (commits since the last stage marker) and continues the stage, then squashes when done. The STAGE_START_SHA is derived from git log per the Stage Squash Protocol.
