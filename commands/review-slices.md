---
description: "Review a sliced-build stack by fanning out diff-critic and diff-security across the changed slices and their dependents, then writing slice-tagged findings to .plans/review-<branch>.md for /build-sliced to consume. Read-only — reports findings, never edits."
argument-hint: [base-branch]
allowed-tools: Read, Write, Grep, Glob, Agent, Bash(git:*), Bash(mkdir:*)
---

# Review Slices

Review a stack built by `/build-sliced`. Fans out the same specialist agents as
`/jay-pr-review` (`diff-critic`, `diff-security`), but scopes them to the **changed
slices and their immediate dependents** and tags every finding with the `Slice-Id` it
lands in — so `/build-sliced` can replay from the earliest touched slice.

> Shared formats (trailer, review file): `commands/_sliced-format.md`.
> Findings-only, read-only. This command never edits code and never rewrites history.

## Step 1: Resolve branch, base, plans

- `BRANCH` = `git branch --show-current`.
- `BASE` = `$1` → else `git config branch.<BRANCH>.base` → else `main`.
- `PLANS_DIR` = `.plans` (mkdir if missing). `SLUG` = `<BRANCH>` with `/`,`_` → `-`.
- `REVIEW_FILE` = `{PLANS_DIR}/review-<SLUG>.md`. Overwrite if it exists.

## Step 2: Read the ledger

```bash
git log <BASE>..HEAD --format='%H%x00%(trailers:key=Slice-Id,valueonly)%x00%(trailers:key=Depends-On,valueonly)%x00%s'
```

Parse into `SLICES` = `[{sha, id, dependsOn[], subject}]`, then derive each slice's `kind`
from the edge set per `commands/_sliced-format.md` §1a — **leaf** iff no other slice names
it in `Depends-On`, **foundation** otherwise. If any commit in range lacks a `Slice-Id`,
stop and report: this branch wasn't built by `/build-sliced`, or a commit was added by hand
— the review scope can't be computed reliably.

## Step 3: Compute review scope (changed slices + dependents)

**Changed slices** = the slices whose commits differ from the last review. Determine
this from the prior `REVIEW_FILE` if one exists (compare its recorded `Slice-Id → sha`
map, embedded in the file's `<!-- slicemap -->` comment from the previous run) — any id
whose sha moved, or any id absent from the prior map, is changed. If there is **no**
prior review file, every slice is "changed" (first review of the stack).

**Dependents** = every slice whose `Depends-On` names a changed slice, directly. Because
`Depends-On` is multi-valued, match against each id in the list — a slice consuming two
foundations is a dependent of both. Include them for seam coverage: a foundation change can
break a leaf that itself didn't change.

`SCOPE` = changed ∪ dependents. If `SCOPE` is empty, write a clean review file
(Step 6) and stop.

## Step 4: Fan out review agents (single message, parallel)

Build the scoped diff range. The slices in `SCOPE` are contiguous from some earliest
slice `E` to the tip in almost all cases; pass the range `<parent of E's sha>...HEAD`
plus the explicit changed-file list for `SCOPE` (`git diff <parent-of-E>...HEAD
--numstat`). Pass file paths, never contents — the agents read what they need.

Fan out in one message:

- `diff-critic` — always. Correctness defects, contract changes, test gaps.
- `diff-security` — unless the scoped diff is **security-inert**: no changed file
  touches auth, input handling, persistence, logging, secrets, crypto, IaC, or shells
  out, and no dependency was added. When skipped, note it in the review file's Notes.

Prefix every agent prompt with:

> Only flag issues introduced or worsened by these slices. Do not report pre-existing
> issues in unchanged code. Project-local conventions in the surrounding files win over
> any general guide. Return `[]` rather than inventing findings.

Both agents are read-only and return a JSON array of
`{severity, file, line, summary, fix}`. Merge the arrays; when both report the same
`file:line`, keep the higher severity and one summary.

## Step 5: Resolve each finding to a slice

For each finding, map its `file:line` to the owning `Slice-Id`
(`commands/_sliced-format.md` §3):

```bash
git log <BASE>..HEAD -1 --format='%(trailers:key=Slice-Id,valueonly)' -L<line>,<line>:<file>
```

- Resolves to a slice in `SCOPE` → tag it with that `Slice-Id` and use its **derived** kind
  (Step 2) for the depth grouping.
- Resolves to a slice **outside** `SCOPE`, or to no slice in range → **Unassigned**.
  `/build-sliced` treats unassigned findings as touching the earliest changed slice.

## Step 6: Write the review file

Follow `commands/_sliced-format.md` §3 exactly. Group findings by slice **depth** (the
derived kind from Step 2 — foundation first, that's the order the build loop replays in),
`Critical` first within a depth. Every actionable item is a `- [ ]` checkbox prefixed with
its `Slice-Id`.

Embed the current slice map as an HTML comment so the next review can compute "changed":

```
<!-- slicemap: s01=<sha> s02=<sha> ... -->
```

## Step 7: Report

```
Reviewed <K> slices (<scope: changed + dependents>) on <BRANCH>.
Findings: <C critical, H high, M medium, L low>. Written to <REVIEW_FILE>.
```

- If zero critical/high: append "No blocking findings — run /build-sliced to address the
  rest, or declare done."
- If zero findings at all: append "Stack is clean at reviewed scope. Declare done when
  satisfied, or widen the base to review more slices."

## Guidelines

- One message, multiple Agent calls — parallel is the point.
- Pass file lists, not file contents.
- Scope is changed slices **plus their direct dependents** — the seam coverage is
  deliberate; don't narrow it to just changed slices.
- Kind is derived from `Depends-On`, never read from a trailer.
- Every finding carries a `Slice-Id` (or lands in Unassigned). That tag is what lets the
  build loop replay from the right place — an untagged finding is useless to it.
- Read-only. Never edit code, never touch history, never open a PR.
