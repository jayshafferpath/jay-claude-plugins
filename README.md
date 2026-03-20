# jay-claude-plugins

Personal Claude Code commands for Jira queue automation, PR workflows, and stacked PR management.

## Commands

### Queue System

Automated Jira work queue with a label-based state machine. Tickets flow through: `ClaudeReady` -> `ClaudeWorkPlanning` -> `ClaudeWorkPlanningDone` -> `ClaudePlanApproved` -> `ClaudeWorkExecuting` -> `ClaudeWorkFinished`.

| Command | Description |
|---|---|
| `/jay-claude-queue` | Run all three queue phases in sequence |
| `/jay-queue-plan` | Phase 1: Find `ClaudeReady` tickets, gate on stack dependencies, create worktrees, run `/jira-start` |
| `/jay-queue-execute` | Phase 2: Find `ClaudePlanApproved` tickets, launch parallel execution agents |
| `/jay-queue-promote` | Phase 3: Promote downstream tickets to `ClaudeReady`, detect stack completion |

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
ClaudeReady           -- eligible for planning (user-applied or auto-promoted)
ClaudeWorkPlanning    -- /jira-start in progress
ClaudeWorkPlanningDone -- plan ready, awaiting user approval
ClaudePlanApproved    -- user approved, eligible for execution
ClaudeWorkExecuting   -- /plan-execute in progress
ClaudeWorkFinished    -- implementation done, PR created
ClaudeWorkFailed      -- execution failed, needs investigation
ClaudeStackComplete   -- all tickets in an Epic finished (added to Epic)
```

## Install

```bash
./install.sh
```

Symlinks all commands into `~/.claude/commands/`. Existing files are backed up as `.bak`.

## Prerequisites

- [Claude Code](https://claude.ai/code)
- [Atlassian MCP server](https://mcp.atlassian.com) (for queue and stack-rebase commands)
- Jira plugin skills: `/jira-start`, `/plan-execute` (from [claude-plugins](https://github.com/pathccm/claude-plugins))
