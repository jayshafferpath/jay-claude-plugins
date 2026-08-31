---
description: "Review a sliced-build stack by fanning out diff-critic and diff-security across every slice whose content or dependency closure moved, then writing slice-tagged findings to .plans/review-<branch>.md for /build-sliced to consume. Merges into the prior review file rather than regenerating it. Read-only — reports findings, never edits."
argument-hint: [base-branch]
allowed-tools: Read, Write, Grep, Glob, Agent, Bash(git:*), Bash(mkdir:*)
---

# Review Slices

Review a stack built by `/build-sliced`. Fans out the same specialist agents as
`/jay-pr-review` (`diff-critic`, `diff-security`), but scopes them to the slices whose
**content or dependency closure moved** and tags every finding with the `Slice-Id` it lands
in — so `/build-sliced` can replay from the earliest touched slice.

> Shared formats (trailer, fingerprint, review file): `commands/_sliced-format.md`. Use
> the exact command forms it gives — each has a silent failure mode.
> Findings-only, read-only. This command never edits code and never rewrites history.

## Step 1: Resolve branch, base, plans

- `BRANCH` = `git branch --show-current`.
- `BASE` = `$1` → else `git config branch.<BRANCH>.base` → else `main`.
- `PLANS_DIR` = `.plans` (mkdir if missing). `SLUG` = `<BRANCH>` with `/`,`_` → `-`.
- `REVIEW_FILE` = `{PLANS_DIR}/review-<SLUG>.md`. If it exists, **read it first and treat
  this run as a merge into it**, not a regeneration (`commands/_sliced-format.md` §3,
  "Regenerating the file is a merge"). The prior `slicemap` drives Step 3, and no open
  finding may be dropped by a pass that didn't look at its slice. Regenerating from only
  what this pass found discards findings the user has not acted on.

## Step 2: Read the ledger

```bash
git log <BASE>..HEAD \
  --format='%H%x00%(trailers:key=Slice-Id,valueonly,separator=%x2C)%x00%(trailers:key=Depends-On,valueonly,separator=%x2C)%x00%s'
```

`separator=` is required — without it each record straddles three lines and any
line-oriented parse mis-splits it (`commands/_sliced-format.md` §1).

Parse into `SLICES` = `[{sha, id, dependsOn[], subject}]`, then derive each slice's `kind`
and `depth` from the edge set per `commands/_sliced-format.md` §1a — **leaf** iff no other
slice names it in `Depends-On`, **foundation** otherwise; depth is the graph level. Use
depth for grouping, kind for counts.

**Stop and report** — do not review a stack whose ledger can't be read:

- A commit in range with **no** `Slice-Id`, **or an empty one**: this branch wasn't built by
  `/build-sliced`, a commit was added by hand, or the trailers were split across multiple
  `-m` flags so `Slice-Id` never parsed (`commands/_sliced-format.md` §1, "Committing the
  trailer").
- A `Depends-On` id that resolves to no slice in range, or a cycle in the edge set
  (`commands/_sliced-format.md` §1a). Scope, depth, and the closure below are all derived
  from those edges; an unreadable graph makes every one of them confidently wrong.

## Step 3: Compute review scope

A slice is **changed** iff `stable(s)` is false (`commands/_sliced-format.md` §1b): its own
patch-id moved, **or** any patch-id in its transitive `Depends-On` closure moved, measured
against the `<!-- slicemap -->` recorded by the previous run. A slice absent from the prior
map is changed. With **no** prior review file, every slice is changed (first review of the
stack).

`SCOPE` = the changed slices. The closure is what earns the seam coverage: a foundation
change puts every slice built on it — at any depth — in scope even when their own patches are
byte-identical, because a patch that reads the same against a moved foundation behaves
differently. A rule keyed on direct dependents only reaches depth+1, and silently stops at
any intermediate slice whose own patch happens not to move.

Key on patch-id, **never on SHA**. A replay rewinds and re-commits, so every slice from the
replay point to the tip gets a fresh SHA even when its content is untouched — a SHA-keyed
comparison would mark the entire tail as changed and re-review work that provably didn't
move.

If `SCOPE` is empty, **nothing moved since the last review**: carry the prior file forward
unchanged, report that, and stop. Never write a clean review file from a pass in which no
agent ran — that is a claim the run didn't earn, and it would drop every open finding.

## Step 4: Fan out review agents (single message, parallel)

Build the scoped diff range. The slices in `SCOPE` are contiguous from some earliest
slice `E` to the tip in almost all cases; pass the range `<parent of E's sha>...HEAD` plus
the changed-file list for the slices in `SCOPE` — union of `git diff-tree --no-commit-id
--name-only -r <sha>` over each one, not a whole-range diff. Pass file paths, never
contents — the agents read what they need.

When `SCOPE` is **not** contiguous, this range over-covers — it includes slices between
`E` and the tip that aren't in scope. That's tolerated, not a bug: Step 5 resolves any
resulting finding to its real `Slice-Id` and files it under **Out of scope**, so the
finding keeps its true home instead of being misattributed.

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
(`commands/_sliced-format.md` §3, "Resolving a finding's `Slice-Id`"):

```bash
git log <BASE>..HEAD -1 -s \
  --format='%(trailers:key=Slice-Id,valueonly,separator=%x2C)' \
  -L<line>,<line>:<file>
```

`-s` is required — `-L` implies `-p`, so without it the id comes back with a diff hunk
stapled to it. Tolerate a `fatal: There is no path …` failure (exit 128) for a path that
no longer exists at `HEAD`; that finding is **Unassigned**.

- Resolves to a slice in `SCOPE` → tag it with that `Slice-Id` and file it under that
  slice's **derived depth** (Step 2).
- Resolves to a slice **outside** `SCOPE` → tag it with that `Slice-Id` and file it under
  **Out of scope**. Keep the id: it resolved cleanly, and discarding it would make
  `/build-sliced` attribute the finding to the earliest changed slice and replay from the
  wrong place — possibly never reaching the code the finding is about.
- Resolves to **no** slice in range → run the pre-`BASE` check
  (`commands/_sliced-format.md` §3, "Resolving a finding's `Slice-Id`"). Owned by a commit at
  or before `BASE` → **drop it** and note the drop; the finding is about code this branch
  never touched, and no replay can reach it. Otherwise → **Unassigned**, which
  `/build-sliced` treats as touching the earliest id in the `changed:` comment.

## Step 6: Write the review file

Follow `commands/_sliced-format.md` §3 exactly. Group findings by slice **depth** (the
derived value from Step 2 — shallowest first, the order the build loop re-derives in),
`Critical` first within a depth. Every actionable item is a checkbox prefixed with its
`Slice-Id`.

Merge against the prior file rather than regenerating it — the table in
`commands/_sliced-format.md` §3, "Regenerating the file is a merge", is the whole rule. In
short: `- [~]` verbatim always, `- [x]` dropped, and an open `- [ ]` may only be dropped by
this pass if this pass actually reviewed its slice. An open finding on a `stable` slice
carries forward untouched; one on a slice that moved outside this pass's scope carries
forward marked `unverified`. Findings this pass found fresh are always `- [ ]`.

Embed two comments so the next run and the build loop each get what they need:

```
<!-- slicemap: s01=<patch-id> s02=<patch-id> ... -->
<!-- changed: s03,s04 -->
```

`slicemap` records **patch-ids, not SHAs** — see Step 3 — and is the input to the next
review's comparison. `changed` is this run's `SCOPE`, and it is the only durable record of
it: `/build-sliced` reads it to place `Unassigned` findings and cannot recompute it, because
by replay time no patch-id has moved since this file was written. The prose
**Reviewed slices** header is for humans and is never parsed.

## Step 7: Report

```
Reviewed <K> of <N> slices on <BRANCH> — every slice whose content or closure moved.
Findings: <C critical, H high, M medium, L low>. Written to <REVIEW_FILE>.
```

- Name any findings carried forward rather than found this pass, and any dropped as
  pre-`BASE`.
- If nothing moved since the last review (empty `SCOPE`): report "No slice moved since the
  last review — <REVIEW_FILE> left as it stands, <N> findings still open." Do not rewrite
  the file.
- If zero critical/high: append "No blocking findings — run /build-sliced to address the
  rest, or declare done."
- If zero findings at all: append "Stack is clean at reviewed scope. Declare done when
  satisfied, or widen the base to review more slices."

## Guidelines

- One message, multiple Agent calls — parallel is the point.
- Pass file lists, not file contents.
- Scope is every slice that is not `stable` — own patch-id moved, or anything in its
  transitive `Depends-On` closure moved. The closure is the seam coverage; don't narrow it
  to direct dependents, which stops at depth+1.
- "Changed" is keyed on patch-id, never SHA — SHAs churn on every replay.
- Kind and depth are derived from `Depends-On`, never read from a trailer. Group by depth.
- An unreadable ledger — empty `Slice-Id`, dangling edge, cycle — stops the review. Never
  review a stack whose graph you had to guess at.
- Every finding keeps the `Slice-Id` it resolved to, even when that slice is out of scope;
  only a finding that resolves to no slice lands in Unassigned. That tag is what lets the
  build loop replay from the right place — a discarded or invented tag sends it to the
  wrong commit.
- The file is a merge, not a regeneration. A finding is removed only by a pass that looked
  at its slice; `- [~]` never resurrects as open.
- Read-only. Never edit code, never touch history, never open a PR.
