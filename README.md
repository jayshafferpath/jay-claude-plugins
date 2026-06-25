# jay-claude-plugins

Claude Code commands for Jira ticket automation, PR workflows, and stacked PR management.

## Commands

| Command | Description |
|---|---|
| `/ticket-work [KEY...]` | Run tickets end-to-end: drift-check, plan, execute, PR, review, push. With args: single ticket (or expand a Story to subtasks). Without args: process the queue. |
| `/prework KEY` | Pre-`/ticket-work` setup: resolve stack, ensure branch + working directory, seed checklist, run drift check. Stops before planning. |
| `/orchestrate` | Survey active stacks; auto-run safe lifecycle steps; surface decisions that need a human. |
| `/ticket-status KEY` | Show a ticket's lifecycle state: stack, branch, PR, labels, checklist, blockers. |
| `/pr-chat KEY` | Load full PR context (ticket + TDD + diff + every changed file) for free-form discussion. |
| `/refresh-research KEY` | Re-run the drift check and refresh Implementation Notes. |
| `/fix-drift KEY` | Detect drift between AC and the branch implementation, then fix the code. |
| `/finalize` | Pre-merge pass: update PR description, post finalization context for downstream agents. |
| `/promote-to-main` | Promote stacked tickets to main one at a time. |
| `/stack-rebase KEY` | Rebase a stacked PR chain after its base moved. |
| `/rebase-on-main [--cascade]` | Rebase the current branch onto `origin/main` and force-push. `--cascade` chains into `/stack-rebase`. |
| `/prune KEY` | Revert the ticket's merge, close the PR, cancel the Jira ticket. |
| `/rework KEY` | Reset the branch to its base and restart the lifecycle from scratch. |
| `/cleanup KEY` | Auto-dispatching post-merge teardown. Detects the merge target and runs phase-1 or terminal cleanup. Flags: `--no-rebase`, `--no-refresh-feature`. |
| `/cleanup-main KEY` | Explicit terminal cleanup: PR merged to `main` → delete branch, Jira → Done, cascade-rebase, refresh feature branch. Refuses if the merge target was an Epic feature branch. |
| `/cleanup-feature KEY` | Explicit phase-1 cleanup: PR merged into the parent Epic's feature branch → retain branch + Jira state for `/promote-to-main`, cascade-rebase siblings, refresh Epic branch. Refuses if the merge target was `main`. |
| `/ears-requirements [topic]` | Ideate and write EARS requirements interactively. |
| `/cop-fight` | Drive CI to green and judge each Copilot review comment on viability — implement the sound ones, dismiss the rest with an explanatory reply. Replaces blind auto-fix loops. |

### `/ticket-work` lifecycle

Idempotent — resumes from checklist state.

- **Single mode** (`/ticket-work KEY`): runs one ticket through plan → execute → review → push.
- **Queue mode** (`/ticket-work`): discovers eligible tickets via JQL, gates on stack deps, launches parallel agents.
- **Parent expansion**: a Story/Task with subtasks expands to its eligible subtasks; labels and assignee are inherited.

Steps: drift check → plan (`/plan-ticket`) → execute (TDD Red-Green-Refactor per plan task) → verify AC → refactor → review (`/jay-pr-review` sanity plan) → stack-ready (merge into feature branch, or wait for `ClaudePRApproved`) → PR push & review sub-procedure (description, draft PR, post review summary). CI green and Copilot review comments are NOT automatic — run `/cop-fight` on demand after the PR opens.

**Mode C** ships a completed stack's feature branch as a single PR (to main, or to the parent Epic's branch for nested Stories), reusing the same PR push & review sub-procedure with a final draft → ready flip.

## Label State Machine

```
ClaudeWork                 -- durable: Claude owns this ticket
ClaudeDriftChecked         -- Implementation Notes are current
ClaudeReady                -- eligible for planning
ClaudePlanning             -- /plan-ticket in progress
ClaudeExecuting            -- TDD execution in progress
ClaudeStackReady           -- review done. Standalone: awaiting ClaudePRApproved
ClaudePRApproved           -- user-applied: gate for the PR push & review sub-procedure
ClaudeNeedsReview          -- PR pushed or merged to feature branch; user reviews
ClaudePendingMainPromotion -- Story shipped to Epic branch; awaiting /promote-to-main
ClaudeMainPR               -- /promote-to-main opened a main-targeting PR
ClaudeStackComplete        -- stack done; triggers Mode C if a feature branch exists
ClaudeFailed               -- error; user investigates
ClaudePruned               -- /prune marked the ticket abandoned
```

User actions: tag a ticket `ClaudeWork` + `ClaudeReady` to enqueue it; run `/cleanup KEY` after merge to main.

## TDDs and Research

The planner decomposes a TDD at `docs/tdds/{slug}.md` into Jira Epics/Stories/Subtasks. The TDD is the source of truth — tickets only deep-link to it.

A TDD declares the repos each capability touches via a `**Repos**:` line under each H2. Research runs per (capability, repo) against locally-cached clones, producing sha-pinned permalinks.

**Owner vs consumer**: every TDD has one owner repo holding the canonical body. Consumer repos init via a pointer file — no body copy — and decompose their own slice. Both kinds plan against the same TDD independently; tickets land as separate Epic trees in the same Jira project.

- `@planner init {path-or-slug}` — owner init (inside the owning repo). Relocates the TDD to `docs/tdds/`, validates shape, populates the clone cache, runs research per repo, writes one sidecar per repo at `docs/tdds/{slug}/{repo}.research.md`, stamps frontmatter.
- `@planner init {owner-slug}:{tdd-slug}` — consumer init. Fetches the owner TDD at a pinned SHA, validates this repo is in scope, runs research for the consumer's repos, writes a pointer file with mode/owner/sha frontmatter.
- `@planner {slug-or-key}` — decompose. Refuses if the local TDD isn't initialized.

**Lazy decomposition**: stops at the first unblocked unit. Within the first Epic, only parallel-startable Stories get full Gherkin + subtasks + Implementation Notes; everything else is a skeleton. `@planner STORY-KEY` or `@planner EPIC-KEY` fleshes a skeleton when its blockers close.

**Drift detection**: Implementation Notes carry a baseline SHA. `/ticket-work` (S3.5) diffs cited line ranges from `baseline_sha..HEAD`. If anything moved, notes are refreshed and a Jira comment posts old vs new — recommending `/rework` if the plan was already approved against stale notes. Manual trigger: `/refresh-research KEY`.

## Stack Architecture

Jira is the source of truth — git has no knowledge of stack structure.

**Stacks**: a Story/Task/Epic is a stack container. Its children form the stack; ordering comes from "is blocked by" links (topo-sorted).

**Feature branches**: every Story/Epic container gets a feature branch (named after its key, or set via `branch:<name>` label). Tickets inside a stack are layered as git branches — each based on the previous, accumulating ancestor changes — and PR into the shared feature branch. Container-to-container deps are honored: if Epic B is blocked by Epic A, B's feature branch bases on A's branch until A merges. Standalone tickets skip the feature branch and PR direct to main.

**Promotion** (`/promote-to-main`): walks the stack in dep order. For each ticket: `git rebase --onto origin/main {prev} {curr}` strips ancestor commits, opens a PR to main, waits for merge, advances.

**Cleanup** (`/cleanup KEY`, or the explicit `/cleanup-main KEY` / `/cleanup-feature KEY`):
1. Verifies the merge landed.
2. Deletes branch + transitions Jira → Done.
3. Cascade-rebases unmerged downstream tickets onto fresh main; retargets the first downstream PR's base.
4. Refreshes the long-lived feature branch by `reset --hard origin/main` + re-merging open ticket branches with `--no-ff`. (Sidesteps the patch-id failure mode of rebasing onto squash-merged commits. Refuses if the feature branch has hand-authored commits or any worktree is dirty.)

Skip steps 3–4 with `--no-rebase` / `--no-refresh-feature`.

**Two-phase cleanup** for Story-containers under an Epic: phase 1 (`/cleanup-feature`) runs cascade-rebase + Epic branch refresh but keeps the Story branch alive (sets `ClaudePendingMainPromotion`); phase 2 (`/cleanup-main`) runs after `/promote-to-main` lands the Story PR on main and finishes terminal cleanup. Use `/cleanup` if you don't want to think about which phase applies — it auto-dispatches based on the detected merge target.

## Project Structure

```
commands/   slash commands (symlinked to ~/.claude/commands/)
agents/     agents (symlinked to ~/.claude/agents/)
cli/        Node CLI tools (bin/, lib/, tests/)
dashboard/  Vite browser dashboard (api/, ui/)
```

## Install

```bash
./install.sh
```

Symlinks commands/agents into `~/.claude/`, creates `.env` from `.env.example` and `~/.claude/.env`, runs `npm install` in `cli/`, and writes a wrapper in `~/.local/bin/` for each `cli/package.json` `bin` entry. Wrappers embed an absolute node path so they survive `asdf reshim`. Put `~/.local/bin` ahead of `~/.asdf/shims` on `PATH`.

After install, set Jira credentials in `.env` and `DEV_ROOT` in `~/.claude/.env`.

## Configuration

`.env` files are loaded without overriding existing env vars:

1. `.env` (project root) — Jira credentials.
2. `~/.claude/.env` — machine-level settings.

| Variable | Required | Description |
|---|---|---|
| `JIRA_EMAIL` | Yes | Atlassian account email |
| `JIRA_API_TOKEN` | Yes | [API token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_DOMAIN` | Yes | `your-org.atlassian.net` |
| `DEV_ROOT` | Yes | parent directory of all repo clones |
| `SLACK_WEBHOOK_URL` | No | Slack webhook for notifications |

Tickets need a `repo:<name>` label that maps to `$DEV_ROOT/<name>`.

## Agents

| Agent | Description |
|---|---|
| `@planner` | Decompose a TDD into Jira Epics/Stories/Subtasks; research codebase patterns and cite them as sha-pinned permalinks. Supports owner/consumer split. |
| `@refactor` | Analyze code for CRAP score, DRY violations, and refactoring opportunities. |

## CLI

`ticket-status` is the user-facing CLI; the rest are called by commands/agents:

| Script | Description |
|---|---|
| `ticket-status` | View and manage Claude ticket stacks in Jira. |
| `append-activity` | Append a timestamped entry to the ticket's `[claude-activity-log]` Jira comment. |
| `sync-checklist` / `sync-plan` | Sync checklist state and plan content between Jira and local files. |
| `seed-checklist` | Initialize a checklist on a ticket from a plan. |
| `resolve-stack` | Resolve stack ordering from Jira issue links. |
| `ensure-work-dir` | Resolve a ticket's working directory and ensure its branch exists. |
| `ensure-pr` | Create or update a draft PR for the current branch. |
| `pr-state` | Normalized `gh pr list` probe. |
| `discover-queue` | Run the Q2 JQL queries; expand parents into subtasks; optionally apply inheritance. |
| `set-ticket-state` | Move a ticket to a progress label or add/remove arbitrary labels. |
| `cascade-rebase` | Cascade-rebase a chain of stacked branches after their base moved. |
| `promote-downstream` | Mark unblocked downstream dependents `ClaudeReady`; report stack completion. |
| `drift-check` | Diff cited line ranges against the baseline SHA; emit a drift report. |
| `stage-squash` | Squash commits into a single `[{KEY}] {label}` commit and force-with-lease push. |
| `post-review-summary` | Post a PR review summary as a Jira comment. |

### Dashboard

```bash
cd dashboard && npm install && npm run dev
```

Opens at `http://localhost:5173`.

## Development

```bash
cd cli
npm install
npm test            # vitest
npm run lint        # biome
npm run lint:fix
```

CI enforces 90% branch coverage.

## Prerequisites

- [Claude Code](https://claude.ai/code)
- [Atlassian MCP server](https://mcp.atlassian.com)
- Claude Code skills: `/plan-ticket`, `/prework`, `/ticket-work` (all local to this plugin), `/jay-pr-description`, `/jay-pr-review` (local — replaces the upstream `/pr-review` + `/pr-execute-plan` pair)
