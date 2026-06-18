---
description: "Promote a single stacked ticket to main: rebase onto main, open PR. Accepts a ticket key, container key, or feature branch name."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__editJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__getTransitionsForJiraIssue
  - mcp__atlassian__transitionJiraIssue
  - Bash(git *)
  - Bash(cd *)
  - Bash(ls *)
  - Bash(gh *)
  - Bash(resolve-stack *)
  - Bash(ensure-pr *)
  - Bash(post-review-summary *)
  - Bash(append-activity *)
  - Read
  - Write
  - Skill
---

# Promote to Main

Promotes a single ticket's branch to main: rebases onto main (isolating just its changes) and opens a PR to main.

To promote the next ticket in a stack, re-run this command after the prior PR merges.

## Arguments

$ARGUMENTS

Required: a Jira ticket key OR a stack container key (Story or Epic). Since feature branches are now named after the container key, passing a "branch name" is equivalent to passing the container key.
- If a ticket key is given: that ticket is promoted.
- If a container key is given: the next ticket to promote is determined by **git history on the feature branch** — the oldest ticket merged into the feature branch that is not yet on main. Jira's topological order is validated against git's merge order; the command errors out on mismatch.

---

## Step 1: Initialize

### 1a: Resolve Argument to a Jira Key

Set `RESOLVED_KEY` = `$ARGUMENTS` (uppercased). The arg must match `^[A-Z][A-Z0-9_]+-\d+$`; if it doesn't, display "Invalid Jira key: `{ARGUMENTS}`. Pass a ticket or container key (e.g. `EPIC-123`)." and **stop**.

### 1b: Resolve Stack with resolve-stack

Run the **Stack Context Resolution** sub-procedure (defined in `commands/ticket-work.md`) with `KEY={RESOLVED_KEY}` and `FETCH=true`.

If `FEATURE_BRANCH` is null: display "{RESOLVED_KEY} has no Story/Epic container; nothing to promote via feature branch. Use the standard PR workflow." and **stop**.

If `UNMERGED_BLOCKERS` is non-empty: display:

```
Refuse to promote — {CONTAINER_KEY} is blocked by unmerged container(s): {UNMERGED_BLOCKERS}.
Promote and merge those containers first, then re-run.
```
and **stop**.

Filter out tickets from `STACK_ORDER` where `branch` is null — display "Warning: no branch found for {KEY}, skipping" for each.

### 1b-final: Ensure Cleanup Prerequisites

Run the **Ensure Cleanup Prerequisites** sub-procedure (defined in `commands/ticket-work.md`) with `STACK_ORDER`, `REPO_ROOT`, and `RESOLVED_KEY` from Step 1b. The sub-procedure verifies every ticket merged into the feature branch has its `merged/{KEY}` tag on origin; if any are missing, it inline-runs `/cleanup --yes --no-rebase --no-refresh-feature` to backfill the tag, halting only when `/cleanup` itself cannot produce one.

After the sub-procedure returns, `STACK_ORDER` has been refreshed to reflect any state shifts cleanup may have caused. Continue to Step 1c with the refreshed view.

### 1c: Select Target Ticket

If `{RESOLVED_KEY}` matches a ticket key in `STACK_ORDER` (i.e. a leaf, not the container): that ticket is `CURRENT_TICKET`. Skip to Step 1d.

Otherwise, `{RESOLVED_KEY}` is the container key. **Git history on the feature branch is the authority** for which ticket promotes next, with `merged/{KEY}` tags as the marker (created by `/cleanup` Step 2d):

1. Read the merge order from the feature branch by walking commits and resolving tags:
   ```bash
   cd {REPO_ROOT}
   git log --first-parent origin/{FEATURE_BRANCH} --format=%H
   ```
   For each SHA in the output, run:
   ```bash
   git tag --points-at {SHA} 'merged/*'
   ```
   Each matching tag has the form `merged/{KEY}`; strip the prefix to extract the ticket key. Skip SHAs with no `merged/*` tag (commits unrelated to ticket merges, e.g. integration commits). The `git log` command lists newest-first; reverse the resulting key sequence to get chronological merge order. Call this list `GIT_MERGE_ORDER`.

   The Step 1b-final prerequisite gate guarantees every `mergedIntoFeature` ticket has its tag on origin, so `GIT_MERGE_ORDER` should match `STACK_ORDER`'s feature-merged subset modulo ordering.

2. Validate against Jira's topological order: take `STACK_ORDER` and keep only entries whose key appears in `GIT_MERGE_ORDER`, preserving their original order. Call this `JIRA_MERGED_ORDER`. Compare it element-by-element to `GIT_MERGE_ORDER`. On mismatch, display:

   ```
   Mismatch between git merge order and Jira dependency order on {FEATURE_BRANCH}:

     Git:  TICKET-1, TICKET-3, TICKET-2
     Jira: TICKET-1, TICKET-2, TICKET-3

   Refusing to promote — fix the Jira blocker links so they reflect actual merge order, then re-run.
   ```
   and **stop**.

3. Determine the next ticket to promote — the oldest entry in `GIT_MERGE_ORDER` whose ticket in `STACK_ORDER` has `mergedIntoMain === false`. Set `CURRENT_TICKET` to the matching entry from `STACK_ORDER`.

4. If no such ticket exists (every merged ticket is already on main): display "All tickets merged into {FEATURE_BRANCH} are already on main." and **stop**.

If `STACK_ORDER` is empty after filtering: display "No promotable tickets found in {CONTAINER_KEY}." and **stop**.

Display:
```
Promote to Main - {CURRENT_TICKET.key} ({CONTAINER_KEY})
Feature branch: {FEATURE_BRANCH}
Branch: {CURRENT_TICKET.branch}
```

### 1d: Check Ticket Status

Determine the current state of `CURRENT_TICKET`:

1. Check if branch is merged into main:
   ```bash
   git fetch origin && git branch -r --merged origin/main | grep "origin/{BRANCH_NAME}"
   ```
   If yes: display "{KEY} is already merged to main." and **stop**.

2. Check if a PR to main exists:
   ```bash
   pr-state {BRANCH_NAME} --base main --cwd {REPO_ROOT}
   ```
   - If output is non-null and `state` is `"MERGED"`: display "{KEY} PR is already merged." and **stop**.
   - If output is non-null and `state` is `"OPEN"`: display "PR already open for {KEY}: {url}" and **stop**.

3. Otherwise, proceed to Step 2.

---

## Step 2: Replay onto Main

The goal is to isolate just this ticket's changes on top of main. The ticket's own dev branch carries ancestor tickets' commits from the stacking; we don't want those on the main-targeting PR.

Two strategies, in preference order:

1. **Tag-based replay** (preferred): cherry-pick the squash commit on the feature branch (tagged `merged/{CURRENT_TICKET.key}` by `/cleanup` Step 2d). The squash commit is exactly what was reviewed-and-approved into the feature branch — byte-for-byte the diff we want on main. Doesn't depend on the predecessor's dev branch still existing.
2. **Rebase fallback** (legacy): `git rebase --onto origin/main {UPSTREAM_BRANCH} {BRANCH_NAME}`. Used only when the `merged/{KEY}` tag is unavailable — i.e. tickets that shipped before the tag was introduced, or repos where Step 1b-final's backfill couldn't produce one.

### 2a: Determine Strategy

Probe for the merge tag:

```bash
cd {REPO_ROOT} && git rev-parse --verify refs/tags/merged/{CURRENT_TICKET.key}
```

- If the command succeeds (tag resolves to a SHA): set `STRATEGY = "tag"` and `MERGE_SHA = <the resolved SHA>`. Skip the `UPSTREAM_BRANCH` derivation.
- If the command fails (tag absent): set `STRATEGY = "rebase"` and derive `UPSTREAM_BRANCH`:
  - If `CURRENT_TICKET` was selected via `GIT_MERGE_ORDER` (container-key path): use the predecessor in `GIT_MERGE_ORDER` — the entry immediately before `CURRENT_TICKET.key`. If `CURRENT_TICKET` is the first entry (no predecessor), no rebase is needed.
  - Otherwise (leaf ticket-key path): if this ticket has a same-stack blocker, `UPSTREAM_BRANCH` = the blocker's branch name (the changes we want to strip). If this is the first ticket in the stack (no blocker), no rebase is needed — it's already based on the feature branch which should be at or near main.
  - Look up the branch name for `UPSTREAM_BRANCH` from the corresponding entry in `STACK_ORDER`. If the predecessor branch no longer exists (it was deleted by terminal cleanup after the predecessor promoted to main), display:
    ```
    Refuse to promote — STRATEGY=rebase requires the predecessor branch {UPSTREAM_BRANCH}, which no longer exists.
    The merged/{CURRENT_TICKET.key} tag is also missing, so the tag-based replay isn't available either.

    Recovery: re-run /cleanup {CURRENT_TICKET.key} --yes --no-rebase --no-refresh-feature to backfill the tag,
    then re-run /promote-to-main.
    ```
    and **stop**. Step 1b-final's backfill should have caught this; reaching here means cleanup couldn't produce the tag.

### 2b: Checkout

`resolve-stack {RESOLVED_KEY} --fetch` from Step 1b (and again in Step 1d after any inline cleanup) has already refreshed remote refs. Skip the redundant `git fetch origin` and check out directly:

```bash
cd {REPO_ROOT} && git checkout {BRANCH_NAME}
```

If `git checkout` reports the index is stale and refuses, fall back to a single `git fetch origin` and retry — but do not fetch unconditionally.

### 2c: Replay

**If `STRATEGY == "tag"`** — reset the ticket branch to fresh main and cherry-pick the squash commit:

```bash
cd {REPO_ROOT} && git reset --hard origin/main
cd {REPO_ROOT} && git cherry-pick {MERGE_SHA}
```

The reset throws away the ticket branch's intermediate dev commits — the resulting PR diff is the single squash commit that was already reviewed on the feature branch. Main is going to squash-merge anyway, so individual commit history isn't preserved either way.

If the cherry-pick reports conflicts, drop into Step 2d. (`git cherry-pick` uses the same conflicted-index state as `git rebase`, so the same auto-resolution loop applies — replace `git rebase --continue` with `git cherry-pick --continue` and `git rebase --abort` with `git cherry-pick --abort` when reading 2d.)

**If `STRATEGY == "rebase"`** — legacy path. If this ticket has a same-stack blocker (need to strip ancestor changes):

```bash
git rebase --onto origin/main {UPSTREAM_BRANCH} {BRANCH_NAME}
```

If this is the first ticket (no blocker), rebase onto latest main:

```bash
git rebase origin/main
```

### 2d: Handle Conflicts

Initialize `AUTO_RESOLVED = []` (a list of `{file, summary}` records) to be reported at the end of the run.

If the rebase or cherry-pick encounters conflicts, attempt **semantic auto-resolution** using the loop below. Do **not** abort on the first conflict — work through them.

> Throughout 2d, "continue" and "abort" map to the active operation:
> - `STRATEGY == "tag"` → `git cherry-pick --continue` / `git cherry-pick --abort`
> - `STRATEGY == "rebase"` → `git rebase --continue` / `git rebase --abort`
>
> The conflicted-index inspection commands (`git show :1:`, `:2:`, `:3:`, `git diff --name-only --diff-filter=U`, etc.) are identical across both.

#### 2d.i: Resolve the Current Conflict Set

Loop while `git status --porcelain` shows files in `UU`/`AA`/`DD`/`AU`/`UA`/`DU`/`UD` state (i.e. an in-progress rebase with conflicts):

1. List conflicting files:
   ```bash
   git diff --name-only --diff-filter=U
   ```

2. For **each** conflicting file:
   - Read the file with the Read tool to inspect the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).
   - Inspect both sides:
     - Run `git log --oneline -5 HEAD -- {file}` to see what `HEAD` (the base, currently `origin/main`) brings.
     - Run `git log --oneline -5 MERGE_HEAD -- {file} 2>/dev/null` or `git log --oneline -5 REBASE_HEAD -- {file} 2>/dev/null` to see what the incoming commit brings.
     - If helpful, run `git show :1:{file}` (common ancestor), `git show :2:{file}` (HEAD/ours), `git show :3:{file}` (incoming/theirs) to view the three-way state.
   - Use the ticket context (`CURRENT_TICKET`) and the conflict shape to decide on a semantic resolution. Prefer the change whose intent matches `CURRENT_TICKET`. If both sides modify the same lines but the changes are *additive and non-overlapping in intent*, combine them.
   - Write the resolved file with Edit/Write, removing all conflict markers.
   - **If you cannot confidently resolve a file** (genuine semantic ambiguity, conflicting business logic, or the resolution requires information you don't have), fall through to **2d.iii**.
   - Stage the resolved file: `git add {file}`.
   - Append to `AUTO_RESOLVED`: `{ file, summary: "<one-line description of the resolution>" }`.

3. Continue the rebase:
   ```bash
   git rebase --continue
   ```
   This may surface a new set of conflicts on the next commit — loop back to the top of 2d.i.

4. If `git rebase --continue` succeeds and `git status` reports a clean working tree (no rebase in progress), exit the loop and proceed to **2d.ii**.

#### 2d.ii: Validate the Resolution

If `AUTO_RESOLVED` is non-empty, validate before pushing:

1. Detect available checks in `{REPO_ROOT}` (look for `package.json` scripts, `tsconfig.json`, `pyproject.toml`, etc.). Run whatever is cheap and relevant — typically one of:
   - `npm run typecheck` / `tsc --noEmit`
   - `npm run lint`
   - `npm test` (only if fast; skip long suites)
   - Project-specific equivalents
2. If any check fails, fall through to **2d.iii**.
3. If checks pass (or none are applicable), continue to Step 2e.

#### 2d.iii: Bail Out

If semantic resolution fails or post-rebase validation fails:

1. Abort the in-progress operation:
   - If `STRATEGY == "tag"`: `git cherry-pick --abort`
   - If `STRATEGY == "rebase"`: `git rebase --abort`
   (Both are safe to run even if not in progress — they'll just error harmlessly.)
2. Display (substitute the strategy-specific recovery commands):

```
CONFLICT replaying {BRANCH_NAME} onto main — auto-resolution failed

Files Claude attempted to resolve:
- path/to/file1.ts — {summary}
- path/to/file2.ts — {summary}

Files Claude could not resolve / failing validation:
- path/to/file3.ts — {reason}

Aborted. Resolve manually:
  cd {REPO_ROOT}
  git checkout {BRANCH_NAME}
  {if STRATEGY == "tag":
    "git reset --hard origin/main
  git cherry-pick " + MERGE_SHA + "
  # resolve conflicts
  git cherry-pick --continue"
  else:
    "git rebase --onto origin/main " + UPSTREAM_BRANCH + " " + BRANCH_NAME + "
  # resolve conflicts
  git rebase --continue"}
```

3. **STOP** — do not continue.

After resolving manually, re-run `/promote-to-main {KEY}` to resume.

### 2e: Force Push

After successful rebase:

```bash
git push --force-with-lease origin {BRANCH_NAME}
```

---

## Step 3: Open PR to Main (shared sub-procedure)

Run the **Shared sub-procedure: PR Push & Review** (defined in `commands/ticket-work.md`) with these bindings:

- `WORK_DIR` = `REPO_ROOT`
- `BRANCH` = `BRANCH_NAME`
- `BASE` = `main`
- `JIRA_KEY` = `KEY`
- `STORAGE` = inline (this command does not persist resume state — re-running re-derives it)
- `MARK_READY` = false (the user marks it ready after reviewing the auto-rebased diff)
- `LABEL_FLIP` = none (label transitions for this ticket happen via the per-ticket lifecycle, not promotion)
- `DRAFT` = false (promote-to-main opens the PR ready-for-review since review already happened pre-promotion)

The mapping is:
- 3a ↔ P1 (PR description) — additionally append a "Stack Context" section to `./pr.md` after the skill runs:
  ```markdown

  ## Stack Context

  Promoted from feature branch `{FEATURE_BRANCH}` to main.
  Part of {CONTAINER_KEY}.
  ```
- 3b ↔ P2 (push, then `ensure-pr` — base is `main`, **non-draft** since `DRAFT=false`). Store `pr.number` as `PR_NUMBER` and `pr.url` as `PR_URL`. If `action` is `"exists"`, skip ahead to 3d.
- 3c ↔ P5 (Copilot review loop)
- 3d ↔ P6 (post review summary)

Promote-to-main does **not** run P3 / P4 / P7 — review work is owned by the per-ticket lifecycle (S4.5/S4.6) before promotion; P7 (mark-ready) is Mode-C-only.

### 3e: Update Jira

After the shared sub-procedure completes, append to the activity log:
```bash
append-activity {KEY} --heading "PR to main opened" --body "{PR_URL}. Promoting from feature branch \`{FEATURE_BRANCH}\`."
```

---

## Step 4: Done

Display:

```
Promote to Main - {KEY}

Branch: {BRANCH_NAME}
PR: {PR_URL}
```

If `AUTO_RESOLVED` is non-empty, append:

```

Auto-resolved conflicts during rebase:
  - path/to/file1.ts — {summary}
  - path/to/file2.ts — {summary}

Review the resolution in the PR diff before merging.
```

Then append:

```

Next steps:
  1. Review and merge the PR
  2. To promote the next ticket in the stack, re-run /promote-to-main {CONTAINER_KEY} (or pass the feature branch name or next ticket key directly)
```

**Stop.**

---

## Error Handling

- If a branch doesn't exist for a ticket: skip it with a warning
- If rebase has conflicts: attempt semantic auto-resolution per Step 2d. If auto-resolution or post-rebase validation fails, abort the rebase and report.
- If force-push fails: report the error and stop (branch protection, etc.)
- If `gh pr create` fails: report and stop
- If Jira operations fail: warn but continue (non-critical)
- If the resolved key has no Story/Epic container: refuse to run (this command only applies to stacked feature-branch workflows)
- If the container has unmerged blocker containers: refuse to run and instruct the user to promote the blocker(s) first
