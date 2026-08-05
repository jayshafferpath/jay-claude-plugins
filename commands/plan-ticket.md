---
description: "Lightweight plan generator for a Jira ticket. Reads AC + Implementation Notes from Jira, verifies the surfaces against the working tree, and writes a short implementation checklist to Jira as a managed plan comment. No EARS."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - Bash(sync-plan *)
  - Bash(mktemp *)
  - Bash(rm *)
  - Read
  - Write
  - Glob
  - Grep
  - Agent
---

# /plan-ticket

Generate a short, focused implementation plan for a Jira ticket and sync it to Jira. Replaces the heavy `/jira-start` workflow inside `/ticket-work` S4.1 with something that fits this plugin's ecosystem:

- **State lives in Jira**, not in `.plans/`. The plan is a managed Jira comment (`sync-plan`).
- **No EARS expansion.** Acceptance criteria already exist on the ticket as Gherkin; restating them as EARS adds ceremony without information.
- **This is where file-level design happens.** The planner's Implementation Notes describe how the code works *today* at a pinned SHA — they deliberately don't name the files a change touches (see `agents/planner.md` Principle 7). Deciding which files change, in what order, and how work is bundled requires the working tree at current HEAD, which only this command has. So a bounded research pass belongs here.
- **Bounded research, not a re-survey.** The Notes give you the terrain — start from their permalinks and surfaces rather than exploring from scratch. Verify what they claim, then extend only as far as the AC requires.
- **No persistent local plan file.** A short markdown file is written to a tmp path, synced, then deleted.

The output is a checklist of 3-7 implementation tasks grounded in the AC and verified against the working tree, framed as `- [ ] task` bullets so `sync-plan` can read progress back via `--read` and `--mark-done`.

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
- `*How this works today:*` — bullet list of `symbol — path:line — what it does today` entries. (Legacy tickets: `*Existing patterns to extend:*`.)
- `*Relevant surfaces:*` — bullet list of paths or directories where the relevant code lives. (Legacy tickets: `*Files likely to change:*`.)
- `*Existing test coverage:*` — bullet list of test paths and how they're structured. (Legacy tickets: `*Tests likely to extend:*`.)
- `*Constraints:*` — bullet list of constraints, often citing TDD requirements.

Accept both spellings — tickets created before the Notes format changed are still in flight.

Store each as an array of bullets. These are **orientation, not a design**: the planner recorded what existed at the baseline SHA and deliberately stopped short of naming the files a change touches. Do not treat `*Relevant surfaces:*` as a change manifest or map tasks 1:1 onto it — a directory entry like `src/cmd/` means "handlers live here", not "one task per file in here". `*Constraints:*` is the exception: those are binding, and the plan must respect them.

### 2c: TDD Reference

Locate `h2. TDD Reference` if present — capture path + anchor. The plan header should link to it.

---

## Step 2.5: Ground the plan in the working tree

The Notes describe the baseline SHA; you're planning against current HEAD in the actual working directory. This step turns orientation into a concrete change surface. **Keep it bounded — this is a verification pass over ground the planner already mapped, not a fresh survey.**

1. **Read the cited code.** For each `*How this works today:*` bullet, `Read` the cited path at the lines given (or `Grep` the symbol if the lines have moved). Confirm the described behavior still holds. This is usually 2-5 files and is the highest-value part of the step.
2. **Resolve surfaces to files.** For each `*Relevant surfaces:*` entry: if it's a file, confirm it exists; if it's a directory, `Glob` it to see what's actually inside and identify the specific files the AC implicates. This is where the file list gets *created* — by looking, not by inheriting a guess.
3. **Locate the test surface.** From `*Existing test coverage:*`, find the suite you'll extend and read enough of it to match its structure (table-driven vs per-case, fixture setup, helper imports). If the Notes say coverage is absent, find the nearest sibling suite and follow its conventions rather than inventing a layout.
4. **Only if the AC names behavior the Notes don't cover**, spawn one `Explore` subagent with a narrow question to find it. Cap at one — if a single scoped Explore can't locate it, the ticket's AC and its research have diverged, which is a drift problem (`/refresh-research`), not something to paper over with a guessed plan.

Bind the result as `SURFACE` — the concrete list of files this change touches, each with a one-line reason, derived from what you just read. **`SURFACE` is yours, not the ticket's.** If it diverges from the Notes' surfaces (a module moved, the real entry point is elsewhere, the change is wider or narrower than the terrain suggested), that's expected and correct — note the divergence in the plan's `## Notes` section so the reviewer sees the reasoning. Do not edit the ticket's Implementation Notes to match; those record the research baseline and `drift-check` compares against them.

---

## Step 3: Compose the plan

Synthesize a short markdown plan. **Hard ceiling: 7 implementation tasks.** Aim for 3-5. Each task is a single `- [ ]` checklist item with one short sentence describing what changes and where.

### Task-derivation rules

1. **One task per coherent change in `SURFACE`** (from Step 2.5) — group files that move together for one reason (a handler and its test, a type and its consumer) into a single task. Task count follows the shape of the change you found, not the length of any list in the ticket.
2. **Order tasks so each leaves the tree working** where the change allows it. Prefer the sequence that gets to a passing test earliest. Don't impose a data-model → API → UI ordering by default; that's one strategy among several and the AC rarely requires it.
3. **Fold tests into the code task they cover** ("Update `foo.ts` + extend `foo.test.ts`"). Give tests their own task only when the test surface is genuinely separate — a new integration suite, or coverage spanning several of the code tasks.
4. **Add one task for documentation / OpenAPI / config** only if the AC explicitly requires it. Don't add boilerplate "update CHANGELOG" tasks.
5. **Drop everything else.** No "review requirements", no "research patterns", no "manual testing". Those are not implementation tasks.

### Wording

Each task should:
- Start with a verb: `Add`, `Update`, `Wire`, `Extract`, `Replace`, `Remove`, `Cover`.
- Name the file or path explicitly: `Add Retry-After header logic to src/server/routes/tasks.ts`.
- Stay under ~100 chars. If you need more, the task is too big — split it.

### When Implementation Notes is sparse or missing

If the ticket has AC but no Implementation Notes (or only a stub), Step 2.5 has no terrain to start from. Widen it rather than guessing:
- Spawn one `Explore` subagent scoped to the AC's domain to locate the relevant code, then run Step 2.5's read-and-resolve passes over what it finds.
- Derive tasks from the resulting `SURFACE` as usual.
- Prefix the plan header with: `> No Implementation Notes on the ticket — surfaces located by direct exploration at HEAD.`

This costs one extra subagent, not a wrong plan. It should still be uncommon — `/prework`'s drift check plus planner Phase 5.0 mean most tickets arrive with orientation.

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

   {one-line note ONLY when the header carries a degraded-mode warning, when SURFACE
    diverged from the ticket's Implementation Notes (say how and why), or when an unusual
    bundling decision was made — e.g. "Bundling routes + middleware in one task because
    they share the same Express plugin." Skip the section entirely otherwise.}
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

If the ticket had no Implementation Notes, append:

```
  ⚠ No Implementation Notes on the ticket — surfaces located by direct
    exploration at HEAD. Review the plan in Jira before letting execute proceed.
```

If `SURFACE` diverged from the ticket's Implementation Notes, append:

```
  ℹ Plan surface differs from the ticket's Implementation Notes ({what moved}).
    Notes record the research baseline and were left unchanged; run
    /refresh-research {TICKET_KEY} if the baseline itself looks stale.
```

---

## Error handling

- **No AC and no Implementation Notes** → stop with the message in Step 1. Do not write an empty plan.
- **`sync-plan` fails** → surface the error verbatim. Do not retry silently. Leave the tmp file in place for inspection and tell the user the path.
- **Plan already exists in Jira** (`sync-plan --read` returns non-empty) — this command is destructive of the prior plan. The caller (`/ticket-work`) is responsible for skip-when-present; if invoked directly by the user with an existing plan, ask via `AskUserQuestion` whether to overwrite before syncing.

---

## What this command does NOT do

- Move Jira status (`/ticket-work` S4.1 handles `ClaudePlanning` transition).
- Re-survey the codebase from scratch. Step 2.5 verifies and extends the planner's orientation; it is capped at one `Explore` subagent (widened only when the ticket has no Implementation Notes at all).
- Edit the ticket's Implementation Notes. Those record the research baseline that `drift-check` compares against — divergences go in the plan's `## Notes`, and a genuinely stale baseline is `/refresh-research`'s job.
- Write to `.plans/` or any persistent local path.
- Append to the activity log (`/ticket-work` S4.1 handles the activity comment).
- Squash stage commits (`/ticket-work` S4.1 handles `stage-squash`).

Those responsibilities stay with the caller. This command is a single-purpose plan composer.
