---
description: "v2 — verify and push the slice branches built up during Phase 2 as a stack of layered PRs to main. Slice branches already exist (story-worker fast-forwarded each commit during execution); this verifies, pushes, and opens PRs."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - mcp__atlassian__createIssueLink
  - Bash(git *)
  - Bash(gh *)
  - Bash(ls *)
  - Bash(cd *)
  - Read
  - Write
---

# Epic Finalize (v2)

Open the stacked slice PRs to main. Invoked by `/epic-work` Phase 3, or directly when all stories have merged to the feature branch.

Story-worker fast-forwarded each commit onto its slice branch during Phase 2, so this is mechanical: verify, run tests, push, open PRs. **No cherry-picking happens here.**

## Arguments

`$ARGUMENTS` — required: `<EPIC_KEY>`.

## Pre-conditions

- Epic has `V2EpicSlicing` (or `V2EpicPlanApproved` with all stories `V2StoryReady`).
- Feature branch `<EPIC_KEY>` exists and is up-to-date.
- At least one slice ticket exists in Jira.
- Working tree clean.

## Algorithm

### F1 — Resolve and validate slice graph

1. Query Jira for children of `<EPIC_KEY>` with `V2Slice`. Read each slice's "is blocked by" links.
2. For each slice:
   - Verify slice branch `slice/<EPIC_KEY>/<slice-name>` exists locally (slice name parsed from `[Slice <EPIC_KEY>] <slice-name>`).
   - Verify at least one feature-branch commit has a `Slice:` trailer matching this ticket.
3. Verify the dependency graph is acyclic.
4. **Linearize.** Topo-sort with ties broken by ticket creation order (oldest first). The result is a total order; every slice has exactly one "physical parent" — the most recent dependency in this order. See README "Semantic DAG, physical chain."

### F2 — Per-slice verification (no cherry-picking)

For each slice in topo order:

1. **Confirm slice branch is in sync.** For every feature-branch commit with `Slice: <SLICE_KEY>`, confirm a corresponding commit exists on the slice branch (matched by author/date/subject after trailer strip). Missing → halt. Recovery: `/v2-rework <STORY_KEY>` for the story that owned the missing commit, or manual cherry-pick.
2. **Verify base.**
   - No dependencies → base must be `main`.
   - Has dependencies → base must be the slice branch of the **physical parent** (the most recent dependency in F1's linearized order). Other dependencies are documentation-only — they're recorded in Jira but the chain only follows the physical parent.
   - Wrong base → rebase onto the correct base. Halt on rebase conflict.
3. **Run the project's test command** against the slice branch (detected per-run, same heuristics as story-worker).
   - On failure → halt with which slice failed and test output. Recovery: `/v2-rework <SLICE_KEY>` or manual fix.
4. **Push** `slice/<EPIC_KEY>/<slice-name>` to origin.

### F3 — PR creation (per slice, in topo order)

Reuses v1's per-ticket PR flow, applied per slice. For each slice:

1. **Generate description** — invoke `/pr-description` against the slice branch's diff vs its base. Returns `{title, body}` following the team's template.
2. **Inject slice-specific sections:**
   - Link to slice ticket
   - Link to epic
   - List of stories that contributed commits (from the original `Story:` trailers on feature-branch copies)
3. **Open PR** — `gh pr create --base <base> --head slice/<EPIC_KEY>/<slice-name> --draft`. Base is `main` for root slices, else the most recent dependency's slice branch.
4. **Run finalize** — invoke `/finalize` against the slice ticket. Posts the final description, sets ticket state, posts downstream-context for the next slice.
5. **Link PR ↔ ticket** — comment on slice ticket with PR URL; add slice ticket key to the PR description as a Jira link.
6. **Label** slice ticket `V2SliceReady`.

Sequential (later slice's `/finalize` can reference earlier slice's PR URL).

### F4 — Mark epic ready

1. Apply `V2EpicReady` to the epic, clear `V2EpicSlicing`.
2. Comment on the epic with slice count + PR URLs in stacked order + recommended merge order (top of stack first).

---

## Recovery patterns

- **Slice branch out of sync** — fast-forward dropped a commit. Halt with which commit + which slice. Recovery: `/v2-rework <STORY_KEY>` (re-runs the story, re-fast-forwards) or manual `git cherry-pick <SHA>` onto the slice branch + retest.
- **Verification fails on a slice** — `/v2-rework <SLICE_KEY>` (deletes the slice branch, walks the slice graph, reopens contributing stories so their commits get re-fast-forwarded), or fix manually.
- **Slice ticket has no contributing commits** — likely the contributing story was pruned. User cancels via `/v2-prune <SLICE_KEY>` and re-runs.
- **Slice branch rebase fails** — human task. Resolve and re-run `/epic-finalize`.
- **Slice branch already pushed** — push is idempotent if not diverged. Diverged → halt and ask before force-pushing.

---

## Stacked PR mechanics (post-finalize)

Once Phase 3 has cut the stack, the feature branch is sealed. New commits live on slice branches.

**After a slice PR merges:** user runs `/v2-cleanup <SLICE_KEY>`. Verifies the slice landed on main, transitions the ticket, deletes the branch, **cascade-rebases** the rest of the stack onto main, comments on the epic.

If a downstream slice no longer compiles after rebase, CI surfaces it; user runs `/address-feedback` against the failing slice.

**Reviewer comments on a slice PR:** see `address-feedback.md`. Single pass; no Slice: trailer needed (branch identity is the slice).
