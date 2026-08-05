---
description: "One triage pass over every active stack: auto-run the promotions and cleanups that are safe, then detect stagnant tickets (abandoned in-flight agents, unattended failures, rotting PRs) and nudge them. Single-pass by design — wrap in /loop for polling."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__atlassianUserInfo
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__getJiraIssue
  - Bash(git *)
  - Bash(gh *)
  - Bash(resolve-stack *)
  - Bash(ticket-status *)
  - Bash(verify-merge *)
  - Bash(classify-actions *)
  - Bash(detect-stagnation *)
  - Bash(set-ticket-state *)
  - Bash(append-activity *)
  - Read
  - Write
  - Skill
---

# Triage Tickets

Find tickets that need to be **promoted** or that have gone **stagnant**, then act on both.

This is the unattended-operator command. `/orchestrate` answers "what is each ticket's next action?" from label and merge state; it has no time dimension, so a ticket whose agent died in `ClaudeExecuting` nine days ago is indistinguishable from one that entered the state a minute ago. This command adds that axis and closes the loop.

**Single pass by design.** It does not sleep or self-loop — run it under the existing `/loop` skill for polling:

```
/loop 15m /triage-tickets
```

Division of labor:
- **Promotion** — delegated wholesale to `/orchestrate`. Do not reimplement the decision table.
- **Stagnation** — owned here, via the `detect-stagnation` CLI (`cli/lib/stagnation.js`).

## Arguments

`$ARGUMENTS`

Optional:
- `--status` — read-only. Print the digest, run nothing. Safe first invocation.
- `--scope KEY` — narrow to one container or ticket.
- `--no-promote` — skip the `/orchestrate` delegation; stagnation only.
- `--no-nudge` — detect and report stagnation, but take no nudge actions.
- `--in-flight-hours N` — abandoned-agent threshold (default 12).
- `--failed-days N` — unattended-failure threshold (default 3).
- `--pr-days N` — rotting-PR threshold (default 5).
- `--behind-commits N` — base-moved threshold (default 25).

Parse `$ARGUMENTS` into `STATUS_ONLY`, `SCOPE_KEY`, `NO_PROMOTE`, `NO_NUDGE`, and the four threshold numbers. Validate `SCOPE_KEY` against `^[A-Z][A-Z0-9_]+-\d+$`; on mismatch display `Invalid scope key: {value}.` and **stop**.

If `--status` is combined with `--no-promote` or `--no-nudge`, the extra flag is redundant — note it and continue.

---

## Step 1: Promotion pass

Skip this step entirely if `NO_PROMOTE` or `STATUS_ONLY` is set.

Use the **Skill** tool to run skill `orchestrate` with args `{SCOPE_KEY or ""} --no-loop`. `--no-loop` matters: `/orchestrate` re-surveys and loops up to 5 rounds on its own, and this command is already the loop body.

Capture from its final summary:
- actions run, with outcome per ticket
- the awaiting-approval and blocked/in-flight lists

Record as `PROMOTION_RESULTS`. If `/orchestrate` halts (Jira unreachable), record the reason and continue to Step 2 — stagnation detection is independent and still useful.

When `STATUS_ONLY` is set, instead run skill `orchestrate` with args `{SCOPE_KEY or ""} --status` so the digest shows what *would* be promoted.

---

## Step 2: Build the stacks snapshot

`detect-stagnation` consumes the same JSON shape as `classify-actions`, so this is the snapshot `/orchestrate` Step 2 already knows how to build.

Run the **Stack Context Resolution** sub-procedure (`commands/_shared-stack-procedures.md`) for each active container — or just `SCOPE_KEY` when scoped — exactly as `/orchestrate` Step 2 does. Enumerate containers with the same lifecycle JQL:

```
labels = "ClaudeWork" AND assignee = currentUser() AND statusCategory != Done
```

Per ticket, capture into the snapshot:

```json
{
  "container": { "key": "...", "featureBranch": "...", "parentFeatureBranch": "...", "unmergedBlockers": [] },
  "tickets": [
    { "key": "...", "branch": "...", "labels": [], "updatedAt": "<ISO>" }
  ]
}
```

`updatedAt` is the Jira `updated` field — request it explicitly in the issue fields, since the default field set used elsewhere omits it.

For any ticket carrying `ClaudeFailed`, also try to capture `failedSince`: the timestamp at which the label was applied, from the issue changelog (`mcp__atlassian__getJiraIssue` with `expand=changelog`, newest `ClaudeFailed` label addition). This matters because a drive-by comment bumps `updated` and makes an old failure look fresh. When the changelog is unavailable, omit the field — the CLI falls back to `updatedAt`.

Leave `lastCommitAt`, `lastActivityAt`, and `pr` **absent**. The CLI enriches them from git, gh, and the activity log; supplying them here would override the probes.

Write the snapshot to a temp file under `$CLAUDE_JOB_DIR/tmp` when that variable is set, otherwise the system temp dir.

If no active containers resolve, display `No active stacks found.` and skip to Step 5.

---

## Step 3: Detect stagnation

```bash
detect-stagnation --stacks-file <tmp-stacks.json> --repo-root {REPO_ROOT} \
  --in-flight-hours {N} --failed-days {N} --pr-days {N} --behind-commits {N}
```

Pass a threshold flag only when the user overrode it; the CLI owns the defaults.

Exit codes: `0` = nothing stagnant, `2` = at least one finding, `1` = error. Treat exit 2 as success — it is the signal, not a failure.

Parse stdout as JSON: `{ findings, byKind, counts }`. Findings arrive sorted worst-first. Each carries `key`, `kind`, `container`, `suggestedAction`, and `detail`.

If `REPO_ROOT` is unresolved for a stack, run without `--repo-root`: the PR and commit rules degrade to "cannot judge" and only the Jira-timestamp rules fire. Note the degradation in the digest rather than silently reporting fewer findings.

The three kinds:

| kind | means | suggestedAction |
|---|---|---|
| `abandoned-in-flight` | `ClaudePlanning`/`ClaudeExecuting`, no activity-log append, branch commit, or Jira update past the threshold — the label asserts a running agent that isn't | `clear-stale-in-flight` |
| `unattended-failure` | `ClaudeFailed` untouched past the threshold — surfaced daily by `/orchestrate`, addressed never | `escalate-failure` |
| `rotting-pr` | open PR untouched past the threshold, and/or its base moved far enough ahead that the diff under review is misleading | `ping-review` or `stack-rebase` |

---

## Step 4: Nudge

Skip if `STATUS_ONLY` or `NO_NUDGE`.

Nudges are deliberately conservative: they restore accurate state and leave a durable record. **No nudge writes code, force-pushes, or transitions a Jira status.** Anything heavier is a suggestion in the digest for the human to run.

For each finding, in the order returned:

### `abandoned-in-flight` → clear the stale label

The label is the actual damage: `ClaudeExecuting` makes the queue treat the ticket as claimed, so nothing else picks it up and it sits forever. Clearing it returns the ticket to the queue.

1. **Re-probe before acting.** The snapshot may be minutes old and an agent may have resumed. Re-read the ticket's labels and `updated`; if the label is gone or `updated` has moved since the snapshot, record `outcome: "recovered"` and move on.
2. Move the ticket back to `ClaudeReady`:
   ```bash
   set-ticket-state {KEY} --to ClaudeReady
   ```
   `set-ticket-state` clears the other progress labels, so this both drops the stale in-flight label and re-queues the work in one call.
3. Record why, so the next agent isn't confused by a ticket that silently regressed a state:
   ```bash
   append-activity {KEY} --heading "Stale in-flight label cleared by /triage-tickets" \
     --body "{detail}. Reset to ClaudeReady so the queue can pick it up again."
   ```

Never clear an in-flight label without the activity-log entry — an unexplained state regression is worse than the stale label.

### `unattended-failure` → escalate, do not auto-fix

`/fix-drift` and `/rework` both mutate the branch, and `/rework` is destructive. Neither is appropriate unattended.

Append one activity entry recording the age, then surface the ticket in the digest's **Needs a decision** section with its options (`/fix-drift`, `/rework`, `/prune`). Append at most one escalation entry per ticket per day — check the existing `[claude-activity-log]` for a prior "Unattended failure" heading within the last 24h and skip if present, so a 15-minute loop doesn't spam the ticket.

### `rotting-pr` → rebase when mechanical, otherwise report

- `suggestedAction: "stack-rebase"` — the base moved. Use the **Skill** tool to run skill `stack-rebase` with args `{KEY}`. It owns its own conflict handling and refuses cleanly; record whatever it reports. Do **not** attempt conflict resolution here.
- `suggestedAction: "ping-review"` — nobody has touched the PR. There is no safe automated nudge (posting to a PR is outward-facing and reviewer-pinging is the user's call), so report it in the digest only.

Record each nudge into `NUDGE_RESULTS` as `{ key, kind, action, outcome, note }` with `outcome` ∈ `success | failed | skipped | recovered`.

A nudge that throws is recorded and skipped — never abort the pass over one ticket.

---

## Step 5: Digest

Print one block. Keep it short enough to scan in a loop notification.

```
Triage — {N} stacks, {M} tickets    {timestamp}

Promoted ({count}):
  ✓ /cleanup KEY1 — branch deleted, Jira → Done
  ✓ /promote-to-main KEY2 — PR opened: {URL}
  ✗ /promote-to-main KEY3 — rebase conflict in path/file.ts

Stagnant ({count}):
  ⚠ KEY4  abandoned-in-flight   ClaudeExecuting, quiet 31.5h  → label cleared, re-queued
  ⚠ KEY5  unattended-failure    ClaudeFailed 9.2d             → needs a decision
  ⚠ KEY6  rotting-pr            PR #42 is 80 commits behind   → /stack-rebase run
  ⚠ KEY7  rotting-pr            PR #43 untouched 11.4d        → ping a reviewer

Needs a decision ({count}):
  - KEY5 — ClaudeFailed 9.2d. /fix-drift, /rework, or /prune?
  - KEY7 — PR #43 has had no review activity for 11.4d.

Awaiting your review ({count}):
  - KEY8 — stack ready, PR open and waiting on review

Degraded:
  - EPIC-3 — repo root unresolved; PR and commit rules skipped
```

Omit any empty section. When nothing at all needs attention, print a single line — a polling loop should be quiet when things are healthy:

```
Triage — {N} stacks, all healthy, nothing stagnant.    {timestamp}
```

---

## Error Handling

- Jira unreachable: report and stop. Every rule depends on Jira state.
- `detect-stagnation` exits 1: report stderr and skip Step 4; still print the promotion results from Step 1.
- `resolve-stack` fails for one container: mark that stack degraded, continue with the others.
- Never nudge a ticket twice in one pass.
- Never re-run a nudge that reported `failed` — surface it and let the next pass or a human retry.
- This command's only direct mutations are `set-ticket-state` and `append-activity`. Everything heavier is dispatched through a skill that already owns its safety checks.
