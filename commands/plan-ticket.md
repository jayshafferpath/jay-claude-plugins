---
description: "Lightweight plan generator for a Jira ticket. Reads AC + Implementation Notes from Jira, writes a short implementation checklist to Jira as a managed plan comment. No EARS, no codebase research — that work belongs upstream in planner/TDD."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - Bash(sync-plan *)
  - Bash(mktemp *)
  - Bash(rm *)
  - Read
  - Write
---

# /plan-ticket

Generate a short, focused implementation plan for a Jira ticket and sync it to Jira. Replaces the heavy `/jira-start` workflow inside `/ticket-work` S4.1 with something that fits this plugin's ecosystem:

- **State lives in Jira**, not in `.plans/`. The plan is a managed Jira comment (`sync-plan`).
- **No EARS expansion.** Acceptance criteria already exist on the ticket as Gherkin; restating them as EARS adds ceremony without information.
- **No Explore subagent.** Codebase research is the `planner` phase's job (Implementation Notes). This command consumes that research, not duplicates it.
- **No persistent local plan file.** A short markdown file is written to a tmp path, synced, then deleted.

The output is a checklist of 3-7 implementation tasks grounded in the ticket's Implementation Notes, framed as `- [ ] task` bullets so `sync-plan` can read progress back via `--read` and `--mark-done`.

---

## Arguments

$ARGUMENTS

Required: a Jira ticket key (e.g. `PROJ-123`).

Optional flags:
- `--base <branch>` — informational only; included in the plan header so reviewers know where the branch will land. Default: current branch's tracking base, or `main`.

---

## Step 1: Resolve cloud + ticket

1. Call `mcp__atlassian__getAccessibleAtlassianResources` → `CLOUD_ID` (first resource).
2. Call `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`. Extract:
   - `summary`, `description`, `issuetype.name`, `priority.name`
   - `parent` (Epic/Story) if present
   - `status.name`

If the ticket has neither Acceptance Criteria nor Implementation Notes, display `"Ticket {TICKET_KEY} has no AC or Implementation Notes — cannot plan. Run /prework or have planner generate Implementation Notes first."` and stop.

---

## Step 2: Parse ticket signals

Parse the description into three buckets:

### 2a: Acceptance Criteria

Locate the `h2. Acceptance Criteria` block (or `## Acceptance Criteria` in markdown-formatted descriptions). Extract Gherkin scenarios — fenced `gherkin`/`feature` blocks, or bare `Given/When/Then` triples. Store the raw text as `AC_RAW` and a count of distinct scenarios as `AC_SCENARIO_COUNT`.

### 2b: Implementation Notes

Locate the `h2. Implementation Notes` block. Extract these subsections (any may be absent):

- `Research baseline` — repo SHA(s) the planner used.
- `*Existing patterns to extend:*` — bullet list of `symbol — path:line — why` entries.
- `*Files likely to change:*` — bullet list of file paths with one-line rationale.
- `*Tests likely to extend:*` — bullet list of test paths.
- `*Constraints:*` — bullet list of constraints, often citing TDD requirements.

Store each as an array of bullets. Treat `*Files likely to change:*` and `*Existing patterns to extend:*` as the **design backbone** — the plan tasks should map roughly 1:1 onto file groupings here.

### 2c: TDD Reference

Locate `h2. TDD Reference` if present — capture path + anchor. The plan header should link to it.

---

## Step 3: Compose the plan

Synthesize a short markdown plan. **Hard ceiling: 7 implementation tasks.** Aim for 3-5. Each task is a single `- [ ]` checklist item with one short sentence describing what changes and where.

### Task-derivation rules

1. **One task per file group in `*Files likely to change:*`** — if two files have the same purpose (e.g., a service and its test), bundle them into one task.
2. **Add one task for tests** if `*Tests likely to extend:*` lists separate test surfaces from `*Files likely to change:*`. Otherwise fold tests into the matching code task ("Update `foo.ts` + add tests in `foo.test.ts`").
3. **Add one task for documentation / OpenAPI / config** only if the AC explicitly requires it. Don't add boilerplate "update CHANGELOG" tasks.
4. **Drop everything else.** No "review requirements", no "research patterns", no "manual testing". Those are not implementation tasks.

### Wording

Each task should:
- Start with a verb: `Add`, `Update`, `Wire`, `Extract`, `Replace`, `Remove`, `Cover`.
- Name the file or path explicitly: `Add Retry-After header logic to src/server/routes/tasks.ts`.
- Stay under ~100 chars. If you need more, the task is too big — split it.

### When Implementation Notes is sparse or missing

If the ticket has AC but no Implementation Notes (or only a stub):
- Derive tasks directly from Gherkin scenarios — one task per `Given` clause's setup target, collapsed where two scenarios touch the same surface.
- Include a single trailing task: `Add tests covering all AC scenarios.`
- Prefix the plan header with a one-line note: `> Plan derived from AC only — no Implementation Notes available. Surface files may be wrong; revise after first read of the codebase.`

This is a degraded mode and should be rare — `/prework`'s drift check + planner Phase 5.0 should ensure Implementation Notes exist for most tickets.

---

## Step 4: Write + sync

1. Create a tmp file:
   ```bash
   PLAN_FILE=$(mktemp -t plan-{TICKET_KEY}.XXXXXX.md)
   ```
2. Write the following content to `$PLAN_FILE` via the `Write` tool:

   ```markdown
   # Plan: {TICKET_KEY} — {SUMMARY}

   **Base branch**: {BASE_BRANCH}
   **TDD**: {tdd_path}#{tdd_anchor}  ← only if present
   **Issue type**: {ISSUE_TYPE}  •  **Priority**: {PRIORITY}

   ## Implementation tasks

   - [ ] {task 1}
   - [ ] {task 2}
   - [ ] {task 3}
   ...

   ## Notes

   {one-line note ONLY when degraded-mode plan or when an unusual decision was made,
    e.g. "Bundling routes + middleware in one task because they share the same Express plugin."
    Skip the section entirely otherwise.}
   ```

   No EARS section. No "Testing Strategy" section. No "Documentation Updates" section. No "Research Phase" section. Keep it under ~30 lines including the header.

3. Sync to Jira:
   ```bash
   sync-plan {TICKET_KEY} --file $PLAN_FILE
   ```
   The CLI counts `- [ ]` / `- [x]` tasks and reports `n/m complete`.

4. Delete the tmp file:
   ```bash
   rm -f $PLAN_FILE
   ```

The Jira plan comment is now the source of truth. `/ticket-work` S4.2 reads it via `sync-plan {TICKET_KEY} --read` and drives Red-Green-Refactor per task.

---

## Step 5: Display summary

Output:

```
Plan generated for {TICKET_KEY}: {n} implementation tasks
  Synced to Jira as managed plan comment.
  Next step: /ticket-work resumes at S4.2 (execute).
```

If degraded mode was used, append:

```
  ⚠ Plan derived from AC only — Implementation Notes were missing.
    Review the plan in Jira before letting execute proceed.
```

---

## Error handling

- **No AC and no Implementation Notes** → stop with the message in Step 1. Do not write an empty plan.
- **`sync-plan` fails** → surface the error verbatim. Do not retry silently. Leave the tmp file in place for inspection and tell the user the path.
- **Plan already exists in Jira** (`sync-plan --read` returns non-empty) — this command is destructive of the prior plan. The caller (`/ticket-work`) is responsible for skip-when-present; if invoked directly by the user with an existing plan, ask via `AskUserQuestion` whether to overwrite before syncing.

---

## What this command does NOT do

- Move Jira status (`/ticket-work` S4.1 handles `ClaudePlanning` transition).
- Run the Explore subagent or codebase research.
- Write to `.plans/` or any persistent local path.
- Append to the activity log (`/ticket-work` S4.1 handles the activity comment).
- Squash stage commits (`/ticket-work` S4.1 handles `stage-squash`).

Those responsibilities stay with the caller. This command is a single-purpose plan composer.
