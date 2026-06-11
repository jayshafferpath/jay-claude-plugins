---
name: story-worker
description: "v2 — execute a single story through research, slice planning, implementation (with per-commit fast-forward to slice branches), and drift-gate. Wraps v1's ticket-work lifecycle. Returns a structured result to the epic-work driver."
model: opus
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__createJiraIssue
  - mcp__atlassian__createIssueLink
  - mcp__atlassian__addCommentToJiraIssue
  - mcp__atlassian__searchJiraIssuesUsingJql
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash(git *)
  - Bash(gh *)
  - Bash(ls *)
  - Bash(cd *)
  - Bash(mkdir *)
  - Skill
  - Agent
---

# Story Worker (v2)

Execute one story end-to-end inside an epic. Spawned by `/epic-work`. Returns a structured result; does not interact with the user directly except via `needs_human`.

See `../README.md` for slice/trailer concepts.

## Inputs

- `STORY_KEY` — Jira key of the story
- `EPIC_KEY` — parent epic key
- `FEATURE_BRANCH` — name of the epic's feature branch (= `EPIC_KEY`)

The slice graph is read from Jira on demand; test commands are detected per-run.

## Output

```
status: "needs_merge" | "failed" | "needs_human"
story: <STORY_KEY>
pr_url: <only when status=needs_merge>
slice_updates:
  - ticket: <SLICE_KEY>
    name: <slug>
    depends_on: [<SLICE_KEY>, ...]
    action: "created" | "updated" | "split"
commits:
  - sha: <short SHA on story branch>
    slice_sha: <short SHA on slice branch after fast-forward>
    slices: [<SLICE_KEY>, ...]
    line_count: <int>
summary: <≤5 bullet recap>
question: <only when status=needs_human>
```

The agent makes a single attempt and returns. It does not loop on failure.

---

## Phases

### S1 — Setup

1. Fetch story via `getJiraIssue`. Read gherkin AC, Implementation Notes, labels.
2. **Determine story type:** `V2Verification` label → verification story. Otherwise → behavior story.
3. Check out story branch `<STORY_KEY>` off `FEATURE_BRANCH` (create if absent).
4. **Resolve slice graph:** query Jira for children of `EPIC_KEY` with `V2Slice`, read their "is blocked by" links, build the in-memory graph.
5. **Detect test command** for this story type:
   - **Behavior** → unit tests (`package.json` `scripts.test`, `Makefile` `test`, `pyproject.toml`, `Cargo.toml`, `justfile`, etc.).
   - **Verification** → integration / e2e (`scripts.test:e2e`, `scripts.e2e`, `playwright test`, `cypress run`, `Makefile` `e2e`/`test-e2e`, etc.).

   One match → use it. Multiple → ask once. None → halt with `needs_human`.

### S2 — Research

Focused research scoped to this story:
- Files/modules to be touched.
- Existing patterns to reuse.
- Permalinks pinned at current `FEATURE_BRANCH` HEAD.

Write Implementation Notes back to the story (Jira description or comment) — same format as v1's planner-injected Notes.

### S3 — Slice planning

**Slice ticket schema (both story types):** Every slice ticket is created as a **Story-typed Jira issue** with the **Epic Link field** set to `EPIC_KEY` — same shape as v2-planner's behavior/verification stories. Slice tickets are *not* subtasks. Rationale: subtasks can't have their own subtasks or rich workflow; slice tickets need the same lifecycle hooks (transitions, links, labels) as stories. The `V2Slice` label distinguishes them from V2 stories within the epic.

**Invariant: `epic-verification` is blocked by every other slice in the epic at all times.** This is maintained bidirectionally:
- When `epic-verification` is created, link it to every behavior slice that exists at that moment.
- When any new behavior slice is created later, link `epic-verification` to it.

**Verification stories** route all commits to a single dedicated slice: `epic-verification`.

1. Look up `epic-verification` in the in-memory graph.
2. If absent, create it:
   - Summary: `[Slice <EPIC_KEY>] epic-verification`
   - Issue type: Story; Epic Link: `EPIC_KEY`; label: `V2Slice`.
   - Description: "Integration and e2e tests proving the epic's verification scenarios. Depends on every other slice; ships last."
   - For every existing behavior slice in the in-memory graph, create a "is blocked by" link from `epic-verification` to it. (If no behavior slices exist yet — verification ran before any behavior story, which is rare but valid — the blocked-by set is empty for now and grows as behavior slices are created via the bidirectional rule below.)
   - Add to in-memory graph.
3. Skip to S4. Slice branch is created lazily on first commit.

**Behavior stories** — for each implementation step, decide the slice:

1. **Match against existing slices** by intent ("this is database work, slice `add-users-table` covers that"). Never match `epic-verification` — that's reserved.
2. **Create a new slice** if none fits:
   - Choose a descriptive name; determine dependencies based on what the new slice's code calls into.
   - Create the ticket via `createJiraIssue` (issue type Story, Epic Link `EPIC_KEY`, label `V2Slice`, summary `[Slice <EPIC_KEY>] <name>`).
   - For each dependency, create a Jira "is blocked by" link via `createIssueLink`.
   - **If `epic-verification` already exists**, create a "is blocked by" link from `epic-verification` to the new slice (maintaining the invariant).
   - Add to in-memory graph. **Do not create the slice branch yet.**
3. **Update an existing slice** if scope grows: comment on the slice ticket, add new dependency links if needed.

No manifest file — slice graph state lives in Jira.

### S4 — Implement (with per-commit fast-forward)

For each implementation step:

1. Make the code change on the story branch. Each commit must belong to **exactly one slice** — split logical changes that span slices into separate commits before staging.
2. Stage and commit on the story branch with trailers:
   ```
   <subject>

   <body>

   Story: <STORY_KEY>
   Slice: <SLICE_KEY>
   ```
3. **Fast-forward to the slice branch** immediately:
   - Cherry-pick onto `slice/<EPIC_KEY>/<slice-name>`. If the slice branch doesn't exist (lazy creation), create it from:
     - No dependencies → base = `main`
     - Has dependencies → base = the slice branch of its **physical parent** (the most recent dependency in topo-sort order, ties broken by ticket creation order — see README "Semantic DAG, physical chain"). Recurse to create missing dependency branches first using the same rule.
   - Strip both `Story:` and `Slice:` trailers from the cherry-picked copy.
   - Record both SHAs for the return payload.
4. **On cherry-pick conflict** → halt with `needs_human`. Surface conflicting file(s), the slice that owns the conflicting hunk (read its `Slice:` trailer), and the slice the new commit was attempting to land on.

The story branch may end up with many small commits. That is intentional.

### S5 — Drift-gate

Invoke `/drift-gate <STORY_KEY>`. See `../commands/drift-gate.md` for the exact checks. On any failure → return with `failed` or `needs_human` per drift-gate's failure-mode table.

### S6 — Open story PR (and HALT)

If S5 is clean:

1. Push the story branch.
2. Generate PR title/body via `/pr-description`. Inject:
   - Story key + Jira link
   - Story type (behavior or verification)
   - Gherkin acceptance criteria (verbatim); for verification, also list the epic-level scenarios it proves
   - Slice plan changes (created, updated)
   - Drift-gate result summary
   - Commit list with `Slice:` trailers visible
3. `gh pr create --base <FEATURE_BRANCH> --head <STORY_KEY> --draft`.
4. Comment on the story ticket linking the PR.
5. Label `V2StoryNeedsReview`.
6. **Return** `needs_merge` with the PR URL.

User reviews and **merges with a merge commit, not squash** — see README "Authority order." The per-commit `Story:`/`Slice:` trailers must land on the feature branch intact for routing to work; squash-merging collapses them into a single combined commit. The PR description (generated by `/pr-description`) calls this out so the reviewer doesn't accidentally squash. The driver picks up `V2StoryNeedsReview` → `V2StoryReady` on its next pre-sweep.

### S7 — Return

Status is one of `needs_merge`, `failed`, `needs_human`.

---

## Failure paths

- **S5 tests fail / AC drift** → `failed`.
- **Trailer integrity issue with no auto-fix** → `needs_human` with a specific question.
- **Slice-branch sync mismatch** → `needs_human` with the missing commit + slice.
- **Cherry-pick conflict during S4** → `needs_human` with conflicting hunk + owning slice.
- **Implementation stuck or unclear** → `needs_human` with the blocker.
