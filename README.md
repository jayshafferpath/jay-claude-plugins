# jay-claude-plugins

Personal Claude Code commands for Jira queue automation, PR workflows, and stacked PR management.

## Commands

### Queue System

Automated Jira work queue with a label-based state machine. Label `ClaudeWork` on any ticket to mark it for Claude. Move to "In Progress" when ready: `ClaudeWork` + In Progress -> `ClaudePlanning` -> `ClaudePlanNeedsApproval` -> `ClaudePlanApproved` -> `ClaudeExecuting` -> `ClaudeNeedsReview` -> Done.

| Command | Description |
|---|---|
| `/jay-claude-queue` | Run all three queue phases in sequence |
| `/jay-queue-plan` | Phase 1: Find `ClaudeWork` + In Progress tickets, gate on stack dependencies, create worktrees, run `/jira-start` |
| `/jay-queue-execute` | Phase 2: Find `ClaudePlanApproved` tickets, launch parallel execution agents |
| `/jay-queue-promote` | Phase 3: Promote downstream tickets when blocker is Done, detect stack completion |

### PR Workflows

| Command | Description |
|---|---|
| `/jay-pr-description` | Generate a PR title and description following the team's PR template |
| `/jay-pr-walkthrough` | Walk through PR changes file-by-file with explanations |

### Stacked PRs

| Command | Description |
|---|---|
| `/jay-stack-rebase` | Rebase a stacked PR chain after a base PR is merged or updated |

### Requirements

| Command | Description |
|---|---|
| `/jay-ears-requirements` | Ideate and write EARS (Easy Approach to Requirements Syntax) requirements interactively |

## Queue Label State Machine

```
ClaudeWork (+ In Progress) -- eligible for planning (user labels ClaudeWork, moves to In Progress when ready)
ClaudePlanning             -- /jira-start in progress
ClaudePlanNeedsApproval    -- plan ready, user: review plan and apply ClaudePlanApproved
ClaudePlanApproved         -- user approved, eligible for execution
ClaudeExecuting            -- /plan-execute in progress
ClaudeNeedsReview          -- done, user: review PR, iterate, then move ticket to Done
ClaudeFailed               -- error, user: investigate
ClaudeStackComplete        -- all tickets in an Epic finished (added to Epic)
```

### User Actions
- **Label `ClaudeWork`**: mark any ticket for Claude to work on
- **Move to In Progress**: signal that a `ClaudeWork` ticket is ready for planning
- **Apply `ClaudePlanApproved`**: approve a plan after reviewing it
- **Move to Done**: signal that PR review is complete, triggers downstream promotion

### `ClaudeNeeds*` = user action required
- `ClaudePlanNeedsApproval` -> review plan, apply `ClaudePlanApproved`
- `ClaudeNeedsReview` -> review PR, iterate, move ticket to Done

## Install

```bash
./install.sh
```

Symlinks all commands into `~/.claude/commands/`. Existing files are backed up as `.bak`.

## Prerequisites

- [Claude Code](https://claude.ai/code)
- [Atlassian MCP server](https://mcp.atlassian.com) (for queue and stack-rebase commands)
- Jira plugin skills: `/jira-start`, `/plan-execute` (from [claude-plugins](https://github.com/pathccm/claude-plugins))
