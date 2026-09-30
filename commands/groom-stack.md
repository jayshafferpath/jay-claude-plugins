---
description: "Prep a stacked chain of GitHub PRs for human review, bottom-up: discover the chain purely from base/head branch relationships (no Jira), rebase any branch that has fallen behind its own base, refresh the PR description via /jay-pr-description, regenerate each PR's /jay-pr-review findings, and fold in a report-only refactor scan — in dependency order, so PRs can be merged bottom-up without staleness surprises."
argument-hint: "[pr-number-or-url] [--dry-run]"
allowed-tools:
  - Read
  - Write
  - Bash(git *)
  - Bash(gh *)
  - Bash(cd *)
  - Bash(mkdir *)
  - Bash(post-review-summary *)
  - Skill
  - Agent
---

# Groom Stack

Get a stacked chain of GitHub PRs ready for a human to review, bottom-up.

> **Discovery, not declaration.** This command has no manifest of what's stacked on
> what — it derives the chain from `baseRefName`/`headRefName` on the open PRs
> themselves: PR B is "on top of" PR A when `B.baseRefName === A.headRefName`. That
> means the chain is exactly as real as the PRs' base refs are kept — a PR whose base
> was never retargeted after its true predecessor merged looks, to `gh`, like it's
> stacked on a branch that's gone. Step 1c below treats that as a finding, not a crash.

## Arguments

`$ARGUMENTS`

- `PR_REF` (optional, positional) — a PR number (`42`) or PR URL. Omit to use the
  current branch's open PR (`gh pr view`, no argument).
- `--dry-run` — report only. Still fetches and runs the staleness check per PR
  (read-only), but never rebases, pushes, edits a PR, or regenerates a review plan.

---

## Step 1: Discover the chain

### 1a: Resolve the anchor PR

```bash
git rev-parse --show-toplevel
```
Store as `REPO_ROOT`. Reject a dirty tree now — the loop checks out a different branch
per PR and a dirty tree makes that unsafe:
```bash
cd {REPO_ROOT} && git status --porcelain
```
Non-empty output → display "Working tree is dirty. Commit or stash before grooming: {files}" and **stop**.

```bash
cd {REPO_ROOT} && gh pr view {PR_REF or nothing} --json number,url,title,headRefName,baseRefName,isCrossRepository
```

If this fails: display "No PR found{ for {PR_REF} if given}. Pass a PR number or URL, or run this from a branch with an open PR." and **stop**.

If `isCrossRepository` is `true`, display "PR #{number} heads from a fork — this command only grooms PRs whose head branch exists in this repo's remote (local checkout + push required)." and **stop**. Everything downstream assumes every branch in the chain is `origin/<branch>` in the current repo.

Store this as `ANCHOR`.

### 1b: Walk down to the bottom

Repeat, starting from `current = ANCHOR`:

```bash
gh pr list --head {current.baseRefName} --state open --json number,url,title,headRefName,baseRefName,isCrossRepository --limit 2
```

- **Zero results** → `current.baseRefName` is not itself a PR's head in this repo (it's the trunk this stack roots on, whatever it's called). Stop walking down. `current` (the last one found, or `ANCHOR` if this is the first iteration) is the bottom of the discoverable stack — record its `baseRefName` as `TRUNK`.
- **One result** → that PR is the predecessor. If its `number` has already been visited (track visited PR numbers in a set as you go), **stop** and report a cycle: "Cycle detected walking down from #{ANCHOR.number} — PR #{number} appears twice in the base-ref chain." This should not happen with real branches; treat it as a data problem, not something to route around.
- **Two-plus results** → more than one open PR shares that head branch, which `gh pr list --head` should already dedupe to one PR-per-branch in practice; if it doesn't, take the first and note the anomaly in Step 4's report rather than guessing further.
- If the result's `isCrossRepository` is `true`, stop walking down at this point (don't check out a fork branch) and record `TRUNK = null, truncated: "fork boundary at #{number}"` — Step 2 starts from whatever was discovered above this point.

Prepend each found predecessor to `DOWN_CHAIN` (so it ends up bottom-first). Continue until a stop condition above is hit.

### 1c: Walk up to the tip

Repeat, starting from `current = ANCHOR`:

```bash
gh pr list --base {current.headRefName} --state open --json number,url,title,headRefName,baseRefName,isCrossRepository --limit 5
```

- **Zero results** → `current` is the tip. Stop.
- **Exactly one result** → that PR continues the stack. Same cycle guard and fork guard as 1b. Append to `UP_CHAIN`.
- **Two or more results** → the stack **forks** here: multiple open PRs base on the same head. Do not pick one — record `FORK = { at: current, branches: [...] }` and stop climbing. This chain's grooming still covers everything at and below `current`; the fork's alternatives are reported in Step 4 so the human can re-run `/groom-stack` rooted at whichever branch they want to also cover.

### 1d: Assemble the stack

`STACK` = `DOWN_CHAIN` (bottom-first) + `[ANCHOR]` + `UP_CHAIN` (tip-last). This is the
full bottom-up order — **never re-sort it**.

### 1e: Detect a broken base (informational, not fixed here)

For each `P` in `STACK` except the bottom one, check whether `origin/{P.baseRefName}`
still exists:

```bash
git ls-remote --exit-code origin {P.baseRefName}
```

Non-zero exit → `P`'s base branch is gone (its real predecessor almost certainly merged
and had its branch deleted, and nobody retargeted `P`'s PR base yet). Record
`{ ticket: P.number, missingBase: P.baseRefName }` in `BROKEN_BASES`. This can't be
fixed by rebasing — there's nothing to rebase onto — so it's surfaced in Step 4 as a
required manual action (retarget the PR base, typically to the branch its merged
predecessor targeted), not attempted automatically. Exclude `P` from Step 3's grooming
loop; nothing after a broken base in the chain can be trusted either, so treat the first
`BROKEN_BASES` entry the same way Step 3 treats a rebase conflict — halt grooming at that
point.

---

## Step 2: Report the discovered stack before touching anything

```
Discovered a {N}-PR stack rooted on `{TRUNK}`:

  1. #{STACK[0].number} — {STACK[0].title}  ({STACK[0].headRefName} → {STACK[0].baseRefName})
  2. #{STACK[1].number} — {STACK[1].title}  ({STACK[1].headRefName} → {STACK[1].baseRefName})
  ...
```

If `FORK` was recorded, display it now, before any grooming starts:

```
⚠ Stack forks above #{FORK.at.number} ({FORK.at.headRefName}) — {K} open PRs base on it:
  - #{branch1.number}: {branch1.title}
  - #{branch2.number}: {branch2.title}
  Only the chain through #{ANCHOR.number} is groomed this run. Re-run /groom-stack
  against one of the branches above to groom that side of the fork.
```

If `BROKEN_BASES` is non-empty, display it now too:

```
⚠ Broken base(s) — cannot rebase, needs a manual retarget:
  - #{number}: bases on `{missingBase}`, which no longer exists on origin.
    Retarget with: gh pr edit {number} --base <correct-branch>
```

---

## Step 3: Groom each PR, bottom-up

Process `STACK` in order, stopping before the first entry recorded in `BROKEN_BASES`
(Step 1e). Sequential and halts on the first unresolved rebase conflict — everything
above the conflicted PR is left `not-attempted`. Unlike the old Jira-container version
of this command, this halt **is** load-bearing here: every PR's base really is the
previous PR's head, so a conflict genuinely leaves everything above it unverifiable
against a moving target, not just unexamined.

For each `P` in `STACK`:

### 3a: Fetch and checkout

```bash
cd {REPO_ROOT} && git fetch origin {P.headRefName} {P.baseRefName}
git checkout {P.headRefName}
```

If checkout fails, record `P` as `skipped — {error}` and continue to the next PR (does
not halt the loop — only a rebase conflict does).

### 3b: Staleness check

```bash
git merge-base --is-ancestor origin/{P.baseRefName} HEAD
```

Exit `0` → not stale, `P.rebased = false`. Non-zero → stale.

**`--dry-run`**: record `P.wouldRebase = true` and skip straight to 3d (no rebase, no
push, no description/review regen).

### 3c: Rebase if stale

```bash
git rebase origin/{P.baseRefName}
```

On conflict:
1. `git diff --name-only --diff-filter=U`
2. `git rebase --abort`
3. Record `{ status: "conflict", files }` on `P`.
4. **Halt the loop.** Jump to Step 4.

On success:
```bash
git push --force-with-lease origin {P.headRefName}
```
Record `P.rebased = true`, `P.newBase = $(git rev-parse origin/{P.baseRefName})`.

This is the one place order truly cascades: rebasing `P` moves `origin/{P.headRefName}`,
and the next PR up has `baseRefName === P.headRefName`, so its own 3b re-fetch will
correctly see the new tip. No separate cascade step is needed — sequential bottom-up
with a fresh fetch per PR **is** the cascade.

### 3d: Refresh the PR description

Skip under `--dry-run`.

1. `cd {REPO_ROOT}`, use the Skill tool to run skill `jay-pr-description` with args
   `{P.baseRefName}`.
2. Read the generated `./pr.md`. First line (stripped of a leading `# `) is `NEW_TITLE`;
   the rest is the body. Write the body to a temp file.
3. ```bash
   gh api --method PATCH repos/{owner}/{repo}/pulls/{P.number} -f title="{NEW_TITLE}" -F body=@{BODY_FILE}
   ```
   REST PATCH rather than `gh pr edit`, for the same reason `/finalize` Step 2 and the
   old Jira-backed version of this command used it: `gh pr edit` needs `read:org` scope
   for reviewer resolution even when only title/body are touched, and `-F body=@file`
   avoids re-introducing shell interpolation on a description containing backticks or `$`.

### 3e: Regenerate the review plan

Skip under `--dry-run`.

`cd {REPO_ROOT}`, use the Skill tool to run skill `jay-pr-review` with args
`{P.baseRefName}`. Writes `{REPO_ROOT}/.plans/pr-review-{P.headRefName}.md` — see
`commands/_pr-review-format.md` for the shape.

Because every PR in the stack shares the same `.plans/` directory (there's no per-ticket
worktree here — this whole loop runs from one `REPO_ROOT`, one checkout at a time), the
next sub-steps' file lookups **must** resolve by branch, not just grab whatever
`pr-review-*.md` file exists — `cli/lib/review-summary.js`'s `findReviewPlanFile` matches
the exact `pr-review-{P.headRefName}.md` first for this reason.

### 3f: Refactor scan (report-only)

Skip under `--dry-run`.

`jay-pr-review` (3e) covers correctness and security; it never flags CRAP hotspots,
DRY violations, or structural smells (`diff-critic` explicitly skips "speculative
refactors, architecture opinions" — that's this agent's lane, not its overlap). Run the
`refactor` agent as a fourth reviewer, scoped to this PR's diff only:

1. Get the changed files: `git diff origin/{P.baseRefName}...HEAD --name-only --diff-filter=ACMR`.
2. Invoke `refactor` (Agent tool) with `BASE = origin/{P.baseRefName}`, diff range
   `origin/{P.baseRefName}...HEAD`, and the file list — same inputs `jay-pr-review`
   passes its agents. Pass file paths, never file contents.
3. Prefix the prompt with this override — it replaces the agent's normal conversational
   flow (Phases 3–6 in `agents/refactor.md`), which assumes an interactive session and
   write authority, neither of which applies here: groom-stack runs unattended across
   possibly several PRs it doesn't own.

   > Score only functions/lines this diff actually changed or added — do not analyze or
   > report on unchanged code the diff merely touches. Do not read or estimate the rest
   > of the file's history. Stop after Phase 3 (report findings) — do not enter Phase 4
   > or later, do not propose to implement anything, and do not ask which findings to
   > address. Map CRAP > 30 to `critical`, CRAP 15–30 to `high`, a DRY violation with 3+
   > occurrences (at least one inside this diff) to `medium`, and any other smell worth
   > a reviewer's attention to `low` — assign `low` sparingly; per the three-strikes
   > rule, don't flag duplication at 2 occurrences. Return a JSON array of
   > `{severity, file, line, summary, fix}`, nothing else. Return `[]` if the diff is
   > clean — never invent a finding to look thorough.

4. Read back `{REPO_ROOT}/.plans/pr-review-{P.headRefName}.md` (written by 3e) and, for
   each returned finding, append a `- [ ] \`{file}:{line}\` — {summary}. Fix: {fix}.
   (source: refactor)` line to the matching `### Critical` / `### High` / `### Medium` /
   `### Low` section under `## Findings`, creating the section if this PR's `diff-critic`/
   `diff-security` pass didn't already need it. Keep severity order (Critical first,
   empty sections omitted) per `commands/_pr-review-format.md`. Write the file back.

Report-only means exactly that: this agent never gets `Edit`/`Write` here and its
findings are never auto-fixed — a human decides whether to act on them, same as every
other finding in the plan.

### 3g: Count findings

Skip under `--dry-run`.

Read `{REPO_ROOT}/.plans/pr-review-{P.headRefName}.md` back (now merged with 3f's
findings) and count open (`- [ ]`) items per `### Critical` / `### High` / `### Medium` /
`### Low` section. Store as `P.findings = { critical, high, medium, low }`.

### 3h: Post the review summary

Skip under `--dry-run`.

```bash
post-review-summary {P.headRefName} --plans-dir .plans
```
(run from `{REPO_ROOT}`). No `--ticket-key` — there is no ticket. If `posted: false` with
reason `no_plan_file`, that's unexpected (3e/3f just wrote one) — treat it as a warning
rather than a halt.

---

## Step 4: Report

```
Groomed {K} of {N} PR(s) in the stack rooted on `{TRUNK}`.

Review bottom-up, in this order:

  1. #{P.number} — {P.title}
     {P.headRefName} → {P.baseRefName}
     {url}
     {"Rebased onto " + short(P.newBase) if P.rebased else "Would rebase" if P.wouldRebase else "Already current"}
     Findings: {critical}C {high}H {medium}M {low}L  ({REPO_ROOT}/.plans/pr-review-{P.headRefName}.md)
  2. ...
```

For any PR recorded `conflict` in Step 3c:

```
STOPPED at #{P.number} — rebase conflict onto origin/{P.baseRefName}

Conflicting files:
{files}

Resolve manually:
  cd {REPO_ROOT}
  git checkout {P.headRefName}
  git rebase origin/{P.baseRefName}
  # resolve conflicts
  git add {files}
  git rebase --continue
  git push --force-with-lease origin {P.headRefName}

Then re-run: /groom-stack {P.number}

Not attempted (stopped above this PR in the order): {remaining PR numbers}
```

Repeat the `FORK` and `BROKEN_BASES` warnings from Step 2 here too — they're standing
risks on this stack regardless of what this pass groomed.

If every PR groomed cleanly with zero critical/high findings across the whole stack and
no fork/broken-base warnings, append: "Stack is clean and current — safe to open for
review in the order above."

---

## Error Handling

- No PR resolvable from `PR_REF` (or the current branch): refuse in Step 1a before doing
  anything.
- A fork-headed PR anywhere in the chain: excluded from grooming at the point it's
  found; the rest of the chain that doesn't depend on checking it out still grooms.
- A broken base (Step 1e) halts the loop at that PR, same as a rebase conflict — there is
  nothing to rebase onto, so continuing upward would build on an unverified branch.
- A rebase conflict halts the loop at that PR. Never auto-resolve it — this command
  doesn't own the code in any of these PRs, it's grooming someone else's in-review work.
- A stack fork (Step 1c) is reported, never resolved by picking a branch — that choice
  belongs to the human.
- `--dry-run` never runs `git rebase`, `git push`, `gh api PATCH`, `jay-pr-description`,
  `jay-pr-review`, the `refactor` scan, or `post-review-summary`. It still fetches and
  runs the read-only staleness/base-existence checks, because a report that can't say
  "would rebase" or "base is broken" isn't useful.
- The `refactor` scan (3f) is report-only by design here — it never gets write access
  and its findings are folded into the plan as unchecked items like any other finding,
  not auto-fixed. `/ticket-work` S4.4 gives this same agent write authority because it
  owns the ticket's branch; groom-stack doesn't own any branch in the stack, so it
  doesn't.
- This command never looks at Jira itself and never assumes a stack has one. `/jay-pr-description` (Step 3d) will read a Jira ticket if it finds a key-shaped substring in the branch name, but that's its own opt-in behavior — groom-stack's chain discovery, staleness checks, and rebase logic are 100% git/GitHub.

## Guidelines

- Bottom-up order is exactly what Step 1 discovered — never re-sort by severity,
  findings count, or PR age. The order exists to match the actual base-ref dependency,
  and that's the one thing a reviewer needs preserved.
- The cascade is implicit: rebase-then-push at each level, re-fetch at the next. Do not
  add a separate "cascade rebase downstream" step — sequential bottom-up with a fresh
  fetch per PR already produces it.
- `findReviewPlanFile` resolving by exact branch filename first (not ticket key) is what
  makes it safe to run this loop with several stack levels' review files coexisting in
  one shared `.plans/`. Don't reintroduce a ticket-key-only lookup here.
- Every side-effecting step (rebase, push, PR edit, review regen, summary post) is
  idempotent to re-run — grooming a clean stack a second time should report "already
  current" everywhere, not duplicate comments or thrash descriptions.
