# jay-claude-plugins

Claude Code commands for Jira ticket automation, PR workflows, and stacked PR management.

## Commands

| Command | Description |
|---|---|
| `/ticket-work [KEY...]` | Run Jira tickets end-to-end: drift-check, plan, execute, PR, review, push. With args: single ticket (or expand a Story to subtasks). Without args: discover and process the full queue. |
| `/refresh-research KEY` | Manually re-run the research drift check on a ticket: diff cited code against the research baseline SHA and refresh the Implementation Notes if drift is detected |
| `/fix-drift KEY` | Detect drift between a ticket's acceptance criteria and the current branch implementation, then fix the code to match |
| `/finalize` | Final pre-merge pass: update PR description and post finalization context for downstream stacked ticket agents |
| `/promote-to-main` | Promote stacked tickets to main one at a time: rebase onto main, open PR, wait for merge, advance to next |
| `/stack-rebase KEY` | Rebase a stacked PR chain after a base PR is merged or updated |
| `/prune KEY` | Prune a ticket from the stack: revert its merge from the feature branch, close its PR, and cancel the Jira ticket |
| `/ears-requirements [topic]` | Ideate and write EARS (Easy Approach to Requirements Syntax) requirements interactively |

### `/ticket-work` in detail

Idempotent — reads checklist state and resumes from wherever it left off.

**Single ticket mode** (`/ticket-work PROJ-123`): Runs one ticket through the full lifecycle — plan, approve, execute, create draft PR, self-review, push.

**Queue mode** (`/ticket-work`): Discovers all eligible tickets via JQL, gates on stack dependencies, creates worktrees, and launches parallel agents — one per ticket.

**Parent expansion**: If a key is a Story/Task with subtasks, it expands to the eligible subtasks and runs them in parallel. Labels and assignee are inherited from the parent.

#### Single ticket lifecycle

0. **Drift check** — diff cited code in the ticket's `Implementation Notes` against the research baseline SHA; refresh the notes (and post a Jira comment) if any cited line range moved
1. Plan generated with `/jira-start`
2. Plan approved (gate — waits for `ClaudePlanApproved` label)
3. Plan executed with `/plan-execute`
4. PR description generated with `/pr-description`
5. PR pushed as draft
6. PR review plan generated with `/pr-review`
7. PR review plan executed with `/pr-execute-plan`
8. Changes pushed to PR
9. PR review summary posted as comment

## Label State Machine

```
ClaudeWork                 -- durable tag: Claude owns this ticket (never removed)
ClaudeDriftChecked         -- research drift check ran; Implementation Notes are current
ClaudeReady                -- eligible for planning
ClaudePlanning             -- /jira-start in progress
ClaudePlanNeedsApproval    -- plan ready, user: review and apply ClaudePlanApproved
ClaudePlanApproved         -- user approved, eligible for execution
ClaudeExecuting            -- /plan-execute in progress
ClaudeNeedsReview          -- done, user: review PR, iterate, move ticket to Done
ClaudeFailed               -- error, user: investigate
ClaudeStackComplete        -- all tickets in stack finished (added to stack container)
```

### User actions
- **Label `ClaudeWork`** + **`ClaudeReady`**: mark a ticket for Claude and signal it's ready for planning
- **Apply `ClaudePlanApproved`**: approve a plan after reviewing it
- **Move to Done**: signal that PR review is complete; triggers downstream promotion

### `ClaudeNeeds*` = user action required
- `ClaudePlanNeedsApproval` → review plan, apply `ClaudePlanApproved`
- `ClaudeNeedsReview` → review PR, iterate, move ticket to Done

## TDDs and Research

The planner sources its decomposition from a Technical Design Document checked into the repo at `docs/tdds/{slug}.md`. The TDD is the source of truth — Jira tickets only deep-link to it.

### Decomposition flow

`@planner docs/tdds/auth.md` (or just `@planner auth`):

1. **Resolves the TDD** in the primary repo or any additional working directory
2. **Pins a SHA** — `git rev-parse HEAD` in the TDD's repo. All ticket-facing TDD links use sha-pinned GitHub permalinks (`github.com/{org}/{repo}/blob/{sha}/docs/tdds/auth.md#section-anchor`) so they never rot
3. **Identifies capabilities** as Epics, orders them by dependency
4. **Researches codebase patterns** for the first Epic — produces sha-pinned permalinks (`...#L42-L60`) for existing modules, conventions, and tests the implementation should reuse
5. **Surfaces patterns as proposed TDD additions** in the approval phase — you fold them into the TDD and commit before tickets are created, so the TDD remains the single source of truth for design context
6. **Writes Gherkin** scenarios (Stories), subtask decompositions, and dependency graph
7. **Per-ticket research** — for each Full ticket about to be created, runs a fresh narrow research pass and injects an `Implementation Notes` block with sha-pinned permalinks and a recorded baseline SHA
8. **Creates Jira tickets** with TDD link + Implementation Notes (Full) or skeleton stubs (downstream); stale tickets from prior decompositions are surfaced for `/prune`

### Lazy decomposition

Decomposition stops at the first unblocked unit. Within the first Epic, only the parallel-startable Stories (no inward blockers) are fleshed out with full Gherkin, subtasks, and Implementation Notes. Every other Story is a **skeleton**: title, brief scope, TDD anchor, and dependency links — nothing more. Remaining Epics are skeletons too.

This avoids predicting the future. A pinned `Implementation Notes` baseline goes stale fast; codebase state changes; design intent shifts; even the right Gherkin can be wrong by the time downstream work is queued. Lazy decomposition keeps the tree of speculation small.

When a skeleton is ready to work:

- `@planner STORY-KEY` — flesh a skeleton Story (Gherkin + subtasks + Implementation Notes) once its blockers have closed
- `@planner EPIC-KEY` — flesh a skeleton Epic into Stories (still applying the lazy rule within the Epic) once its upstream Epics are done

Skeleton-Story re-entry verifies that all `is blocked by` links point to Done tickets before fleshing — defaulting to abort if any blocker is still open, since fleshing too early defeats the whole point.

### Drift detection

Implementation Notes carry a baseline SHA per repo. When `/ticket-work` picks up a ticket (S3.5, before planning), it diffs each cited line range from `baseline_sha..HEAD` using `git log -L`. If any cited code moved or was renamed:

- The ticket's Implementation Notes are refreshed at the current SHA
- A Jira comment posts old vs new baselines, drifted citations, and replacements
- If the plan was already approved against stale notes, the comment recommends `/rework`

Trigger the same check manually with `/refresh-research PROJ-123` — useful after a rebase or when a ticket has been sitting in the queue for a while.

## Stack Architecture

Jira is the source of truth for stack structure — git has no knowledge of it.

### How stacks are defined

A **stack container** is a Story, Task, or Epic in Jira. Its subtasks (or Epic children) form the stack. Ordering comes from Jira issue links: each ticket declares what it "is blocked by" within the same container. A topological sort of those links produces the execution and promotion order.

### Feature branch model

Every Story/Epic container is automatically a feature branch, named after the container's Jira key (e.g. `EPIC-123`). The tooling creates the branch on first ticket-work invocation — no manual setup, no `branch:` label.

During development, tickets in a stack are layered as git branches: each ticket branch is based on the previous ticket's branch (or on the feature branch if it's the first), accumulating ancestor changes. All ticket PRs target the shared feature branch. This means ticket-3's branch contains ticket-1 + ticket-2 + ticket-3 changes.

When containers depend on each other (Epic B `is blocked by` Epic A), the tooling honors the DAG: if A's branch is unmerged, B's feature branch is automatically based on A's branch instead of main. `/promote-to-main` refuses to promote any ticket inside B until A is fully merged. Standalone tickets (no Story/Epic container) skip the feature branch and PR direct to main.

### Promotion to main

`/promote-to-main` walks the stack in dependency order and promotes each ticket individually:

1. **Isolate** — `git rebase --onto origin/main {previous-ticket-branch} {current-ticket-branch}` strips ancestor commits, leaving only this ticket's diff on top of main.
2. **PR** — Opens a PR from the rebased branch directly to main.
3. **Gate** — Stops and waits for the PR to merge before advancing.
4. **Repeat** — After merge, the next ticket is rebased onto the now-updated main.

This works because once ticket-N merges to main, ticket-N+1's rebase strips ticket-N's commits (which are now in main anyway), leaving a clean diff of just ticket-N+1's changes.

### Why Jira, not git

Git branches don't encode ordering or dependency — they're just pointers. The stack needs a data structure that answers "what comes before this?" and "what's the container?" Jira's parent/child relationships and issue links provide both, making the stack portable across worktrees, machines, and agents.

## Project Structure

```
commands/       Claude Code slash commands (symlinked to ~/.claude/commands/)
agents/         Claude Code agents (symlinked to ~/.claude/agents/)
cli/            Node.js CLI tools and shared libraries
  bin/          Executable scripts
  lib/          Shared modules (Jira client, git helpers, config, etc.)
  tests/        Vitest test suite
dashboard/      Web dashboard (Vite + browser UI)
  api/          Dashboard backend
  ui/           Dashboard frontend
```

## Install

```bash
./install.sh
```

This will:
1. Symlink commands into `~/.claude/commands/` and agents into `~/.claude/agents/`
2. Create `.env` from `.env.example` (project-level credentials)
3. Create `~/.claude/.env` (machine-level config like `DEV_ROOT`)
4. Install the `ticket-status` CLI via `npm link`

After running, edit:
- **`.env`** — set your Jira credentials
- **`~/.claude/.env`** — set `DEV_ROOT` to your dev directory (parent of all repo clones)

## Configuration

All config lives in `.env` files. Two are loaded (neither overrides existing env vars):

1. **`.env`** (project root) — Jira credentials, project-specific settings
2. **`~/.claude/.env`** — machine-level settings shared across projects

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `JIRA_EMAIL` | Yes | Your Atlassian account email |
| `JIRA_API_TOKEN` | Yes | [API token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_DOMAIN` | Yes | e.g. `your-org.atlassian.net` |
| `DEV_ROOT` | Yes | Path to parent directory of all repo clones |
| `SLACK_WEBHOOK_URL` | No | Slack webhook for notifications |

### Dev root

The queue uses `DEV_ROOT` to locate repo clones. Tickets need a `repo:` label (e.g., `repo:my-backend`) that maps to a subdirectory under the dev root. For example, if `DEV_ROOT=/home/you/dev` and a ticket has `repo:my-backend`, the repo is at `/home/you/dev/my-backend`.

## Agents

| Agent | Description |
|---|---|
| `@planner` | Decompose a repo-based Technical Design Document (`docs/tdds/{slug}.md`) into Gherkin-based Epics, Stories, and Subtasks in Jira. Researches codebase patterns and cites them as sha-pinned GitHub permalinks |
| `@refactor` | Analyze code for CRAP score, DRY violations, and refactoring opportunities |

## CLI Tools

All CLI tools live in `cli/` and are installed globally via `npm link` during setup.

### `ticket-status`

Terminal CLI for viewing and managing Claude ticket stacks in Jira.

```bash
ticket-status
```

### Automation scripts

These are called by the commands/agents during ticket execution:

| Script | Description |
|---|---|
| `sync-checklist` | Sync checklist state between Jira and local plan |
| `sync-plan` | Sync plan content to Jira ticket description |
| `resolve-stack` | Resolve stack ordering from Jira issue links |
| `ensure-pr` | Create or update a draft PR for the current branch |
| `post-review-summary` | Post a PR review summary as a Jira comment |
| `seed-checklist` | Initialize a checklist on a Jira ticket from a plan |

### Web Dashboard

Browser-based dashboard with stack tree views, state badges, approval buttons, and auto-refresh.

```bash
cd dashboard && npm install && npm run dev
```

Opens at `http://localhost:5173`.

## Development

```bash
cd cli
npm install
npm test            # run tests (vitest)
npm run lint        # check with biome
npm run lint:fix    # auto-fix lint issues
```

Tests require 90% branch coverage (enforced in CI).

## Prerequisites

- [Claude Code](https://claude.ai/code)
- [Atlassian MCP server](https://mcp.atlassian.com) (for ticket-work and stack-rebase)
- Claude Code skills: `/jira-start`, `/plan-execute`, `/pr-description`, `/pr-review`, `/pr-execute-plan` (from [claude-plugins](https://github.com/pathccm/claude-plugins))
