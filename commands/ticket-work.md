---
description: "Run Jira tickets through plan, execute, and code review to stack-ready. Feature branches merge locally after review passes. Without feature branch, PR push requires ClaudePRApproved. With args: single ticket. Without args: discover and process queue."
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
  - Read
  - Write
  - Skill
  - Agent
---

# Ticket Work

Run Jira tickets through: plan → execute → code review → stack-ready.
Tickets in a Story/Epic stack: merge locally into the container's feature branch (named after the container key, e.g. `EPIC-123`) after review passes.
Standalone tickets (no Story/Epic container): stop at stack-ready; PR to main requires `ClaudePRApproved` trigger.
Idempotent — reads checklist state and resumes from wherever it left off.

- **With arguments**: Run a single ticket (or expand a Story to its subtasks and run them in parallel).
- **Without arguments**: Discover all eligible tickets from Jira and process them (queue mode).

## Label Reference

The canonical lifecycle label set lives in `cli/lib/labels.js` (`DURABLE_LABELS`, `PROGRESS_LABELS`, `CONTAINER_LABELS`, `TERMINAL_LABELS`). Progress flow is roughly: `ClaudeReady` → `ClaudeDriftChecked` → `ClaudePlanning` → `ClaudeExecuting` → `ClaudeStackReady` → `ClaudePRApproved` → `ClaudeNeedsReview` → cleanup; `ClaudeFailed` is the failure side-channel and `ClaudeStackComplete` is the container-level rollup that triggers Mode C. `ClaudeWork` is durable and never removed. Use `set-ticket-state` for every transition — it consults `PROGRESS_LABELS` to clear the previous state automatically, and `LABEL_TO_STATUS_TRANSITIONS` to move the Jira workflow status when applicable (currently: `ClaudeNeedsReview` → "In Review"). When no matching workflow transition exists the label change still applies and the CLI emits a warning.

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
   - the entry does not already carry any progress label from `PROGRESS_LABELS` (`ClaudePlanning`, `ClaudeExecuting`, `ClaudeStackReady`, `ClaudePRApproved`, `ClaudeNeedsReview`, `ClaudeFailed`).
   Call this `NEXT_KEY`.
3. If no entry qualifies:
   - If every entry is finished (per `isFinished()` — i.e. `mergedIntoFeature` or `mergedIntoMain` for each), the Epic is effectively complete. Display "Epic {EPIC_KEY} has no unblocked work — all tickets finished. Run `/ticket-work {EPIC_KEY}` again once `ClaudeStackComplete` is set, or apply the label manually to trigger Mode C." and **stop**.
   - Otherwise, display "Epic {EPIC_KEY} has no eligible tickets — every remaining ticket is blocked or already in flight. First blocker: {first non-eligible entry's key} (waiting on {its `unblockedBlockers[0]`})." and **stop**.
4. Inherit labels/assignee from the Epic onto `NEXT_KEY` if it's a subtask whose parent is the Epic (or the Epic-descended Story) — same rules as the "Inherit from Parent" block below; reuse `buildParentInheritancePatch` semantics from `cli/lib/queue.js`.
5. Force `SERIAL_MODE = true` and set `EPIC_SINGLE_MODE = true` for the rest of this invocation, regardless of whether `--serial` was passed. `EPIC_SINGLE_MODE` tells S6 to stop instead of auto-advancing — Epic entry runs exactly one ticket per invocation; re-run `/ticket-work {EPIC_KEY}` to pick the next.
6. Display: "Epic {EPIC_KEY}: working next unblocked ticket {NEXT_KEY} - {NEXT_SUMMARY} (serial mode, single-ticket-per-invocation)."
7. Proceed to **Single Ticket Lifecycle** below using `{NEXT_KEY}` as `TICKET_KEY`. Do **not** fall through to the "parent with subtasks" expansion path — Epics never run the Queue Pipeline from Mode A.

### Standard ticket resolution

If it is a **parent with subtasks** (issue type is Story/Task and has subtasks), expand to its subtasks via JQL: `parent = {PARENT_KEY}`. Apply exclusion filter (skip subtasks that already have `ClaudePlanning`, `ClaudeExecuting`, `ClaudeStackReady`, `ClaudePRApproved`, `ClaudeNeedsReview`, or `ClaudeFailed`). If not a parent, use the ticket directly.

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

# Shared sub-procedure: PR Push & Review

This sub-procedure is parameterized and called from both **S4.9–S4.12** (per-ticket PR flow) and **C3.1–C3.7** (Mode C feature-branch PR flow). It captures the common shape — generate description, push as draft, review-plan + execute, Copilot loop, post review summary — so changes to that shape only need to be made once.

## Inputs

| Param | Per-ticket (S4) | Mode C |
|---|---|---|
| `WORK_DIR` | the ticket's worktree or repo root | the container's `REPO_ROOT` |
| `BRANCH` | `BRANCH_NAME` (ticket branch) | `FEATURE_BRANCH` |
| `BASE` | `PR_TARGET` | `PR_BASE` |
| `JIRA_KEY` | `TICKET_KEY` | `CONTAINER_KEY` |
| `STORAGE` | Jira checklist via `sync-checklist` | local file `{REPO_ROOT}/.claude/plans/ticket-work-{CONTAINER_KEY}-pr.md` |
| `MARK_READY` | `false` (PR stays draft until human marks ready) | `true` (run `gh pr ready {BRANCH}` at the end) |
| `LABEL_FLIP` | on push, `set-ticket-state {JIRA_KEY} --to ClaudeNeedsReview` | none (Mode C does not touch ticket labels — the container's `ClaudeStackComplete` is independent) |
| `DRAFT` | `true` (per-ticket PRs open as draft) | `true` (Mode C feature-branch PRs also open as draft, then P7 flips to ready) |

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
3. If this flow has a `LABEL_FLIP`: run the supplied `set-ticket-state` command.
4. Append to the activity log: `append-activity {JIRA_KEY} --heading "Draft PR opened" --body "{BRANCH} → {BASE}: {PR_URL}"`.
5. Mark step P2 done in `STORAGE`.

### Step P3: PR review plan generated
**Skip if**: step is already marked done in `STORAGE`.

1. `cd {WORK_DIR}`
2. Use the Skill tool to run skill `pr-review`.
3. Mark step P3 done in `STORAGE`.

### Step P4: PR review plan executed
**Skip if**: step is already marked done in `STORAGE`.

1. `cd {WORK_DIR}`
2. Use the Skill tool to run skill `pr-execute-plan`.
3. After execution: if there are uncommitted changes, stage and commit, then push: `git push origin {BRANCH}`.
4. Mark step P4 done in `STORAGE`.

### Step P5: CI green and Copilot review comments resolved with judgement
**Skip if**: step is already marked done in `STORAGE`.

This step replaces the prior blind `pr-watch` auto-fix loop. `/cop-fight` drives CI to green, then evaluates each Copilot comment for soundness — implementing the comments that hold up to scrutiny and dismissing the rest with an explanatory reply.

1. `cd {WORK_DIR}`
2. Run the `/cop-fight` command with default args (`--rounds 5 --interval 30`). If you want to bound the loop more aggressively for ticket-work resume safety, pass `--rounds 3` instead.
3. If `/cop-fight` stops with red CI or pending Copilot comments after max rounds, **stop and surface the failure to the user** — do not mark P5 done. The next `/ticket-work` invocation will resume here.
4. If `/cop-fight` made changes and pushed, update `HEAD_SHA`.
5. Mark step P5 done in `STORAGE`.

### Step P6: PR review summary posted
**Skip if**: step is already marked done in `STORAGE`.

1. `cd {WORK_DIR}`
2. Run `post-review-summary {BRANCH} --plans-dir .claude/plans --ticket-key {JIRA_KEY}`.
3. If output `posted: true`, mark step P6 done. If `posted: false` with reason `no_plan_file`, mark done anyway (nothing to post).

### Step P7: PR marked ready for review (Mode C only)
**Skip if**: step is already marked done in `STORAGE`, OR `MARK_READY` is false.

1. Run `gh pr ready {BRANCH}`.
2. Append to the activity log: `append-activity {JIRA_KEY} --heading "Feature branch PR ready" --body "Ready for human review: {PR_URL}"`.
3. Mark step P7 done in `STORAGE`.

---

# Mode C: Feature Branch PR (completed stack)

Triggered when a stack container key is passed that has `ClaudeStackComplete`. This opens a PR from the feature branch (named after the container key) to its parent's feature branch (when the container is a Story nested under an Epic-with-feature-branch) or to `main` (top-level Epics, standalone Stories). Runs code review and resolves Copilot comments.

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
   cd {REPO_ROOT} && git fetch origin
   ```
5. Checkout the feature branch:
   ```bash
   cd {REPO_ROOT} && git checkout {FEATURE_BRANCH} && git pull origin {FEATURE_BRANCH}
   ```
6. If `PR_BASE` is not `main`, ensure the parent feature branch exists locally and is up to date:
   ```bash
   cd {REPO_ROOT} && git fetch origin {PR_BASE}:{PR_BASE} 2>/dev/null || git fetch origin {PR_BASE}
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
- [ ] 5. Copilot review comments resolved
- [ ] 6. PR review summary posted
- [ ] 7. PR marked ready for review
```

## C3: Execute Checklist

Run the **Shared sub-procedure: PR Push & Review** (defined above) with these bindings:

- `WORK_DIR` = `REPO_ROOT`
- `BRANCH` = `FEATURE_BRANCH`
- `BASE` = `PR_BASE`
- `JIRA_KEY` = `CONTAINER_KEY`
- `STORAGE` = the local checklist file at `{REPO_ROOT}/.claude/plans/ticket-work-{CONTAINER_KEY}-pr.md` (read/update with checkbox edits)
- `MARK_READY` = true
- `LABEL_FLIP` = none

Each `Step P{n}` in the sub-procedure maps onto checklist item `n` in this file (P1 ↔ "PR description generated", …, P7 ↔ "PR marked ready for review"). Before starting P1, ensure we are on `{FEATURE_BRANCH}`: `cd {REPO_ROOT} && git checkout {FEATURE_BRANCH}`. The sub-procedure handles the rest.

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
resolve-stack {KEY} --repo-root {REPO_ROOT}
```

Parse the JSON output. Find the ticket's entry in the `stack` array. Use:
- `FEATURE_BRANCH` = `container.featureBranch`
- `CONTAINER_BASE` = `container.baseBranch`
- `UNMERGED_BLOCKERS` = `container.unmergedBlockers`
- `BASE_BRANCH` = ticket's `baseBranch`
- `BRANCH_NAME` = ticket's `branch` (or `{KEY}` if null)

If the ticket's `eligible` is `false`:
- **skip this ticket**
- Display: "Skipping {KEY}: waiting on {unblockedBlockers[0]}"

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
   cd {REPO_ROOT} && git checkout {BRANCH_NAME}
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

Awaiting PR Approval:
  - {KEY}: stack ready, add ClaudePRApproved to open PR
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

Run the **Stack Context Resolution** sub-procedure (defined below) with `KEY={TICKET_KEY}` and `REPO_ROOT={CURRENT_ROOT}`. After the sub-procedure runs, also extract from the ticket's `stack[]` entry:
- `BRANCH_NAME` = ticket's `branch` (or `{TICKET_KEY}` if null)
- `BASE_BRANCH` = ticket's `baseBranch`
- `PR_TARGET` = ticket's `prTarget`
- `SUMMARY` = ticket's `summary`
- `labels` = ticket's `labels` array

(`FEATURE_BRANCH`, `CONTAINER_KEY`, `CONTAINER_BASE`, `UNMERGED_BLOCKERS`, `REPO_ROOT`, etc. come from the sub-procedure.)

If the ticket's `eligible` is `false` and `unblockedBlockers` is non-empty:
- Display: "Blocked: waiting on {unblockedBlockers[0]}" and **stop**.

- **Ensure `ClaudeWork` label**: If the ticket does not already have the `ClaudeWork` label, add it using `mcp__atlassian__editJiraIssue` with `update`: `{"labels": [{"add": "ClaudeWork"}]}`.

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

Parse the JSON: `{ workDir, branch, mode, created, fetched }`. Set `WORK_DIR = workDir` and `PLANS_DIR = {WORK_DIR}/.claude/plans` (used only for PR review plans in S4.5/S4.6).

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
- If `source` is `"seeded"`: the checklist was freshly created (seeded from Jira labels and git stage commits) and written to Jira. Start from the first unchecked step.

Store the `steps` array in memory for step tracking throughout S4.

## Stage Squash Protocol

Each lifecycle stage (S4.1 through S4.6) produces exactly one squash commit on the ticket branch when it completes. Implementation lives in `cli/lib/stage-squash.js` (exposed as the `stage-squash` CLI).

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
- S4.5+S4.6: `review: PR fixes applied`

## S3.5: Drift Check (Implementation Notes refresh)

Before executing the checklist, verify that the ticket's `Implementation Notes` (created by `planner` Phase 5.0) still match the code. If the cited code has moved or changed since the research SHA, re-run the per-ticket research and update the ticket.

**Skip entirely if:**
- The ticket has no `h2. Implementation Notes` block (e.g., older tickets created before this protocol). Continue to S4.
- The checklist already shows step 2 (S4.2 execute) as `[x]`. Drift detection is moot once implementation has started.
- The Jira label `ClaudeDriftChecked` is present AND was added after the most recent push to `BASE_BRANCH`. (This makes drift checks idempotent within a session but re-runs if upstream has moved.)

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

If `status` is `no-notes`, this protocol is moot — set `ClaudeDriftChecked` and continue to S4.

### S3.5b.i: Constraints pass (LLM verification)

The CLI cannot tell whether listed constraints are still applicable. After parsing the JSON:

1. If `constraintsRaw` is null or only contains "none surfaced", skip this step.
2. Otherwise, for each constraint bullet, read the cited region at HEAD via `Read` / `Grep` and decide: **still applicable**, **already resolved**, or **scope changed**.
3. If any constraint is `already resolved` or `scope changed`, treat the ticket as drifted even if the structural pass returned `current` — fold those changes into the refresh in S3.5c.

### S3.5c: Decide

**No drift** (`status === "current"` AND constraints pass found nothing):
- Add `ClaudeDriftChecked`: `set-ticket-state {TICKET_KEY} --add ClaudeDriftChecked`.
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
- Add `ClaudeDriftChecked`: `set-ticket-state {TICKET_KEY} --add ClaudeDriftChecked`.

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

### Step S4.1: Plan generated with /jira-start

**Skip if**: step 1 is already checked `[x]`, OR a plan already exists in Jira (check via `sync-plan {TICKET_KEY} --read` returning data), OR git log contains `[{TICKET_KEY}] plan:` stage commit.

1. Move the ticket to `ClaudePlanning`:
   ```bash
   set-ticket-state {TICKET_KEY} --to ClaudePlanning
   ```
2. Use the Skill tool to run skill `jira-start` with args `{TICKET_KEY} --base {BASE_BRANCH}`
3. Sync the plan file to Jira as a managed comment:
   ```bash
   sync-plan {TICKET_KEY} --file {PLANS_DIR}/jira-{TICKET_KEY}.md
   ```
   (jira-start writes a local file — this syncs it to Jira. The local file is now disposable.)
4. Append a plan summary to the activity log:
   ```bash
   append-activity {TICKET_KEY} --heading "Plan generated" --body-file <tmp-summary.md>
   ```
   The body should contain: approach overview (1-2 sentences), key implementation steps as bullets, and if stacked: "Stacked on {BASE_BRANCH}".
5. Mark step 1 as done in the steps array and sync checklist to Jira.
6. Apply Stage Squash Protocol: `stage-squash {TICKET_KEY} --label "plan: generated" --base {BASE_BRANCH} --branch {BRANCH_NAME}`.

---

### Step S4.2: Plan executed with TDD (Red-Green-Refactor)

**Skip if** any of:
- step 2 is already checked `[x]` in the Jira checklist, OR
- the Jira plan's task list already shows every task marked done (verify via `sync-plan {TICKET_KEY} --read` and inspecting `sections[*].tasks[*].done`), OR
- git log on the current branch already contains an `[{TICKET_KEY}] execute:` stage commit (the squash from a prior completed S4.2 run).

Execution follows test-driven development: for each plan task, write a failing test derived from the Gherkin acceptance criteria first (Red), then implement to make it pass (Green), then refactor. Tests are written in the project's native test framework.

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
    - (Keep `ClaudeExecuting` label — it will be replaced by `ClaudeStackReady` in step 7)
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

### Step S4.4: Refactoring pass with @refactor agent

**Skip if**: step 4 is already checked `[x]`.

After TDD execution and acceptance verification, run a targeted refactoring pass on the code changed by this ticket. The refactor agent identifies CRAP score hotspots, DRY violations, and structural smells — then implements approved fixes.

0. (`stage-squash` derives `STAGE_START_SHA` automatically when run at the end of the stage; nothing to record up front.)

1. Make sure we are in the working directory: `cd {WORK_DIR}`
2. Get the list of files changed on this branch:
   ```bash
   git diff {BASE_BRANCH}...HEAD --name-only --diff-filter=ACMR
   ```
3. Launch the refactor agent targeting only the changed files:
   - Use the Agent tool with `subagent_type: "refactor"`
   - Prompt: "Analyze the following files for CRAP score, DRY violations, and refactoring opportunities. These were changed as part of ticket {TICKET_KEY}. Only flag issues introduced or worsened by this branch's changes — don't report pre-existing issues in unchanged code. Implement any refactorings that are clearly beneficial (reduce complexity, eliminate duplication) without changing behavior. Skip anything marginal or subjective. Files: {FILE_LIST}"
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

### Step S4.5: PR review plan generated with /pr-review

**Skip if**: step 5 is already checked `[x]`.

0. Record `STAGE_START_SHA` (Stage Squash Protocol — shared with S4.6, squash happens after S4.6).

1. Make sure we are in the working directory: `cd {WORK_DIR}`
2. Ensure plans directory exists: `mkdir -p {PLANS_DIR}`
3. Pin the review base so `pr-review` diffs against the ticket's actual stacked base, not `main`. At this point in the lifecycle no PR exists yet (it's created later at S4.10), so the skill's `pr-context.sh` would otherwise fall back through `PR base → origin/HEAD` and pick `main`. Writing `branch.<BRANCH_NAME>.base` is the highest-priority hook in that resolver. Use the `origin/{BASE_BRANCH}` form so the value resolves even when the local branch ref doesn't exist (worktree mode, branches that have only been fetched):
   ```bash
   git config branch.{BRANCH_NAME}.base origin/{BASE_BRANCH}
   ```
4. Use the Skill tool to run skill `pr-review`
5. Mark step 5 as done and sync checklist to Jira.

---

### Step S4.6: PR review plan executed with /pr-execute-plan

**Skip if**: step 6 is already checked `[x]`.

1. Make sure we are in the working directory: `cd {WORK_DIR}`
2. Use the Skill tool to run skill `pr-execute-plan`
3. After execution: stage and commit any changes if present
4. Mark step 6 as done and sync checklist to Jira.
5. Apply Stage Squash Protocol: `stage-squash {TICKET_KEY} --label "review: PR fixes applied" --base {BASE_BRANCH} --branch {BRANCH_NAME}` (covers S4.5+S4.6).

---

### Step S4.7: Stack ready

S4.7 has two sub-steps. S4.7a always runs and is the only thing that "marks the ticket as stack-ready". S4.7b only runs when the ticket sits inside a Story/Epic stack with a `FEATURE_BRANCH` — it merges the reviewed branch into that feature branch and shifts the label from `ClaudeStackReady` to `ClaudeNeedsReview`.

#### Step S4.7a: Mark stack ready

**Skip if**: step 7 is already checked `[x]`.

This sub-step marks the ticket stack-ready, which unblocks downstream tickets without requiring a PR to be opened. It runs for every ticket — feature-branch and standalone alike.

1. Update Jira labels — move the ticket to `ClaudeStackReady`:
   ```bash
   set-ticket-state {TICKET_KEY} --to ClaudeStackReady
   ```
2. Append to the activity log:
   ```bash
   append-activity {TICKET_KEY} --heading "Stack ready" --body "Code review complete. Stack unblocked — downstream tickets may begin."
   ```
3. Mark step 7 as done and sync checklist to Jira.

After S4.7a:
- If `FEATURE_BRANCH` is null (standalone workflow): this is the terminal state for non-feature-branch tickets. Display:
  ```
  Ticket {TICKET_KEY} - Stack Ready (terminal)

  Branch: {BRANCH_NAME}
  Code review complete. Downstream tickets are unblocked.
  To open the PR later: add `ClaudePRApproved` in Jira, then re-run `/ticket-work {TICKET_KEY}`.
  ```
  Proceed to S6 (promote downstream), then stop. Do **not** run S4.7b.
- If `FEATURE_BRANCH` is set: continue to S4.7b.

#### Step S4.7b: Merge into feature branch (feature-branch workflow only)

**Skip if**: `FEATURE_BRANCH` is null. Feature-branch tickets stop after S4.7b; the container's Mode C checklist takes over from there. The S4.8–S4.12 steps in this command's per-ticket checklist are stamped done by S4.7b (see step 7 below) because the work they describe is owned by Mode C, not by the per-ticket lifecycle.

1. **Verify review is clean**: Read the PR review plan file from `{PLANS_DIR}/` (matching `pr-review-*.md` or `pr-{TICKET_KEY}*.md`). Parse all items in the plan:
   - If any issues are marked unresolved or incomplete: run `set-ticket-state {TICKET_KEY} --to ClaudeFailed`, append the unresolved-issues list to the activity log (`append-activity {TICKET_KEY} --heading "Review issues unresolved" --body-file <issues.md>`), and **stop**.
   - Display: "Review has unresolved issues. Fix them and re-run `/ticket-work {TICKET_KEY}`."
   - Only proceed if ALL issues identified by the review have been resolved.
2. Ensure feature branch is up to date:
   ```bash
   cd {WORK_DIR} && git fetch origin && git checkout {FEATURE_BRANCH} && git pull origin {FEATURE_BRANCH}
   ```
3. Merge the ticket branch:
   ```bash
   git merge {BRANCH_NAME} --no-ff -m "Merge {TICKET_KEY}: {SUMMARY}"
   ```
4. If merge conflicts occur:
   - Attempt automatic resolution for trivial conflicts
   - If unresolvable: abort the merge (`git merge --abort`), run `set-ticket-state {TICKET_KEY} --to ClaudeFailed`, and **stop**
   - Display: "Merge conflict merging {BRANCH_NAME} into {FEATURE_BRANCH}. Investigate and re-run."
5. Push the updated feature branch:
   ```bash
   git push origin {FEATURE_BRANCH}
   ```
6. Return to the ticket's working directory:
   - If `SERIAL_MODE`: `git checkout {BRANCH_NAME}`
   - If worktree mode: `cd {WORK_DIR}`
7. Mark steps 8-12 as done in this ticket's checklist and sync to Jira. Those steps describe per-ticket PR work that does not apply here — feature-branch tickets do not get their own main-targeting PR; the container's Mode C flow ships them as a single feature-branch PR. Stamping 8-12 as done keeps the resume logic from looping back into per-ticket PR steps that have nothing left to do.
8. Append to the activity log:
   ```bash
   append-activity {TICKET_KEY} --heading "Merged to feature branch" --body "Merged into feature branch \`{FEATURE_BRANCH}\`."
   ```
9. Update Jira labels — move the ticket to `ClaudeNeedsReview`:
   ```bash
   set-ticket-state {TICKET_KEY} --to ClaudeNeedsReview
   ```
10. Display:
    ```
    Ticket {TICKET_KEY} - Merged to Feature Branch

    Branch: {BRANCH_NAME} → {FEATURE_BRANCH}
    All review issues resolved. Merged locally and pushed.
    ```
11. Proceed to S6 (promote downstream), then stop.

---

### Step S4.8: PR approved

**Skip if**: step 8 is already checked `[x]`.

Check the ticket's current labels:
- If `ClaudePRApproved` is present: mark step 8 as done, sync checklist to Jira, and continue.
- If `ClaudeStackReady` is present (or no PR approval label):
  - Tell the user:
    ```
    Awaiting PR approval.

    To approve: add the `ClaudePRApproved` label in Jira, then re-run `/ticket-work {TICKET_KEY}`.

    Or type "approve pr" to approve now and continue.
    ```
  - If the user types "approve pr" or similar affirmative:
    - Run `set-ticket-state {TICKET_KEY} --to ClaudePRApproved`
    - Mark step 8 as done and sync checklist to Jira.
  - Otherwise: **stop here**. The command will resume from this step on next run.

---

### Steps S4.9–S4.12: PR Push & Review (shared sub-procedure)

S4.9 through S4.12 are an instance of the **Shared sub-procedure: PR Push & Review** (defined earlier in this file). Use these bindings:

- `WORK_DIR` = `WORK_DIR`
- `BRANCH` = `BRANCH_NAME`
- `BASE` = `PR_TARGET`
- `JIRA_KEY` = `TICKET_KEY`
- `STORAGE` = the Jira checklist on `{TICKET_KEY}` (use `sync-checklist {TICKET_KEY}` to read/write)
- `MARK_READY` = false (per-ticket PRs stay draft until the human marks them ready)
- `LABEL_FLIP` = `set-ticket-state {TICKET_KEY} --to ClaudeNeedsReview` applied at P2 (creates draft PR)

The mapping is:
- S4.9 ↔ P1 (PR description)
- S4.10 ↔ P2 (push as draft)
- S4.11 ↔ P5 (Copilot review loop)
- S4.12 ↔ P6 (post review summary)

S4 does **not** run P3 / P4 / P7 — those are Mode-C-only (review plan generation/execution and ready-for-review flip). The per-ticket flow handled review at S4.5/S4.6 already; the Mode C flow re-runs review at the feature-branch level for the integrated diff.

After P6, mark steps 9-12 as done in the Jira checklist (a single `sync-checklist` call may cover them).

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

After reaching stack-ready (step 7) or completing all steps, check if there are downstream tickets in the same stack that are now unblocked and eligible for work.

**Skip S6 entirely if `EPIC_SINGLE_MODE` is true.** When `/ticket-work` was entered with an Epic key, this invocation runs exactly one ticket; the user re-runs `/ticket-work {EPIC_KEY}` to advance to the next. Display: "Epic single-ticket invocation complete. Re-run `/ticket-work {EPIC_KEY}` to pick up the next unblocked ticket." and **stop** before S6a.

### S6a: Find Eligible Downstream Tickets

Run `resolve-stack {TICKET_KEY} --repo-root {REPO_ROOT}` to refresh the stack state after this ticket completed.

From the `stack` array, find tickets that come after the current ticket and have `eligible == true`. These are the downstream tickets now unblocked.

Filter out:
- Tickets not assigned to the current user
- Tickets that already have any progress label (`ClaudePlanning`, `ClaudeExecuting`, `ClaudeStackReady`, `ClaudePRApproved`, `ClaudeNeedsReview`, `ClaudeFailed`)

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
- Plan already exists in Jira: skip /jira-start (don't overwrite existing plan).
- On failure at step S4.2 (execution): Jira label is set to `ClaudeFailed`. User must investigate, fix, remove `ClaudeFailed` label, then re-run.
- In queue mode: never stop due to a single ticket failure. Each agent handles its own error state.
- If interrupted mid-stage (squash not yet applied): on resume, Claude detects uncommitted stage work (commits since the last stage marker) and continues the stage, then squashes when done. The STAGE_START_SHA is derived from git log per the Stage Squash Protocol.
