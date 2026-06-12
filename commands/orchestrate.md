---
description: "Orchestrate the active ticket-stack workflows: survey state across all active stacks, auto-run safe lifecycle steps (cleanup merged tickets, promote PR-approved tickets), and surface decisions that need a human (failed tickets, drift, plan/PR approvals)."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__atlassianUserInfo
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__getJiraIssue
  - Bash(git *)
  - Bash(cd *)
  - Bash(gh *)
  - Bash(resolve-stack *)
  - Bash(ticket-status *)
  - Read
  - Skill
---

# Orchestrate

Survey every active stack the user is working on, decide the next safe action per ticket, run the auto-safe ones in batch, and surface the rest as decisions for the user. This is the project-level coordinator that wraps `/cleanup`, `/promote-to-main`, `/ticket-work`, `/rework`, `/fix-drift`, and `/stack-rebase`.

The orchestrator is **status-first, action-second**. It always prints a full status view before it runs anything, so the user can redirect if the auto-decisions look wrong.

## Arguments

`$ARGUMENTS`

Optional:
- `--status` — read-only. Print the survey, do not run any actions. Useful for `/loop`-style polling.
- `--auto-all` — also auto-run the actions that normally prompt (`/rework`, `/fix-drift`). Use after a `--status` pass looks right.
- `--scope KEY` — narrow to one container or ticket key instead of project-wide. Resolves via `resolve-stack`.
- `--no-loop` — run a single survey-and-dispatch round instead of repeating until idle.

Parse `$ARGUMENTS` into:
- `STATUS_ONLY` (boolean) — true if `--status` is present.
- `AUTO_ALL` (boolean) — true if `--auto-all` is present.
- `SCOPE_KEY` (string|null) — value of `--scope`, uppercased and validated against `^[A-Z][A-Z0-9_]+-\d+$`.
- `LOOP` (boolean) — true unless `--no-loop` is present.

If `--status` and `--auto-all` are both present: display "Cannot combine --status (read-only) with --auto-all." and **stop**.

---

## Step 1: Initialize

### 1a: Atlassian Cloud + User

- `mcp__atlassian__getAccessibleAtlassianResources` → first `id` is `CLOUD_ID`.
- `mcp__atlassian__atlassianUserInfo` → `account_id` is `MY_ACCOUNT_ID`.

### 1b: Enumerate Container Keys

If `SCOPE_KEY` is set, skip this step — Step 2 will resolve directly from the scope key.

Otherwise, enumerate every container that has at least one in-flight ticket assigned to the user. This step only collects keys; the per-stack `resolve-stack --fetch` runs in Step 2.

`mcp__atlassian__searchJiraIssuesUsingJql` with:

```
labels = "ClaudeWork" AND assignee = currentUser() AND statusCategory != Done
```

Fields: `key, summary, status, labels, issuelinks, parent, issuetype`.

For each issue, derive its container key:
- Sub-task → `parent.key`.
- Otherwise → first `issuelinks` entry pointing at an Epic, or `parent.key` if parent is an Epic.
- Standalone (no container) → use the ticket's own key.

Deduplicate to a list of unique `CONTAINER_KEYS`. If empty, display "No active stacks found." and **stop**.

---

## Step 2: Resolve Each Stack

Initialize `STACKS = []` (per-container snapshot).

For each container key (or just `SCOPE_KEY` if scoped), in alphabetical order, run the **Stack Context Resolution** sub-procedure (defined in `commands/ticket-work.md`) with `KEY={CONTAINER_KEY}` and `FETCH=true`. The orchestrator additionally captures `stack[*].status`, `stack[*].blockers`, `stack[*].mergedIntoFeature`, and `stack[*].mergedIntoMain` per ticket from the same JSON.

If `REPO_ROOT` is null: record the stack with an error marker (`error: "no repo root"`) and continue — we can still show its Jira state, but cannot do git-side work.

Append the parsed result to `STACKS`.

---

## Step 3: Classify Next Action Per Ticket

For each `ticket` in each stack, derive `next_action`. The label state machine is the source of truth; cross-check with git state where it changes the answer.

Compute helpers (only meaningful when `repoRoot` and `branch` exist):
- `pr_state` — run `pr-state {branch} --base main --cwd {REPO_ROOT}` (only when needed in branches below).
- `pr_to_feature_state` — same but `--base {featureBranch}` if there's a feature branch.

Decision table, in order — first match wins:

1. **`mergedIntoMain === true` AND branch still exists locally OR remote** → `next_action = "cleanup-terminal"`, **auto-safe**.
   *Why safe: `/cleanup` re-verifies the merge SHA is reachable from `origin/main` before doing anything destructive. If the ticket carries `ClaudePendingMainPromotion`, this is the deferred terminal cleanup that completes the two-phase Story-container flow.*

1a. **`branch === featureBranch` AND `parentFeatureBranch` is non-null AND a merged PR `--base {parentFeatureBranch}` exists AND `mergedIntoMain === false` AND `labels` does NOT include `ClaudePendingMainPromotion`** → `next_action = "cleanup-phase-1"`, **auto-safe**.
   *Why safe: cleanup will detect `MERGE_TARGET = parentFeatureBranch`, set `DEFER_DESTRUCTIVE = true`, retain the branch, leave Jira In Progress, apply `ClaudePendingMainPromotion`, and run sibling cascade-rebase + Epic-feature-branch refresh. The Story branch stays alive for `/promote-to-main`. The label gates re-entry — once it's applied, this rule no longer matches and the ticket waits for promotion or for terminal cleanup (rule 1).*

2. **`labels` includes `ClaudePRApproved` AND no open PR to main exists** → `next_action = "promote-to-main"`, **auto-safe**.
   *Why safe: rebase aborts on conflict; force-push uses `--force-with-lease`.*

3. **`labels` includes `ClaudeStackReady` AND open PR to main exists** → `next_action = "awaiting-pr-approval"`, **manual** (user adds `ClaudePRApproved`).

4. **`labels` includes `ClaudeStackReady` AND no PR to main yet** → `next_action = "awaiting-pr-approval"`, **manual**.

5. **`labels` includes `ClaudeFailed`** → `next_action = "failed"`, **ask**. Read the most recent entry from the ticket's `[claude-activity-log]` Jira comment (search for the heading naming a `ticket-work` step like `S4.2`, `S4.3`, `S4.7`) and capture the failing step into `failed_step`. Use it to bias the prompt:
   - Failure at S4.2 (TDD execute) → recommend `/rework` (implementation went off the rails).
   - Failure at S4.3 (TDD verify) → recommend `/fix-drift` (code drifted from acceptance criteria).
   - Failure at S4.7 (review issues) → recommend manual investigation; neither auto-action is appropriate.
   - Failure step unknown / log not found → present both options without a recommendation.

6. **`labels` includes `ClaudeExecuting` OR `ClaudePlanning`** → `next_action = "in-flight"`, **none** — another run is in progress, do nothing.

7. **`labels` includes `ClaudeReady` AND `eligible === true`** → `next_action = "ticket-work"`, **ask** (long-running, mutates code).

8. **`labels` includes `ClaudeReady` AND `eligible === false`** → `next_action = "blocked-on-stack"`, **none** — waiting on an upstream blocker.

9. Otherwise → `next_action = "idle"`, **none**.

Also detect **stale-stacked** branches at the stack level: if any ticket has `mergedIntoFeature === false` AND its blocker has `mergedIntoFeature === true`, the stack may need a `/stack-rebase`. Mark the stack with `needs_stack_rebase = true`. (This is informational — `/cleanup` covers the post-merge cascade automatically; standalone `/stack-rebase` is for the rare manual case.)

Detect **container-blocked**: if `container.unmergedBlockers` is non-empty, mark the stack with `blocked_on_container = unmergedBlockers` and force every ticket in the stack to `next_action = "blocked-on-container"`. The whole stack waits.

---

## Step 4: Render Status View

Print one section per stack, in order. Use a tree layout that mirrors `ticket-status`:

```
{CONTAINER_KEY}: {summary}
  ⎇  {featureBranch or "(no feature branch)"}
  Repo: {repoRoot or "(unresolved)"}
  {if blocked_on_container: "BLOCKED on " + comma-separated unmergedBlockers}

  ├── {KEY1}: {summary}    [{label state}] → {next_action}
  ├── {KEY2}: {summary}    [{label state}] → {next_action}
  └── {KEY3}: {summary}    [{label state}] → {next_action}
```

Annotate each ticket's `→ {next_action}` line with one of:
- `✓ auto: cleanup-terminal` — safe, will run (PR merged to main; full teardown).
- `✓ auto: cleanup-phase-1` — safe, will run (Story-container PR merged into parent Epic feature branch; branch retained for /promote-to-main, sibling rebase + Epic-feature-branch refresh only).
- `✓ auto: promote-to-main` — safe, will run.
- `? ask: rework or fix-drift` — failed, will prompt.
- `? ask: ticket-work` — ready, will prompt (long-running).
- `⏸ manual: awaiting PR approval (add ClaudePRApproved)` — user action.
- `… in-flight` — another agent is working on this.
- `⊘ blocked on {KEY}` — waiting on stack predecessor.
- `⊘ blocked on container {KEY}` — waiting on parent container merge.
- `· idle` — nothing to do.

After all stacks, print a project summary:

```
─────────────────────────────────────
Project survey: {N} stacks, {M} tickets

Auto-safe queue ({count}):
  - /cleanup KEY1
  - /promote-to-main KEY2

Awaiting your decision ({count}):
  - KEY3 — failed, /rework or /fix-drift?

Awaiting your approval ({count}):
  - KEY5 — stack ready, label ClaudePRApproved

Blocked / in-flight ({count}):
  - KEY6 — blocked on KEY7
  - KEY8 — in-flight (ClaudeExecuting)
```

If `STATUS_ONLY` is true: **stop** here.

---

## Step 5: Run Auto-Safe Actions (Batched)

If the auto-safe queue is empty, skip to Step 6.

The user has already seen the queue in Step 4. Display:

```
Running {N} auto-safe actions (sequential, re-survey at end of round):
  - /cleanup KEY1
  - /promote-to-main KEY2
  ...
```

Then run them in order. For each entry:

- Use the **Skill** tool to invoke the matching skill with the ticket key as args:
  - `cleanup-phase-1` and `cleanup-terminal` → use the Skill tool to run skill `cleanup` with args `{KEY} --yes`. The `--yes` flag bypasses the interactive confirmation prompt that `/cleanup` issues at the end of its Step 3 — without it, the auto-safe batch would deadlock waiting on a "type confirm" prompt. The orchestrator already showed the queue in Step 4, so the user has seen the full set of cleanups before any of them run.
  - `promote-to-main` → use the Skill tool to run skill `promote-to-main` with args `{KEY}`.
- Capture stdout/stderr summary into `RUN_RESULTS[]`: `{ key, action, outcome: "success" | "failed" | "stopped", note }`.
- If a skill invocation halts with a refusal (e.g., `/cleanup` refuses because the merge SHA isn't reachable), record `outcome: "stopped"` with the refusal reason and continue to the next action — do not retry.
- If the skill errors mid-run (e.g., rebase conflict bailout in `/promote-to-main`), record `outcome: "failed"` with the failing step name and continue.

Do **not** re-survey between actions in the batch. We re-survey once at the end of the round in Step 7 (this matches the chosen execution-order semantics: batch then re-survey).

---

## Step 6: Ask About Risky Actions

This step covers two scopes:

- **Per-ticket prompts** — one prompt per ticket whose `next_action` is `"failed"` or `"ticket-work"`. Each ticket gets its own prompt; the user answers each independently.
- **Per-stack prompts** — one prompt per stack whose `needs_stack_rebase = true`, regardless of how many tickets it contains. The stack-rebase action runs once on the leading ticket and cascades to the rest of the chain.

If `AUTO_ALL` is true, queue them as auto:
- per-ticket `failed` → run `/fix-drift {KEY}` first (less destructive); if it bails or labels stay `ClaudeFailed`, stop and surface for manual `/rework`.
- per-ticket `ticket-work` → run `/ticket-work {KEY}`.
- per-stack `needs_stack_rebase` → run `/stack-rebase {leading-ticket-of-stack}` once for the whole stack.

Run each via the Skill tool (e.g., for `failed`, use the Skill tool to run skill `fix-drift` with args `{KEY}`; for `ticket-work`, run skill `ticket-work` with args `{KEY}`; for `needs_stack_rebase`, run skill `stack-rebase` with args `{leading-ticket-of-stack}`), append to `RUN_RESULTS`.

Otherwise (default), ask the user **per ticket**, not in a single mega-prompt:

For each `failed` ticket:

```
{KEY}: {summary}
  Branch: {branch}
  Last labels: {claude-prefixed labels}
  Failed at: {failed_step or "unknown"}
  Recommendation: {recommendation derived from failed_step, or "(none)"}

What should I do?
  [1] /fix-drift {KEY}   — adjust code to match AC, less destructive
  [2] /rework {KEY}      — reset branch and restart from scratch (destructive)
  [3] skip               — leave as-is, surface again next /orchestrate
```

Mark the recommended option with `(recommended)` in the prompt rendering when a recommendation is set.

For each `ticket-work` candidate:

```
{KEY}: {summary} — ready to start
  Run /ticket-work {KEY}? [y/N/skip]
```

For each stack with `needs_stack_rebase = true`, prompt **once** (not per-ticket):

```
{CONTAINER_KEY}: {summary} — stale stacked branches
  Tickets needing rebase: {KEY-A}, {KEY-B}, ...
  Run /stack-rebase {leading-key}? [y/N/skip]
```

Run the chosen action via the Skill tool (e.g., for option `[1]`, run skill `fix-drift` with args `{KEY}`; for `[2]`, run skill `rework` with args `{KEY}`), append to `RUN_RESULTS`. A skip records `outcome: "skipped-by-user"`.

---

## Step 7: Re-Survey and Loop

If `RUN_RESULTS` is empty (no actions ran this round) **or** `LOOP` is false: skip to Step 8.

Otherwise, re-run Steps 2–6 (a fresh round). Stop looping when a round produces zero new auto-safe actions and zero new ask-actions the user accepts. Track total round count and accumulated `RUN_RESULTS` across rounds.

Hard cap at 5 rounds to prevent runaway loops; if hit, display "Loop cap reached — re-run /orchestrate to continue." and stop.

---

## Step 8: Final Summary

Print a single consolidated report:

```
Orchestrate — Complete ({N} round(s))

Actions run:
  ✓ /cleanup KEY1 — branch deleted, Jira → Done
  ✓ /promote-to-main KEY2 — PR opened: {URL}
  ✓ /fix-drift KEY3 — drift resolved, ClaudeFailed cleared
  ✗ /promote-to-main KEY4 — rebase conflict in path/file.ts (manual fixup needed)
  ⏸ /rework KEY5 — skipped by user

Awaiting your approval:
  - KEY7 — stack ready, label ClaudePRApproved

Blocked / in-flight:
  - KEY8 — blocked on KEY9
  - KEY10 — in-flight (ClaudeExecuting)

Errors:
  - KEY11 — repo root unresolved (missing repo: label)
```

If any action failed, suggest re-running `/orchestrate` after manual fixup. Do not retry automatically.

---

## Error Handling

- Cannot reach Jira: surface the error and stop — orchestration depends on Jira state.
- `resolve-stack` errors on a single container: record the error in that stack's entry, continue with other stacks.
- A skill invocation halts mid-batch: record the outcome, continue with the next action. Do not bail the whole orchestrator unless the failure is at the orchestrator level (Jira down, etc.).
- Never auto-resolve merge conflicts at the orchestrator level — the underlying skills (`/promote-to-main`, `/cleanup`) own that logic and refuse cleanly when they can't.
- Never run `/rework` without explicit user opt-in (it's destructive — resets the branch and clears progress).
- The orchestrator only runs `Skill`-dispatched actions. It never edits code, force-pushes, or transitions Jira directly — those side effects belong to the dispatched skills, where the existing safety checks live.
