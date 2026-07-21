---
description: "Quick mode of /ticket-work: forces complexity:trivial on the ticket and delegates to /ticket-work. Skips /plan-ticket, the refactor pass, and the /jay-pr-review plan. Single-ticket only — no queue mode, no Story expansion. Use for mechanical edits, doc tweaks, dep bumps, and small changes where the auto-classifier would otherwise choose 'standard'."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - Bash(append-activity *)
  - Bash(sync-checklist *)
  - Skill
---

# Ticket Work — Quick Mode

Force-marks a Jira ticket as `complexity:trivial`, then runs the standard `/ticket-work` lifecycle. The trivial complexity tier is what does the actual work — see `commands/ticket-work.md` for the full behavior. This command exists so a human can override the S3.4 auto-classifier (specifically its "bias-toward-standard veto" on words like `auth`, `migration`, `schema`, etc.) when they know a change is genuinely small.

## What quick mode skips

All skips come from `complexity:trivial` behavior already documented in `commands/ticket-work.md`:

- **S4.1** `/plan-ticket` — pre-marked done at seed time with `(skipped: trivial)`.
- **S4.2** collapses to **no-plan mode** — single-batch implementation, one commit, Gherkin coverage still required.
- **S4.4** `@refactor` agent — pre-marked done with `(skipped: trivial)`.
- **S4.5** `/jay-pr-review` plan — pre-marked done with `(skipped: trivial)`.

Everything else runs: drift check (S3.5), AC verification (S4.3), stage-squash protocol, activity log, and the standalone-ticket PR flow (S4.7 gate + S4.8–S4.10) or the feature-branch flow (S4.6b) as applicable.

## Arguments

$ARGUMENTS

Required: a single Jira ticket key (e.g., `PROJ-123`). Optionally followed by `--serial` to compose with serial mode.

Quick mode is deliberately single-ticket. Story expansion, Epic walking, and queue mode all live in `/ticket-work`; if the user wants those, they should invoke `/ticket-work` directly (parents that inherit `complexity:trivial` from a durable label are the intended path for bulk trivial work — this command is for one-off overrides).

## Steps

### 1. Parse arguments

Split `$ARGUMENTS` on whitespace. The first non-flag token is `TICKET_KEY`. Any `--serial` flag is preserved and forwarded to `/ticket-work`. Reject if:

- No ticket key was provided — display: "Quick mode requires a ticket key. Usage: `/ticket-work-quick PROJ-123 [--serial]`" and **stop**.
- More than one ticket key was provided — display: "Quick mode is single-ticket only. For multiple tickets, add `complexity:trivial` to each in Jira and run `/ticket-work`." and **stop**.

### 2. Fetch the ticket

- Use `mcp__atlassian__getAccessibleAtlassianResources` to get `CLOUD_ID`.
- Use `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}` to load the ticket and its labels.

### 3. Force complexity:trivial

Inspect the ticket's labels:

- If `complexity:trivial` is already present: display "Already `complexity:trivial` — no relabel needed." and continue to step 4.
- If `complexity:standard` is present: replace it. Call `mcp__atlassian__editJiraIssue` with `update: { "labels": [{"remove": "complexity:standard"}, {"add": "complexity:trivial"}] }`.
- If neither is present: call `mcp__atlassian__editJiraIssue` with `update: { "labels": [{"add": "complexity:trivial"}] }`.

Then append to the activity log:

```bash
append-activity {TICKET_KEY} --heading "Quick mode: forced complexity:trivial" --body "Human override via /ticket-work-quick. Skipping /plan-ticket, @refactor, and /jay-pr-review. See ticket-work.md 'Complexity Tiers' for the exact skip set."
```

### 4. Refresh the checklist if needed

If a `[claude-checklist-sync]` comment already exists on the ticket with `complexity:standard` in its frontmatter, the seeded checklist has the wrong skips baked in. Clear it so `/ticket-work` re-seeds fresh against the new tier:

- Read the checklist via `sync-checklist {TICKET_KEY} --read`.
- If the response indicates a checklist exists (has `steps`) AND its `complexity` field is `standard` (or absent), delete the managed comment. The simplest path: `sync-checklist {TICKET_KEY} --clear` if the CLI supports it; otherwise fall through and let `/ticket-work` handle it — the S3.4 skip inside `ticket-work.md` describes the re-seed logic and knows to no-op when progress has already been made on non-1/4/5/6 steps.

If no checklist exists yet, skip this step — `seed-checklist` will produce the trivial-tier variant on first pickup.

### 5. Hand off to /ticket-work

Use the Skill tool to run skill `ticket-work` with args `{TICKET_KEY}` (append ` --serial` if the flag was present). Everything downstream — S1 environment detection, drift check, trivial-mode execute, AC verification, PR flow — runs exactly as documented in `commands/ticket-work.md`.

Quick mode adds nothing else. Its only job is to flip the label and delegate.

## When NOT to use this

- Anything touching `migrations/`, `auth/`, `security/`, `iam/`, `infrastructure/`, `terraform/`, `permissions/`, or `compliance/` — the S3.4 veto exists for a reason. If you're overriding it, you're accepting the review-surface loss.
- Multi-file refactors — even if each file is small, the coordination is what a plan buys you. Let the classifier land on `standard`.
- Tickets with more than a couple of Gherkin scenarios — no-plan mode's single-batch test authoring works best with 0–1 scenarios.

If any of these apply, run `/ticket-work {KEY}` and let S3.4 classify it, or manually apply `complexity:standard` before running.
