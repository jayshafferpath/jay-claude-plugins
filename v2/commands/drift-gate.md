---
description: "v2 — automated gate that replaces per-ticket human review. Runs tests, AC drift detection, and commit trailer integrity. Detect-only by default; with --fix-trailers, auto-amends manual story-branch commits with the active slice. With --sweep-feature, walks the feature branch since main to catch out-of-band manual commits before the Phase 2 checkpoint."
allowed-tools:
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Read
  - Write
  - Edit
---

# Drift Gate (v2)

The automated check that gates a story's merge into the feature branch. Replaces v1's per-ticket human review.

The gate's job is to **report**, not to fix. Repair belongs to whoever called it (story-worker, or a human running `/v2-rework`). The exceptions are `--fix-trailers` (story-branch manual commits during a story have a deterministic fix — use the active slice) and the auto-amend behavior in `--sweep-feature` (feature-branch manual commits during an in-progress story have the same deterministic fix).

## Arguments

`$ARGUMENTS` — required:
- `<STORY_KEY>` — the story to gate (per-story mode).
- `[--fix-trailers]` — auto-amend missing `Slice:` trailers on the story branch using the in-progress slice. Default: detect-only.
- `[--sweep-feature <EPIC_KEY>]` — feature-branch sweep mode (no story key required). Walks every commit on `<EPIC_KEY>` since `main`, looking for manual commits that bypassed story-worker. Auto-amends with the active slice if there's an in-progress story; halts otherwise. Invoked once from `/epic-work` Phase 2b before the human checkpoint.

The two modes are mutually exclusive. Per-story mode requires `<STORY_KEY>`; sweep mode requires `--sweep-feature <EPIC_KEY>`.

## Test Command Detection

This is the canonical detection rule. `run-e2e.md` and `address-feedback.md` reference this section rather than re-deriving it.

Detect the test command per-run from project files:

| Story type | Project signals | Command preference |
|---|---|---|
| **Behavior** (no `V2Verification` label) | `package.json` `scripts.test`, `Makefile` `test` target, `pyproject.toml` `[tool.pytest]` / `[tool.poetry.scripts]`, `Cargo.toml`, `justfile` `test` recipe | first match wins; ask once if multiple. |
| **Verification** (`V2Verification` label) | `package.json` `scripts.test:e2e` / `scripts.e2e` / `scripts.test:integration`, `playwright.config.*`, `cypress.config.*`, `Makefile` `e2e` / `test-e2e`, `justfile` `e2e` recipe | first match wins; ask once if multiple. |

**Resolution rules:**
- Exactly one match → use it. Record what was used in an `[claude-activity-log]` comment on the story so re-runs are reproducible.
- Multiple matches → ask the user once per session, remember the answer for the rest of the run.
- Zero matches → halt with `needs_human` (per-story mode) or surface "no command detected for story type X" (sweep mode).

In **sweep mode** there's no story to anchor type detection on; the sweep walks both behavior and verification commits and runs *whichever command(s) the in-progress story would use*. If no story is in progress (the sweep was triggered standalone), only trailer integrity is checked — tests are skipped.

Standalone debug invocation: `/drift-gate STORY-123` to see why a story is being rejected.

---

## Per-story mode (`<STORY_KEY>` provided)

### Checks

1. **Tests** — story-type-aware per the detection rule above. Pass = exit 0.

2. **AC drift** — gherkin acceptance criteria from the story vs. the implementation on the story branch. Reuses the **drift-analysis logic** from v1's `/fix-drift` (steps 3–4: branch diff + test files + AC categorization into Satisfied / Partial / Missing / Incorrect) without invoking the fix path. v1's `/fix-drift` does not expose a detect-only flag — drift-gate runs the same comparator inline rather than shelling out. For verification stories, also includes the epic-level scenarios cited in the story's `h2. Proves` section (which lists scenarios from the Epic's `h2. Verification Scenarios`). Pass = every AC is Satisfied.

3. **Trailer integrity** — every commit on the story branch since the feature branch must have:
   - A `Story:` trailer matching `<STORY_KEY>`
   - Exactly one `Slice:` trailer (multi-slice trailers rejected) referencing a real `V2Slice` ticket in the epic (live JQL re-check)
   - For verification stories, every `Slice:` trailer must reference `epic-verification`

4. **Slice-branch sync** — every story-branch commit's `Slice:` points to a slice branch that contains the corresponding cherry-picked copy (matched by author/date/subject after trailer strip). A missing copy means story-worker's per-commit fast-forward dropped a commit — halt; do not auto-replay.

### Outputs

- Exit 0 + structured summary on pass.
- Non-zero exit + structured failure report on any check failing.
- With `--fix-trailers`, each amendment is recorded as an `[claude-activity-log]` comment on the story.

### Failure modes

| Failure | Behavior |
|---|---|
| Test command cannot be detected | Halt. Ask user to disambiguate. |
| Tests fail | Halt. Return failure with truncated test output. |
| AC drift | Halt. List unsatisfied scenarios. |
| Missing `Slice:` trailer (story branch) | Halt unless `--fix-trailers` and an active slice exists. |
| `Slice:` references unknown ticket | Halt — slice graph / trailer disagreement. Human-resolved. |
| Verification commit references non-`epic-verification` slice | Halt. |
| Multi-slice trailer | Halt — story-worker should have split the commit. |
| Story-branch commit has no copy on its slice branch | Halt. Surface SHA + slice. |

---

## Sweep mode (`--sweep-feature <EPIC_KEY>`)

Triggered from `/epic-work` Phase 2b (between the story loop and the human checkpoint), and on demand for debugging. The sweep is the canonical answer to "did anything bypass story-worker?"

### What it walks

Every commit on the feature branch (`<EPIC_KEY>`) since the merge-base with `main`. For each commit:

1. **Trailer presence.** A feature-branch commit must have exactly one `Story:` and exactly one `Slice:` trailer.
2. **Trailer integrity.** Same checks as per-story mode (real `V2Slice` ticket, single-slice, verification commits route to `epic-verification`).
3. **Slice-branch sync.** A matching commit must exist on `slice/<EPIC_KEY>/<slice-name>` (matched by author/date/subject after trailer strip).

### Manual-commit auto-amend

If a commit lacks both trailers, it's a manual commit (someone bypassed story-worker — `git commit` directly on the feature branch).

- **In-progress story** (a story labeled `V2StoryExecuting` or `V2StoryNeedsReview` whose branch is currently checked out): the active slice for that story is the most recent slice referenced in the in-progress story's commits. If exactly one slice is in play, **auto-amend** the manual commit with `Story: <in-progress story>` and `Slice: <active slice>`, fast-forward to the slice branch, and record an `[claude-activity-log]` comment on the story.
- **No in-progress story, or ambiguous active slice**: halt. Surface SHA + author + subject and ask the user how to attribute it. Recovery: rebase the commit out, attribute it via a fresh story, or `/v2-prune` the change if it shouldn't ship.

### Outputs

- Exit 0 with `clean` summary.
- Exit non-zero with a per-commit table of issues if any check fails.
- Auto-amended commits are listed in the summary so the user sees what changed.

### When the sweep skips tests

If no story is in progress when the sweep runs, only trailer integrity and slice-branch sync are checked. Tests are skipped — the sweep is a structural integrity check, not a quality check, when run standalone. The story-level drift-gate covers test invariants per story.
