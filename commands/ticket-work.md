---
description: "Run Jira tickets through plan, execute, and code review to stack-ready. Feature branches merge locally after review passes. Without a feature branch, a draft PR to main opens automatically. Takes one or more ticket keys; a Story or Epic key runs the next unblocked member, one per invocation."
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

Takes one or more ticket keys. A Story or Epic key resolves its stack and runs
the next unblocked member — one ticket per invocation; re-run to advance.

> Shared sub-procedures: `commands/_shared-stack-procedures.md`.
> Design rationale for these steps: `docs/design-notes.md`.

## Shell command shape

Every command block in this skill is one Bash tool call. Never chain with `&&`, `||`, or `;`. The permission engine can't statically match compound commands, so chaining breaks per-tool allowlist rules (e.g. `Bash(stage-squash:*)`) and forces prompts.

- For git operations that need a specific directory, use `git -C {DIR} <cmd>` — never `cd {DIR} && git <cmd>`.
- A standalone `cd {WORK_DIR}` step is one call; do not append the next step onto it with `&&`. Bash cwd persists across tool calls in a session, so subsequent commands run in `{WORK_DIR}` without any further cd.
- For non-git CLIs (e.g. `stage-squash`, `append-activity`, `ensure-pr`) that must run inside a repo, do the `cd {WORK_DIR}` once as its own step (or rely on the session's persistent cwd) and invoke the CLI on its own line.

## Label Reference

Canonical set: `cli/lib/labels.js` (`DURABLE_LABELS`, `PROGRESS_LABELS`,
`CONTAINER_LABELS`). Flow is `ClaudeReady` → `ClaudePlanning` → `ClaudeExecuting`
→ `ClaudeStackReady` → cleanup. `ClaudeFailed` is the failure side-channel,
`ClaudeStackComplete` the container rollup that triggers Mode C, `ClaudeWork`
durable and never removed.

Use `set-ticket-state` for every progress transition — it clears the previous
state automatically and does **not** touch the Jira workflow status. Review
state, drift state, phase-1 cleanup, and cancellation are deliberately *not*
labels; they are read from the PR, the baseline SHA, the `merged/{KEY}` tag, and
the Jira status respectively (rationale in `docs/design-notes.md`).

Feature branches are derived automatically: one per Story/Epic container, named
after its Jira key (e.g. `EPIC-123`), or after a `branch:<name>` label on the
container if set. The tooling creates it on first use from `main` or from a
blocker container's branch (`resolve-stack` → `container.baseBranch`).

### Complexity Tiers

Two independent gates decide which steps run. They read different signals at
different points and fire independently:

- **Gate 1 — skip plan, collapse execute.** Decided **pre-execute** at S3.4 from
  AC and Implementation Notes. Skips S4.1 and runs S4.2 in **no-plan mode**
  (single-batch tests instead of per-task Red-Green-Refactor). Expressed as the
  `complexity:trivial` label; `seed-checklist` pre-marks S4.1/S4.4/S4.5 done with
  a ` (skipped: trivial)` suffix so the S4 loop walks past them.
- **Gate 2 — skip the review pass.** Decided **post-execute** at S4.3.5
  from the actual diff. Skips S4.4 (which subsumes the retired S4.5) with a
  ` (skipped: output trivial)` suffix. In-memory only — no Jira label.

Gate 1 must commit before any code is written; Gate 2 can only be judged honestly
once the code exists (a small-looking AC may produce a 500-line diff). Tier
resolution is `getComplexity(labels)`, defaulting to `standard`. Step numbering is
stable across tiers.

CI green and Copilot comments are not pipeline-driven. The lifecycle stops once
the PR is pushed and the review summary is posted; run `/cop-fight` on demand
afterwards.

### Activity Log Comment

All narrative status goes into one managed, append-only Jira comment (marker
`[claude-activity-log]`) via the `append-activity` CLI — never
`mcp__atlassian__addCommentToJiraIssue`. Each call adds a timestamped entry with a
heading and a compacted body (1–5 bullets, not full narration).

```bash
append-activity {TICKET_KEY} --heading "<short title>" --body "<compact summary>"
```

For multi-line bodies write a temp file and use `--body-file`. Subagents launched
from this command call `append-activity` once at the end of their work.

## Code Style

The **Code Style** section in `~/.claude/CLAUDE.md` is the source of truth. S4.2 (execute) and S4.4 (refactor) apply it verbatim. Project-local conventions (existing patterns in the touched files, CLAUDE.md, linter config) always win when they conflict.

## Test Tiers

Resolve **two** commands once, during S4.2 setup, and reuse them for the rest of
the lifecycle. Most projects wrap their test entry point in lint, dependency
refresh, container setup, and security scanning — appropriate for a merge gate,
wasteful on every inner-loop iteration.

- `FAST_TEST` — the narrowest command that runs a chosen test file or pattern
  directly through the runner, skipping wrappers. Prefer invoking the runner via
  the package manager (e.g. `pnpm --filter <pkg> exec vitest run <path>`,
  `pytest <path>`, `go test ./<pkg>`). Used for the inner loop.
- `FULL_TEST` — the project's real suite command, the one CI runs. Used only at
  the S4.2 exit gate and after the S4.4 refactor.

When the project's wrapper script exposes env toggles for its expensive phases
(lint/pre-commit, dependency update, security scan, schema validation), set them
off for `FAST_TEST` and leave them on for `FULL_TEST`. Check the script for
`${VAR:-true}` defaults before assuming none exist.

Record both in the S4.2 activity-log entry so a resume does not re-derive them.
If `FAST_TEST` cannot be isolated, set `FAST_TEST = FULL_TEST` and say so in the
log — correctness never yields to speed here.

**Redirect test output to a file and read back only the summary and failures.**
Full suite output is large and the interesting part is the tail. Never pipe raw
suite output into context wholesale.

## Arguments

$ARGUMENTS

Required: one or more space-separated Jira ticket keys (e.g., `PROJ-123 PROJ-456`).

A **container** key (Epic, or a Story/Task with members) resolves its stack and
runs the next unblocked member — one per invocation; re-run to advance. A **leaf**
key runs directly. Several leaf keys run through the multi-ticket runner.

There is no discovery mode: invoked with no arguments, display "Ticket key
required. `/orchestrate` finds eligible work; `/ticket-work KEY` runs it." and
**stop**.

### Flags

- `--serial`: Work tickets sequentially using branch checkout instead of worktrees. Stays in the main repo directory and switches branches between tickets. Use when worktrees are impractical (e.g., monorepos with expensive setup, limited disk space, or tooling that doesn't support worktrees).

### Flag Parsing

Parse `$ARGUMENTS` to extract flags before processing ticket keys. Any token starting with `--` is a flag; remaining tokens are ticket keys. Store `SERIAL_MODE = true` if `--serial` is present.

---

# Mode A: Resolve the requested ticket

## A1: Resolve Tickets

Use `mcp__atlassian__getAccessibleAtlassianResources` to get `CLOUD_ID`.

For each key in `$ARGUMENTS`, use `mcp__atlassian__getJiraIssue` to fetch it.

### Completed stack — Mode C

If the issue is a **stack container** (Epic, or a Story/Task with members) AND has the `ClaudeStackComplete` label: this is a completed feature branch ready for PR to main. Read `commands/_container-flows.md` and run **Mode C: Feature Branch PR** from it, then stop.

### Container key — pick the next unblocked ticket

If the issue is a **container** (`Epic`, or a Story/Task with members) and Mode C
did not trigger above, do **not** expand to all descendants or fan out. Containers
advance one ticket per invocation.

1. Run the **Stack Context Resolution** sub-procedure (`commands/_shared-stack-procedures.md`) with `KEY={CONTAINER_KEY}`
   and `FETCH=true`.
2. Walk `STACK_ORDER` in order and pick the **first** entry where:
   - `entry.eligible === true`, AND
   - the entry carries no progress label from `PROGRESS_LABELS`, AND
   - `entry.inReview !== true` — set by `resolve-stack` when the ticket has an
     open PR or a review-state Jira status. Those are out for review, not waiting.

   Call this `NEXT_KEY`.
3. If no entry qualifies:
   - If every entry is finished (per `isFinished()`), display "Container
     {CONTAINER_KEY} has no unblocked work — all tickets finished. Re-run once
     `ClaudeStackComplete` is set, or apply the label manually to trigger Mode C."
     and **stop**.
   - Otherwise display "Container {CONTAINER_KEY} has no eligible tickets — every
     remaining ticket is blocked or in flight. First blocker: {key} (waiting on
     {its `unblockedBlockers[0]`})." and **stop**.
4. Set `SINGLE_MODE = true` for the rest of this invocation. This tells S6 to stop
   instead of auto-advancing — re-run `/ticket-work {CONTAINER_KEY}` to pick the next.
5. Display: "Container {CONTAINER_KEY}: working next unblocked ticket {NEXT_KEY} -
   {NEXT_SUMMARY} (one ticket per invocation)."
6. Proceed to **Single Ticket Lifecycle** using `{NEXT_KEY}` as `TICKET_KEY`.

### Leaf ticket — run directly

Otherwise the key is a leaf ticket: proceed to **Single Ticket Lifecycle** with it
as `TICKET_KEY`. `SERIAL_MODE` still propagates — it controls worktree-vs-branch
handling in S2a/S2b — so do not strip `--serial` when handing off.

### Multiple keys

When `$ARGUMENTS` names several leaf tickets, read `commands/_container-flows.md`
and run the **Multi-ticket runner** (Q3 onward) from it. There is no JQL discovery
mode; `/orchestrate` owns finding work.

---

# Single Ticket Lifecycle

Runs one ticket through all steps. Used directly (Mode A) or from the multi-ticket runner.

## S1: Detect Environment

### S1a: Determine Mode and Working Directory

Set `SERIAL_MODE = true` if `--serial` was passed. Run `git rev-parse --show-toplevel`
and store it as `CURRENT_ROOT`.

- **Serial mode**: `REPO_ROOT` and `WORK_DIR` are both `CURRENT_ROOT` — all work
  happens in the main repo, and S2 checks out the ticket branch there.
- **Worktree mode, already in the ticket's worktree** (basename of `CURRENT_ROOT`
  matches `{TICKET_KEY}`): `WORK_DIR = CURRENT_ROOT`, and `REPO_ROOT` is the main
  worktree — the first entry in `git worktree list --porcelain` (marked `bare` or
  carrying no `branch`). If `CURRENT_ROOT` *is* the main worktree, S2 still needs to
  create the ticket worktree.
- **Worktree mode, elsewhere**: `REPO_ROOT = CURRENT_ROOT` and
  `WORK_DIR = {REPO_ROOT}/../{TICKET_KEY}`.

`BRANCH_NAME` comes from `resolve-stack` in S1c. `ensure-work-dir` (S2) resolves the
rest — base refs, idempotent reuse of existing branches and worktrees, and the
serial-vs-worktree split — so do not pre-compute it here.

### S1b: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### S1c: Resolve Stack Context

Run the **Stack Context Resolution** sub-procedure (`commands/_shared-stack-procedures.md`) with `KEY={TICKET_KEY}`, `REPO_ROOT={CURRENT_ROOT}`, and `FETCH=true`. `FETCH` is required — S1d's gate reads `mergedIntoFeature` / `mergedIntoMain`, which go stale against local origin refs.

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

Run the **Ensure Cleanup Prerequisites** sub-procedure (`commands/_shared-stack-procedures.md`) with `STACK_ORDER` and `REPO_ROOT` from S1c and `RESOLVED_KEY={TICKET_KEY}`. Any predecessor already merged into the feature branch but missing its `merged/{KEY}` tag gets backfilled before this ticket's branch or rebase base is computed.

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

Parse the JSON: `{ workDir, branch, mode, created, fetched }`. Set `WORK_DIR = workDir` and `PLANS_DIR = {WORK_DIR}/.claude/plans` (used only for the PR review plan at S4.4).

In serial mode the branch is checked out in `{REPO_ROOT}`; in worktree mode the worktree is created at `{REPO_ROOT}/../{TICKET_KEY}`.

### S2.5: Rebase onto origin/{BASE_BRANCH}

Every invocation rebases the ticket branch onto the latest `origin/{BASE_BRANCH}`
before loading the checklist, keeping it synced with whatever it is stacked on —
`main`, the container's feature branch, or a sibling ticket's branch.

**Skip if** `ensure-work-dir` reported `created: true` in S2 (a fresh branch is
already at base).

1. `cd {WORK_DIR}`
2. `git fetch origin {BASE_BRANCH}`
3. `git merge-base --is-ancestor origin/{BASE_BRANCH} HEAD` — exit 0 means already
   up to date, skip the rest.
4. `git rebase origin/{BASE_BRANCH}`
5. **On conflict**: `git rebase --abort`, then move the ticket to failed and stop —
   the user resolves and re-runs:
   ```bash
   set-ticket-state {TICKET_KEY} --to ClaudeFailed
   ```
   ```bash
   append-activity {TICKET_KEY} --heading "Rebase conflict" --body "Conflict rebasing \`{BRANCH_NAME}\` onto \`origin/{BASE_BRANCH}\`. Resolve manually and remove \`ClaudeFailed\` to retry."
   ```
6. **On success with commits replayed**: `git push --force-with-lease origin {BRANCH_NAME}`.
   Skip the push when the rebase was a no-op.

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

Tickets carry an optional `complexity:trivial` or `complexity:standard` label that drives which steps in S4 actually run (see "Complexity Tiers" in the Label Reference section). This step ensures every ticket has a tier label before S4 begins.

1. **The single ticket fetch.** Call `mcp__atlassian__getJiraIssue` once with
   `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`. This is the *only* description
   fetch in the lifecycle — `resolve-stack` does not return the description, and the
   labels from S1c are stale if a human just edited one. Bind and keep for the whole run:

   - `DESCRIPTION` — the raw description body.
   - `GHERKIN_SCENARIOS` — every `Given`/`When`/`Then` block and fenced
     `gherkin`/`feature` block parsed out of it. **S4.2 setup and S4.3 both consume
     this binding; neither re-fetches.**
   - `IMPL_NOTES` — the `h2. Implementation Notes` block, when present.
   - `labels` — current labels, superseding the S1c copy.

2. If `labels` contains `complexity:trivial` or `complexity:standard`, skip the rest of
   S3.4 and continue to S3.5 — but keep the bindings above; the later steps need them
   regardless of tier.
3. Otherwise classify from `GHERKIN_SCENARIOS` and `IMPL_NOTES` (already in hand from step 1). Decide tier using this rubric:
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

Each lifecycle stage (S4.1 through S4.4) produces exactly one squash commit on the ticket branch when it completes. Implementation lives in `cli/lib/stage-squash.js` (exposed as the `stage-squash` CLI).

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
- S4.4: `review: combined review pass`

(S4.5 is retired into S4.4 and no longer produces its own stage commit. Its old label
`review: PR review plan generated` may appear in branches from before the merge; treat
it as equivalent when detecting prior progress.)

## S3.5: Drift Check (Implementation Notes refresh)

Verify the ticket's `Implementation Notes` (written by `planner` Phase 5.0) still
match the code before executing. Cheap and idempotent — safe on every resume.

**Skip entirely if** the ticket has no `h2. Implementation Notes` block, or the
checklist already shows step 2 done (drift is moot once implementation started).

1. Run `drift-check {TICKET_KEY} --repo-root {WORK_DIR}`.

   The CLI parses the Implementation Notes subsections plus `h2. TDD Reference` and
   runs every structural verifier in one pass, emitting `{ status, baseline,
   citations[], patterns[], filesLikelyToChange[], testsLikelyToExtend[], tddRef,
   sidecars[], constraintsRaw, drifted, unknown, total }`. Top-level `status` is
   `"drifted"` if any sub-check drifted. On `no-notes`, continue to S4.

2. **Constraints pass** — the CLI cannot judge whether a listed constraint still
   applies, so this part is yours. Skip when `constraintsRaw` is null or only says
   "none surfaced". Otherwise read each cited region at HEAD via `Read`/`Grep` and
   classify it **still applicable**, **already resolved**, or **scope changed**. Any
   of the latter two means treat the ticket as drifted even if `status` was
   `current`.

3. **Decide:**
   - **No drift** (`status === "current"` and the constraints pass found nothing):
     append `Drift check passed — research baseline {sha} still current.` and
     continue to S4.
   - **Drift detected**: refresh the notes and post the diff comment following
     `commands/refresh-research.md` (which owns this procedure — it re-runs
     per-ticket research per `planner` Phase 5.0a–5.0c, re-pins moved citations,
     drops removed ones, and posts the `h3. Drift detected` comment via
     `mcp__atlassian__addCommentToJiraIssue`). Fold in the constraints adjustments
     from step 2. Leave the progress label alone — the refreshed baseline SHA is the
     record. If the ticket is already `ClaudeExecuting` or later, warn in the
     comment that the plan was generated against the prior baseline and may need
     `/rework`.

Either way, proceed to S4.

---

## S4: Execute Checklist

Work through each unchecked step in order. At each **stage boundary** — not after every
internal action — do exactly two things:

1. Apply the Stage Squash Protocol. `stage-squash` force-with-lease pushes the squashed
   commit itself (`cli/lib/stage-squash.js`), so the remote lands the clean state.
2. Mark the step(s) done and sync once:
   ```bash
   sync-checklist {TICKET_KEY} --steps '{JSON_STEPS_ARRAY}'
   ```

Do **not** add a separate `git push origin {BRANCH_NAME}` — the squash already pushed,
and pushing first would send the pre-squash commits only to overwrite them a moment
later. Batch adjacent checklist updates into one `sync-checklist` call: every call
re-fetches the ticket's whole comment list, so N calls cost N full comment fetches.

The squashed remote state is what supports idempotent resume from any machine.

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
4. Apply Stage Squash Protocol: `stage-squash {TICKET_KEY} --label "plan: generated" --base {BASE_BRANCH} --branch {BRANCH_NAME}`.
5. Mark step 1 as done in the steps array and sync the checklist to Jira.

---

### Step S4.2: Plan executed with TDD (Red-Green-Refactor)

**Skip if** any of:
- step 2 is already checked `[x]` in the Jira checklist, OR
- the Jira plan's task list already shows every task marked done (verify via `sync-plan {TICKET_KEY} --read` and inspecting `sections[*].tasks[*].done`), OR
- git log on the current branch already contains an `[{TICKET_KEY}] execute:` stage commit (the squash from a prior completed S4.2 run).

Two modes, detected by reading the plan (`sync-plan {TICKET_KEY} --read`):

- **Standard mode** (plan exists): per-task Red-Green-Refactor, steps 6a–6d.
- **No-plan mode** (plan empty or absent — Gate 1 fired): single batch, steps
  6'a–6'c. Gate 1 cuts the R-G-R ceremony, **not** AC coverage.

Setup, before either mode:

1. `set-ticket-state {TICKET_KEY} --to ClaudeExecuting`
2. `append-activity {TICKET_KEY} --heading "TDD execution started" --body "Beginning Red-Green-Refactor cycle for plan tasks."`
3. **Use `GHERKIN_SCENARIOS`** from S3.4 step 1 — already parsed. Do not call
   `mcp__atlassian__getJiraIssue` again. These drive the tests.
4. **Detect the test framework** from the project: existing test files,
   `package.json` (jest/vitest/mocha), `pytest.ini`, `go.test`. Note the file-naming
   convention (`*.test.ts`, `*_test.go`, `test_*.py`) and directory layout
   (`__tests__/`, `tests/`, colocated). Tests are always written in the project's
   native framework.

   Resolve `FAST_TEST` and `FULL_TEST` now, per the **Test Tiers** section above.
   Every "run the tests" instruction below names which tier it means.
5. **Read the plan**: `sync-plan {TICKET_KEY} --read` → `sections[*].tasks[*]`, each
   with `label` and `done`.

6. **For each plan task, execute the Red-Green-Refactor cycle:**

   #### 6a: Red — write the failing test

   Write a test mapping to the Gherkin scenario steps this task covers, in the
   project's framework and naming conventions. Name it after the scenario and step
   (`{Scenario Name} - {step}`) unless the project has its own pattern.

   Run it with `FAST_TEST` scoped to the new test file and confirm it **fails for
   the right reason**. A test that passes immediately means the behavior already
   exists — note it and move to the next task. A syntax or import error means fix
   the test, not the code.

   `git add {TEST_FILE} && git commit -m "Red: {task title} - failing test for {scenario step}"`

   #### 6b: Green — implement to pass

   Implement the minimum to pass. Apply the **Code Style** section in
   `~/.claude/CLAUDE.md`; surrounding-file conventions win on conflict.

   Run `FAST_TEST` scoped to this task's test file(s) **plus** any test file the
   task's code changes could plausibly break — nearby suites for the modules you
   touched. Do not move on red.

   Do **not** run `FULL_TEST` here. The regression sweep happens once, at step 7.
   Running it per task multiplies the wrapper cost by the task count and gates on
   nothing the step-7 run won't catch.

   `git add -A && git commit -m "Green: {task title} - implementation passes"`

   #### 6c: Refactor (optional)

   If the code can be improved without behavior change (duplication, naming,
   extraction), do it, re-run the same `FAST_TEST` scope, and commit
   `Refactor: {task title}`.

   #### 6d: Mark task complete in Jira

   `sync-plan {TICKET_KEY} --mark-done "{task_label}"`

6'. **No-plan mode (Gate 1 fired)** — replaces 6a–6d entirely when no plan exists:

   #### 6'a: Make the change

   Implement the AC directly. Do not split into per-task commits; the entire ticket is one logical change.

   **Before writing**: apply the **Code Style** section in `~/.claude/CLAUDE.md`. Project-local conventions in the surrounding files win when they conflict.

   #### 6'b: Add Gherkin-driven tests (if any scenarios exist)

   If the AC has Gherkin scenarios, write tests covering them as a single batch — one test per scenario, named after the scenario. Skip this sub-step entirely when the AC has zero scenarios (pure copy/doc/dep-bump tickets).

   Test contract: every Gherkin scenario in the AC must have a corresponding test. This is preserved across both modes — Gate 1 cuts the R-G-R ceremony, not the coverage requirement.

   #### 6'c: Run tests and commit once

   Run `FAST_TEST` over the tests you just wrote plus the suites nearest the code
   you changed. Fix until green — do not commit red. Then
   `git add -A && git commit -m "{TICKET_KEY}: {summary}"`.

   Step 7's `FULL_TEST` run is the regression gate; no need to pay it twice.

   No `sync-plan --mark-done` calls — there's no plan to update.

7. **Exit gate — the one `FULL_TEST` run.** Run `FULL_TEST`, redirecting output to a
   file and reading back the summary plus any failures. Fix and re-run until green.
   Then `git status` — commit anything uncommitted.

   This is the only full-suite run in S4.2 regardless of task count, and it is not
   optional: everything before it ran a narrowed scope, so this is the first point
   at which cross-module regressions surface.
8. Re-read the plan (`sync-plan {TICKET_KEY} --read`) to confirm task state.
9. Append a compacted recap (per-task one-liners + totals) via a temp file:

   ```
   - [x] Task 1 title (N tests)
   - [ ] Task 3 title (incomplete)

   Completed N/M tasks. Total tests written: T.
   ```

   `append-activity {TICKET_KEY} --heading "TDD execution finished" --body-file <tmp-summary.md>`

10. **All tasks complete**: apply the Stage Squash Protocol with label
    `execute: TDD implementation`, then mark step 2 done and sync the checklist.
    Keep `ClaudeExecuting` — S4.6a replaces it with `ClaudeStackReady`.
11. **Tasks incomplete**: `set-ticket-state {TICKET_KEY} --to ClaudeFailed` and **stop**
    for the user to investigate.

---

### Step S4.3: Acceptance criteria verified (TDD final check)

**Skip if**: step 3 is already checked `[x]`.

S4.2 should have produced a test per Gherkin scenario. This step confirms coverage
and a green suite.

1. Use `GHERKIN_SCENARIOS` (bound at S3.4 step 1) — do not re-fetch the description.
   **No scenarios** → mark step 3 done and continue; nothing to verify.
2. **Do not re-run `FULL_TEST`.** S4.2 step 7 ended on a green full suite and no code
   has changed since, so a second run cannot fail differently. Only run tests here if
   this step writes a missing test below, and then use `FAST_TEST` on the new file.

**Lightweight path** — `complexity == trivial` AND ≤1 scenario: the S4.2
batch already mirrors the scenarios, so skip the coverage map. Mark step 3 done,
apply Stage Squash Protocol with label `verify: acceptance criteria`, and append
`--heading "TDD verification passed (lightweight)" --body "Full suite green at S4.2 exit gate. AC covered by S4.2 batch tests."`.

Otherwise build a coverage map, matching each scenario against tests modified on this
branch (`git diff {BASE_BRANCH}...HEAD --name-only` filtered to test/spec paths):

```
### Scenario: {scenario name}
- [x] Given {step} → {test file}:{test name}

{N}/{M} scenarios fully covered by tests.
```

- **Fully covered**: apply Stage Squash Protocol (`verify: acceptance criteria`), then
  mark step 3 done, sync the checklist, and append `--heading "TDD verification passed"`.
- **Gaps**: write the missing test (Red), implement if needed (Green), commit, and
  re-verify with `FAST_TEST`. Because this path changes code after S4.2's gate, close
  it with one `FULL_TEST` run before marking step 3 done. If gaps survive the fix
  attempt, `set-ticket-state {TICKET_KEY} --to ClaudeFailed`, append the coverage map
  via `--body-file`, and **stop**.

---

### Step S4.3.5: Output-size check (Gate 2)

**Skip if**: `complexity == trivial` (S4.4–S4.5 are already pre-marked skipped at seed time), OR step 4 is already checked `[x]` (which implies S4.3.5 ran on a prior invocation or refactor already happened).

This step inspects the actual diff produced by S4.2 and decides whether to skip the combined review pass (S4.4; S4.5 is retired into it). It runs only for `complexity:standard` tickets. The decision is set in-memory via the `OUTPUT_TRIVIAL` flag — no Jira label.

1. `cd {WORK_DIR}`
2. Collect diff signals:
   ```bash
   git diff {BASE_BRANCH}...HEAD --shortstat
   git diff {BASE_BRANCH}...HEAD --name-only
   ```
3. Compute `OUTPUT_TRIVIAL = true` when **all** of:
   - Total changed LOC (insertions + deletions) ≤ 200, excluding test files and lockfiles (`*.test.*`, `*_test.*`, `*.spec.*`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `go.sum`).
   - ≤5 non-test files changed.
   - No changed file matches a risk pattern: `migrations/`, `auth/`, `security/`, `iam/`, `infrastructure/`, `terraform/`, `*.sql`, `*.tf`, files in directories named `permissions/` or `compliance/`.
   - No public API surface changed: no exported signature added, removed, or altered in a package entry point (`index.*`, `mod.rs`, `__init__.py`) and no route/schema/OpenAPI definition touched.
4. Otherwise `OUTPUT_TRIVIAL = false`.
5. If `OUTPUT_TRIVIAL` is true:
   - Mark steps 4, 5 done with `(skipped: output trivial)` suffix via `sync-checklist`.
   - Append to the activity log:
     ```bash
     append-activity {TICKET_KEY} --heading "Gate 2: output trivial — review pass skipped" --body "Diff is {LOC} LOC across {N} non-test file(s), no risk paths, no public API change. Skipping S4.4 (combined review pass). Run /cop-fight after the PR opens to drive CI green and judge Copilot comments."
     ```
6. If `OUTPUT_TRIVIAL` is false, do nothing — the loop continues into S4.4 normally.

The thresholds are deliberately wider than a "tiny diff" heuristic: the risk-path and
public-API vetoes carry the safety load, and everything skipped here is still reviewed
by CI and by `/cop-fight` against the live PR. The four conditions are ANDed, so a
150-LOC change touching `migrations/` still gets the full pass.

### Step S4.4: Combined review pass (subsumes the old S4.5)

**Skip if**: `complexity == trivial` (pre-marked done — small surface, low ROI), OR
`OUTPUT_TRIVIAL` (Gate 2 fired), OR step 4 is already checked `[x]`.

One pass over this branch's diff that both **finds** problems and **fixes** the
clear ones, then writes the review plan. Previously this was two passes — an
`@refactor` agent and a separate `/jay-pr-review` fan-out — over the identical
diff, plus `/cop-fight` post-PR as a third. The agents largely overlapped; the
diff is read once now.

0. (`stage-squash` derives `STAGE_START_SHA` automatically when run at the end of the
   stage; nothing to record up front.)

1. `cd {WORK_DIR}`, and `mkdir -p {PLANS_DIR}`
2. Get the changed files:
   ```bash
   git diff {BASE_BRANCH}...HEAD --name-only --diff-filter=ACMR
   ```
3. Pin the review base so the review diffs against the ticket's actual stacked base,
   not `main`. No PR exists yet at this point (it opens at S4.9), so the resolver would
   otherwise fall through to `origin/HEAD`. Use the `origin/` form so it resolves even
   when the local branch ref doesn't exist (worktree mode, fetch-only branches):
   ```bash
   git config branch.{BRANCH_NAME}.base origin/{BASE_BRANCH}
   ```
4. **Fan out review agents in a single message** — parallel is the point. Pass each the
   file list and the diff range `{BASE_BRANCH}...HEAD`; let them read what they need.
   Do not pass file contents.

   Always:
   - `quality:code-reviewer` — correctness bugs, error handling, dropped promises,
     null cases. No style nits.
   - `refactor` — CRAP hotspots, DRY violations, structural smells, **plus** the
     **Code Style** principles in `~/.claude/CLAUDE.md`. This agent has write
     authority: it implements refactorings and style fixes that are clearly
     beneficial and behavior-preserving, and skips anything marginal or subjective.

   Conditionally:
   - `quality:security-auditor` — when the diff touches auth, input handling,
     persistence, logging, secrets, or shells out.
   - `testing:test-automator` — when a source file changed without a matching test
     change.

   Every agent gets: "These files changed as part of ticket {TICKET_KEY}. Only flag
   issues introduced or worsened by this branch — do not report pre-existing issues in
   unchanged code, and do not enlarge the diff opportunistically. Return findings as
   `{severity, file, line, summary, fix}` with severity ∈ critical|high|medium|low.
   Say 'clean' rather than inventing findings. Project-local conventions in the
   surrounding files win over any general guide."

5. After the agents return, if any of them changed code, run `FULL_TEST` (this is the
   second and last full-suite run of the lifecycle — code changed since S4.2's gate).
   Redirect output to a file; read back the summary and failures.
   - Tests fail: revert the review pass's commits
     (`git revert --no-commit HEAD~N..HEAD`), commit, and note in the activity log that
     the review fixes were reverted due to test failures.
   - Tests pass, or no code changed: proceed.

6. Write the aggregated findings to `{PLANS_DIR}/pr-review-{BRANCH_NAME}.md`, grouped by
   severity, every actionable item a `- [ ]` checkbox so `post-review-summary` and
   `pr-execute-plan` can parse it. Mark items the `refactor` agent already fixed as
   `- [x]` with `(fixed in review pass)`. Follow the plan format in
   `commands/jay-pr-review.md` Step 5.

7. Apply Stage Squash Protocol: `stage-squash {TICKET_KEY} --label "review: combined review pass" --base {BASE_BRANCH} --branch {BRANCH_NAME}`.
8. Mark steps 4 **and** 5 done in one `sync-checklist` call — step 5 is now satisfied by
   this pass. Suffix step 5 with ` (merged into S4.4)`.

Unresolved findings remain a gate for S4.6b. After the PR opens, `/cop-fight` drives CI
to green and judges Copilot comments against the live PR.

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

**Skip if**: `FEATURE_BRANCH` is null. Feature-branch tickets terminate here — the
container's Mode C checklist takes over. Slots 8–10 are stamped done by this step once
the integration PR opens (that work belongs to Mode C); slot 7 is pre-marked at seed time.

1. **Verify review is clean.** Read the review plan from `{PLANS_DIR}/` (matching
   `pr-review-*.md` or `pr-{TICKET_KEY}*.md`) and parse its items. If any are
   unresolved: `set-ticket-state {TICKET_KEY} --to ClaudeFailed`, append the list
   (`--heading "Review issues unresolved" --body-file <issues.md>`), display "Review has
   unresolved issues. Fix them and re-run `/ticket-work {TICKET_KEY}`.", and **stop**.
   Proceed only when every issue is resolved.

2. **Open the PR into `{FEATURE_BRANCH}`** via the **PR Push & Review** sub-procedure
   (`commands/_shared-stack-procedures.md`), running steps **P1, P2, P4, P5** — skip P3,
   since S4.4 already reviewed this same diff. Bindings:

   `WORK_DIR`=`WORK_DIR`, `BRANCH`=`BRANCH_NAME`, `BASE`=`FEATURE_BRANCH`,
   `JIRA_KEY`=`TICKET_KEY`, `STORAGE`=the Jira checklist (via `sync-checklist`),
   `MARK_READY`=true (opens ready for review), `REVIEW_TRANSITION`=true (P2 moves Jira
   to In Review; `ClaudeStackReady` stays put).

   Slot mapping: S4.8 ↔ P1, S4.9 ↔ P2, S4.10 ↔ P4. P5 (mark-ready) is inline here, not
   a checklist entry.

3. **Stop the per-ticket lifecycle** — do not fall through to S4.8, which is the
   standalone path targeting `main`. Display:

   ```
   Ticket {TICKET_KEY} - Feature Branch PR Open

   Branch: {BRANCH_NAME} → {FEATURE_BRANCH}
   PR: {PR_URL}

   All review issues resolved. PR is ready for human review and merge.
   After merge, `/cleanup` creates the merged/{TICKET_KEY} tag and
   `/promote-to-main` becomes available for the stack.
   ```

4. Proceed to S6 (promote downstream), then stop.

> **Legacy local merges**: tickets that ran the old local-merge flow need manual finishing — see `docs/design-notes.md`.

---

### Step S4.7: PR approval gate (retired)

**Always skip.** `seed-checklist` pre-marks slot 7 done with a ` (skipped: retired)`
suffix. Standalone tickets flow straight from S4.6a into S4.8; the draft PR state is
the checkpoint. Why the slot is retained: `docs/design-notes.md`.

---

### Steps S4.8–S4.10: PR Push & Review (shared sub-procedure)

**Skip if** `FEATURE_BRANCH` is non-null — those tickets terminated at S4.6b, which
already used slots 8–10. This is the **standalone** path: a draft PR against `main`
(`PR_TARGET`), entered straight from S4.6a with no approval gate.

An instance of the **PR Push & Review** sub-procedure
(`commands/_shared-stack-procedures.md`), running **P1, P2, P4** only:

`WORK_DIR`=`WORK_DIR`, `BRANCH`=`BRANCH_NAME`, `BASE`=`PR_TARGET`,
`JIRA_KEY`=`TICKET_KEY`, `STORAGE`=the Jira checklist (via `sync-checklist`),
`MARK_READY`=false (stays draft until a human marks it ready),
`REVIEW_TRANSITION`=true (P2 moves Jira to In Review; `ClaudeStackReady` stays put).

Slot mapping: S4.8 ↔ P1 (description), S4.9 ↔ P2 (push as draft), S4.10 ↔ P4 (review
summary). P3 and P5 are Mode-C-only — S4.4 already handled review for this diff. After
P4, mark steps 8–10 done (one `sync-checklist` call covers them).

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

**Skip S6 entirely if `SINGLE_MODE` is true.** When `/ticket-work` was entered with a container key, this invocation runs exactly one ticket. Display: "Single-ticket invocation complete. Re-run `/ticket-work {CONTAINER_KEY}` to pick up the next unblocked ticket." and **stop** before S6a.

### S6a: Find Eligible Downstream Tickets

Run `resolve-stack {TICKET_KEY} --repo-root {REPO_ROOT}` to refresh the stack state after this ticket completed.

From the `stack` array, find tickets that come after the current ticket and have `eligible == true`. These are the downstream tickets now unblocked.

Filter out:
- Tickets not assigned to the current user
- Tickets that already have any progress label (`ClaudePlanning`, `ClaudeExecuting`, `ClaudeStackReady`, `ClaudeFailed`)
- Tickets already out for review (an open PR, or a review-state Jira status per `isReviewStatus()`)

### S6b: Promote and Run Next Ticket

If exactly **one** eligible downstream ticket is found:

1. Add `ClaudeReady` if not already present, via `mcp__atlassian__editJiraIssue`
   with `update`: `{"labels": [{"add": "ClaudeReady"}]}`
2. Display: "Moving to next ticket in stack: {NEXT_KEY} - {NEXT_SUMMARY} (base: {TICKET_KEY})"
3. Run the **Single Ticket Lifecycle** (S1 onward) for `{NEXT_KEY}`, which uses the
   just-completed ticket's branch as its base

If **multiple** eligible downstream tickets are found:

1. Promote all of them (add `ClaudeReady`)
2. Read `commands/_container-flows.md` and run the **Multi-ticket runner** (Q3
   onward) from it with these tickets

If **no** eligible downstream tickets are found:

1. Check for stack completion (the `promote-downstream` + `ClaudeStackComplete`
   rollup described in `commands/_container-flows.md` Q7)
2. Display: "No more eligible tickets in this stack."

## Error Handling

- If any step fails, the Jira checklist preserves progress. Re-running the command will resume from the failed step (read from Jira).
- Worktree already exists: reuse it (don't recreate).
- Branch already exists: check it out in the worktree.
- PR already exists: push updates to it rather than creating a new one.
- Plan already exists in Jira: skip /plan-ticket (don't overwrite existing plan).
- On failure at step S4.2 (execution): Jira label is set to `ClaudeFailed`. User must investigate, fix, remove `ClaudeFailed` label, then re-run.
- In the multi-ticket runner: never stop the whole run for one ticket failure — record it and continue.
- If interrupted mid-stage (squash not yet applied): on resume, Claude detects uncommitted stage work (commits since the last stage marker) and continues the stage, then squashes when done. The STAGE_START_SHA is derived from git log per the Stage Squash Protocol.
