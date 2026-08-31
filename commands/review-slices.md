---
description: "Review a sliced-build stack by fanning out diff-critic and diff-security across every slice whose content or influence set moved, then writing slice-tagged findings to .plans/review-<branch>.md for /build-sliced to consume. Merges into the prior review file rather than regenerating it. Read-only — reports findings, never edits."
argument-hint: [base-branch]
allowed-tools: Read, Write, Grep, Glob, Agent, Bash(git:*), Bash(mkdir:*), Bash(read-ledger:*), Bash(slice-scope:*), Bash(slice-review:*)
---

# Review Slices

Review a stack built by `/build-sliced`. Fans out the same specialist agents as
`/jay-pr-review` (`diff-critic`, `diff-security`), but scopes them to the slices whose
**content or influence set moved** and tags every finding with the `Slice-Id` it lands
in — so `/build-sliced` can replay from the earliest touched slice.

> Shared formats and the reasoning behind them: `commands/_sliced-format.md`.
> Scope, finding-to-slice resolution, and the review-file merge all belong to CLIs —
> `read-ledger`, `slice-scope`, `slice-review`. Your job in this command is the part that
> needs judgement: deciding whether the diff is security-inert, and reading what the agents
> return. Do not hand-compute a closure, a patch-id comparison, or the merge table.
> Findings-only, read-only. This command never edits code and never rewrites history.

## Step 1: Resolve branch, base, plans

- `BRANCH` = `git branch --show-current`.
- `BASE` = `$1` → else `git config branch.<BRANCH>.base` → else `main`.
- `PLANS_DIR` = `.plans` (mkdir if missing). `SLUG` = `<BRANCH>` with `/`,`_` → `-`.
- `REVIEW_FILE` = `{PLANS_DIR}/review-<SLUG>.md`. If it exists, this run is a **merge into
  it**, not a regeneration (`commands/_sliced-format.md` §3, "Regenerating the file is a
  merge"). `slice-review` enforces that; you never rewrite the file by hand.

## Step 2: Read the ledger and compute scope

One call does both — the ledger read, its validation, and the `stable` predicate over every
slice:

```bash
slice-scope --base <BASE> --review <REVIEW_FILE>
```

Exit 2 → **stop and report** the `violations` verbatim. Do not review a stack whose ledger
can't be read: an empty or missing `Slice-Id`, a duplicate, a merge commit, a dangling edge, a
forward edge, or a cycle all make scope, depth, and the influence set confidently wrong. A
**merge commit** is the common cause on a long-lived stack, and the fix to name is
`git rebase origin/<BASE>` — it carries every message and therefore every id and edge
through — never a merge of `<BASE>` into the branch.

What comes back:

- `changed` — the slices that are **not** `stable`, in **commit order**. This is `SCOPE`.
- `stable` — the rest.
- `range` — the diff range for the fan-out, and `contiguous` — whether it over-covers.
- `files` — the union of the files the in-scope slices touch.
- `detail` — per slice, `ownMoved` and `movedInfluences`, so you can say *why* something is
  in scope.
- `firstReview` — true when there is no prior record, in which case every slice is changed.
  That is the correct reading of a first review, not a bug.

A slice is in scope iff its own patch-id moved **or** a patch-id in its **influence set**
did — the transitive `Depends-On` closure, plus any earlier slice sharing a touched file. Both
terms earn their keep:

- The **closure** puts every slice built on a changed foundation — at any depth — in scope even
  when their own patches are byte-identical, because a patch that reads the same against a
  moved foundation behaves differently. A rule keyed on direct dependents only reaches
  depth+1, and silently stops at any intermediate slice whose own patch happens not to move.
- The **file-overlap** term catches the coupling `Depends-On` cannot express. Replay is
  positional, so a slice is rebuilt against every earlier slice, not just the ones it declares.
  Two leaves writing the same barrel file have no edge between them and can still break each
  other. Overlap is measured over the union of each slice's before and after file lists, so a
  slice that *stops* touching a file counts too.

Neither term makes the predicate a proof — a coupling through a third file with no shared path
is invisible — so treat `stable` as the best scoping git can justify, not a guarantee that an
out-of-scope slice is fine.

If `SCOPE` is empty, **nothing moved since the last review**: leave the file exactly as it
stands, report that, and stop. Never write a review file from a pass in which no agent ran —
that is a claim the run didn't earn.

## Step 3: Fan out review agents (single message, parallel)

Pass the `range` and `files` from Step 2 — the union of the in-scope slices' file lists, not
a whole-range diff. Pass file paths, never contents; the agents read what they need.

When `contiguous` is false the range over-covers: it includes slices between the earliest
in-scope slice and the tip that aren't in scope. That's tolerated, not a bug — Step 4 resolves
any resulting finding to its real `Slice-Id` and files it under **Out of scope**, so the
finding keeps its true home instead of being misattributed.

Fan out in one message:

- `diff-critic` — always. Correctness defects, contract changes, test gaps.
- `diff-security` — unless the scoped diff is **security-inert**: no changed file
  touches auth, input handling, persistence, logging, secrets, crypto, IaC, or shells
  out, and no dependency was added.

This gate is the one judgement call in the command, and it has a consequence downstream:
whichever agents you actually run go into `--agents` in Step 4, and a finding from an agent
you skipped is carried forward `unverified` rather than dropped. Skipping `diff-security`
therefore costs nothing in fidelity — but *claiming* to have run it does.

Prefix every agent prompt with:

> Only flag issues introduced or worsened by these slices. Do not report pre-existing
> issues in unchanged code. Project-local conventions in the surrounding files win over
> any general guide. Return `[]` rather than inventing findings.

Both agents are read-only and return a JSON array of
`{severity, file, line, summary, fix}`. Merge the arrays, tagging each entry with the agent
that produced it as `source`; when both report the same `file:line`, keep the higher severity
and one summary. Write the combined array to a temp file.

## Step 4: Resolve, merge, and write

One call resolves every finding to its owning slice, applies the merge rules, and writes the
file:

```bash
slice-review --base <BASE> --findings <tmp.json> --agents diff-critic[,diff-security]
```

`--agents` is the coverage record, not decoration: it is what makes the per-agent merge rule
decidable, so it must list exactly what you ran in Step 3.

What it does, and why you must not do any of it by hand:

- **Resolves `file:line` to a `Slice-Id`** via the commit that last touched that line. Three
  outcomes, and they are not the same finding: a slice in scope → filed under that slice's
  derived **depth**; a slice outside scope → filed under **Out of scope** *keeping its id*
  (discarding it would make `/build-sliced` attribute the finding to the earliest changed
  slice and replay from the wrong place); no slice in range → either **pre-`BASE`**, which is
  dropped with a note because no replay can reach code this branch never touched, or
  **Unassigned**.
- **Merges rather than regenerates.** `- [~]` verbatim always; `- [x]` dropped; an open
  `- [ ]` removed only by a pass that reviewed its slice **with the agent that produced it**,
  and then recorded as `- [x] (not re-reported)` rather than deleted. An open finding on a
  `stable` slice, on a slice this pass didn't look at, from an agent this pass skipped, or in
  **Unassigned**, all carry forward. Full table in `commands/_sliced-format.md` §3.
- **Writes the machine state** the next run and the build loop each need: every slice's
  patch-id *and* touched-file list, this run's `changed` set in commit order, and the agents
  that ran.

It returns `changed`, `stable`, `counts`, `open`, `retracted`, `carried`, and
`droppedPreBase`. Use `--dry-run` to preview without writing.

## Step 5: Report

```
Reviewed <K> of <N> slices on <BRANCH> — every slice whose content or influence set moved.
Findings: <C critical, H high, M medium, L low>. Written to <REVIEW_FILE>.
```

- Name any findings `carried` forward rather than found this pass, any `retracted`, and any
  `droppedPreBase`. A retraction is a real event — say it happened.
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
- Scope, resolution, and the merge come from `slice-scope` and `slice-review`. They have a
  test suite; a hand-computed closure or merge does not. Your judgement is needed for the
  security-inert gate and for reading agent output — nothing else here.
- Scope is every slice that is not `stable` — own patch-id moved, or anything in its
  **influence set** moved: the transitive `Depends-On` closure plus any earlier slice sharing
  a touched file, before or after. The closure is the seam coverage; don't narrow it to direct
  dependents, which stops at depth+1. Neither term makes it a proof.
- "Changed" is keyed on patch-id, never SHA — SHAs churn on every replay, and a SHA-keyed
  comparison would mark the whole post-replay tail as changed.
- Kind and depth are derived from `Depends-On`, never read from a trailer. Group by depth,
  count by kind.
- An unreadable ledger stops the review. Never review a stack whose graph you had to guess at.
- Every finding keeps the `Slice-Id` it resolved to, even when that slice is out of scope;
  only a finding that resolves to no slice lands in Unassigned. That tag is what lets the
  build loop replay from the right place — a discarded or invented tag sends it to the
  wrong commit.
- The file is a merge, not a regeneration. A finding is removed only by a pass that looked
  at its slice with the agent that found it, and the removal is recorded, not silent.
  `- [~]` never resurrects as open.
- `--agents` must match what you actually ran. It is the coverage record the `unverified`
  rule depends on.
- Read-only. Never edit code, never touch history, never open a PR.
