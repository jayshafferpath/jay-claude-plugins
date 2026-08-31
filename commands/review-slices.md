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

> Shared formats (trailer, fingerprint, review file): `commands/_sliced-format.md`. Use
> the exact command forms it gives — each has a silent failure mode.
> Findings-only, read-only. This command never edits code and never rewrites history.

## Step 1: Resolve branch, base, plans

- `BRANCH` = `git branch --show-current`.
- `BASE` = `$1` → else `git config branch.<BRANCH>.base` → else `main`.
- `PLANS_DIR` = `.plans` (mkdir if missing). `SLUG` = `<BRANCH>` with `/`,`_` → `-`.
- `REVIEW_FILE` = `{PLANS_DIR}/review-<SLUG>.md`. Overwrite if it exists — but read it
  first: the prior slicemap drives Step 3, and every declined (`- [~]`) finding must be
  carried forward into the new file (`commands/_sliced-format.md` §3, "Finding states").
  Regenerating a declined finding as open would push `/build-sliced` back into a replay
  the user already rejected.

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

If any commit in range lacks a `Slice-Id`, **or carries an empty one**, stop and report:
this branch wasn't built by `/build-sliced`, a commit was added by hand, or the trailers
were split across multiple `-m` flags so `Slice-Id` never parsed
(`commands/_sliced-format.md` §1, "Committing the trailer"). The review scope can't be
computed reliably either way.

## Step 3: Compute review scope (changed slices + dependents)

**Changed slices** = the slices whose **patch-id** differs from the last review. Compare
each slice's current patch-id (`commands/_sliced-format.md` §1b) against the
`<!-- slicemap -->` recorded by the previous run; any id whose patch-id moved, or any id
absent from the prior map, is changed. If there is **no** prior review file, every slice
is "changed" (first review of the stack).

Key on patch-id, **never on SHA**. A replay rewinds and re-commits, so every slice from
the replay point to the tip gets a fresh SHA even when its content is untouched — a
SHA-keyed comparison would mark the entire tail as changed and re-review work that
provably didn't move.

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
- Resolves to **no** slice in range (empty output, or the path is gone) → **Unassigned**.
  `/build-sliced` treats unassigned findings as touching the earliest changed slice.

## Step 6: Write the review file

Follow `commands/_sliced-format.md` §3 exactly. Group findings by slice **depth** (the
derived value from Step 2 — shallowest first, the order the build loop re-derives in),
`Critical` first within a depth. Every actionable item is a checkbox prefixed with its
`Slice-Id`.

Carry forward every `- [~]` declined finding from the prior file verbatim, whether or not
this pass rediscovered it. Findings this pass found fresh are always `- [ ]`.

Embed the current slice map as an HTML comment so the next review can compute "changed":

```
<!-- slicemap: s01=<patch-id> s02=<patch-id> ... -->
```

Record **patch-ids, not SHAs** — see Step 3.

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
- "Changed" is keyed on patch-id, never SHA — SHAs churn on every replay.
- Kind and depth are derived from `Depends-On`, never read from a trailer. Group by depth.
- Every finding keeps the `Slice-Id` it resolved to, even when that slice is out of scope;
  only a finding that resolves to no slice lands in Unassigned. That tag is what lets the
  build loop replay from the right place — a discarded or invented tag sends it to the
  wrong commit.
- Declined (`- [~]`) findings carry forward across regenerations. Never resurrect one as
  open.
- Read-only. Never edit code, never touch history, never open a PR.
