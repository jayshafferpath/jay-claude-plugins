---
description: "Build an entire feature as dependency-ordered commit slices on a single branch, foundation-first. Requires a spec artifact (Jira ticket AC, a TDD, or an EARS doc) and refuses work that isn't a greenfield layered feature. Git log is the ledger (Slice-Id trailers); resumable and crash-safe across replays. Consumes .plans/review-<branch>.md to auto-replay from the earliest touched slice. Peer to /ticket-work — no squash."
argument-hint: <spec ref: TICKET-KEY | docs/tdds/{slug}.md | .plans/ears-{slug}.md> [base-branch]
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash(git:*)
  - Bash(gh:*)
  - Bash(mkdir:*)
  - Bash(rm:*)
  - Bash(ls:*)
  - Bash(make:*)
  - Bash(npm:*)
  - Bash(npx:*)
  - Bash(pnpm:*)
  - Bash(yarn:*)
  - Bash(python:*)
  - Bash(pytest:*)
  - Bash(bundle:*)
  - Bash(rspec:*)
  - Bash(go:*)
  - Bash(cargo:*)
---

# Build Sliced

Build a feature as a stack of **commit slices** on one branch. Each slice is one commit
carrying `Slice-Id` / `Depends-On` trailers — git log is the ledger, there is no
manifest. Kind and depth are **derived** from the recorded dependency edges, not
declared; foundation slices (types, schemas, contracts) come first, leaves last. The loop
is: build → `/review-slices` → replay from the earliest touched slice → repeat, until you
are satisfied. **You decide when it ends; this command never auto-exits.**

> Shared formats (trailer, fingerprint, replay cursor, review file):
> `commands/_sliced-format.md`. Use the exact command forms it gives — each has a silent
> failure mode.
> This command owns its branch exclusively and force-pushes on every replay — never
> point it at a shared branch.

## Step 0: Preflight — base, plans, ledger

Everything downstream needs to know whether this is a first invocation or a resume, so
read that first. Nothing here mutates the repo.

- `PLANS_DIR` = `.plans` (mkdir if missing).
- `BASE` = `$2` → else `git config branch.<current>.base` → else `main`.
- Read the ledger on the **current** branch (`commands/_sliced-format.md` §1, "Reading
  the ledger"). Parse into `SLICES` = `[{sha, id, dependsOn[], subject}]`, reversed to
  build order.
- `RESUMING` = true iff `SLICES` is non-empty, or a replay cursor exists in `PLANS_DIR`
  for the current branch.

If any commit in range has an **empty** `Slice-Id`, the trailer block was mis-committed —
almost always by passing each trailer as its own `-m`
(`commands/_sliced-format.md` §1, "Committing the trailer"). Stop and report it; do not
treat those commits as unsliced and build on top of them.

## Step 1: Trigger gate (refuse before building)

**If `RESUMING`, skip this step entirely** — the gate already passed on the first
invocation.

`$1` is a **spec reference**, not a free-text description. This workflow's payoff
depends on foundations being stable enough to freeze on review cycle 1 — and
foundations are only stable if they were *specified*, not improvised while slicing. So
build nothing until all three checks pass. On any failure, **refuse and name the better
home** — never build on a failed gate, never proceed on an override.

### 1a: A spec artifact exists and names the foundation surface

Resolve `$1` to one of the three accepted artifacts and read it. It must name the
feature's **boundaries** — the types/contracts/schemas the leaves will consume — not
just a goal. A spec that says only *what* the feature does, with no *foundation surface*
to slice against, fails this check.

- **Jira ticket key** (matches `[A-Z]+-\d+`): fetch via `mcp__atlassian__getJiraIssue`.
  Requires a populated Acceptance Criteria (and, ideally, `h2. Implementation Notes`
  from `planner`). No AC → fail.
- **A TDD** (`docs/tdds/{slug}.md` or a path ending `.md` under `docs/tdds/`): `Read` it.
  Requires the design/interface section that names contracts. This is the richest
  source — it already orders foundation before consumers.
- **An EARS requirements doc** (`.plans/ears-*.md` or a path the user names as EARS
  output): `Read` it. The structured requirements are the foundation surface.

If `$1` resolves to none of these, or the artifact lacks a foundation surface:

```
Refused: no spec artifact names this feature's foundation surface.
Provide one of:
  - a Jira ticket with Acceptance Criteria      (TICKET-KEY)
  - a TDD                                        (docs/tdds/{slug}.md — run @tdd-builder)
  - an EARS requirements doc                     (run /ears-requirements)
```

### 1b: The work fits — greenfield layered feature

This loop earns its machinery (ledger, replay, cursor) only for a feature with a real
**foundation→leaf** structure. Judge from the spec and a quick look at the repo. Refuse,
naming the better home, when the work is:

- **A single-file / trivial change** — no slices to order. → "too small to slice; make
  the change directly."
- **A pure refactor** — behavior-preserving restructuring. → "use `/refactor`."
- **Already ticketed and stacked** — the spec is a ticket that's part of a Story/Epic
  stack with a feature branch. → "use `/ticket-work {KEY}` — this is stacked work."

Only proceed when the spec describes new, internally-layered behavior: contracts/types
first, consumers built on them.

### 1c: Manual invocation

This command is human-fired only; nothing upstream routes into it yet. If you were
invoked by another command or automation, stop and report that `/build-sliced` is
manual-only.

When 1a–1c all pass, continue to Step 2.

## Step 2: Resolve branch and paths

- `BRANCH`: if `RESUMING` and the current branch is not `BASE`, stay on it. Otherwise
  derive a branch name from the **spec** (the ticket key lowercased, or the TDD/EARS
  slug; kebab-case, ≤6 words) and `git switch -c <BRANCH> <BASE>`. If the branch changed,
  re-read the ledger from Step 0 against it.
- `SLUG` = `<BRANCH>` with `/` and `_` → `-`. Cursor = `{PLANS_DIR}/replay-<SLUG>`.
  Review file = `{PLANS_DIR}/review-<SLUG>.md`.

## Step 3: Reconcile state (idempotent resume)

Derive each slice's kind and depth from the recorded edges per
`commands/_sliced-format.md` §1a. Kind and depth are never read from a trailer. Then
determine mode:

- **Crash recovery first.** If the cursor file exists, the previous replay died
  mid-flight. `git reset --hard <head_before>` (from the cursor), then go to
  **Step 5 (Replay)** starting at the cursor's `replay_from`. Do not build new work
  until the interrupted replay is repaired.
- **Review pending.** Else if `review-<SLUG>.md` exists with **open** (`- [ ]`) findings
  → **Step 5 (Replay)**. Declined findings (`- [~]`) are terminal and never trigger a
  replay (`commands/_sliced-format.md` §3, "Finding states"); a file whose only remaining
  items are `- [x]` or `- [~]` is settled.
- **Fresh or continue.** Else → **Step 4 (Build)**. If `SLICES` is empty this is a cold
  start; otherwise continue adding slices where the feature is incomplete. If the feature
  is complete and nothing is pending, say so and stop — don't invent slices.

Never trust SHAs across runs — they churn on replay. `Slice-Id` order in the ledger is
the truth; a slice is "present" iff its id appears exactly once in `SLICES`.

## Step 4: Build slices (foundation-first)

Decompose the feature **bottom-up** from the spec's foundation surface (Step 1a): build
what nothing else depends on first — the contracts/types/schemas the spec named — then
the consumers on top. This makes foundation-first fall out of dependency order rather
than a pre-committed plan.

For each slice, in order:

1. Write the code and its tests. Each slice must **compile and pass its own tests in
   isolation** — a reviewer reads it as a standalone commit. Run the project's own test
   command; if you can't determine it from the repo, ask rather than guess.
2. Mint a `Slice-Id` (`s01`, `s02`, … in creation order, never renumbered). Set
   `Depends-On` to **every** slice id this one builds on, comma-separated, or `none`.
   Under-reporting an edge silently narrows review scope, replay scope, and the
   kind/depth derivations — name them all.
3. Commit with both trailers in a **single** `-m`
   (`commands/_sliced-format.md` §1, "Committing the trailer"):

   ```bash
   git commit -m "<subject>" -m "Slice-Id: <id>
   Depends-On: <dep>[, <dep>…]|none"
   ```

   Splitting the trailers across two `-m` flags leaves `Slice-Id` **empty** — the commit
   succeeds and looks correct, but the ledger becomes unreadable. Verify after committing
   that the trailer round-trips.

   One commit per slice — never fold two slices into one, never split one slice across
   two commits. Aim for 6–12 slices for a feature; if the spec looks like more than ~12
   before you start, stop and tell the user to split it rather than discovering it at
   slice 13.

4. Do not squash. This is the deliberate divergence from `/ticket-work`'s stage-squash;
   preserved commits are the whole point.

**Escalation.** If a slice cannot be made green against its bar, **halt and report a plan
defect** — name the slice, the bar it fails, and what the spec appears to require that the
code cannot deliver. Never improvise a weaker slice, never relax a test to reach green, and
never fold the failing work into a neighbouring slice to hide it. A halted build with a
named defect is a useful result; a green build that reached green by lowering the bar is
not.

When the feature is fully built, derive kind and depth from the now-complete edge set
(`commands/_sliced-format.md` §1a) — mid-build the derivations are meaningless, because a
slice nothing depends on *yet* reads as a leaf. Then push
(`git push -u origin <BRANCH>`) and go to **Step 6 (Report)**. Tell the user to run
`/review-slices`.

## Step 5: Replay from earliest touched slice

Triggered by open findings in `review-<SLUG>.md`, or by crash recovery.

1. **Guard the worktree.** `git status --porcelain` must be empty. This step
   hard-resets; uncommitted work would be destroyed silently. If dirty, stop and tell the
   user to commit or stash.
2. **Pick the start.** Read the review file. `START` is the slice with an open finding
   that comes **earliest in commit order** — the ledger's build order, not depth and not
   kind. The rewind is positional, so any later start leaves earlier findings unreachable
   and the next run picks the same start again, forever
   (`commands/_sliced-format.md` §1a). Then:
   - `Out of scope` findings carry a real `Slice-Id` — include them in this selection. If
     one sits earlier than every in-scope finding, it becomes `START`.
   - `Unassigned` findings count as touching the earliest changed slice.
3. **Record the "before" fingerprints.** Compute the patch-id of every slice from `START`
   to the tip (`commands/_sliced-format.md` §1b) *before* rewinding. Step 6's
   classification and the test-bar skip both compare against these.
4. **Write the cursor** (`commands/_sliced-format.md` §2) **before** rewriting anything:
   `replay_from=<START> started=<now> head_before=<current HEAD sha>`.
5. **Rewind.** `git reset --hard <parent of START's commit>`. Everything from `START`
   onward will be re-derived.
6. **Re-derive each slice from `START` to the tip, in order.** For each:
   - Apply the findings addressed to that slice.
   - Re-derive downstream slices against the corrected upstream — a foundation change
     may reshape a leaf. **Carry forward the original `Slice-Id`.** Never mint a new id
     for a slice that already existed; that orphans its review feedback and breaks the
     replay-diff.
   - Re-commit with the same trailer block (same `Slice-Id`, updated code). Update
     `Depends-On` if the re-derivation genuinely changed what this slice builds on.
   - Keep each slice green in isolation as in Step 4 — but **skip the bar for any slice
     whose patch-id matches its step-3 value.** Identical content was green when it was
     committed, so re-running cannot yield a different verdict. Slices classified
     `changed` or `shape-changed` re-run.
7. **Re-derive kind and depth** from the post-replay edge set before reporting. A
   foundation change can add or remove an edge, which can flip a slice's derived kind and
   shift depths downstream.
8. **Finish.** `git push --force-with-lease origin <BRANCH>`, then **delete the cursor
   file** (`rm`). Mark the addressed findings `- [x]` in the review file. Leave findings
   you did not address as `- [ ]` — only a human marks one `- [~]` declined.
9. **Emit the replay-diff** (Step 6), classifying each re-derived slice.

If interrupted between steps 4 and 8, the cursor survives and Step 3's crash-recovery
repairs it on the next run.

## Step 6: Report

**After a build:**
```
Built <N> slices on <BRANCH> (<F> foundation, <L> leaf — derived), pushed.
Run /review-slices to review the stack.
```

**After a replay**, emit a **structured replay-diff** — one line per slice from `START`
to the tip, so the user re-reads only what moved. Classify each slice by comparing its
patch-id to the step-3 "before" value (`commands/_sliced-format.md` §1b):

```
Replayed from <START>. Force-pushed <BRANCH>.
  <id> depth 0  changed                — <what changed, per findings>
  <id> depth 1  regenerated-identical
  <id> depth 1  shape-changed          — prior review comment on this slice is now stale
Addressed <M> of <T> findings. Re-run /review-slices, or declare done.
```

- `changed` — patch-id moved, and a finding was addressed here. Ran its bar.
- `regenerated-identical` — patch-id unchanged. No re-review needed and the bar was
  skipped. `/review-slices` reaches the same conclusion independently from the slicemap,
  so this line is a report of a derived fact, not a claim it has to trust.
- `shape-changed` — patch-id moved but no finding targeted this slice; an upstream change
  reshaped it. Any prior comment on it may be stale. Flag these explicitly — they are
  where review feedback silently rots. Ran its bar.

If `M < T`, name the unaddressed findings. They keep the loop in replay mode until they
are addressed or a human declines them.

## Guidelines

- Git is the ledger. Never write a manifest or a plan file; the commits and their
  trailers carry everything except the crash cursor. Content identity is derived from
  patch-id, not cached in a file.
- `Slice-Id` is immutable across replays. This is the one invariant that cannot bend.
  Both trailers go in one `-m` — split across two, the id silently lands empty.
- `Depends-On` names **every** dependency. It is the only record of the graph, and kind
  and depth are derived from it — an unrecorded edge silently narrows review scope,
  replay scope, and both derivations.
- Kind and depth are derived, never declared, and only meaningful against a complete
  slice set. Neither one orders a replay — commit order does.
- One commit per slice; each green in isolation; no squashing.
- The command owns its branch and force-pushes on replay — never a shared branch. Never
  hard-reset a dirty worktree.
- A slice that cannot reach green halts the build as a named plan defect. Never lower the
  bar to reach green. Skipping the bar for an identical patch-id is not lowering it.
- Manual exit only. No open findings means "nothing to replay"; wait for the user.
