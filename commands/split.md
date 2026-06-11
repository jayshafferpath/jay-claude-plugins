---
description: "Split a ticket in the PR stage into multiple smaller tickets and PRs. The agent partitions the original branch's diff into coherent slices, creates a new sibling ticket per slice (sequentially stacked), opens a PR for each, then prunes the original."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__createJiraIssue
  - mcp__atlassian__createIssueLink
  - mcp__atlassian__getIssueLinkTypes
  - mcp__atlassian__getJiraIssueTypeMetaWithFields
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(gh *)
  - Bash(resolve-stack *)
  - Bash(ensure-pr *)
  - Bash(append-activity *)
  - Bash(sync-checklist *)
  - Bash(sync-plan *)
  - Read
  - Write
  - Grep
  - Glob
  - Skill
---

# Split

Split a ticket whose branch has an open PR into multiple smaller tickets and PRs.

The agent analyzes the diff on the ticket's branch, partitions it into coherent slices (the agent decides the slice boundaries — file-, commit-, or hunk-level — based on what the diff looks like), creates a new sibling ticket per slice (same parent container as the original, chained as a sequential stack via "Blocks" links), opens a PR per slice, then prunes the original ticket and PR.

Use when a ticket in code review has grown too big or too mixed, and the right move is to ship it as several smaller PRs rather than rework or merge as-is.

## Arguments

$ARGUMENTS

Required: a Jira ticket key (e.g., `PROJ-123`). The ticket must:
- Be at the PR stage (i.e., have a branch with an open PR), and
- Have a `repo:` label (or be a child of a parent that does) so the repo root resolves, and
- Have a parent Story/Epic — the new sibling tickets will be created under the same parent.

---

## Step 1: Initialize

### 1a: Get Atlassian Cloud ID

- Use `mcp__atlassian__getAccessibleAtlassianResources`
- Store first resource `id` as `CLOUD_ID`

### 1b: Resolve Stack Context

Run:
```bash
resolve-stack {TICKET_KEY} --fetch
```

Parse the JSON output. Extract:
- `CONTAINER_KEY` = `container.key`
- `FEATURE_BRANCH` = `container.featureBranch` (may be null)
- `REPO_ROOT` = `container.repoRoot`
- `STACK_ORDER` = `stack` array
- Find this ticket's entry in `stack` and extract:
  - `BRANCH_NAME` = ticket's `branch`
  - `BASE_BRANCH` = ticket's `baseBranch`
  - `SUMMARY` = ticket's `summary`
  - `PARENT_KEY` = ticket's parent (Story/Epic) — typically `CONTAINER_KEY`. If the ticket is a subtask, `PARENT_KEY` is its Story.

If `REPO_ROOT` is null: display "Cannot resolve repo root for {TICKET_KEY}. Ensure a `repo:` label is set on the ticket or its container." and **stop**.

If `BRANCH_NAME` is null: display "{TICKET_KEY} has no branch — nothing to split." and **stop**.

### 1c: Fetch Original Ticket Metadata

Use `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`. Extract:
- `PROJECT_KEY` (from `key` prefix)
- `ISSUE_TYPE` = `fields.issuetype.name`
- `LABELS` = `fields.labels` (filter out Claude* progress labels — those are not inherited)
- `COMPONENTS` = `fields.components`
- `PARENT` = `fields.parent` (if subtask)
- `DESCRIPTION_RAW` = `fields.description` (for reference when authoring split descriptions)

Determine `INHERITED_LABELS`:
- Keep `repo:*` labels (load-bearing for repo resolution).
- Drop all `Claude*` labels.
- Keep any other labels.

### 1d: Identify Downstream Dependents

Walk `STACK_ORDER` and collect tickets that list `{TICKET_KEY}` as a same-stack blocker (directly or transitively). Store as `DOWNSTREAM`.

If `DOWNSTREAM` is non-empty, splitting will require re-pointing those blocker links from `{TICKET_KEY}` to the **last** new split ticket (since the last split sits at the top of the new chain, replacing where the original sat in the stack).

---

## Step 2: Detect PR State

```bash
cd {REPO_ROOT} && gh pr view {BRANCH_NAME} --json url,state,number,baseRefName 2>/dev/null
```

- If output parses as JSON: store `pr.url`, `pr.state`, `pr.number`, `pr.baseRefName`. Set `ORIGINAL_PR_BASE = pr.baseRefName`.
- If no PR or state is not `OPEN`: display "{TICKET_KEY} does not have an open PR. /split is only for tickets at the PR stage." and **stop**.

If `pr.state` is `MERGED`: display "{TICKET_KEY} is already merged. Nothing to split." and **stop**.

---

## Step 3: Analyze the Diff and Propose Slices

### 3a: Gather Diff Context

```bash
cd {REPO_ROOT} && git fetch origin
git log --oneline origin/{ORIGINAL_PR_BASE}..origin/{BRANCH_NAME}
git diff --stat origin/{ORIGINAL_PR_BASE}...origin/{BRANCH_NAME}
git diff origin/{ORIGINAL_PR_BASE}...origin/{BRANCH_NAME}
```

Read the existing PR description for additional context: `gh pr view {BRANCH_NAME} --json body -q .body`.

### 3b: Propose Slices

The agent decides the slicing strategy. Choose the boundary unit based on what the diff actually looks like:

- **By files** — when distinct files map cleanly onto distinct concerns (e.g., DB migration in one file, API handler in another, frontend in a third).
- **By commits** — when the original PR was already well-committed and each commit (or commit range) represents a coherent slice.
- **By hunks (file + line ranges)** — only when a single file mixes changes belonging to different concerns and there is no other way to separate them. Avoid unless necessary.

Mix strategies if it gives a cleaner split (e.g., file-level for most, with one file split by hunks).

For each proposed slice, produce:
- `index` (1-based, defines stack order)
- `title` — a short, action-oriented summary
- `description` — what the slice does and why it's separable
- `assignment` — list of files / commit SHAs / hunks that go into this slice
- `rationale` — why this slice is coherent on its own and what makes it independently shippable

**Constraints when proposing slices:**
- Every change in the original diff must end up in exactly one slice — no overlap, no orphans.
- Slices must be sequenceable: slice N must build and pass review on top of slice N-1, with each prior slice merged. Order them so each slice's prerequisites are satisfied by earlier slices.
- Aim for 2–5 slices. If you cannot find 2 coherent slices, the ticket isn't actually splittable — display "Diff is too tightly coupled to split cleanly. Consider /rework instead." and **stop**.
- Prefer splits along architectural boundaries (data layer, API, UI, tests, config) rather than arbitrary file-count balancing.

Display the proposal to the user:

```
Split proposal for {TICKET_KEY}: {SUMMARY}

Original PR:    {PR_URL}
Original base:  {ORIGINAL_PR_BASE}
Parent ticket:  {PARENT_KEY}
Total changes:  {N} files, {+X/-Y} lines

Slicing strategy: {files | commits | hunks | mixed}

Slice 1: {title}
  Base:        {ORIGINAL_PR_BASE}
  Assignment:  {file list / commit SHAs / hunks}
  Rationale:   {one-line rationale}

Slice 2: {title}
  Base:        slice-1's branch
  Assignment:  ...
  Rationale:   ...

...

After split:
  - {N} new sibling tickets created under {PARENT_KEY}, chained via Blocks links
  - {N} new branches and PRs (each based on its predecessor)
  - Original ticket {TICKET_KEY} pruned (PR closed, status → Won't Do, ClaudePruned label)
{if DOWNSTREAM non-empty:
  - Re-point {DOWNSTREAM count} downstream blocker link(s) from {TICKET_KEY} to slice-{N} (top of new chain)
}

Type "confirm" to proceed, "revise" to adjust the slicing, or anything else to abort.
```

If the user types "revise", solicit specific feedback (e.g., "merge slices 2 and 3", "split slice 1 further by hunks") and re-propose. Loop until "confirm" or abort.

If the user does not confirm: display "Split aborted." and **stop**.

---

## Step 4: Pre-Flight Checks

Before mutating anything, verify:

### 4a: Working Tree Clean

```bash
cd {REPO_ROOT} && git status --porcelain
```

If non-empty: display "Working tree is dirty. Commit or stash before splitting." and **stop**.

### 4b: Branch is Up-To-Date with Remote

```bash
git rev-parse origin/{BRANCH_NAME}
git rev-parse {BRANCH_NAME}
```

If local and remote SHAs differ: display "Local {BRANCH_NAME} is out of sync with origin. Pull or push before splitting." and **stop**.

### 4c: Look Up "Blocks" Link Type

Use `mcp__atlassian__getIssueLinkTypes` with `cloudId={CLOUD_ID}`. Find the link type with `name === "Blocks"` and store its `id` (or use the name directly when calling `createIssueLink`, depending on what the MCP signature accepts).

---

## Step 5: Create New Sibling Tickets

Loop over slices in order (slice 1 first, slice N last). For each slice:

### 5a: Create the Jira Issue

Use `mcp__atlassian__createJiraIssue` with:
- `cloudId` = `CLOUD_ID`
- `projectKey` = `PROJECT_KEY`
- `issueTypeName` = `ISSUE_TYPE` (same as original — Subtask if the original was a subtask; else whatever the original was)
- `summary` = slice title
- `description` (Jira ADF or wiki markup matching project convention):
  ```
  h2. Context
  Split from [{TICKET_KEY}|{ATLASSIAN_BASE}/browse/{TICKET_KEY}] — slice {INDEX} of {TOTAL}.

  h2. Scope
  {slice description}

  h2. Assignment
  {file list / commit SHAs / hunks for this slice}

  h2. Rationale
  {why this slice is independently shippable}
  ```
- `additionalFields`:
  - `parent` = `{ key: PARENT_KEY }` (mirrors original)
  - `labels` = `INHERITED_LABELS` (no Claude* labels — the new ticket starts fresh)
  - `components` = `COMPONENTS` (from original)

Store the new ticket's key as `SLICE_KEYS[index]`.

### 5b: Link Sequential Blocker (if not the first slice)

For slice 2..N, create a "Blocks" link from `SLICE_KEYS[index-1]` → `SLICE_KEYS[index]`:
- `inwardIssueKey` = `SLICE_KEYS[index-1]` (blocker)
- `outwardIssueKey` = `SLICE_KEYS[index]` (blocked)
- `linkTypeName` = `"Blocks"`

This produces the sequential stack: slice 1 blocks slice 2 blocks slice 3, etc.

### 5c: Append Provenance Comment

Append an activity log entry on the new slice ticket explaining its origin:

```bash
append-activity {SLICE_KEYS[index]} --heading "Created via /split" --body "Split from {TICKET_KEY} — slice {INDEX} of {TOTAL}. Base branch: \`{slice base}\`. Original PR: {PR_URL}."
```

---

## Step 6: Create Branches and Apply Slice Diffs

For each slice in order, create its branch and stage its changes.

Branch naming: follow the existing convention (`{TICKET_KEY}-{kebab-summary}`). Derive the kebab-summary from the slice title (lowercase, alphanumerics + hyphens, max ~40 chars).

### 6a: Slice 1

```bash
cd {REPO_ROOT}
git checkout {ORIGINAL_PR_BASE}
git pull origin {ORIGINAL_PR_BASE}
git checkout -b {SLICE_BRANCH_1}
```

Apply slice 1's changes from the original branch:

- **By files**: `git checkout origin/{BRANCH_NAME} -- {file1} {file2} ...` then `git add` and commit.
- **By commits**: `git cherry-pick {sha1} {sha2} ...` (resolve conflicts as they arise).
- **By hunks**: `git checkout -p origin/{BRANCH_NAME} -- {file}` and accept only the hunks belonging to this slice. For programmatic application, use `git diff origin/{ORIGINAL_PR_BASE}...origin/{BRANCH_NAME} -- {file}`, extract the relevant hunks (write to a temp patch file), then `git apply {patch}`.

Commit with message: `{Slice 1 title}\n\nSplit from {TICKET_KEY}, slice 1 of {TOTAL}.`

### 6b: Slice 2..N

For each subsequent slice, base on the previous slice's branch:

```bash
git checkout {SLICE_BRANCH_{i-1}}
git checkout -b {SLICE_BRANCH_i}
```

Apply slice `i`'s changes (same techniques as 6a). Commit.

### 6c: Verify Coverage

After all slices are committed locally, verify no changes were lost or duplicated:

```bash
git diff origin/{ORIGINAL_PR_BASE}..{SLICE_BRANCH_N}
git diff origin/{BRANCH_NAME}..{SLICE_BRANCH_N}
```

The first should equal the original PR's diff (the union of all slices, applied in order). The second should be empty (final slice branch contains exactly the same tree as the original PR).

If `git diff origin/{BRANCH_NAME}..{SLICE_BRANCH_N}` is non-empty:
1. List the diff.
2. Display:
   ```
   Slice coverage mismatch — the union of all slices does not equal the original PR's tree.

   Differences:
   {diff}

   Aborting before pushing or creating PRs. Local branches {SLICE_BRANCH_1..N} have been created but not pushed.
   Investigate the slice assignments and re-run /split, or manually fix the slice branches and continue from Step 7.
   ```
3. **Stop.**

### 6d: Push Each Slice Branch

For each slice branch:

```bash
git push -u origin {SLICE_BRANCH_i}
```

If a push fails, report the error and **stop**. Earlier slice branches that did push remain — they can be cleaned up manually or the command can be re-run.

---

## Step 7: Open PRs for Each Slice

For each slice in order:

### 7a: Generate PR Description

```bash
cd {REPO_ROOT}
git checkout {SLICE_BRANCH_i}
```

Use the Skill tool to run skill `pr-description` with args `{slice base branch}`.

Read `./pr.md`. Append a stack context section:

```markdown

## Stack Context

Slice {i} of {TOTAL} — split from [{TICKET_KEY}]({ATLASSIAN_BASE}/browse/{TICKET_KEY}).
{if i > 1: "Stacked on top of [{SLICE_KEYS[i-1]}]({slice i-1 PR URL}). Review and merge in order."}
{if i < TOTAL: "Followed by [{SLICE_KEYS[i+1]}]({ATLASSIAN_BASE}/browse/{SLICE_KEYS[i+1]})."}
```

### 7b: Create PR

```bash
ensure-pr {SLICE_BRANCH_i} --base {slice base branch} --body-file ./pr.md
```

Parse the JSON output. Store `pr.url` as `SLICE_PR_URLS[i]` and `pr.number` as `SLICE_PR_NUMBERS[i]`.

For slice 1, the base is `{ORIGINAL_PR_BASE}` (typically `main` or the feature branch).
For slice 2..N, the base is `{SLICE_BRANCH_{i-1}}`.

### 7c: Update Slice Ticket with PR URL

```bash
append-activity {SLICE_KEYS[i]} --heading "PR opened" --body "{SLICE_PR_URLS[i]}"
```

---

## Step 8: Re-Point Downstream Blocker Links

If `DOWNSTREAM` is non-empty:

For each downstream ticket that had `{TICKET_KEY}` as a direct blocker:
1. Remove the existing "is blocked by {TICKET_KEY}" link. (Use `mcp__atlassian__getJiraIssue` to find the issue link `id`, then delete via the appropriate MCP call. If no delete tool is exposed, leave the old link and add a comment noting the manual cleanup needed.)
2. Create a new "Blocks" link: `SLICE_KEYS[N]` (last split, top of new chain) → downstream ticket.

Display each re-pointed link to the user.

If link deletion isn't possible via available tools, display:

```
Manual cleanup needed: the following downstream tickets still link to the now-pruned {TICKET_KEY}:
  - {DOWNSTREAM_KEY_1}
  - {DOWNSTREAM_KEY_2}

Re-point their "is blocked by" link from {TICKET_KEY} to {SLICE_KEYS[N]} in Jira.
```

---

## Step 9: Prune the Original

The split slices are live, branches pushed, PRs open, and downstream links re-pointed. Now retire the original ticket.

Use the Skill tool to run skill `prune` with args `{TICKET_KEY}`.

This will:
- Close the original PR with a "pruned — work redistributed" comment
- Revert the original's merge on the feature branch (if applicable)
- Transition the original ticket to Won't Do / Cancelled
- Apply `ClaudePruned` label

When prune prompts for confirmation, auto-confirm — the user already approved the split in Step 3.

If prune reports downstream warnings, ignore them — Step 8 already handled re-pointing.

---

## Step 10: Summary

Display:

```
Split {TICKET_KEY} — Complete

Original ticket: {TICKET_KEY} ({SUMMARY})
  PR:     {PR_URL} (closed)
  Status: pruned

New sibling tickets (under {PARENT_KEY}):
  1. {SLICE_KEYS[1]}: {slice 1 title}
       Branch: {SLICE_BRANCH_1}
       PR:     {SLICE_PR_URLS[1]}
       Base:   {ORIGINAL_PR_BASE}
  2. {SLICE_KEYS[2]}: {slice 2 title}
       Branch: {SLICE_BRANCH_2}
       PR:     {SLICE_PR_URLS[2]}
       Base:   {SLICE_BRANCH_1}
  ...

Stack chain: {SLICE_KEYS[1]} → {SLICE_KEYS[2]} → ... → {SLICE_KEYS[N]}
{if DOWNSTREAM was non-empty:
  Downstream re-point: {DOWNSTREAM_KEY_1}, ... now blocked by {SLICE_KEYS[N]}
}

Next steps:
  1. Review and merge {SLICE_PR_URLS[1]} first
  2. After each merge, the next slice's PR will be ready for review (its base catches up automatically)
  3. To advance the stack post-merge, run /cleanup on each slice ticket as it lands
```

---

## Error Handling

- **Repo root unresolved** → refuse to run.
- **No open PR on the original** → refuse to run; this command is only for the PR stage.
- **Dirty working tree or out-of-sync branch** → stop before any mutation.
- **Diff too coupled to split** → stop and recommend `/rework` instead.
- **Slice coverage mismatch in 6c** → stop before pushing; never publish a partial split.
- **Push failure** → stop. Earlier successful pushes remain; rerun is safe (the agent should detect existing branches/PRs and skip).
- **Conflict during cherry-pick or patch apply** → stop and report the conflicting file. Manual resolution required, then re-run from Step 6 for that slice onward.
- **Jira ticket creation failure** → stop. Already-created slice tickets remain (manual cleanup required) — report which were created so the user knows the state.
- **Downstream link delete unavailable** → fall back to a manual-cleanup notice; do not block the split.
- **Prune step fails** → report failure but leave the new slices intact. The user can retry `/prune {TICKET_KEY}` manually.

## Idempotency

Re-running `/split {TICKET_KEY}` after a partial failure should be safe:
- `ensure-pr` is idempotent (returns existing PR if one is open for the branch).
- Branch creation should check for existing branch first; if it exists with the expected commits, skip the apply step.
- Jira issue creation is **not** idempotent — if some slice tickets were created on a prior run, the agent should detect them by searching for tickets under `PARENT_KEY` whose description references "Split from {TICKET_KEY} — slice N of M" and reuse those keys instead of creating duplicates.
