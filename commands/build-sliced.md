---
description: "Build an entire feature as dependency-ordered commit slices on a single branch, foundation-first. Requires a spec artifact (Jira ticket AC, a TDD, or an EARS doc) and refuses work that isn't a greenfield layered feature. Git log is the ledger (Slice-Id trailers); resumable and crash-safe across replays. Re-invoke with no arguments to replay: consumes .plans/review-<branch>.md and rewinds to the earliest slice with an open finding. Peer to /ticket-work — no squash."
argument-hint: "[spec ref: TICKET-KEY | docs/tdds/{slug}.md | .plans/ears-{slug}.md] [base-branch] — omit both to replay the current branch"
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash(git:*)
  - Bash(mkdir:*)
  - Bash(rm:*)
  - Bash(ls:*)
  - Bash(read-ledger:*)
  - Bash(slice-replay:*)
  - Bash(make:*)
  - Bash(just:*)
  - Bash(task:*)
  - Bash(npm:*)
  - Bash(npx:*)
  - Bash(pnpm:*)
  - Bash(yarn:*)
  - Bash(bun:*)
  - Bash(deno:*)
  - Bash(python:*)
  - Bash(pytest:*)
  - Bash(tox:*)
  - Bash(uv:*)
  - Bash(poetry:*)
  - Bash(bundle:*)
  - Bash(rspec:*)
  - Bash(rake:*)
  - Bash(go:*)
  - Bash(cargo:*)
  - Bash(dotnet:*)
  - Bash(mvn:*)
  - Bash(gradle:*)
  - Bash(mix:*)
---

# Build Sliced

Build a feature as a stack of **commit slices** on one branch. Each slice is one commit
carrying `Slice-Id` / `Depends-On` trailers — git log is the ledger, there is no
manifest. Kind and depth are **derived** from the recorded dependency edges, not
declared; foundation slices (types, schemas, contracts) come first, leaves last. The loop
is: build → `/review-slices` → replay from the earliest touched slice → repeat, until you
are satisfied. **You decide when it ends; this command never auto-exits.**

> Shared formats and the reasoning behind them: `commands/_sliced-format.md`.
> Every derivation over the ledger belongs to a CLI — `read-ledger` and `slice-replay`.
> Do not hand-roll a `git log --format=%(trailers:…)`, a patch-id comparison, a closure, or
> a replay start; each has a silent failure mode the CLIs already handle and are tested for.
> This command owns its branch exclusively and force-pushes on every replay — never
> point it at a shared branch.

## Step 0: Preflight — spec, base, plans, ledger

Everything downstream needs to know whether this is a first invocation or a resume, so
resolve that first. Nothing here touches the worktree or rewrites history; the one write is
`git fetch`, which only advances remote-tracking refs.

- `PLANS_DIR` = `.plans` (mkdir if missing).
- **Resolve the resume target from the spec, not from where you happen to be standing.**
  - `$1` given → identify the artifact (ticket key, TDD path, EARS path — no gate yet, just
    identity) and derive the branch name from it: the ticket key lowercased, or the TDD/EARS
    slug; kebab-case, ≤6 words. That is `BRANCH`.
  - No `$1` → this is the documented replay invocation. `BRANCH` = the current branch, which
    must carry `git config branch.<BRANCH>.slicedSpec`. **Missing config is a refusal
    whether or not a ledger exists** — say that `/build-sliced` needs a spec reference. A
    ledger without a spec is the worse of the two cases, not a licence to continue: Step 1's
    gate is skipped on resume, and Step 4 decides *where the feature is incomplete* by
    reading the spec, so there would be nothing to build against. Re-invoke with the spec
    reference to adopt the existing stack — Step 2 records the config and the ledger is
    picked up unchanged.
- `BASE` = `$2` → else `git config branch.<BRANCH>.base` → else `main`.
- **If `BRANCH` exists**, `git fetch origin <BASE>` and read the ledger with drift in one
  call — `<BASE>..<BRANCH>`, since you may not be on it yet:

  ```bash
  read-ledger --base <BASE> --head <BRANCH> --drift
  ```

  Exit 2 → the ledger is unreadable; stop and report its `violations` verbatim. Otherwise
  `slices` is the stack in commit order, with `kind`, `depth`, `patchId` and `touched`
  already derived.

  **The drift check is gated on the branch existing, not on `RESUMING`.** A branch with zero
  slices still sits on whatever base it was cut from, and `git switch` to it in Step 2 does
  no fetch — so skipping the check there founds the whole feature on a stale base, which is
  the exact failure the "never branch from a local `<BASE>`" rule exists to prevent.
- `RESUMING` = true iff `BRANCH` exists **and** (`slices` is non-empty or a replay cursor
  exists in `PLANS_DIR` for it).

`RESUMING` is a fact about the spec's branch, never about the working directory. Deriving it
from the current branch lets `/build-sliced NEW-123`, fired while standing on an unrelated
sliced stack, skip the trigger gate and append the new feature's slices to someone else's
branch.

**Stop and report** — never build on a ledger you had to guess at:

- **Any `read-ledger` violation.** The table in `commands/_sliced-format.md` §1 says what
  each code means; the CLI's own message names the fix. Do not treat a commit without an id
  as unsliced and build on top of it, and do not "work around" a dangling edge or a cycle —
  replay scope, depth, and the `stable` predicate all derive from those edges.
- **`drift.advanced` is true.** Name the fix rather than acting on it — this rewrites
  every slice's SHA and the user should choose when that happens. `drift.behindBy` is the
  count:

  ```
  <BRANCH> is <drift.behindBy> commits behind origin/<BASE>. Rebase before continuing:
    git rebase origin/<BASE>
  Then re-run. Do NOT merge origin/<BASE> in — a merge commit carries no Slice-Id
  and makes the ledger unreadable to /build-sliced and /review-slices alike.
  ```

  A rebase is the safe move here precisely because the ledger is keyed on `Slice-Id`, not on
  SHA: commit messages carry through, so every id and every edge survives the replay of the
  stack onto the new base. Expect patch-ids to move where the rebase shifted diff context —
  that is a truthful `shape-changed`, and the next `/review-slices` will scope to it.

## Step 1: Trigger gate (refuse before building)

**If `RESUMING`, skip this step entirely** — the gate already passed on the first
invocation, and `branch.<BRANCH>.slicedSpec` records which spec it passed for.

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

## Step 2: Switch to the branch and resolve paths

- `BRANCH` came from the spec in Step 0. If it exists, `git switch <BRANCH>`; otherwise
  `git fetch origin <BASE>` then `git switch -c <BRANCH> origin/<BASE>`. Branch from
  `origin/<BASE>`, never a local `<BASE>` — a stale local ref silently puts the whole feature
  on the wrong foundation.
- A `$1` that disagrees with the current branch's `slicedSpec` means **switch, never
  append**. Two specs never share a stack.
- Record the spec so a no-arg resume can find its way back:
  `git config branch.<BRANCH>.slicedSpec <$1>` and `git config branch.<BRANCH>.base <BASE>`.
  Durable, per-branch, no new file — the same convention Step 0 reads `branch.<x>.base` from.
- `SLUG` = `<BRANCH>` with `/` and `_` → `-`. Cursor = `{PLANS_DIR}/replay-<SLUG>`.
  Review file = `{PLANS_DIR}/review-<SLUG>.md`.

## Step 3: Reconcile state (idempotent resume)

Determine mode. Do **not** derive kind or depth here: mid-build the derivations are
meaningless — a slice nothing depends on *yet* reads as a leaf — and nothing in this step
uses them. Step 4 and Step 5 each re-derive against a complete set.

- **Crash recovery first.** If the cursor file exists, the previous replay died
  mid-flight. `slice-replay recover --branch <BRANCH> --plans-dir <PLANS_DIR>` reports the
  cursor and the worktree state in one call. **Guard before repairing** — the repair itself
  is a hard reset, and it runs ahead of Step 5's own guard. In this order:
  1. If `worktree.cherryPickInProgress`, `git cherry-pick --abort`. This comes **first**
     because a conflicted cherry-pick leaves paths staged `AA`/`UU`, so judging
     `worktree.clean` before the abort would see a dirty tree and tell the user to commit or
     stash — advice that would commit conflict markers. Aborting is safe here: Step 5.1
     guaranteed a clean tree when the replay began, so anything dirty now came from the
     replay itself.
  2. Re-probe. `worktree.clean` must be true. A crash mid-replay is precisely when the tree
     holds half-finished work, so this is the guard's highest-value moment, not a formality.
     If still dirty, stop and tell the user to commit or stash.

  Then `git reset --hard <headBefore>` (from the cursor) and go to **Step 5 (Replay)**,
  re-entering at **step 5.4** with the existing cursor. Re-entry there is deliberate: the
  cursor already holds the pre-rewind fingerprints the dead replay was working against, and
  the reset restored the stack they were measured on, so there is nothing to re-capture.
  Do not build new work until the interrupted replay is repaired.
- **Review pending.** Else if `review-<SLUG>.md` exists with **open** (`- [ ]`) findings
  → **Step 5 (Replay)**. Declined findings (`- [~]`) are terminal and never trigger a
  replay (`commands/_sliced-format.md` §3, "Finding states"); a file whose only remaining
  items are `- [x]` or `- [~]` is settled. `slice-replay plan` reports `settled: true` when
  nothing is open, so let it make that call rather than eyeballing the checkboxes.
- **Fresh or continue.** Else → **Step 4 (Build)**. If the ledger is empty this is a cold
  start; otherwise continue adding slices where the feature is incomplete. If the feature
  is complete and nothing is pending, say so, report the hand-off (Step 6), and stop — don't
  invent slices.

Never trust SHAs across runs — they churn on replay. `Slice-Id` order in the ledger is
the truth; a slice is "present" iff `read-ledger` lists its id (it refuses duplicates, so
one appearance is guaranteed).

## Step 4: Build slices (foundation-first)

Decompose the feature **bottom-up** from the spec's foundation surface (Step 1a): build
what nothing else depends on first — the contracts/types/schemas the spec named — then
the consumers on top. This makes foundation-first fall out of dependency order rather
than a pre-committed plan.

For each slice, in order:

1. Write the code and its tests, then **run the bar** — the slice compiles and its own
   tests pass against the tree at this commit (`commands/_sliced-format.md` §1c). Determine
   the project's test command from the repo; if you cannot, ask rather than guess.
2. Mint a `Slice-Id` (`s01`, `s02`, … in creation order, never renumbered). Set
   `Depends-On` to **every** slice id this one builds on, comma-separated, or `none`.
   Under-reporting an edge silently narrows review scope, replay scope, and the
   kind/depth derivations — name them all. **Only ever name an earlier slice**: replay is
   positional, so a dependency on a later commit is a `forward-edge` violation and stops the
   ledger. If a slice you already committed turns out to need a foundation you have not
   written yet, the fix is to reorder (rebase), not to point an edge forward.
3. Commit with both trailers in a **single** `-m`
   (`commands/_sliced-format.md` §1, "Committing the trailer"):

   ```bash
   git commit -m "<subject>" -m "Slice-Id: <id>
   Depends-On: <dep>[, <dep>…]|none"
   ```

   **Stage the slice's own paths, never `git add -A`.** The cursor and the review file live
   in `{PLANS_DIR}` inside the worktree, and a repo that doesn't gitignore `.plans/` will let
   a blanket add commit them into a slice — which pollutes that slice's touched-file list (so
   the overlap term starts matching on `.plans/` paths) and, on a replay, commits the crash
   cursor itself. Confirm `.plans/` is ignored or excluded before the first commit.

   Splitting the trailers across two `-m` flags leaves `Slice-Id` **empty** — the commit
   succeeds and looks correct, but the ledger becomes unreadable. Re-run `read-ledger` after
   committing rather than reading `git log` by eye; the empty field is invisible there.

   One commit per slice — never fold two slices into one, never split one slice across
   two commits. Let the spec's dependency structure decide how many slices there are:
   effort is not a slicing axis, and a target count would refuse features it has no reason
   to refuse. What *is* bounded is the session: if the remaining slices will not fit in one
   pass, halt and name what's left rather than rushing the tail.

4. Do not squash. This is the deliberate divergence from `/ticket-work`'s stage-squash;
   preserved commits are the whole point.

**Escalation.** If a slice cannot be made green against its bar, **halt and report a plan
defect** — name the slice, the bar it fails, and what the spec appears to require that the
code cannot deliver. Never improvise a weaker slice, never relax a test to reach green, and
never fold the failing work into a neighbouring slice to hide it. A halted build with a
named defect is a useful result; a green build that reached green by lowering the bar is
not.

When the feature is fully built, `read-ledger --base <BASE>` once more for the final
kind/depth counts — the derivations are only meaningful against a complete slice set. Then
push (`git push -u origin <BRANCH>`) and go to **Step 6 (Report)**. Tell the user to run
`/review-slices`.

## Step 5: Replay from earliest touched slice

Triggered by open findings in `review-<SLUG>.md`, or by crash recovery.

1. **Guard the worktree.** `git status --porcelain` must be empty. This step
   hard-resets; uncommitted work would be destroyed silently. If dirty, stop and tell the
   user to commit or stash.
2. **Plan the replay.** One call does the selection, the pre-rewind fingerprint capture,
   and the cursor write — in that order, all before anything is rewritten:

   ```bash
   slice-replay plan --base <BASE> --branch <BRANCH> --plans-dir <PLANS_DIR>
   ```

   It returns `start`, `startIndex`, `parentSha`, `replaySpan`, `findingIds`, and
   `headBefore`. `start` is the slice with an open finding that comes **earliest in commit
   order** — not depth, not kind. Out-of-scope findings carry real ids and are included in
   that selection; `Unassigned` findings anchor to the earliest id in the review file's
   `changed` list. Do not second-guess any of this, and do not compute a start yourself:
   the rewind is positional, so any later start leaves earlier findings unreachable and the
   next run picks the same start forever.

   Exit 2 → stop and report. `stale-review` means an open finding names an id that is not in
   the ledger; `unanchored-unassigned` means an Unassigned finding has nothing to anchor to.
   Both are "re-run `/review-slices`", never "guess a start".
3. **Rewind.** `git reset --hard <parentSha>`. Everything in `replaySpan` is re-applied,
   but only the slices that need it are re-derived. `git reset --hard` moves the branch ref
   but leaves the old commits reachable by SHA, which is what makes the cherry-pick path
   work — and the cursor holds those SHAs, so a crash cannot lose them.
4. **Walk `replaySpan` in order.** Re-derivation is the fallback, not the default — you
   find out whether a foundation change reshaped a leaf by trying, not by assuming:
   - **The slice is in `findingIds`** → re-derive it: apply the findings and re-commit with
     the same trailer block. **Carry forward the original `Slice-Id`.** Never mint a new id
     for a slice that already existed; that orphans its review feedback and breaks the
     replay-diff. Update `Depends-On` only if the re-derivation genuinely changed what this
     slice builds on — and only ever toward an earlier slice.
   - **Otherwise** → `git cherry-pick <the cursor's before[id].sha>`. **Never `-x`**: it
     appends `(cherry picked from commit …)` to the last paragraph of the message, which is
     the trailer block, and a third trailer line is not what you meant to write. A plain
     cherry-pick preserves the patch exactly, so the patch-id survives and the trailers come
     along untouched. Re-deriving a slice with no finding is work with no expected change,
     and it destroys the one signal the replay-diff runs on: an agent re-implementing from
     spec essentially never reproduces a byte-identical patch, so everything downstream of a
     fix would read as `shape-changed` forever. Note that a fix to `start` puts every later
     slice in a moved influence set — if that alone triggered re-derivation, this path would
     never run.
   - **Then run the bar** on the slice, whether re-derived or cherry-picked, **unless
     `slice-replay classify` puts it in `barSkipped`** — i.e. it classifies
     `regenerated-identical`: its own patch-id *and* every patch-id in its influence set
     unchanged (`commands/_sliced-format.md` §1b). `changed`, `shape-changed`, and
     `context-changed` all run it. A clean cherry-pick is **not** a green light: it
     preserves the patch, not the tree, and a patch that reads identically against a moved
     foundation is exactly the case that compiled yesterday and fails today.
   - **A cherry-pick conflict, or a red bar on a cherry-picked slice**, means the slice
     genuinely reshaped against the corrected upstream. On a **conflict, abort before
     re-deriving**: `git cherry-pick --abort`. A conflicted cherry-pick is not a no-op that
     left the tree alone — it leaves conflict markers in the working files, the paths staged
     `AA`/`UU`, and `CHERRY_PICK_HEAD` set. Re-deriving into that state writes code around
     conflict markers and lets `git commit` silently reuse the cherry-picked message instead
     of the trailer block you meant to write. Abort, re-derive against the corrected
     upstream, and let the classifier call it `shape-changed`. This is the only evidence that
     a downstream slice needed rewriting, and it is cheaper to collect than to assume.
5. **Classify.** `slice-replay classify --base <BASE> --branch <BRANCH> --plans-dir
   <PLANS_DIR>` reads the cursor's pre-rewind fingerprints and returns each replayed slice's
   `class`, `runsBar`, `depth`, and moved influences, plus the re-derived kind and depth for
   the post-replay edge set (a foundation change can add or remove an edge, flipping a
   derived kind and shifting depths downstream). This is Step 6's replay-diff.

   **A non-empty `findingsUnaddressed` is a bug in this run, not a report.** It names slices a
   finding was routed to whose patch did not move — meaning the slice was cherry-picked when
   it should have been re-derived. Go back to step 4 and re-derive them; do not push. Nothing
   else catches this: the classification alone reads as an ordinary skip.
6. **Finish.** `git push --force-with-lease origin <BRANCH>`, then
   `slice-replay clear --branch <BRANCH> --plans-dir <PLANS_DIR>` to delete the cursor —
   in that order, never before the push. Mark the addressed findings `- [x]` in the review
   file. A replay never leaves an in-scope finding open: address it, or **halt and report a
   plan defect** naming the finding and why the slice cannot satisfy it — same escalation as
   a slice that cannot reach green. Leaving it `- [ ]` re-picks the same start on every
   future invocation and pins the loop. Only a human marks a finding `- [~]` declined.

   A finding that says the *slicing* is wrong — two slices should be one, or one should
   split — cannot be addressed by a replay at all, because the slice set is fixed and
   `Slice-Id` is immutable. Halt as a plan defect and say so
   (`commands/_sliced-format.md` §3, "What a finding cannot express").

If interrupted between steps 2 and 6, the cursor survives and Step 3's crash-recovery
repairs it on the next run.

## Step 6: Report

**After a build:**
```
Built <N> slices on <BRANCH> (<F> foundation, <L> leaf — derived), pushed.
Run /review-slices to review the stack.
```

**After a replay**, emit a **structured replay-diff** straight from `slice-replay
classify` — one line per replayed slice, so the user re-reads only what moved:

```
Replayed from <start>. Force-pushed <BRANCH>.
  <id> depth 0  changed                — <what changed, per findings>
  <id> depth 1  context-changed        — patch identical, rebuilt on a moved foundation
  <id> depth 1  regenerated-identical
  <id> depth 2  shape-changed          — prior review comment on this slice is now stale
Addressed <M> of <T> findings. Re-run /review-slices, or declare done and open a PR.
```

- `changed` — own patch-id moved, and a finding was addressed here. Ran its bar.
- `shape-changed` — own patch-id moved but no finding targeted this slice; an upstream change
  reshaped it. Any prior comment on it may be stale. Flag these explicitly — they are
  where review feedback silently rots. Ran its bar.
- `context-changed` — own patch-id unchanged, but something in its influence set moved. Prior
  comments still describe the text accurately; the *verdict* was never re-earned, so it
  **ran its bar**. This is the class a patch-id-only comparison misses.
- `regenerated-identical` — own patch-id and the whole influence set unchanged, so nothing git
  can see beneath the slice moved. No re-review needed and the bar was skipped.
  `/review-slices` reaches the same conclusion independently from the slicemap, so this line
  is a report of a derived fact, not a claim it has to trust.

Also surface any `unmeasured: true` slice — one present in the ledger but absent from the
cursor, which means it was added after the replay began and was classified against nothing.

`M < T` should not happen: a replay that cannot address an in-scope finding halts as a plan
defect (Step 5.6) rather than pushing a stack with known-open work. If a human has declined
findings, say how many and move on.

When the stack is settled, say so and hand off — this command does not open PRs, and nothing
downstream picks the branch up on its own:

```
<BRANCH> is settled: <N> slices, no open findings. Take it through the normal PR flow.
```

## Guidelines

- Git is the ledger. Never write a manifest or a plan file; the commits and their
  trailers carry everything except the crash cursor. Content identity is derived from
  patch-id and the influence set, not cached in a file.
- Every derivation over the ledger goes through `read-ledger` or `slice-replay`. They have a
  test suite; a hand-rolled `git log --format`, patch-id comparison, or closure does not,
  and each of the spellings involved has a silent failure mode.
- `Slice-Id` is immutable across replays. This is the one invariant that cannot bend.
  Both trailers go in one `-m`; `read-ledger` is how you check, not `git log`.
- `Depends-On` names **every** dependency, and only ever an **earlier** slice. It is the only
  record of the graph — review scope, replay scope, kind, depth, and the `stable` predicate
  all derive from it, so an unrecorded edge silently narrows all five. An edge that doesn't
  resolve, points forward, or closes a cycle stops the command.
- Kind and depth are derived, never declared, and only meaningful against a complete
  slice set. Neither one orders a replay — commit order does, and `slice-replay plan` owns
  that choice.
- One commit per slice; each green against its bar in isolation; no squashing. No target
  slice count — effort is not a slicing axis. A commit with no `Slice-Id` — a merge commit
  above all — makes the ledger unreadable; rebase onto a moved `<BASE>`, never merge it in.
- The bar is one fixed thing: compiles, own tests pass, against that slice's tree
  (`commands/_sliced-format.md` §1c). If the project's runner isn't in `allowed-tools`, stop
  and say so rather than substituting a check you can run.
- Resume identity comes from the spec (`branch.<x>.slicedSpec`), never from the current
  branch. Missing that config is a refusal even when a ledger exists. Two specs never share
  a stack.
- Base drift is checked whenever the branch exists, not only on resume — an empty branch sits
  on a base too, and `git switch` does not fetch.
- A replay re-derives only the slices carrying a finding and cherry-picks the rest (never
  `-x`), then re-derives a cherry-picked slice on evidence — a conflict or a red bar — never
  because its influence set moved. A clean cherry-pick preserves the patch, not the tree; a
  conflicted one leaves markers and `CHERRY_PICK_HEAD` behind, so `--abort` before
  re-deriving.
- The command owns its branch and force-pushes on replay — never a shared branch. Never
  hard-reset a dirty worktree — including the crash-recovery reset, which is the one most
  likely to meet one. Push before clearing the cursor, never after.
- A slice that cannot reach green, a finding a replay cannot address, or a finding that says
  the slicing itself is wrong, all halt the build as a named plan defect. Never lower the bar
  to reach green. Skipping the bar for a `regenerated-identical` slice is not lowering it;
  skipping it for an identical patch on a moved foundation is. That skip is the best git can
  justify, not a proof — a coupling with neither a declared edge nor a shared file is
  invisible to it.
- Manual exit only. No open findings means "nothing to replay"; wait for the user.
