# jay-claude-plugins

Personal Claude Code commands for Jira ticket automation, PR workflows, and stacked PR management.

## Commands

| Command | Description |
|---|---|
| `/ticket-work [KEY...]` | Run Jira tickets end-to-end: plan, execute, PR, review, push. With args: single ticket (or expand a Story to subtasks). Without args: discover and process the full queue. |
| `/finalize` | Final pre-merge pass: update PR description and post finalization context for downstream stacked ticket agents |
| `/promote-to-main` | Promote stacked tickets to main one at a time: rebase onto main, open PR, wait for merge, advance to next |
| `/stack-rebase KEY` | Rebase a stacked PR chain after a base PR is merged or updated |
| `/ears-requirements [topic]` | Ideate and write EARS (Easy Approach to Requirements Syntax) requirements interactively |

### `/ticket-work` in detail

Idempotent — reads checklist state and resumes from wherever it left off.

**Single ticket mode** (`/ticket-work PROJ-123`): Runs one ticket through the full lifecycle — plan, approve, execute, create draft PR, self-review, push.

**Queue mode** (`/ticket-work`): Discovers all eligible tickets via JQL, gates on stack dependencies, creates worktrees, and launches parallel agents — one per ticket.

**Parent expansion**: If a key is a Story/Task with subtasks, it expands to the eligible subtasks and runs them in parallel. Labels and assignee are inherited from the parent.

#### Single ticket lifecycle

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

## Stack Architecture

Jira is the source of truth for stack structure — git has no knowledge of it.

### How stacks are defined

A **stack container** is a Story, Task, or Epic in Jira. Its subtasks (or Epic children) form the stack. Ordering comes from Jira issue links: each ticket declares what it "is blocked by" within the same container. A topological sort of those links produces the execution and promotion order.

### Feature branch model

During development, tickets are stacked as git branches: each branch is based on the previous ticket's branch, accumulating ancestor changes. All PRs target a shared feature branch (identified by a `branch:*` label on the container). This means ticket-3's branch contains ticket-1 + ticket-2 + ticket-3 changes.

### Promotion to main

`/promote-to-main` walks the stack in dependency order and promotes each ticket individually:

1. **Isolate** — `git rebase --onto origin/main {previous-ticket-branch} {current-ticket-branch}` strips ancestor commits, leaving only this ticket's diff on top of main.
2. **PR** — Opens a PR from the rebased branch directly to main.
3. **Gate** — Stops and waits for the PR to merge before advancing.
4. **Repeat** — After merge, the next ticket is rebased onto the now-updated main.

This works because once ticket-N merges to main, ticket-N+1's rebase strips ticket-N's commits (which are now in main anyway), leaving a clean diff of just ticket-N+1's changes.

### Why Jira, not git

Git branches don't encode ordering or dependency — they're just pointers. The stack needs a data structure that answers "what comes before this?" and "what's the container?" Jira's parent/child relationships and issue links provide both, making the stack portable across worktrees, machines, and agents.

## Configuration

The queue uses `~/.claude/dev-root.json` to locate repo clones. Tickets need a `repo:` label (e.g., `repo:my-backend`) that maps to a subdirectory under the dev root.

```json
{
  "root": "/path/to/dev"
}
```

## CLI Tools

### `ticket-status`

Terminal CLI for viewing and managing Claude ticket stacks in Jira. Provides a dashboard view of in-progress stacks without needing to open Claude Code.

```bash
ticket-status
```

Requires environment variables: `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_DOMAIN`.

### Web Dashboard

Browser-based dashboard with the same data as `ticket-status` plus expandable detail panels per ticket (checklist progress, PR links, branch/worktree info, dependency graph, execution/review progress bars).

```bash
cd dashboard
npm install
npm run dev
```

Opens at `http://localhost:5173`. The API server runs on port 3789; Vite proxies `/api` requests to it automatically.

**Features:**
- Stack tree view with state badges (colored by lifecycle stage)
- Click-to-expand ticket detail panels
- Approve plan / approve PR buttons (per-ticket and bulk)
- Auto-refresh every 30 seconds

**Requires** the same environment variables as `ticket-status`: `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_DOMAIN`.

## Install

```bash
./install.sh
```

Symlinks commands into `~/.claude/commands/`, copies `dev-root.json` to `~/.claude/`, and installs the `ticket-status` CLI via npm link. Existing files are backed up as `.bak`.

## Prerequisites

- [Claude Code](https://claude.ai/code)
- [Atlassian MCP server](https://mcp.atlassian.com) (for ticket-work and stack-rebase)
- Claude Code skills: `/jira-start`, `/plan-execute`, `/pr-description`, `/pr-review`, `/pr-execute-plan` (from [claude-plugins](https://github.com/pathccm/claude-plugins))
