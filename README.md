# jay-claude-plugins

Personal Claude Code commands for Jira ticket automation, PR workflows, and stacked PR management.

## Commands

| Command | Description |
|---|---|
| `/ticket-work [KEY...]` | Run Jira tickets end-to-end: plan, execute, PR, review, push. With args: single ticket (or expand a Story to subtasks). Without args: discover and process the full queue. |
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

## Configuration

The queue uses `~/.claude/dev-root.json` to locate repo clones. Tickets need a `repo:` label (e.g., `repo:my-backend`) that maps to a subdirectory under the dev root.

```json
{
  "root": "/path/to/dev"
}
```

## Install

```bash
./install.sh
```

Symlinks commands into `~/.claude/commands/` and copies `dev-root.json` to `~/.claude/`. Existing files are backed up as `.bak`.

## Prerequisites

- [Claude Code](https://claude.ai/code)
- [Atlassian MCP server](https://mcp.atlassian.com) (for ticket-work and stack-rebase)
- Claude Code skills: `/jira-start`, `/plan-execute`, `/pr-description`, `/pr-review`, `/pr-execute-plan` (from [claude-plugins](https://github.com/pathccm/claude-plugins))
