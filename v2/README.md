# v2 — Epic-Driven Workflow (experiment)

Operates at the **epic** level. Point it at a Jira epic with a TDD link and it decomposes the TDD into a stack of stories, each shipping as its own PR to main, with a per-story human merge gate and an automated integration-test gate for verification stories.

v2 is a **thin wrapper** over v1 — it adds an epic-level planner and a pre-merge verification gate on top of v1 primitives (`ticket-work`, `promote-to-main`, `cleanup`, `rework`, `prune`). v1 commands are invoked unchanged. Both can coexist.

---

## Philosophy

v1 runs at the ticket level: a planner creates tickets, `ticket-work` ships each one. v2 hypothesis: **plan at the epic level so the story tree, dependencies, and verification scenarios come from one upstream document (a TDD), then let v1's per-ticket primitives handle execution.**

The unit of work and the unit of delivery are the same thing — a **story**. A story is one gherkin scenario from the TDD, sized like a v1 ticket, ships as one PR to main.

Two story types:

- **Behavior story** (default) — implements one gherkin scenario from the TDD. `ticket-work`'s drift-gate runs unit tests.
- **Verification story** (`V2Verification` label) — proves an epic-level scenario end-to-end. `/epic-work` runs the integration/e2e suite against the PR branch as an automated pre-merge gate, in addition to the normal `ticket-work` flow.

Stories form a stack via Jira blocker links. The stack drives v1's standard branching: each story branches off its blocker's branch (or `main` if it has no blocker). v1's `Epic-as-container` behavior treats `<EPIC_KEY>` as a local feature branch staging area; each story still ships as its own PR to main via `promote-to-main`.

The per-story human merge gate stays. v2 is *not* a gateless autonomous driver — it's an organizer with a pre-merge integration check.

---

## TDD precondition

Every epic must have a markdown TDD link in its description before `/epic-work` will run:

```
Repo path: docs/tdds/{slug}.md
```

The TDD file must exist locally and have `planner.initialized: true` in its YAML frontmatter (v2 inherits v1's init contract — run `@planner init {slug}` first if the TDD hasn't been initialized).

Confluence links, EARS blocks, and remote issue links are not accepted — the TDD must be a markdown file under `docs/tdds/`.

Without a TDD, the planner has no anchor for verification scenarios and `refresh-research` has nothing to drift against.

---

## Phases

```
/epic-work EPIC-123

  Phase 0 — RESOLVE       (TDD precondition, label-driven phase detect)
  Phase 1 — PLAN          → checkpoint
  Phase 2 — EXECUTE       → strictly sequential per-story loop
                            (ticket-work → verification gate if V2Verification
                             → human merges PR to main → /cleanup → next)
```

There is no Phase 3. The epic is shipped when its last story merges to main. No batch push, no slice finalization.

---

## Jira hierarchy

```
EPIC-123 ─┬─ STORY-456  (behavior story, gherkin from TDD)
          │  STORY-457
          │  STORY-459  (V2Verification — runs integration suite as gate)
```

Stories are direct children of the epic via Epic Link. There are no slices and no subtasks. Each story closes when its PR to main merges.

Stack ordering comes from Jira "is blocked by" links between stories, not from a separate manifest. v1's stacking rules apply: a story with multiple blockers picks the most recent (in topo order, ties broken by ticket creation order) as its physical git parent; the rest are documentation-only.

---

## Verification stories

Verification is **required** — every epic must have ≥1 `V2Verification` story. If the TDD doesn't supply a verification scenario (pure refactor, internal tooling), the planner asks the user to confirm a thin verification (e.g., the happy-path E2E) or rejects the epic for v2.

The planner writes the verification scenarios to the epic description as `h2. Verification Scenarios` so they're discoverable independently of any single story.

Each verification story carries:

- The `V2Verification` label (durable; never changes).
- An `h2. Proves` block listing which epic-level scenarios it proves.
- An `h2. Verification Command` block naming the integration command (e.g., `pnpm test:e2e`). Resolved by the planner at planning time so `/epic-work` doesn't re-detect per run.

A verification story depends on every behavior story whose code it exercises, so it becomes eligible only after those behavior stories are `Done`. Verification stories are terminal in the graph — they don't block anything.

### Verification gate

After `ticket-work` returns `ClaudeNeedsReview` for a verification story, `/epic-work` runs the integration command against the PR branch in a temporary worktree:

- **Pass** → comment on the PR ✅, append-activity, fall through to the human merge gate.
- **Fail** → comment on the PR ❌ with truncated output, apply `V2StoryFailed` and `ClaudeFailed`, halt the loop. User runs `/rework` (retry) or `/prune` (abandon).

The gate runs *before* the human merge gate, not in place of it.

---

## State authority

v2 is **stateless on disk.** Everything is either persisted in Jira or detected fresh on each invocation.

| State | Where it lives |
|---|---|
| Story tree (which stories, deps) | Jira: stories + "blocks" / "is blocked by" links |
| Story execution state | v1's `Claude*` labels (`ClaudeReady`, `ClaudeNeedsReview`, etc.) |
| Verification command | Jira: each verification story's `h2. Verification Command` block |
| Per-epic / per-story narrative | v1's `append-activity` against the relevant ticket |
| Implementation Notes | Jira story description (written by `ticket-work`'s S2 at execution time) |
| Epic phase | Jira: `V2Epic*` labels on the epic |

There is no `plan.md`, no `.epic/` directory, no manifest file. The plan lives in Jira.

---

## Resumability

Each phase reads Jira labels and current git state to determine where to pick up. Re-running mid-epic continues from the last completed step. The Phase 2 loop in particular relies on this: after each story PR merges, the user re-runs `/epic-work`, which sweeps the merged story (runs `/cleanup`), discovers the next unblocked story, and continues.

---

## Files

**Reused from v1 unchanged:** `ticket-work`, `promote-to-main`, `cleanup`, `rework`, `prune`, `pr-description`, `finalize`, `stack-rebase`, `refresh-research`, `fix-drift`. v2 does not modify v1 primitives.

**New in v2:**
- `agents/v2-planner.md` — fork of v1 `planner`. Decomposes a TDD into a fully-fleshed story tree under an existing epic. No skeletons, no subtasks. Required to produce ≥1 verification story. Resolves the verification command at planning time.
- `commands/epic-work.md` — top-level driver. Phase 0 (TDD precondition) → Phase 1 (invoke `v2-planner`) → Phase 2 (sequential per-story loop with verification gate).

---

## Jira label namespace

Scoped to the entity they describe.

**Epic (owned by v2):** `V2EpicPlanning`, `V2EpicPlanApproved`, `V2EpicExecuting`, `V2EpicReady`

**Story (owned by v1):** `ClaudeReady`, `ClaudePlanning`, `ClaudePlanApproved`, `ClaudeExecuting`, `ClaudeStackReady`, `ClaudeNeedsReview`, `ClaudeFailed`, etc.

**Story (owned by v2):**
- `V2Verification` — durable; identifies a verification story. Set by `v2-planner` at ticket creation.
- `V2StoryFailed` — transient; applied by the verification gate on integration-test failure. Cleared by `/rework`.

---

## What this command does *not* do

- **Does not modify v1 primitives.** All branching/merging/stacking changes belong in the v1 commands.
- **Does not stage commits to a long-lived feature branch for batch delivery.** Stories ship straight to main via `ticket-work` + `promote-to-main`. The `<EPIC_KEY>` branch v1 creates is a local staging area, not a release branch.
- **Does not parallelize stories.** Strictly sequential. The verification gate and human merge gate serialize the loop anyway.
- **Does not auto-merge.** Human merges every PR.

---

## Stale files

The following files in `agents/` and `commands/` describe an earlier slice-based design that has since been simplified out:

- `agents/story-worker.md`
- `commands/drift-gate.md`
- `commands/epic-finalize.md`
- `commands/address-feedback.md`
- `commands/address-story-feedback.md`
- `commands/v2-cleanup.md`
- `commands/v2-rework.md`
- `commands/v2-prune.md`
- `commands/run-e2e.md`

They reference slices, slice branches (`slice/<EPIC>/<name>`), `Slice:`/`Story:` git trailers, and a Phase 3 `epic-finalize`. **None of this exists in the current design** — `epic-work.md` and `v2-planner.md` are canonical and explicitly drop slices ("Slices were eliminated in simpler v2 — every story is its own PR to main").

These files should be deleted or rewritten. Until then, the only entry points that actually run are `/epic-work` and `@v2-planner`.
