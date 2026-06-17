# jay-claude-plugins

Claude Code commands for Jira ticket automation, PR workflows, and stacked PR management.

## Commands

| Command | Description |
|---|---|
| `/ticket-work [KEY...]` | Run Jira tickets end-to-end: drift-check, plan, execute, PR, review, push. With args: single ticket (or expand a Story to subtasks). Without args: discover and process the full queue. |
| `/prework KEY` | Pre-`/ticket-work` setup: resolve stack, ensure feature branch + working directory, seed checklist, run drift check. Stops before planning so a human can review notes |
| `/orchestrate` | Project-level coordinator: surveys all active stacks, auto-runs safe lifecycle steps (cleanup merged tickets, promote PR-approved tickets), and surfaces decisions that need a human (failed tickets, drift, plan/PR approvals) |
| `/ticket-status KEY` | Show the lifecycle status of a single ticket — stack position, branch, PR, Jira labels, checklist, blocks/blocked-by |
| `/pr-chat KEY` | Load full PR context (Jira ticket + comments + linked TDD + PR metadata + diff + every changed file) into the conversation, then hand control back for free-form discussion |
| `/refresh-research KEY` | Manually re-run the research drift check on a ticket: diff cited code against the research baseline SHA and refresh the Implementation Notes if drift is detected |
| `/fix-drift KEY` | Detect drift between a ticket's acceptance criteria and the current branch implementation, then fix the code to match |
| `/finalize` | Final pre-merge pass: update PR description and post finalization context for downstream stacked ticket agents |
| `/promote-to-main` | Promote stacked tickets to main one at a time: rebase onto main, open PR, wait for merge, advance to next |
| `/stack-rebase KEY` | Rebase a stacked PR chain after a base PR is merged or updated |
| `/rebase-on-main [--cascade]` | Rebase the current feature branch onto `origin/main` and force-push (refuses on dirty tree, main, or no-op). With `--cascade`, hands off to `/stack-rebase` after a successful push to rebase any downstream stacked tickets |
| `/prune KEY` | Prune a ticket from the stack: revert its merge from the feature branch, close its PR, and cancel the Jira ticket |
| `/rework KEY` | Reset a ticket's branch to its base, clear all progress labels and checklist, then restart the ticket-work lifecycle from scratch. Destructive counterpart to `/prune` — use when implementation is unsalvageable and a fresh start is faster than fixing |
| `/cleanup KEY [--no-rebase] [--no-refresh-feature]` | Post-merge teardown: verify the ticket landed on main, delete its branch (local + remote), transition Jira to Done, note completion on the container if last in stack, cascade-rebase any unmerged downstream tickets onto main, and refresh the long-lived feature branch by resetting to fresh main and re-merging the still-open ticket branches |
| `/ears-requirements [topic]` | Ideate and write EARS (Easy Approach to Requirements Syntax) requirements interactively |

### `/ticket-work` in detail

Idempotent — reads checklist state and resumes from wherever it left off.

**Single ticket mode** (`/ticket-work PROJ-123`): Runs one ticket through the full lifecycle — plan, execute, create draft PR, self-review, push.

**Queue mode** (`/ticket-work`): Discovers all eligible tickets via JQL, gates on stack dependencies, creates worktrees, and launches parallel agents — one per ticket.

**Parent expansion**: If a key is a Story/Task with subtasks, it expands to the eligible subtasks and runs them in parallel. Labels and assignee are inherited from the parent.

#### Single ticket lifecycle

S3.5. **Drift check** — diff cited code in the ticket's `Implementation Notes` against the research baseline SHA; refresh the notes (and post a Jira comment) if any cited line range moved
S4.1. Plan generated with `/jira-start`
S4.2. Plan executed with `/plan-execute` (TDD execute)
S4.3. Implementation verified against the ticket's acceptance criteria (TDD verify)
S4.4. Refactor pass on the diff
S4.5. PR review plan generated with `/pr-review`
S4.6. PR review plan executed with `/pr-execute-plan`
S4.7. **Stack-ready** — for tickets in a Story/Epic stack: merge the ticket branch into the container's feature branch and set `ClaudeNeedsReview`. For standalone tickets: set `ClaudeStackReady` and stop until the user adds `ClaudePRApproved`.
S4.8. **PR-approved gate** — for non-feature-branch tickets, wait for `ClaudePRApproved` before entering the PR push & review sub-procedure.

The PR push & review sub-procedure (P1–P6) generates the description with `/jay-pr-description`, pushes a draft PR, runs `/pr-review` + `/pr-execute-plan`, runs the Copilot loop via `/pr-watch`, and posts a review summary as a Jira comment. The same sub-procedure is reused by Mode C against the feature branch (with P7 flipping the PR from draft to ready for review).

#### Mode C: feature branch PR to main

Once every ticket in a stack reaches stack-ready (the container is `ClaudeStackComplete`), `/ticket-work` enters Mode C and ships the container's feature branch to main as a single PR. Mode C runs through its own checklist (stored locally at `{REPO_ROOT}/.claude/plans/ticket-work-{CONTAINER_KEY}-pr.md`): generate description, push, run `/pr-watch`, post the review summary. Subtasks under a Story-container go through Phase-1 cleanup individually (Story PRs merged into the parent Epic's feature branch); the Story-container itself is then promoted to main via `/promote-to-main`.

## Label State Machine

```
ClaudeWork                    -- durable tag: Claude owns this ticket (never removed)
ClaudeDriftChecked            -- research drift check ran; Implementation Notes are current
ClaudeReady                   -- eligible for planning
ClaudePlanning                -- /jira-start in progress
ClaudeExecuting               -- /plan-execute in progress
ClaudeStackReady              -- code review done, stack unblocked. Feature branch: awaiting merge. Standalone: awaiting ClaudePRApproved
ClaudePRApproved              -- user-applied: approves PR creation for a standalone ticket; gate for the PR push & review sub-procedure
ClaudeNeedsReview             -- merged to feature branch or PR pushed, user: review PR. Post-merge: run /cleanup KEY
ClaudePendingMainPromotion    -- Story-container shipped to its parent Epic's feature branch via Phase-1 cleanup; awaiting /promote-to-main and a follow-up terminal /cleanup
ClaudeMainPR                  -- /promote-to-main opened a main-targeting PR; cleared by terminal /cleanup
ClaudeFailed                  -- error, user: investigate
ClaudeStackComplete           -- all tickets in stack finished (added to stack container); triggers Mode C if a feature branch is set
ClaudePruned                  -- /prune marked the ticket abandoned (work was reverted; PR closed)
```

### User actions
- **Label `ClaudeWork`** + **`ClaudeReady`**: mark a ticket for Claude and signal it's ready for planning
- **Run `/cleanup KEY`** after a PR merges to main: deletes the branch and transitions the ticket to Done

### `ClaudeNeeds*` = user action required
- `ClaudeNeedsReview` → review PR, iterate. After merge to main: run `/cleanup KEY`

## TDDs and Research

The planner sources its decomposition from a Technical Design Document checked into the repo at `docs/tdds/{slug}.md`. The TDD is the source of truth — Jira tickets only deep-link to it.

A TDD declares the repos each capability touches via a `**Repos**:` line under every H2 capability heading (comma-separated GitHub slugs like `org/frontend, org/backend`). Multi-repo TDDs are normal: research runs per (capability, repo) pair against locally-cached clones.

### Owner vs Consumer

Every TDD has exactly one **owner repo** — the repo holding the canonical markdown body. Other repos that need to plan against the same TDD run **consumer init**, which writes a small pointer file (no body copy) and lets that repo decompose its own slice of work. The TDD is mirrored only conceptually, never as a file copy:

- **Owner init** (`@planner init {path-or-slug}`) — run inside the owning repo. Writes the canonical TDD, runs research for *every* repo the TDD declares, writes one sidecar per repo, and stamps `mode: owner` plus `owner_repo` / `owner_path` into the TDD frontmatter.
- **Consumer init** (`@planner init {owner-slug}:{tdd-slug}`, e.g. `@planner init org/platform:auth`) — run inside a consumer repo. Fetches the owner TDD via `gh api` at a pinned SHA, validates that the consumer's repo appears in at least one `**Repos**:` declaration, runs research only for the consumer's own repo(s), writes consumer-side sidecars, and writes a pointer file at `{CONSUMER_REPO}/docs/tdds/{tdd-slug}.md` with `mode: consumer` frontmatter and a single linkback line.

Both kinds of repo can decompose against the same TDD independently; tickets land as separate Epic trees in the same Jira project, all linking back to the owner's canonical TDD URL.

### Init: required pre-flight per TDD per repo

Before any decomposition runs, the local frontmatter must record `initialized: true` and a non-empty `repos:` array.

#### Owner init

Run inside the owning repo:

```
@planner init {path-or-slug}
```

Init accepts the TDD from anywhere — a draft you've been iterating on outside the repo, a non-canonical folder, or already at `docs/tdds/`. It:

1. **Relocates the TDD** to the canonical `{TDD_REPO}/docs/tdds/{slug}.md` location. Drafts outside the repo are copied (original left untouched); files inside the repo are moved. If the canonical target already exists, init refuses rather than clobber it.
2. **Validates TDD shape** — H1 present, capability sections present, every H2 declares `**Repos**:` GitHub slugs, heading anchors unique.
3. **Verifies `gh` access** to every repo declared in the TDD.
4. **Populates the clone cache** at `{TDD_REPO}/.planner-cache/{org}/{repo}` (gitignored) for every repo declared.
5. **Runs Epic-level codebase research** per (capability, repo) pair against the cache — produces sha-pinned GitHub permalinks for existing patterns and constraints.
6. **Writes one sidecar per repo** at `{TDD_REPO}/docs/tdds/{slug}/{repo-name}.research.md` carrying patterns and constraints H2-grouped per capability. The TDD body itself is not modified beyond frontmatter.
7. **Repo readiness checks** — git origin resolves to GitHub, working tree is clean enough, `docs/tdds/` exists, additional working dirs are accessible.
8. **Jira pre-flight** — verifies project visibility, required issue types (Epic / Story / Sub-task), and the "Blocks" link type.
9. **Writes the init marker** — YAML frontmatter records `mode: owner`, `owner_repo`, `owner_path`, and a per-repo `repos:` array (each with its own `initialized_sha` and sidecar path) so subsequent `@planner` runs can hard-gate on it.

#### Consumer init

Run inside a consumer repo (one not owning the TDD):

```
@planner init {owner-slug}:{tdd-slug}
```

For example, `@planner init org/platform:auth` from inside `org/employer-frontend` says "I want to plan my slice of `auth` against the canonical TDD that lives at `org/platform:docs/tdds/auth.md`." Consumer init:

1. **Fetches the owner TDD** via `gh api repos/{owner-slug}/contents/docs/tdds/{tdd-slug}.md` at the owner's `origin/HEAD`, and pins that commit as `owner_sha`.
2. **Validates the owner is initialized** — the owner TDD's frontmatter must carry `mode: owner` (or be a legacy owner TDD) and a non-empty `repos:` array.
3. **Validates the consumer is in scope** — refuses if this consumer's `org/repo` isn't named in any `**Repos**:` declaration. Refuses if invoked from inside the owner repo (use plain `init` instead).
4. **Asks which repos to research** — defaults to the consumer's own repo only; the user can opt to research additional in-scope repos.
5. **Populates the consumer cache** at `{CONSUMER_REPO}/.planner-cache/`, runs research per (capability, repo) pair, and writes consumer-side sidecars at `{CONSUMER_REPO}/docs/tdds/{tdd-slug}/{repo-name}.research.md`.
6. **Writes the pointer file** at `{CONSUMER_REPO}/docs/tdds/{tdd-slug}.md` carrying `mode: consumer`, `owner_repo`, `owner_path`, `owner_sha`, `consumer_repo`, `jira_project`, and `repos:` plus a single linkback line to the canonical TDD. The TDD body is not copied.

When the owner TDD changes meaningfully, re-run `@planner init {owner-slug}:{tdd-slug}` to refresh `owner_sha` and re-research patterns. Consumer decomposition runs warn at start if the owner's body has shifted since the pinned SHA.

`@planner {slug}`, `@planner EPIC-KEY`, and `@planner STORY-KEY` all refuse to run if the local TDD (owner or consumer pointer) has not been initialized.

### Decomposition flow

After init, `@planner docs/tdds/auth.md` (or just `@planner auth`):

1. **Resolves the TDD** in the primary repo or any additional working directory; verifies the init marker. Detects owner vs consumer mode from frontmatter — in consumer mode, the body is fetched from the owner repo via `gh api ... ?ref={owner_sha}` (immutable).
2. **Pins SHAs** — for owner mode, `git rev-parse HEAD` in the TDD's repo; for consumer mode, the owner's pinned `owner_sha`. All ticket-facing TDD links resolve to the owner's canonical permalink so they never rot.
3. **Identifies capabilities** as Epics, orders them by dependency. In consumer mode, capabilities that don't touch any of the consumer's researched repos are out of scope.
4. **Reads patterns** for the first Epic from each touched repo's sidecar. If the consumer references a repo it didn't research locally, the agent fetches the owner's sidecar via `gh api` and links to the owner's sidecar URL rather than embedding its citations.
5. **Writes Gherkin** scenarios (Stories), subtask decompositions, and dependency graph.
6. **Per-ticket research** — for each Full ticket about to be created, runs a fresh narrow research pass and injects an `Implementation Notes` block with sha-pinned permalinks and a recorded baseline SHA. Skeleton tickets skip this.
7. **Creates Jira tickets** with TDD link (always pointing at the owner's permalink) + Implementation Notes (Full) or skeleton stubs (downstream); stale tickets from prior decompositions are surfaced for `/prune`.

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

Every Story/Epic container is automatically a feature branch. The branch name is derived from the container's Jira key by default (e.g. `EPIC-123`); set a `branch:<name>` label on the container to override it. The tooling creates the branch on first ticket-work invocation — no manual setup required.

During development, tickets in a stack are layered as git branches: each ticket branch is based on the previous ticket's branch (or on the feature branch if it's the first), accumulating ancestor changes. All ticket PRs target the shared feature branch. This means ticket-3's branch contains ticket-1 + ticket-2 + ticket-3 changes.

When containers depend on each other (Epic B `is blocked by` Epic A), the tooling honors the DAG: if A's branch is unmerged, B's feature branch is automatically based on A's branch instead of main. `/promote-to-main` refuses to promote any ticket inside B until A is fully merged. Standalone tickets (no Story/Epic container) skip the feature branch and PR direct to main.

### Promotion to main

`/promote-to-main` walks the stack in dependency order and promotes each ticket individually:

1. **Isolate** — `git rebase --onto origin/main {previous-ticket-branch} {current-ticket-branch}` strips ancestor commits, leaving only this ticket's diff on top of main.
2. **PR** — Opens a PR from the rebased branch directly to main.
3. **Gate** — Stops and waits for the PR to merge before advancing.
4. **Repeat** — After merge, the next ticket is rebased onto the now-updated main.

This works because once ticket-N merges to main, ticket-N+1's rebase strips ticket-N's commits (which are now in main anyway), leaving a clean diff of just ticket-N+1's changes.

### Post-merge maintenance

After a ticket merges to main, `/cleanup KEY` does the full teardown in one pass:

1. Verifies the merge landed (refuses otherwise).
2. Deletes the ticket's branch (local + remote) and transitions Jira to Done.
3. **Cascade-rebases unmerged downstream tickets** onto fresh main and retargets the first downstream PR's base. This is the same logic as `/stack-rebase` Scenario A, run inline so the stack is never left dangling off a deleted branch.
4. **Refreshes the long-lived feature branch** so it doesn't drift from main over the lifetime of an Epic. The feature branch is `reset --hard origin/main` and the still-open ticket branches are re-merged on top with `--no-ff`. This sidesteps the patch-id failure mode of rebasing onto squash-merged commits — the squashed work simply isn't replayed because we throw the old feature-branch state away. Pre-flight refuses if the feature branch has hand-authored commits not present in any tracked ticket branch (would be silently destroyed) or if any worktree on the feature branch is dirty. The pre-refresh SHA is logged so a `git reset --hard {sha}` recovery is always available.

Pass `--no-rebase` to skip step 3 or `--no-refresh-feature` to skip step 4.

#### Two-phase cleanup for Story-containers

A Story whose feature branch was PR'd into the parent Epic's feature branch (a Story-container under an Epic) goes through cleanup **twice**:

- **Phase 1 — Story PR merged into Epic feature branch.** `/cleanup STORY-KEY` detects `MERGE_TARGET = parentFeatureBranch` and sets `DEFER_DESTRUCTIVE = true`. It runs the activity-log update and the cascade-rebase + Epic-feature-branch refresh, but **keeps the Story branch alive** and leaves the Story In Progress with `ClaudePendingMainPromotion` applied. The branch must survive because `/promote-to-main` rebases it onto main next.
- **Phase 2 — Story PR merged into main (after `/promote-to-main` lands it).** Re-running `/cleanup STORY-KEY` detects the merged main-targeting PR via the Step 1b probe, picks `MERGE_TARGET = main`, and runs terminal cleanup: branch delete, Jira → Done, `ClaudePendingMainPromotion` removed.

Leaf tickets (Subtasks under a Story, or standalone tickets) only see Phase 2 — they go straight from main-merge to terminal cleanup in one pass.

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
4. `npm install` the CLI dependencies and generate standalone wrappers in `~/.local/bin/` for every CLI declared in `cli/package.json`'s `bin` field. The wrappers embed an absolute path to the node binary so the CLIs survive `asdf reshim` and don't trip version prompts when run from repos with a different `.tool-versions`. Make sure `~/.local/bin` is on your `PATH` ahead of `~/.asdf/shims`.

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
| `@planner` | Decompose a repo-based Technical Design Document (`docs/tdds/{slug}.md`) into Gherkin-based Epics, Stories, and Subtasks in Jira. Researches codebase patterns across declared repos and cites them as sha-pinned GitHub permalinks. Supports a TDD owner / consumer split: the canonical TDD lives in the owning repo, and consumer repos init via a pointer file (no body copy) so they can plan their own slice independently |
| `@refactor` | Analyze code for CRAP score, DRY violations, and refactoring opportunities |

## CLI Tools

All CLI tools live in `cli/`. `install.sh` runs `npm install` and writes a wrapper in `~/.local/bin/` for each entry in `cli/package.json`'s `bin` field — the wrappers exec a hardcoded node binary so the CLIs work everywhere `~/.local/bin` is on `PATH`.

### `ticket-status`

Terminal CLI for viewing and managing Claude ticket stacks in Jira.

```bash
ticket-status
```

### Automation scripts

These are called by the commands/agents during ticket execution:

| Script | Description |
|---|---|
| `append-activity` | Append a timestamped entry to the ticket's `[claude-activity-log]` Jira comment — the canonical narrative log for ticket-work and friends |
| `sync-checklist` | Sync checklist state between Jira and local plan |
| `sync-plan` | Sync plan content to Jira ticket description |
| `resolve-stack` | Resolve stack ordering from Jira issue links |
| `ensure-pr` | Create or update a draft PR for the current branch |
| `ensure-work-dir` | Resolve a ticket's working directory and ensure its branch (or container feature branch) exists, based off the right parent |
| `post-review-summary` | Post a PR review summary as a Jira comment |
| `seed-checklist` | Initialize a checklist on a Jira ticket from a plan |
| `discover-queue` | Run the Q2 JQL queries (ready / parent / in-flight), expand parent Stories/Tasks into eligible subtasks, optionally apply parent label/assignee inheritance |
| `set-ticket-state` | Move a ticket to a progress label (auto-clears the others), or add/remove arbitrary labels |
| `cascade-rebase` | Cascade-rebase a chain of stacked branches after their base merged or moved; can retarget the head PR's base and post activity-log notes |
| `promote-downstream` | After a ticket lands as Done, mark its now-unblocked downstream dependents `ClaudeReady` and report containers that just hit stack completion |
| `drift-check` | Parse a ticket's `Implementation Notes`, diff each cited line range against the baseline SHA, and emit a structured drift report |
| `stage-squash` | Squash every commit since the last stage marker into a single `[{KEY}] {label}` commit and force-with-lease push |
| `pr-state` | Probe `gh pr list` for the most recent PR matching a branch/base/state filter and emit a normalized JSON object |

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
