# jay-claude-plugins

Claude Code tooling for Jira ticket automation, stacked PR management, and end-to-end TDD → Jira → PR → merge workflows.

Three surfaces, one lifecycle:

1. **Agents** (`@planner`, `@tdd-builder`, `@refactor`) — long-lived, domain-specific subagents Claude Code dispatches when you `@` them.
2. **Slash commands** (`/ticket-work`, `/prework`, `/orchestrate`, …) — deterministic pipelines executed inside a Claude Code session.
3. **CLI tools** (`ticket-status`, `resolve-stack`, `sync-plan`, …) — Node scripts in `~/.local/bin/` that agents/commands call to touch Jira and git without going through an MCP round-trip.

Jira is the source of truth for stack structure, ticket state, and lifecycle labels. Git only knows about branches — never about parent/child relationships.

## Install

```bash
./install.sh
```

Does five things:

1. Symlinks `commands/*.md` → `~/.claude/commands/` and `agents/*.md` → `~/.claude/agents/`.
2. Creates `.env` from `.env.example` (project-level Jira creds) if missing.
3. Creates `~/.claude/.env` (machine-level, holds `DEV_ROOT`) if missing.
4. Runs `npm install` in `cli/`.
5. Generates a wrapper for each `cli/package.json` `bin` entry in `~/.local/bin/`. Wrappers embed an absolute node path so they survive `asdf reshim` and work in repos with a different `.tool-versions`.

Put `~/.local/bin` **ahead of** `~/.asdf/shims` on `PATH`. After install, fill in credentials:

- `.env` — `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_DOMAIN`
- `~/.claude/.env` — `DEV_ROOT` (parent directory of your repo clones), optional `SLACK_WEBHOOK_URL`

Tickets are routed to a repo via a `repo:<name>` label, resolved to `$DEV_ROOT/<name>`.

## Prerequisites

- [Claude Code](https://claude.ai/code)
- [Atlassian MCP server](https://mcp.atlassian.com) (`mcp__atlassian__*` tools)
- GitHub CLI (`gh`) authenticated
- Node 20+ (see `.tool-versions`)

## Module layout

```
agents/         @planner, @tdd-builder, @refactor
commands/       slash commands (/ticket-work, /prework, /orchestrate, ...)
cli/
  bin/          Node CLI entry points (symlinked into ~/.local/bin/)
  lib/          shared libraries: jira, git, labels, stack-resolver, ...
  tests/        vitest suite
dashboard/      Vite browser dashboard for viewing stack state
docs/           architecture diagrams
install.sh      symlink commands/agents, install CLIs
```


## Core concepts

### Stack architecture

Jira is the source of truth. A **stack** is a Story/Task/Epic (the "container") plus its children, topologically sorted by "is blocked by" links.

Every container gets a **feature branch** named after its Jira key (or `branch:<name>` label). Its children are stacked as git branches — each based on the previous — and PR into the shared feature branch. When Epic B is blocked by Epic A, B's feature branch bases on A's branch until A merges. Standalone tickets (no container) skip the feature branch and PR direct to `main`.

### Label state machine

Progress labels flow one-at-a-time via `set-ticket-state`, which clears the previous progress label:

```
ClaudeWork                 durable: Claude owns this ticket
ClaudeReady                eligible for planning
ClaudePlanning             /plan-ticket in progress
ClaudeExecuting            TDD execution in progress
ClaudeStackReady           review done; PR open, awaiting human review
ClaudeStackComplete        container-level rollup; triggers Mode C
ClaudeFailed               failure side-channel
```

To enqueue a ticket: tag it `ClaudeWork` + `ClaudeReady`. To finish it: run `/cleanup KEY` after merge to main.

The set is deliberately small. A state earns a label only when another *process* must see it — a peer agent (`ClaudePlanning`/`ClaudeExecuting` are distributed locks across parallel `/ticket-work` agents), a JQL query that has to find the ticket before anything can probe it, or a human handing work in (`ClaudeReady`). Everything else is read from the system that already records it:

| State | Read from |
| --- | --- |
| Out for review | An open PR (`getOpenPrMap`), or Jira status "In Review"/"Code Review"/"Review". `resolve-stack` surfaces `entry.inReview` and `entry.openPr`; `transition-jira {KEY} --event review` moves the status on PR push. |
| PR approved | GitHub review state on the PR itself. There is no approval label — every PR opens as a draft, and a human marking it ready and approving it is the gate. |
| Merged | `git merge-base` / merged-PR lists (`mergedIntoFeature`, `mergedIntoMain`). |
| Phase-1 cleanup ran | The `merged/{KEY}` git tag from `/cleanup` Step 2d. |
| Implementation Notes current | `drift-check` diffs the research baseline SHA against HEAD — idempotent, so no marker is needed. |
| Designs captured | The `h3. Designs` block in Implementation Notes plus `.designs/{KEY}/*.png`. |
| Abandoned | Jira status Cancelled, set by `/prune`. |
| Step progress | The per-ticket checklist (`.claude/plans/ticket-work-{KEY}.md`, mirrored to a Jira comment). |

### TDDs and research

`@planner` decomposes a TDD at `docs/tdds/{slug}.md` into Jira Epics/Stories/Subtasks. The TDD is the source of truth; tickets deep-link to it.

A TDD declares repos each capability touches via a `**Repos**:` line under each H2. Research runs per (capability, repo) against locally-cached clones, producing SHA-pinned permalinks stored in **Implementation Notes** on each ticket.

**Drift detection**: Implementation Notes carry a baseline SHA. `/ticket-work` at S3.5 diffs cited line ranges from `baseline_sha..HEAD`. If anything moved, notes are refreshed and a Jira comment posts old vs new — recommending `/rework` if the plan was already approved against stale notes. Manual trigger: `/refresh-research KEY`.

**Lazy decomposition**: the planner stops at the first unblocked unit. Within the first Epic, only parallel-startable Stories get full Gherkin + subtasks + Implementation Notes; everything else is a skeleton, fleshed out later via `@planner STORY-KEY` when its blockers close.

## Agents

Invoke with `@name <args-or-prompt>` in a Claude Code session.

### `@tdd-builder`

Conversational TDD drafter. Ingests a Jira PRD (plus linked Confluence pages) into repo-local reference files, researches the named repos via the planner clone cache, and drafts a planner-ready TDD at `docs/tdds/{slug}.md`. Proposes capabilities grounded in existing repo patterns rather than pattern-matching on the ticket. Stops at "draft ready" — you run `@planner init {slug}` next.

**Typical trigger**: you have a PRD in Jira and want a repo-aware technical design without hand-writing one.

### `@planner`

Decomposes a repo-based TDD into Gherkin-based Jira Epics/Stories/Subtasks with dependency-ordered blocker links. Populates the local clone cache, runs research per (capability, repo), writes sidecars at `docs/tdds/{slug}/{repo}.research.md`, and stamps the TDD frontmatter. Supports owner/consumer split: canonical TDD lives in one repo; other repos init via a pointer file with `mode: consumer`, `owner:`, `sha:` frontmatter and plan their own slice independently.

**Entry points**:
- `@planner init {path-or-slug}` — owner init (in owning repo). Relocates TDD to `docs/tdds/`, validates shape, runs research, writes sidecars, stamps frontmatter.
- `@planner init {owner-slug}:{tdd-slug}` — consumer init. Fetches owner TDD at pinned SHA, validates repo is in scope, runs research for this repo, writes a pointer file.
- `@planner {slug-or-key}` — decompose. Refuses if the local TDD isn't initialized. Given a Jira key, fleshes that skeleton.

### `@refactor`

Analyzes code for CRAP score, DRY violations, and refactoring opportunities. Scans repos or targeted files, presents prioritized findings, and — with approval — implements the accepted refactorings. Read-and-edit only; no Jira/git side effects.

**Typical trigger**: mid-`/ticket-work` at S4.4 (called by the pipeline), or manually against a file you're unhappy with.

## Slash commands

Every command lives at `ai/commands/{name}.md`; symlinked to `~/.claude/commands/{name}.md` by `install.sh`. Frontmatter declares the exact tool surface (Atlassian MCP calls, `Bash(...)` allowlist, etc.); reading a command's `.md` is the fastest way to see what it will touch.

### Lifecycle: plan → execute → review → ship

#### `/prework KEY`

Pre-`/ticket-work` setup: resolves the stack via `resolve-stack`, ensures the feature branch + working directory exist (`ensure-work-dir`), seeds the checklist from the plan (`seed-checklist`), runs a drift check, and captures Figma design context if the ticket has a Figma link. Stops before planning.

Use when you want to inspect a ticket's landing zone before turning `/ticket-work` loose on it.

#### `/plan-ticket KEY`

Lightweight plan generator. Reads AC + Implementation Notes from Jira, writes a short markdown checklist to a tmp file, syncs it into the ticket's managed plan comment via `sync-plan`, and cleans up. No EARS expansion, no Explore subagent — the heavy research lives upstream in `@planner`.

State lives in Jira as a comment, not in `.plans/`.

#### `/ticket-work [KEY...]`

The main engine. Idempotent — reads checklist state from Jira and resumes wherever it left off.

- **Single mode** (`/ticket-work KEY`): runs one ticket through drift-check → plan → execute (TDD Red-Green-Refactor per plan task) → verify AC → refactor (`@refactor`) → review (`/jay-pr-review`) → stack-ready.
- **Queue mode** (`/ticket-work`): discovers eligible tickets via JQL (`discover-queue`), gates on stack deps, and launches parallel agents.
- **Parent expansion**: a Story/Task with subtasks expands to its eligible subtasks; labels and assignee are inherited via `buildParentInheritancePatch`.

**Complexity tiers**: two independent gates control which steps run.
- **Gate 1** (pre-execute, S3.4): sets `complexity:trivial`. Skips `/plan-ticket` and runs execute in no-plan mode (single-batch test authoring).
- **Gate 2** (post-execute, S4.3.5): decided from actual diff size. Skips `@refactor` and `/jay-pr-review`. In-memory only; no Jira label.

**Stack behavior**: containered tickets merge locally into their feature branch after review passes. Standalone tickets run straight through `ClaudeStackReady` and open a draft PR against `main`; the draft state is the checkpoint, so nothing merges until a human marks it ready and approves it.

**Mode C**: when a container's last child ships (`ClaudeStackComplete`), the feature branch is pushed as a single PR — to `main`, or to the parent Epic's branch for nested Stories — reusing the same PR push & review sub-procedure with a final draft → ready flip.

CI green and Copilot comments are **not** automatic — run `/cop-fight` on demand after the PR opens.

#### `/jay-pr-review [BASE]`

Generates a PR review plan at `.plans/pr-review-<branch>.md`. Fans out specialist agents in parallel (via the `Agent` tool) and aggregates their findings into a single checklist file. `/ticket-work` calls this at S4.5; you can also run it manually against any branch.

Base defaults: `$ARGUMENTS` → `git config branch.<BRANCH>.base` → `gh pr view --json baseRefName` → `main`.

#### `/finalize`

Final pre-merge pass. Updates the PR description to reflect the actual shipped state, then posts a finalization comment with context downstream stacked-ticket agents can use (touched files, gotchas, follow-ups). Writes to Jira's activity log via `append-activity`.

### Post-merge: cleanup

#### `/cleanup KEY` (auto-dispatching)

Detects the merge target and runs the right phase:
- Terminal (PR merged to `main`) → `/cleanup-main`
- Phase-1 (Story-container PR merged into parent Epic's feature branch) → `/cleanup-feature`

Flags: `--no-rebase`, `--no-refresh-feature` to skip the cascade / refresh steps.

#### `/cleanup-main KEY`

Explicit terminal cleanup. Verifies the PR merged to `main` and the merge commit is reachable from `origin/main`. Deletes local + remote branch, transitions Jira → Done (or applies terminal labels if no Done transition exists), appends "Shipped" / "Stack complete" activity entries, cascade-rebases any unmerged downstream tickets (`cascade-rebase`), and refreshes the long-lived feature branch by resetting to `origin/main` and re-merging still-unmerged ticket branches with `--no-ff`.

Refuses if merge target was an Epic feature branch (wrong phase).

#### `/cleanup-feature KEY`

Explicit phase-1 cleanup. PR merged into a parent Epic's feature branch. Tags the merge commit as `merged/{KEY}` — load-bearing for `/promote-to-main`, and the durable record that phase-1 ran — retains the Story branch on disk + remote (must survive for `/promote-to-main`), leaves Jira in its current status and progress label, cascade-rebases siblings, refreshes the Epic feature branch.

Refuses if merge target was `main`.

#### `/promote-to-main KEY`

Promotes a stacked ticket to main. Walks the stack in dep order and, for each ticket, runs `git rebase --onto origin/main {prev} {curr}` to strip ancestor commits, opens a PR to main, and waits for merge before advancing.

Accepts a ticket key, container key, or feature branch name.

### Recovery / manual intervention

#### `/rebase-on-main`

Rebase current branch onto `origin/main` and `--force-with-lease` push. Aborts cleanly on conflict.

#### `/stack-rebase KEY`

Cascade-rebase a full stacked PR chain after its base moved. Wraps `cascade-rebase`, updates PR base refs via `gh pr edit`.

#### `/refresh-research KEY`

Manually re-run the per-ticket drift check. Diffs cited line ranges against the baseline SHA and updates Implementation Notes if anything moved. Fires when a blocker branch merges and pinned SHAs become unreachable.

#### `/fix-drift KEY`

Detects drift between Jira AC and the current implementation, then fixes the code to match the ticket. Resumes the ticket-work lifecycle after fixing.

#### `/rework KEY`

Resets the ticket's branch to its base, clears all progress labels and checklist, restarts the lifecycle from scratch. Use when the current implementation is unsalvageable and starting over is faster than fixing.

#### `/prune KEY`

Abandons a ticket. Reverts its merge from the feature branch, closes the PR, transitions the Jira ticket to Cancelled.

### Observability

#### `/ticket-status KEY`

Shows the full lifecycle state of a ticket: stack, branch, PR, Jira labels, checklist state, blocks/blocked-by. Thin wrapper around the `ticket-status` CLI's verbose mode.

#### `/orchestrate [KEY]`

Project-level coordinator across all active stacks. Surveys state, auto-runs safe lifecycle steps (cleanup merged tickets, promote PR-approved tickets), and surfaces decisions that need a human (failed tickets, drift, plan/PR approvals, cold-ticket kickoffs).

Two entry paths:
- **Lifecycle tickets** (`Claude*` labels) → advance along the state machine.
- **Cold tickets** (assigned, no `Claude*` labels) → offer to chain `/prework KEY` + `/ticket-work KEY` to enter the lifecycle. Pass `KEY` as a positional argument to scope to one ticket (equivalent to `--scope KEY`).

Uses `classify-actions` to bucket tickets into safe-to-auto-run vs needs-human.

#### `/triage-tickets`

One triage pass over every active stack, built for unattended polling. Two halves:

- **Promotion** — delegates to `/orchestrate --no-loop`, which owns the label/merge decision table.
- **Stagnation** — the time dimension `/orchestrate` lacks. `classify-actions` reads labels and merge state only, so a ticket whose agent died in `ClaudeExecuting` nine days ago looks identical to one that entered the state a minute ago.

Three stagnation rules, from the `detect-stagnation` CLI:

| Rule | Fires when | Nudge |
|---|---|---|
| `abandoned-in-flight` | `ClaudePlanning`/`ClaudeExecuting` with no activity-log append, branch commit, or Jira update for `--in-flight-hours` (default 12) | Clears the stale label back to `ClaudeReady` and logs why, so the queue can pick it up again |
| `unattended-failure` | `ClaudeFailed` untouched for `--failed-days` (default 3) | Escalated in the digest — never auto-fixed, since `/fix-drift` and `/rework` both mutate the branch |
| `rotting-pr` | Open PR untouched for `--pr-days` (default 5), or its base moved `--behind-commits` ahead (default 25) | Runs `/stack-rebase` when the base moved; reports only when it just needs a reviewer |

Single-pass by design — wrap it in `/loop` for polling:

```
/loop 15m /triage-tickets
```

Start with `/triage-tickets --status` to see the digest without acting. `--no-promote` / `--no-nudge` narrow it to one half.

#### `/pr-chat KEY`

Loads full PR context (Jira ticket + linked TDD + PR metadata + diff + full contents of every changed file) into the conversation, then hands control back to you for free-form discussion. Useful for pre-review self-check, drafting PR copy, or reasoning about review comments.

### Auxiliary

#### `/ears-requirements [topic]`

Interactive EARS (Easy Approach to Requirements Syntax) drafter. Guides you through the five patterns (ubiquitous, event-driven, unwanted-behavior, state-driven, optional-feature) to produce unambiguous requirements.

#### `/cop-fight`

Post-PR-push helper. Drives CI to green, then evaluates each Copilot review comment on viability and value before deciding whether to implement or dismiss with an explanation. Replaces blind auto-fix loops.

## CLI tools

`ticket-status` is the only user-facing CLI; the rest are called by commands and agents. All are installed as wrappers in `~/.local/bin/` and read Jira credentials from `.env` / `~/.claude/.env`.

| Script | Purpose |
|---|---|
| `ticket-status` | View and manage Claude ticket stacks in Jira. Verbose mode powers `/ticket-status`. |
| `discover-queue` | Run the queue-discovery JQL queries; expand parents into subtasks; optionally apply inheritance. Called by `/ticket-work` in queue mode. |
| `resolve-stack` | Resolve stack ordering from Jira issue links. Returns container + ordered members + base branch. |
| `ensure-work-dir` | Resolve a ticket's working directory (`$DEV_ROOT/<repo>`) and ensure its branch exists (creating it based on `resolve-stack` output if needed). |
| `ensure-pr` | Create or update a draft PR for the current branch. Idempotent. |
| `pr-state` | Normalized `gh pr list` probe. Used by `/orchestrate` and cleanup. |
| `seed-checklist` | Initialize a ticket's checklist from its plan; pre-marks skipped steps per complexity tier. |
| `sync-checklist` | Sync checklist state between Jira and local files. |
| `sync-plan` | Sync plan content (as a managed Jira comment) between Jira and local files. |
| `set-ticket-state` | Move a ticket to a progress label (clearing the previous progress label) or add/remove arbitrary labels. Also moves Jira workflow status when the label→status map applies. |
| `append-activity` | Append a timestamped entry to the ticket's `[claude-activity-log]` managed comment. |
| `drift-check` | Diff cited line ranges against the baseline SHA; emit a drift report. Called by `/ticket-work` S3.5 and `/refresh-research`. |
| `cascade-rebase` | Cascade-rebase a chain of stacked branches after their base moved. |
| `promote-downstream` | Mark unblocked downstream dependents `ClaudeReady`; report stack completion. |
| `stage-squash` | Squash commits into a single `[{KEY}] {label}` commit and force-with-lease push. |
| `verify-merge` | Verify a PR merged and the merge commit is reachable from the expected target. |
| `classify-actions` | Bucket tickets into safe-to-auto-run vs needs-human for `/orchestrate`. |
| `detect-stagnation` | Add the time dimension `classify-actions` lacks: flag abandoned in-flight agents, unattended failures, and rotting PRs. Exits 2 when it finds something. Used by `/triage-tickets`. |
| `post-review-summary` | Post a PR review summary as a Jira comment. |
| `cleanup-feature-refresh` | Refresh an Epic feature branch by resetting to base + re-merging unmerged ticket branches. |

Run any CLI directly for its options: `ticket-status --help`, `resolve-stack --help`, etc.

## Real workflows

### 1. Greenfield: PRD → shipped feature

Starting from a PRD in Jira:

```
1. @tdd-builder PROJ-123
     ↳ drafts docs/tdds/{slug}.md grounded in repo patterns

2. @planner init {slug}
     ↳ runs research per repo, writes sidecars, stamps frontmatter

3. @planner {slug}
     ↳ decomposes into Epic → Stories → Subtasks with Gherkin AC
       and Implementation Notes (SHA-pinned research citations).
       Lazy: only unblocked units get fleshed out.

4. Tag first Story ClaudeWork + ClaudeReady.

5. /ticket-work
     ↳ queue mode. Discovers eligible tickets, expands the Story into
       its subtasks (label + assignee inheritance), runs each one through
       drift-check → plan → execute → refactor → review → merge-to-feature-branch.
       Container's feature branch accumulates each subtask.

6. Last subtask done → ClaudeStackComplete on the container → Mode C
   opens a single PR for the whole feature branch.

7. Merge that PR into the parent Epic branch.

8. /cleanup KEY (or the phase auto-detects and runs /cleanup-feature)
     ↳ tags merged/{KEY} (marks phase-1 done), retains the Story
       branch, cascade-rebases sibling Stories.

9. /promote-to-main KEY
     ↳ rebases Story onto main, opens main-targeting PR, waits.

10. PR merges to main → /cleanup KEY (auto-runs /cleanup-main)
      ↳ deletes branch, transitions Jira → Done, refreshes Epic branch.

11. @planner {epic-key}   (fleshes next unblocked Story skeleton)
    → back to step 4.
```

### 2. Standalone bug ticket (no stack)

```
1. Tag ticket ClaudeWork + ClaudeReady in Jira.

2. /ticket-work KEY
     ↳ no container, so no feature branch. Runs the same pipeline and
       ends at ClaudeStackReady with a draft PR open against main.

3. Review the diff locally / in GitHub.
4. Mark the PR ready for review on GitHub when it looks right.

5. /cop-fight
     ↳ waits for CI, judges Copilot comments, dismisses noise, fixes real issues.

6. Merge in GitHub.
7. /cleanup KEY.
```

### 3. Mid-stack drift: blocker merged while a Story was in flight

```
State: STORY-B is executing. Its blocker STORY-A just merged. The pinned
SHAs in STORY-B's Implementation Notes are now unreachable from HEAD.

1. /ticket-work KEY resumes → S3.5 drift-check fires automatically
     ↳ diffs cited ranges baseline_sha..HEAD, detects moves.
     ↳ refreshes Implementation Notes; posts old-vs-new Jira comment.
     ↳ recommends /rework if the plan was already approved against stale notes.

2a. Small drift: /ticket-work continues from the updated notes.
2b. Big drift: /rework KEY → resets branch, clears labels, restarts.

Manual variant: /refresh-research KEY (same drift check without re-running
the pipeline).

Manual variant: /fix-drift KEY (AC drift, not research drift — fixes code
to match the ticket's Gherkin).
```

### 4. Rescue a broken stacked PR chain

```
State: PR-A (base of stack) got a fixup commit and was rebased.
PR-B and PR-C now point at the old PR-A tip.

1. /stack-rebase KEY   (KEY = any ticket in the chain)
     ↳ resolve-stack → cascade-rebase walks the chain in dep order.
     ↳ each branch rebased onto its parent's new tip.
     ↳ force-with-lease pushed.
     ↳ gh pr edit rewrites base refs for retargeted PRs.
```

### 5. Abandoning work mid-flight

```
STORY-B was merged into the Epic feature branch, but the product decision
changed — we're not shipping it.

1. /prune STORY-B
     ↳ reverts the merge commit from the feature branch.
     ↳ closes the PR.
     ↳ transitions the Jira ticket to Cancelled.
     ↳ cascade-rebases downstream siblings past the revert.
```

### 6. Multi-repo TDD (owner/consumer split)

```
Backend repo owns the TDD:
  cd $DEV_ROOT/backend
  @tdd-builder PROJ-500
  @planner init auth-migration
  # docs/tdds/auth-migration.md now canonical here

Frontend consumes it:
  cd $DEV_ROOT/frontend
  @planner init backend:auth-migration
    ↳ fetches owner TDD at pinned SHA
    ↳ validates this repo is in scope (repo listed under some capability)
    ↳ runs research for frontend's affected code
    ↳ writes docs/tdds/auth-migration.md as a pointer file
      with mode: consumer, owner: backend, sha: <pinned>

Now both repos can @planner {slug} → decompose their slice → generate
their own Epic tree in the same Jira project, with cross-repo blocker
links honored during promotion.
```

### 7. Nightly operator loop

```
Morning:
  /orchestrate
    ↳ auto-runs safe steps:
       - /cleanup for tickets whose PR merged overnight
       - /promote-to-main for containers whose phase-1 cleanup already ran
       - promote-downstream for freshly-unblocked dependents
    ↳ surfaces needs-human list:
       - ClaudeFailed tickets (investigate)
       - drift-detected tickets (review Jira comment, decide /rework?)
       - stack-ready tickets (review the open PR, mark ready + approve?)

Address the list, then:
  /ticket-work         (queue mode picks up freshly-Ready work)
```

Unattended variant — polls instead of waiting for you to run it:

```
/loop 15m /triage-tickets
  ↳ each pass:
     - delegates promotion to /orchestrate --no-loop
     - detects stagnation the label table can't see:
        · agents that died mid-run (label cleared, work re-queued)
        · ClaudeFailed tickets nobody has addressed in days
        · open PRs gone quiet, or whose base has moved far ahead
     - prints one digest; stays quiet when everything is healthy
```

## Dashboard

Local browser dashboard for viewing stack state.

```bash
cd dashboard
npm install
npm run dev
```

Opens at `http://localhost:5173`. Reads Jira via the same credentials as the CLI.

## Development

```bash
cd cli
npm install
npm test           # vitest
npm run lint       # biome check .
npm run lint:fix   # biome check --write .
```

CI enforces 90% branch coverage.

Command and agent bodies (`ai/commands/*.md`, `ai/agents/*.md`) are plain markdown with YAML frontmatter — edits take effect on next Claude Code session invocation via the symlinks.

## Configuration reference

| Variable | Location | Required | Description |
|---|---|---|---|
| `JIRA_EMAIL` | `.env` | Yes | Atlassian account email |
| `JIRA_API_TOKEN` | `.env` | Yes | API token (id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_DOMAIN` | `.env` | Yes | e.g. `your-org.atlassian.net` |
| `DEV_ROOT` | `~/.claude/.env` | Yes | Parent directory containing all repo clones |
| `SLACK_WEBHOOK_URL` | `~/.claude/.env` | No | Webhook for notifications |

Env files are loaded without overriding existing env vars: project `.env` first, then `~/.claude/.env`.

Tickets need a `repo:<name>` label that maps to `$DEV_ROOT/<name>`.
