---
description: "v2 — drive an epic from a TDD to a drip-fed stack of PRs to main. Phase 0: validate TDD precondition. Phase 1: invoke v2-planner. Phase 2: loop {ticket-work each unblocked story → if V2Verification, run integration gate before merge → human merges story PR to main → /cleanup → next}. No feature-branch staging, no slices, no batch push."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(gh *)
  - Bash(ls *)
  - Bash(cd *)
  - Bash(append-activity *)
  - Read
  - Write
  - Edit
  - Skill
  - Agent
  - AskUserQuestion
---

# Epic Work (v2)

Drive a Jira Epic to a drip-fed stack of PRs to main. v2 is a thin wrapper over v1: it adds a planner that decomposes a TDD into stories with blocker links, and a pre-merge integration gate for verification stories. Everything else is delegated to v1 primitives — `ticket-work`, `promote-to-main`, `cleanup`, `prune`, `rework`.

See `../README.md` for concepts and `agents/v2-planner.md` for decomposition rules.

## Arguments

`$ARGUMENTS` — required: a Jira Epic key (e.g. `ABC-123`).

## Resumability

Each phase reads Jira labels and current git state to determine where to pick up. Re-running mid-Epic continues from the last completed step.

---

## Phase 0 — Resolve

1. Resolve `CLOUD_ID` via `mcp__atlassian__getAccessibleAtlassianResources`.
2. Fetch the Epic via `mcp__atlassian__getJiraIssue`. Verify it's an Epic issue type. Refuse otherwise.
3. **Validate the TDD precondition.** Walk the Epic's description for a `Repo path:` line in the form:
   ```
   Repo path: docs/tdds/{slug}.md
   ```
   (Same convention v1 planner injects when it creates Epics. Bare `docs/tdds/{slug}.md` references inside Jira-format links also count.)

   - If no `docs/tdds/` reference, halt with:
     ```
     EPIC-<KEY> has no TDD reference in its description.

     v2 requires every epic to point at a markdown TDD at docs/tdds/{slug}.md.
     Add the reference (or run `@planner` if the TDD exists but hasn't been linked)
     and re-run /epic-work.
     ```
   - If the reference resolves but the file is not present in any working directory, halt with:
     ```
     TDD referenced by EPIC-<KEY> ({path}) was not found locally.

     Make sure the working directory containing the TDD is loaded, or re-run
     `@planner init {slug}` if the TDD has not been initialized yet.
     ```
   - Read the file's YAML frontmatter. If `planner.initialized: true` is missing or `planner.repos:` is empty/malformed, halt with:
     ```
     TDD at {path} is not initialized.

     v2 inherits v1's init contract — run `@planner init {slug}` first, then
     re-run /epic-work.
     ```

   Confluence links, EARS blocks, and remote issue links are not accepted — the TDD must be a markdown file under `docs/tdds/`.

4. Determine current phase from labels:
   - No `V2Epic*` labels → Phase 1.
   - `V2EpicPlanApproved` → Phase 2.
   - `V2EpicReady` → done.

---

## Phase 1 — Plan

Apply `V2EpicPlanning` to the Epic.

Invoke the **v2-planner** agent (`v2/agents/v2-planner.md`) with:
- `EPIC_KEY` — the Epic from `$ARGUMENTS`.
- `TDD_PATH` — the `docs/tdds/{slug}.md` path resolved in Phase 0.
- `TDD_REPO` — the working directory the TDD lives in.

v2-planner produces:
- **Behavior stories** — one per non-verification gherkin scenario from the TDD. No Implementation Notes (`ticket-work`'s S2 writes those at execution time).
- **Verification stories** — labeled `V2Verification`. Each cites which epic-level scenarios it proves. Description includes a `h2. Verification Command` block naming the integration command this Epic uses.
- **Blocker links** — Jira "is blocked by" between stories. These drive v1's stacking: each story branches off its blocker's branch.
- **Epic description** — `h2. Verification Scenarios`, `h2. Verification Command`, and `h2. Story Tree` sections are written/updated.

**No `V2Slice` tickets are created.** Slices were eliminated in simpler v2 — every story is its own PR to main.

When v2-planner returns:
1. Read the resulting story tree from Jira (children of the Epic).
2. Render a **Plan Summary**: Epic title + TDD link, behavior stories grouped by stack position, verification stories with what they prove and the integration command, suggested execution order.
3. **Checkpoint** — `AskUserQuestion`: approve / revise / abort.
4. On **approve** → set `V2EpicPlanApproved`, clear `V2EpicPlanning`, fall through to Phase 2.
5. On **revise** → re-invoke v2-planner with feedback. Plan revisions happen as Jira mutations.
6. On **abort** → run `/prune` against each child story, then halt.

**Verification stories are required.** If v2-planner's first attempt produces none (pure refactor, internal tooling), it asks the user to confirm a thin verification story or reject the Epic for v2.

---

## Phase 2 — Execute

Apply `V2EpicExecuting` to the Epic.

This phase runs a **strictly sequential** loop. Each iteration handles one story end-to-end: drive it through `ticket-work`, push its PR to main, run the verification gate if applicable, wait for human merge, run `/cleanup`. Then pick the next.

### 2a — Pre-sweep merged stories

Before discovering work, sweep for stories already merged to main since the last invocation:

```
JQL: parent = {EPIC_KEY} AND labels = "ClaudeNeedsReview"
```

For each, check if its PR to main is merged. If yes:
1. Run `/cleanup {STORY_KEY}` (handles branch deletion, Jira transition, cascade-rebase of downstream stories).

`/cleanup` is a v1 skill; it already handles all of this without v2-specific logic.

### 2b — Discover next unblocked story

```
JQL: parent = {EPIC_KEY}
     AND labels NOT IN ("ClaudeNeedsReview", "ClaudeFailed")
     AND status != Done
```

Filter to stories whose Jira "is blocked by" links are all `Done` (or have `ClaudeNeedsReview` with their PR merged — sweep step 2a should normally catch these first).

Order: behavior stories first; verification stories become eligible only when every behavior they depend on is Done. The blocker-link filter handles this automatically.

If nothing is eligible:
- All stories Done? Set `V2EpicReady`, clear `V2EpicExecuting`, comment "Epic complete — all stories merged to main." on the Epic, exit.
- Some stories blocked but their blockers are awaiting human merge? Halt and surface "Waiting on PR review for {STORY_KEY}: {PR_URL}." Resume by re-running `/epic-work`.
- Otherwise (deadlock): halt with the unblocked-but-not-eligible set surfaced for inspection.

### 2c — Run the story

For the chosen story:

1. **Apply `ClaudeReady`** if not present. (Inherited from `ClaudeWork` ownership.)
2. **Invoke `ticket-work`** as a Skill, passing the story key as the argument.

   `ticket-work` handles: research (S2), planning, implementation, drift-gate, code review. It branches the story off its blocker's branch (or `main` if no blocker — same stacking rules as v1). It pushes the PR.

   Wait for `ticket-work` to return.

3. **Inspect the result.**
   - If the story is now `ClaudeNeedsReview` → PR is open, awaiting human merge. Continue to step 2d (verification gate).
   - If `ClaudeFailed` → halt the loop. Surface "Story {KEY} failed during ticket-work — run `/rework {KEY}` or `/prune {KEY}`." Resume after the user fixes things by re-running `/epic-work`.
   - If `ticket-work` halted asking for human input (e.g., conflict, ambiguity) → halt the loop, surface the question. Resume by re-running.

### 2d — Verification gate (verification stories only)

Skip this step if the story does **not** have the `V2Verification` label.

For verification stories, after `ticket-work` returns with `ClaudeNeedsReview`:

1. **Read the verification command** from the story's description (the `h2. Verification Command` block injected by v2-planner). If absent, halt — the planner should have injected it; treat as a planning bug.
2. **Resolve repo root and PR branch** from the story's metadata (the `repo:` label or the parent Epic's `repo:` label) and from `ticket-work`'s output (the PR URL → `gh pr view {PR_URL} --json headRefName`).
3. **Check out the PR branch** in a temporary worktree to avoid disturbing the user's primary working tree:
   ```bash
   cd {REPO_ROOT}
   git fetch origin {PR_BRANCH}
   git worktree add /tmp/v2-verify-{STORY_KEY} origin/{PR_BRANCH}
   cd /tmp/v2-verify-{STORY_KEY}
   ```
4. **Run the verification command.** Capture stdout, stderr, exit code.
5. **Tear down the worktree:**
   ```bash
   cd {REPO_ROOT}
   git worktree remove /tmp/v2-verify-{STORY_KEY} --force
   ```
6. **Act on the result.**
   - **Pass:** comment on the PR via `gh pr comment {PR_URL} --body "Verification suite passed ✅\n\nCommand: \`{VERIFICATION_COMMAND}\`\nDuration: {seconds}s"`. Append-activity on the story: "Verification gate passed." Continue.
   - **Fail:**
     - Comment on the PR: `gh pr comment {PR_URL} --body "Verification suite failed ❌\n\nCommand: \`{VERIFICATION_COMMAND}\`\nExit: {code}\n\n<details><summary>Output</summary>\n\n\`\`\`\n{last 200 lines}\n\`\`\`\n</details>"`.
     - Apply `V2StoryFailed` and `ClaudeFailed` to the story (preserving `V2Verification`).
     - Append-activity: "Verification gate failed — see PR comment."
     - Halt the loop. Surface: "Verification gate failed for {STORY_KEY}. Inspect {PR_URL}, then run `/rework {STORY_KEY}` (retry) or `/prune {STORY_KEY}` (abandon)."

### 2e — Wait for human merge

`ticket-work` already pushed the PR with `ClaudeNeedsReview`. Surface:

```
Story {STORY_KEY} ready for review:
  PR: {PR_URL}
{ if V2Verification: "  Verification gate: ✅ passed" }

Merge the PR to advance the Epic. Re-run `/epic-work {EPIC_KEY}` to continue.
```

Halt the loop. **The user merges the PR; re-running `/epic-work` resumes via Phase 2a's pre-sweep.**

### 2f — Loop

When the user re-runs:
- Phase 2a sweeps the merged story (runs `/cleanup`, transitions Done, cascade-rebases downstream).
- Phase 2b finds the next unblocked story.
- Repeat until all stories are Done.

When all stories are Done, Phase 2 exits with `V2EpicReady`.

---

## Phase 3 — None

There is no Phase 3. The Epic is shipped when its last story merges. No batch push, no slice finalization.

---

## Failure handling

| Failure | Handling |
|---|---|
| Phase 0 TDD missing/uninitialized | Halt with explicit remediation message. |
| `v2-planner` errors | Halt; user inspects and re-runs. Plan state lives in Jira; partial progress isn't lost. |
| `ticket-work` returns `ClaudeFailed` | Halt; surface; user runs `/rework` or `/prune`. |
| Verification gate fails | Halt; PR commented; story labeled `V2StoryFailed`; user runs `/rework` or `/prune`. |
| Verification command not present in story | Halt; treat as planner bug; user re-runs Phase 1 with revisions. |
| Stack rebase conflict during `/cleanup` | `/cleanup` itself surfaces and halts; user resolves manually, then re-runs `/epic-work`. |
| Deadlock (eligible stories but all blocked) | Halt with eligible/blocked sets printed for inspection. |

## What this command does *not* do

- **Does not modify v1 primitives.** `ticket-work`, `cleanup`, `promote-to-main`, `rework`, `prune` are invoked unchanged. Any branching changes there land in the v1 commands, not here.
- **Does not stage commits to a feature branch.** Stories ship straight to main via `ticket-work`'s standard PR flow. (When v1 `ticket-work` detects an Epic parent it normally treats it as a feature-branch container — see "Epic-as-container behavior" below for how v2 sidesteps that.)
- **Does not parallelize stories.** Strictly sequential. v1 supports parallel queue mode; v2 does not opt into it because the verification gate and human merge gates serialize the loop anyway.
- **Does not do anything per-PR-merge automatically.** Human merge, then re-run.

---

## Epic-as-container behavior

v1 `ticket-work` detects when a ticket has an Epic parent and treats the Epic as a **stack container with a local feature branch named `{EPIC_KEY}`**. It merges the story locally into that feature branch after review and waits for `promote-to-main` to peel each story off and PR it.

This is exactly the drip-feed flow we want, with one subtlety: the user (or `/epic-work`) must run `/promote-to-main` after each story's local merge to actually open the PR to main. Two possible shapes:

**Shape A — let v1 do it (recommended).** After `ticket-work` merges the story locally into `{EPIC_KEY}`, `/epic-work` invokes `/promote-to-main {STORY_KEY}` to open the PR to main and labels `ClaudeNeedsReview`. Verification gate then runs against that PR.

**Shape B — bypass v1's container detection.** Pass a flag to `ticket-work` saying "treat as standalone" so it stacks the story branch off `main` directly and pushes the PR without any local feature-branch intermediate. This requires modifying `ticket-work`.

**Use Shape A.** It keeps v1 untouched. The `/epic-work` loop becomes:

```
for each unblocked story:
  Skill: ticket-work {STORY_KEY}            # research → execute → review → local merge to EPIC branch
  Skill: promote-to-main {STORY_KEY}        # rebase off main, open PR, label ClaudeNeedsReview
  if V2Verification: run verification gate (Phase 2d)
  halt; wait for human merge
  on resume: pre-sweep runs /cleanup
```

The Epic feature branch in Shape A exists only as a local staging area — every commit lands on main via the per-story PR. This is functionally identical to v1's default Epic-stack flow; v2 just adds the planner up front and the verification gate in the middle.

---

## State and labels

**Epic labels** owned by v2:
- `V2EpicPlanning` (Phase 1 in flight)
- `V2EpicPlanApproved` (Phase 1 done, ready for Phase 2)
- `V2EpicExecuting` (Phase 2 in flight)
- `V2EpicReady` (all stories merged)

**Story labels** owned by v1 (`Claude*` set, see `commands/ticket-work.md`):
- `ClaudeReady`, `ClaudePlanning`, `ClaudePlanApproved`, `ClaudeExecuting`, `ClaudeStackReady`, `ClaudeNeedsReview`, `ClaudeFailed`, etc.

**Story labels** owned by v2:
- `V2Verification` — durable; identifies a verification story.
- `V2StoryFailed` — applied when the verification gate fails (independent of `ClaudeFailed`, which `ticket-work` may also apply for unrelated reasons).

`V2Verification` is set by v2-planner at ticket creation; it never changes. `V2StoryFailed` is set by `/epic-work`'s verification gate.

State authority:
- **Story stack ordering and branch graph** → Jira blocker links + v1 `resolve-stack` (used by `ticket-work` and `promote-to-main`).
- **Story execution state** → `Claude*` labels (owned by v1).
- **Verification state** → `V2Verification` (durable) + `V2StoryFailed` (transient, cleared on `/rework`).
- **Epic phase** → `V2Epic*` labels (owned by this command).
