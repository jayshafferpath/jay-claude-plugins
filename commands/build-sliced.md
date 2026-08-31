---
description: "Build an entire feature as dependency-ordered commit slices on a single branch, foundation-first. Requires a spec artifact (Jira ticket AC, a TDD, or an EARS doc) and refuses work that isn't a greenfield layered feature. Git log is the ledger (Slice-Id trailers); resumable and crash-safe across replays. Consumes .plans/review-<branch>.md to auto-replay from the earliest touched slice. Peer to /ticket-work — no squash."
argument-hint: <spec ref: TICKET-KEY | docs/tdds/{slug}.md | .plans/ears-{slug}.md> [base-branch]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(git:*), Bash(gh:*), Bash(mkdir:*), Bash(rm:*)
---

# Build Sliced

Build a feature as a stack of **commit slices** on one branch. Each slice is one commit
carrying `Slice-Id` / `Depends-On` trailers — git log is the ledger, there is no
manifest. Foundation and leaf are **derived** from the recorded dependency edges, not
declared; foundation slices (types, schemas, contracts) come first, leaves last. The loop
is: build → `/review-slices` → replay from the earliest touched slice → repeat, until you
are satisfied. **You decide when it ends; this command never auto-exits.**

> Shared formats (trailer, replay cursor, review file): `commands/_sliced-format.md`.
> This command owns its branch exclusively and force-pushes on every replay — never
> point it at a shared branch.

## Step 0: Trigger gate (refuse before building)

`$1` is a **spec reference**, not a free-text description. This workflow's payoff
depends on foundations being stable enough to freeze on review cycle 1 — and
foundations are only stable if they were *specified*, not improvised while slicing. So
build nothing until all three checks pass. On any failure, **refuse and name the better
home** — never build on a failed gate, never proceed on an override.

**On resume, skip Step 0 entirely.** If the current branch already carries slice commits
(Step 2 finds a `Slice-Id`) or a replay cursor exists, the gate already passed on the
first invocation — go straight to Step 2.

### 0a: A spec artifact exists and names the foundation surface

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

### 0b: The work fits — greenfield layered feature

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

### 0c: Manual invocation

This command is human-fired only; nothing upstream routes into it yet. If you were
invoked by another command or automation, stop and report that `/build-sliced` is
manual-only.

When 0a–0c all pass, continue to Step 1.

## Step 1: Resolve branch, base, plans

- `PLANS_DIR` = `.plans` (mkdir if missing).
- `BASE` = `$2` → else `git config branch.<current>.base` → else `main`.
- `BRANCH`: if the current branch is not `BASE` and has slice commits (Step 2 finds
  any), stay on it. Otherwise derive a branch name from the **spec** (the ticket key
  lowercased, or the TDD/EARS slug; kebab-case, ≤6 words) and
  `git switch -c <BRANCH> <BASE>`.
- `SLUG` = `<BRANCH>` with `/` and `_` → `-`. Cursor = `{PLANS_DIR}/replay-<SLUG>`.
  Review file = `{PLANS_DIR}/review-<SLUG>.md`.

## Step 2: Reconcile state (idempotent resume)

Read the ledger:

```bash
git log <BASE>..HEAD --format='%H%x00%(trailers:key=Slice-Id,valueonly)%x00%(trailers:key=Depends-On,valueonly)%x00%s'
```

Parse into `SLICES` (reverse to build order), then derive each slice's kind from the
recorded edges per `commands/_sliced-format.md` §1a — a slice is a **leaf** iff no other
slice names it in `Depends-On`, **foundation** otherwise. Kind is never read from a
trailer. Then determine mode:

- **Crash recovery first.** If the replay cursor file exists, the previous replay died
  mid-flight. `git reset --hard <head_before>` (from the cursor), then go to
  **Step 4 (Replay)** starting at the cursor's `replay_from`. Do not build new work
  until the interrupted replay is repaired.
- **Review pending.** Else if `review-<SLUG>.md` exists with unchecked `- [ ]` findings
  → **Step 4 (Replay)**.
- **Fresh or continue.** Else → **Step 3 (Build)**. If `SLICES` is empty this is a cold
  start; otherwise continue adding slices where the feature is incomplete.

Never trust SHAs across runs — they churn on replay. `Slice-Id` order in the ledger is
the truth; a slice is "present" iff its id appears exactly once in `SLICES`.

## Step 3: Build slices (foundation-first)

Decompose the feature **bottom-up** from the spec's foundation surface (Step 0a): build
what nothing else depends on first — the contracts/types/schemas the spec named — then
the consumers on top. This makes foundation-first fall out of dependency order rather
than a pre-committed plan.

For each slice, in order:

1. Write the code and its tests. Each slice must **compile and pass its own tests in
   isolation** — a reviewer reads it as a standalone commit. Cache the result against the
   slice's content so a later replay that regenerates this slice identically can reuse the
   verdict instead of re-running (see Step 4).
2. Mint a `Slice-Id` (`s01`, `s02`, … in creation order, never renumbered). Set
   `Depends-On` to **every** slice id this one builds on, comma-separated, or `none`.
   Under-reporting an edge silently narrows review scope, replay scope, and the
   foundation/leaf derivation — name them all.
3. Commit with the trailer block from `commands/_sliced-format.md` §1:

   ```
   git commit -m "<subject>" -m "Slice-Id: <id>" -m "Depends-On: <dep[, dep…]|none>"
   ```

   One commit per slice — never fold two slices into one, never split one slice across
   two commits. Aim for 6–12 slices for a feature; if you're past ~12, the feature is
   too big for one loop — stop and tell the user to split it.

4. Do not squash. This is the deliberate divergence from `/ticket-work`'s stage-squash;
   preserved commits are the whole point.

**Escalation.** If a slice cannot be made green against its bar, **halt and report a plan
defect** — name the slice, the bar it fails, and what the spec appears to require that the
code cannot deliver. Never improvise a weaker slice, never relax a test to reach green, and
never fold the failing work into a neighbouring slice to hide it. A halted build with a
named defect is a useful result; a green build that reached green by lowering the bar is
not.

When the feature is fully built, derive each slice's kind from the now-complete edge set
(`commands/_sliced-format.md` §1a) — mid-build the derivation is meaningless, because a
slice nothing depends on *yet* reads as a leaf. Then push
(`git push -u origin <BRANCH>`) and go to **Step 5 (Report)**. Tell the user to run
`/review-slices`.

## Step 4: Replay from earliest touched slice

Triggered by findings in `review-<SLUG>.md`.

1. **Pick the start.** Read the review file. The start slice is the **earliest-depth,
   earliest-order** slice with an unchecked finding — foundation before leaf by the derived
   kind (`commands/_sliced-format.md` §1a), and among equal depth the earliest by build
   order. `Unassigned` findings count as touching the earliest changed slice. Call it
   `START`.
2. **Write the cursor** (`commands/_sliced-format.md` §2) **before** rewriting anything:
   `replay_from=<START> started=<now> head_before=<current HEAD sha>`.
3. **Rewind.** `git reset --hard <parent of START's commit>`. Everything from `START`
   onward will be re-derived.
4. **Re-derive each slice from `START` to the tip, in order.** For each:
   - Apply the findings addressed to that slice.
   - Re-derive downstream slices against the corrected upstream — a foundation change
     may reshape a leaf. **Carry forward the original `Slice-Id`.** Never mint a new id
     for a slice that already existed; that orphans its review feedback and breaks the
     replay-diff.
   - Re-commit with the same trailer block (same `Slice-Id`, updated code). Update
     `Depends-On` if the re-derivation genuinely changed what this slice builds on.
   - Keep each slice green in isolation as in Step 3 — but **reuse the cached verdict for
     any slice that regenerated identically.** Content-identical means the bar cannot come
     out differently than it did last cycle, so re-running it is waste. Only
     `changed` and `shape-changed` slices re-run.
5. **Re-derive kinds** from the post-replay edge set before reporting. A foundation change
   can add or remove an edge, which can flip a slice's derived kind.
6. **Finish.** `git push --force-with-lease origin <BRANCH>`, then **delete the cursor
   file** (`rm`). Mark the addressed findings `- [x]` in the review file.
7. **Emit the replay-diff** (Step 5), classifying each re-derived slice.

If interrupted between steps 3 and 5, the cursor survives and Step 2's crash-recovery
repairs it on the next run.

## Step 5: Report

**After a build:**
```
Built <N> slices on <BRANCH> (<F> foundation, <L> leaf — derived), pushed.
Run /review-slices to review the stack.
```

**After a replay**, emit a **structured replay-diff** — one line per slice from `START`
to the tip, so the user re-reads only what moved:

```
Replayed from <START>. Force-pushed <BRANCH>.
  <id> foundation  changed              — <what changed, per findings>
  <id> leaf         regenerated-identical
  <id> leaf         shape-changed        — prior review comment on this slice is now stale
Addressed <M> findings. Re-run /review-slices, or declare done.
```

- `changed` — re-derived to address a finding. Re-runs its bar.
- `regenerated-identical` — rebuilt but functionally the same; no re-review needed, and the
  cached verdict is reused rather than re-run. This classification is the cache key, not
  just a report line.
- `shape-changed` — an upstream change reshaped this slice; any prior comment on it may
  be stale. Flag these explicitly — they are where review feedback silently rots. Re-runs
  its bar.

## Guidelines

- Git is the ledger. Never write a manifest or a plan file; the commits and their
  trailers carry everything except the crash cursor and the verdict cache.
- `Slice-Id` is immutable across replays. This is the one invariant that cannot bend.
- `Depends-On` names **every** dependency. It is the only record of the graph, and kind is
  derived from it — an unrecorded edge silently narrows review scope, replay scope, and the
  foundation/leaf split.
- Kind is derived, never declared, and only meaningful against a complete slice set.
- One commit per slice; each green in isolation; no squashing.
- The command owns its branch and force-pushes on replay — never a shared branch.
- A slice that cannot reach green halts the build as a named plan defect. Never lower the
  bar to reach green.
- Manual exit only. Empty findings means "nothing to replay"; wait for the user.
