---
description: Show the lifecycle status of a ticket managed through the Claude ticket-work lifecycle (stack, branch, PR, Jira labels, checklist, blocks/blocked-by).
allowed-tools:
  - Bash(ticket-status *)
---

# Ticket Status

Show the full lifecycle state of a single Jira ticket managed through the Claude ticket-work lifecycle. Wraps the `ticket-status` CLI's verbose mode — see `cli/bin/ticket-status.js` and `cli/lib/labels.js` for the canonical lifecycle states.

## Arguments

`$ARGUMENTS`

Required: a Jira ticket key (e.g., `PROJ-123`). The ticket does not need to be in your active queue — terminal states (Done, Cancelled, ClaudeStackComplete) are reported too.

## Step 1: Validate

If `$ARGUMENTS` is empty, print:

```
Usage: /ticket-status KEY

Example: /ticket-status PROJ-123
```

Stop.

If `$ARGUMENTS` contains anything beyond a single ticket key (whitespace-separated tokens, flags, etc.), bail:

```
/ticket-status takes exactly one ticket key. Got: "{$ARGUMENTS}"
```

Stop.

## Step 2: Run

```bash
ticket-status {KEY}
```

Stream the CLI output verbatim. The CLI handles Jira lookup, label classification, branch/worktree/PR resolution, and checklist rendering — no further processing needed.

If the CLI exits non-zero, surface the error message it printed and stop.
