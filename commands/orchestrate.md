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
  - Bash(verify-merge *)
  - Bash(classify-actions *)
  - Read
  - Skill
---

# Orchestrate

Survey every active stack the user is working on, decide the next safe action per ticket, run the auto-safe ones in batch, and surface the rest as decisions for the user. This is the project-level coordinator that wraps `/prework`, `/ticket-work`, `/cleanup`, `/promote-to-main`, `/rework`, `/fix-drift`, and `/stack-rebase`.

The orchestrator is **status-first, action-second**. It always prints a full status view before it runs anything, so the user can redirect if the auto-decisions look wrong.

It handles two entry paths:

- **Lifecycle tickets** — tickets already carrying a `Claude*` label. Orchestrate advances them along the state machine (plan → execute → PR → promote → cleanup).
- **Cold tickets** — tickets assigned to the user that don't yet carry any `Claude*` label. Orchestrate surfaces them as kickoff candidates and, on approval, chains `/prework KEY` → `/ticket-work KEY` to enter the lifecycle.

## Arguments

`$ARGUMENTS`

Optional:
- `KEY` (positional) — narrow to a single ticket. Equivalent to `--scope KEY`. If the ticket carries no `Claude*` labels, it is treated as a cold-kickoff candidate.
- `--status` — read-only. Print the survey, do not run any actions. Useful for `/loop`-style polling.
- `--auto-all` — also auto-run the actions that normally prompt (`/rework`, `/fix-drift`, `/ticket-work`, cold `/prework` + `/ticket-work`). Use after a `--status` pass looks right.
- `--scope KEY` — narrow to one container or ticket key instead of project-wide. Resolves via `resolve-stack`.
- `--no-loop` — run a single survey-and-dispatch round instead of repeating until idle.

Parse `$ARGUMENTS` into:
- `STATUS_ONLY` (boolean) — true if `--status` is present.
- `AUTO_ALL` (boolean) — true if `--auto-all` is present.
- `SCOPE_KEY` (string|null) — value of `--scope` **or** the first positional (non-flag) token, uppercased and validated against `^[A-Z][A-Z0-9_]+-\d+$`. If both are provided and disagree, display "Conflicting scope: positional {K1} vs --scope {K2}." and **stop**.
- `LOOP` (boolean) — true unless `--no-loop` is present.

If `--status` and `--auto-all` are both present: display "Cannot combine --status (read-only) with --auto-all." and **stop**.

---

## Step 1: Initialize

### 1a: Atlassian Cloud + User

- `mcp__atlassian__getAccessibleAtlassianResources` → first `id` is `CLOUD_ID`.
- `mcp__atlassian__atlassianUserInfo` → `account_id` is `MY_ACCOUNT_ID`.

### 1b: Enumerate Container Keys and Cold Tickets

Initialize `CONTAINER_KEYS = []` and `COLD_TICKETS = []`. `COLD_TICKETS` holds `{ key, summary, status, issuetype }` for tickets that are assigned but not yet in the lifecycle (no `Claude*` labels).

**Scoped mode** — if `SCOPE_KEY` is set:

- Fetch the scoped ticket once via `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={SCOPE_KEY}`, fields `key, summary, status, labels, issuetype, parent, issuelinks, assignee`.
- If any label starts with `Claude`, treat as lifecycle: skip cold-ticket handling here — Step 2 will `resolve-stack` from `SCOPE_KEY`.
- Otherwise, treat as cold: append `{ key, summary, status, issuetype }` to `COLD_TICKETS`. Skip Step 2 entirely (there is no stack to resolve yet — `/prework` will resolve it).

**Project-wide mode** — if `SCOPE_KEY` is null, run two JQL searches:

1. **Lifecycle tickets** — `mcp__atlassian__searchJiraIssuesUsingJql` with:

   ```
   labels = "ClaudeWork" AND assignee = currentUser() AND statusCategory != Done
   ```

   Fields: `key, summary, status, labels, issuelinks, parent, issuetype`.

   For each issue, derive its container key:
   - Sub-task → `parent.key`.
   - Otherwise → first `issuelinks` entry pointing at an Epic, or `parent.key` if parent is an Epic.
   - Standalone (no container) → use the ticket's own key.

   Deduplicate into `CONTAINER_KEYS`.

2. **Cold tickets** — `mcp__atlassian__searchJiraIssuesUsingJql` with:

   ```
   assignee = currentUser() AND statusCategory != Done AND (labels is EMPTY OR NOT (labels in ("ClaudeWork", "ClaudeReady", "ClaudePlanning", "ClaudeExecuting", "ClaudeStackReady", "ClaudeFailed")))
   ```

   Fields: `key, summary, status, labels, issuetype`.

   Filter out anything whose `status` is in `{"In Review", "Code Review", "Done", "Cancelled"}` (defensive — statusCategory should already have excluded Done, but reviews aren't kickoff candidates). Append `{ key, summary, status, issuetype }` to `COLD_TICKETS`.

If both `CONTAINER_KEYS` and `COLD_TICKETS` are empty, display "No active stacks or cold tickets found." and **stop**.

---

## Step 2: Resolve Each Stack

Initialize `STACKS = []` (per-container snapshot).

If `SCOPE_KEY` was resolved to a cold ticket in Step 1b (no `Claude*` labels), skip stack resolution — `COLD_TICKETS` already has what Step 4/6 need. Proceed to Step 3.

Otherwise: for each container key (or just `SCOPE_KEY` if scoped to a lifecycle ticket), in alphabetical order, run the **Stack Context Resolution** sub-procedure (`commands/_shared-stack-procedures.md`) with `KEY={CONTAINER_KEY}` and `FETCH=true`. The orchestrator additionally captures `stack[*].status`, `stack[*].blockers`, `stack[*].mergedIntoFeature`, and `stack[*].mergedIntoMain` per ticket from the same JSON.

If `REPO_ROOT` is null: record the stack with an error marker (`error: "no repo root"`) and continue — we can still show its Jira state, but cannot do git-side work.

Append the parsed result to `STACKS`.

---

## Step 3: Classify Next Action Per Ticket

The decision table is implemented in `cli/lib/classify-actions.js` and exposed as the `classify-actions` CLI. Pass the resolved `STACKS` snapshot to it; it applies the 9-rule first-match table, surfaces stack-level flags (`needsStackRebase`, `blockedOnContainer`), and emits `pendingProbes` for any rule-1a candidate whose parent-feature-branch merge state is unknown.

> **Decision table reference**: The canonical rule list lives in `cli/lib/classify-actions.js` (`classifyTicket`). Briefly: rule 1 = `mergedIntoMain` → `cleanup-terminal`; rule 1a = Story-container merged into parent Epic feature branch, phase-1 not yet run → `cleanup-phase-1`; rule 1b = same shape but `phaseOneDone` → `promote-to-main` (phase-1 cleanup already ran, the main PR hasn't landed); rule 2 = `ClaudeStackReady` → `awaiting-review`; rule 3 = `ClaudeFailed` → `failed`; rule 4 = `ClaudeExecuting` / `ClaudePlanning` → `in-flight`; rule 5 = `ClaudeReady && eligible` → `ticket-work`; rule 6 = `ClaudeReady && !eligible` → `blocked-on-stack`; rule 7 = idle. Container-blocked overrides every rule.

### 3a: Probe rule-1a candidates

Whether phase-1 cleanup already ran for a ticket is recorded by the `merged/{KEY}` git tag that `/cleanup` Step 2d pushes. Read the whole set once per repo root:

```bash
git ls-remote origin 'refs/tags/merged/*'
```

A ticket whose key appears as `refs/tags/merged/{KEY}` has `phaseOneDone = true`; annotate it as such in the `STACKS` snapshot.

For each ticket whose `branch === container.featureBranch` AND `container.parentFeatureBranch` is non-null AND whose `phaseOneDone` is not true, probe the parent-feature-branch merge state:

```bash
verify-merge {branch} --base {parentFeatureBranch} --cwd {REPO_ROOT}
```

Build a JSON map `{ branch: { mergedToParentFeatureBranch: <bool> } }` from the results. Skip tickets that don't fit the prefilter — a `phaseOneDone` ticket is already past phase-1 and classifies as `promote-to-main` without a probe.

### 3b: Run classifier

Write the `STACKS` array (using the JSON shape `{ container: { key, featureBranch, parentFeatureBranch, unmergedBlockers }, tickets: [{ key, branch, labels, mergedIntoMain, mergedIntoFeature, eligible, blockers }] }`) to a temp file, and the probe map to a second temp file. Then:

```bash
classify-actions --stacks-file <tmp-stacks.json> --pr-state-file <tmp-pr-state.json> --repo-root {REPO_ROOT}
```

`--repo-root` lets the CLI resolve `phaseOneDone` itself from the `merged/{KEY}` tags on origin, so it stays correct even if Step 3a's annotation was skipped. Pass it whenever `REPO_ROOT` resolved; a ticket that already carries an explicit `phaseOneDone` in the stacks JSON is left as-is.

Parse stdout as JSON. The output has:
- `stacks` — per-stack array with `classifications` (ticket-level) and `stackFlags` (`needsStackRebase`, `blockedOnContainer`).
- `queues` — pre-bucketed by next-action category: `autoSafe`, `asks`, `manual`, `blocked`, `inFlight`, `idle`.
- `pendingProbes` — branches that need a probe re-run (should be empty after Step 3a).

If `pendingProbes` is non-empty, the CLI exits 3 — re-probe those branches and re-run the classifier. Don't proceed to Step 4 until the queues are settled.

### 3c: Failed-step recommendation

For each ticket in `queues.asks` whose `nextAction === "failed"`, also fetch the ticket's `[claude-activity-log]` comment (via `mcp__atlassian__getJiraIssue` and locate the comment) and pass its body through:

```bash
classify-actions --extract-failed-step --activity-log-file <tmp-log.md>
```

(Or use the `extractFailedStep` lib helper directly if invoking from another script.) Use the recommendation to bias the per-ticket prompt in Step 6:
- `S4.2` (TDD execute) → recommend `/rework`.
- `S4.3` (TDD verify) → recommend `/fix-drift`.
- `S4.6` (review issues / stack-ready) → recommend manual investigation.
- Unknown / log not found → present both options without a recommendation.

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
- `⏸ manual: awaiting review (PR open, needs human review/merge)` — user action.
- `… in-flight` — another agent is working on this.
- `⊘ blocked on {KEY}` — waiting on stack predecessor.
- `⊘ blocked on container {KEY}` — waiting on parent container merge.
- `· idle` — nothing to do.

If `COLD_TICKETS` is non-empty, print a separate section **after** all stacks:

```
Cold tickets (assigned, not yet in lifecycle):
  - {KEY}: {summary}    [{issuetype}, {status}] → ? ask: prework + ticket-work
  ...
```

After all stacks and cold tickets, print a project summary:

```
─────────────────────────────────────
Project survey: {N} stacks, {M} lifecycle tickets, {C} cold tickets

Auto-safe queue ({count}):
  - /cleanup KEY1
  - /promote-to-main KEY2

Awaiting your decision ({count}):
  - KEY3 — failed, /rework or /fix-drift?
  - KEY4 — cold, kick off with /prework + /ticket-work?

Awaiting your review ({count}):
  - KEY5 — stack ready, PR open and waiting on review

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
  - `cleanup-phase-1` and `cleanup-terminal` → use the Skill tool to run skill `cleanup` with args `{KEY} --yes --no-refresh-feature`. The `--yes` flag bypasses the interactive confirmation prompt that `/cleanup` issues at the end of its Step 3 — without it, the auto-safe batch would deadlock waiting on a "type confirm" prompt. The orchestrator already showed the queue in Step 4, so the user has seen the full set of cleanups before any of them run. The `--no-refresh-feature` flag is a temporary guardrail against the NEV-863 data-loss bug: Step 8's feature-branch refresh can silently drop squash merges when prior leaf tickets have been terminal-cleaned (branches deleted). Remove this flag once the feature-refresh.js close-fail + mergeSha-replay fixes ship and have soaked in production.
  - `promote-to-main` → use the Skill tool to run skill `promote-to-main` with args `{KEY}`.
- Capture stdout/stderr summary into `RUN_RESULTS[]`: `{ key, action, outcome: "success" | "failed" | "stopped", note }`.
- If a skill invocation halts with a refusal (e.g., `/cleanup` refuses because the merge SHA isn't reachable), record `outcome: "stopped"` with the refusal reason and continue to the next action — do not retry.
- If the skill errors mid-run (e.g., rebase conflict bailout in `/promote-to-main`), record `outcome: "failed"` with the failing step name and continue.

Do **not** re-survey between actions in the batch. We re-survey once at the end of the round in Step 7 (this matches the chosen execution-order semantics: batch then re-survey).

---

## Step 6: Ask About Risky Actions

This step covers three scopes:

- **Per-ticket prompts** — one prompt per ticket whose `next_action` is `"failed"`, `"ticket-work"`, or (for cold tickets) `"cold-kickoff"`. Each ticket gets its own prompt; the user answers each independently.
- **Per-stack prompts** — one prompt per stack whose `needs_stack_rebase = true`, regardless of how many tickets it contains. The stack-rebase action runs once on the leading ticket and cascades to the rest of the chain.

If `AUTO_ALL` is true, queue them as auto:
- per-ticket `failed` → run `/fix-drift {KEY}` first (less destructive); if it bails or labels stay `ClaudeFailed`, stop and surface for manual `/rework`.
- per-ticket `ticket-work` → run `/ticket-work {KEY}`.
- per-ticket `cold-kickoff` → run `/prework {KEY}`; if it succeeds, immediately run `/ticket-work {KEY}`. If `/prework` bails (blocker, drift, cancelled claim), record the outcome and skip `/ticket-work` for that ticket.
- per-stack `needs_stack_rebase` → run `/stack-rebase {leading-ticket-of-stack}` once for the whole stack.

Run each via the Skill tool (e.g., for `failed`, use the Skill tool to run skill `fix-drift` with args `{KEY}`; for `ticket-work`, run skill `ticket-work` with args `{KEY}`; for `cold-kickoff`, run skill `prework` with args `{KEY}` and then, on success, skill `ticket-work` with args `{KEY}`; for `needs_stack_rebase`, run skill `stack-rebase` with args `{leading-ticket-of-stack}`), append to `RUN_RESULTS`.

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

For each `cold-kickoff` candidate (from `COLD_TICKETS`), prompt:

```
{KEY}: {summary} — cold ticket ({issuetype}, {status})
  Kick off with /prework {KEY} then /ticket-work {KEY}? [y/N/skip]
```

On `y`: run skill `prework` with args `{KEY}`. If prework completes without bailing, run skill `ticket-work` with args `{KEY}`. Record both outcomes in `RUN_RESULTS` (a prework bailout skips `/ticket-work` and records `outcome: "stopped"` with the prework reason).

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

Awaiting your review:
  - KEY7 — stack ready, PR open and waiting on review

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
