# Sliced-build formats

Reference fragment, not a slash command. `install.sh` skips `_`-prefixed files so this
is never symlinked into `~/.claude/commands/`.

Cited by `/build-sliced` and `/review-slices`. Defines the four load-bearing artifacts:
the **commit trailer** (the ledger), the **slice fingerprint** (content identity across
replays), the **replay cursor** (crash-safety), and the **review file** (feedback the
build loop consumes).

**Every derivation over these artifacts belongs to a CLI, not to prose.** The shapes below
are a function of their inputs — patch-ids, edge sets, closures, depths, the four replay
classes, the merge table — and `docs/design-notes.md` is explicit that derivable things get
derived once rather than re-specified per caller. Four commands own all of it:

| CLI | Owns |
|---|---|
| `read-ledger` | reading the trailers, validating the ledger, deriving kind/depth, patch-ids, touched files, base drift |
| `slice-scope` | the `stable` predicate, the influence set, review scope, the diff range |
| `slice-replay` | the replay start, the cursor, the four replay classes, the worktree guard's inputs |
| `slice-review` | resolving a finding to its slice, the merge rules, rendering the review file |

Run them with `--help`; each prints the reasoning behind its output. This file explains
**why** the shapes are what they are and what the CLIs refuse to guess at. Never
re-implement a derivation described here by hand — the point of the split is that the graph
math has one implementation and a test suite, not one per call site.

## 1. Commit trailer — the ledger

Every slice is exactly one commit. Git log *is* the plan; there is no separate
manifest. Each commit carries a trailer block:

```
<subject line — imperative, scoped to this slice>

<optional body>

Slice-Id: <stable-id>
Depends-On: <slice-id>[, <slice-id>…] | none
```

- **`Slice-Id`** is minted **once**, at the slice's first creation, and **preserved
  across every replay of that slice**. The commit SHA churns on replay; the `Slice-Id`
  does not. This is the invariant the whole workflow rests on — review feedback and the
  replay-diff both key off `Slice-Id`, so a replayed slice that mints a fresh id looks
  like the old slice vanished and a stranger appeared. Use a short stable token, e.g.
  `s01`, `s02` … assigned in creation order and never renumbered.
- **`Depends-On`** — **every** `Slice-Id` this slice builds on, comma-separated, or
  `none` (never absent; see the violation table). A slice that consumes two foundations
  names both. This field is the only record of the dependency graph: it drives review
  scope, the depth grouping, and the foundation/leaf derivation. An unrecorded edge is
  invisible to all three, so under-reporting here silently narrows every downstream
  decision.

### Committing the trailer

The two trailer lines must land in the **same trailing paragraph**. Git parses only the
last paragraph of a commit message as the trailer block, and each `-m` is joined to the
previous with a **blank line** — so the intuitive form is silently wrong:

```bash
# WRONG — three paragraphs. Git reads only "Depends-On" as a trailer;
# `Slice-Id` parses as EMPTY and the ledger is unreadable.
git commit -m "<subject>" -m "Slice-Id: s02" -m "Depends-On: s01"
```

Pass both trailers in a single `-m`, newline-separated:

```bash
git commit -m "<subject>" -m "Slice-Id: <id>
Depends-On: <dep>[, <dep>…]|none"
```

This failure is silent in `git log` — the commit succeeds and looks right. `read-ledger`
catches it, and it reports `empty-slice-id` rather than `missing-slice-id` precisely
because the mis-commit has a fingerprint: `Depends-On` parses while `Slice-Id` does not.
Verify after committing that the trailer round-trips.

### Reading the ledger

```bash
read-ledger --base <BASE> [--head <BRANCH>] [--drift]
```

Emits one record per slice in **commit order**, each with `id`, `sha`, `index`, `subject`,
`dependsOn[]`, derived `kind` and `depth`, `patchId`, and `touched[]`. Exit 2 means the
ledger is unreadable — stop and report, never derive anyway.

Two things it does that are easy to get wrong by hand, and are the reason not to:
`separator=` on `%(trailers:…,valueonly)` (without it git newline-terminates each value and
every record straddles three lines), and `--no-commit-id` before `git patch-id` (without it
the second output field is the commit id instead of zeroes, so a caller taking the wrong
field gets a fingerprint that churns on every replay).

### Violations — the ledger is unreadable

Each of these makes every downstream decision plausible-looking and wrong rather than
failing, so `read-ledger` exits 2 and both commands stop:

| code | what it means |
|---|---|
| `merge-commit` | caught by parent count, not by a missing trailer. A merge owns lines no finding can be routed to. Rebase onto the moved base; never merge it in. |
| `empty-slice-id` | the trailers were split across separate `-m` flags. |
| `missing-slice-id` | a commit with no trailer at all — hand-written, or from another workflow. |
| `duplicate-slice-id` | a slice is exactly one commit. |
| `missing-depends-on` | a root slice must say `Depends-On: none` explicitly. An absent field is indistinguishable from a mis-committed block. |
| `self-edge` | a slice listing itself. |
| `dangling-edge` | a `Depends-On` naming no slice in range — a typo, or a dependency below `BASE`. |
| `forward-edge` | a `Depends-On` naming a **later** commit. |
| `cycle` | depth has no base case on a cycle. A derivation that cannot terminate is not a warning. |

`forward-edge` is the one that acyclicity alone does not catch, and it matters because
replay is positional: the rewind re-applies in commit order, so a slice whose dependency
is committed *after* it was never actually built against that dependency. The closure and
the replay would disagree, silently. A slice appended at the tip that a *earlier* slice
should depend on is the realistic way to produce one — the fix is to reorder the slices, not
to edit the edge.

`unfingerprintable-slice` is a **warning**, not an error: a slice whose diff yields no
patch-id (empty, or metadata-only) stays in the ledger but can never be proven unchanged, so
it is always treated as changed and always runs its bar.

## 1a. Kind and depth — derived, never declared

Both come from `read-ledger`. They are **different axes**; do not use one where the other
is meant.

- **Kind** is binary: `leaf` iff no other slice names it in `Depends-On`, `foundation`
  otherwise.
- **Depth** is the slice's level in the graph, and is what the review file groups by.

Kind collapses a multi-level stack: in `s01 ← s02 ← s03`, both `s01` and `s02` are
`foundation`, but their depths are 0 and 1. **Report counts with kind; order findings with
depth.**

A trailer cannot carry either. It would have to be set when the slice is committed, on a
claim about slices that do not exist yet ("is anything going to build on me?"), which the
builder cannot know and nothing reconciles afterward — a slice committed as a leaf that
later acquires a dependent would stay mislabeled forever. The derivation is exact and
self-corrects as the graph grows. That is why `Depends-On` must name *all* dependencies.

**Neither one orders a replay.** Replay rewinds by `git reset --hard`, which is
*positional* — it can only start at a commit and take everything after it. Depth does not
track position (a depth-0 slice can be committed after a depth-1 slice), so a replay
started at the shallowest slice with a finding can leave an earlier commit untouched and
its finding permanently unaddressed. `slice-replay plan` picks the earliest slice in
**commit order**; that choice is not the caller's to make.

**Timing.** Both derivations are only meaningful against a **complete** slice set.
Mid-build every slice not yet depended upon looks like a leaf, so any decision keyed on
kind or depth belongs after the last slice is committed, not at commit time.

## 1b. Content identity across replays

A replay rewinds and re-commits, so **every replayed slice gets a fresh SHA** even when
its content is untouched: the parent moved, and the committer timestamp advanced. SHA
therefore cannot answer the question both commands need to ask — *did this slice's content
actually change?*

The fingerprint is the slice's **patch-id**, which hashes the change itself and is
independent of parent and timestamp. A slice whose content is regenerated identically keeps
its patch-id across a replay; a slice whose content changed, or whose diff context shifted
because an upstream slice moved, gets a new one. That second case is a genuine
`shape-changed` — the slice's diff really does read differently now — so the sensitivity is
wanted, not a false positive.

### The closure — why patch-id alone is not enough

Patch-id answers *did this slice's patch change?*, which is not the question either command
finally needs. A verdict ("this slice was green") is a property of the **tree** the slice was
committed against, not of its patch. An upstream slice that changes a *different file* leaves
a downstream patch-id byte-identical and the downstream code broken:

```
s01: a.ts   export type T = { a: string }
s02: b.ts   const x: T = { a: "1" }            Depends-On: s01

replay s01 → { a: number }, re-commit s02 unchanged
s02 patch-id: identical before and after. s02 no longer compiles.
```

So content identity is defined over the slice **and everything beneath it** — the transitive
`Depends-On` closure.

### The influence set — why the closure alone is not enough either

The closure is the set a slice **builds on**. It is not the set that can **break** it, and
replay makes the gap concrete: rewind is *positional* (`git reset --hard parent(START)`, then
re-apply in commit order), so the tree slice `s` is rebuilt against is `BASE` plus **every
slice committed before it** — of which `closure(s)` is a subset, usually a proper one.

So an earlier slice that `s` declares no edge to can break it anyway: two leaves writing the
same barrel file or DI registration, a shared test fixture, migration ordering. No amount of
`Depends-On` discipline closes this, because the field records a *dependency*, and the
builder writing `Depends-On` is answering "what do I import?" — not "who could invalidate my
tests?" Those are different questions and only the first has a natural answer at commit time.

`slice-scope` widens the predicate by the one such coupling git can see — a shared file:

```
influences(s) = closure(s) ∪ { earlier t : files(t) ∩ files(s) ≠ ∅ }
stable(s)     = patchid(s) unchanged  ∧  ∀ d ∈ influences(s): patchid(d) unchanged
```

`files(s)` is the **union of the slice's before and after file lists**, not just its current
one. A slice that *stops* touching a file is exactly as dangerous as one that starts: if a
replay moves `s01`'s content out of `a.ts` and `s02` reads `a.ts`, then measured against
current lists alone there is no overlap, and `s02` reads stable while the file it depends on
lost its content. This is why the review file records touched-file lists, not just patch-ids.

`influences` is computed entirely from git — `Depends-On` edges, patch-ids, and
`--name-only` file lists — which is why there is no verdict-cache file. `Depends-On` remains
the primary term and must still name **every** dependency: an unrecorded edge drops a slice
out of the closure, and the file-overlap term is a backstop for couplings that were never
declarable, not a substitute for edges the builder simply failed to write down.

**What stays uncovered, stated plainly:** an earlier slice that changes behaviour `s` depends
on through a third file, with no declared edge and no shared path, is invisible to
`influences`. So `regenerated-identical` is the **best skip git can justify**, not a proof of
greenness. It asserts that nothing git can see has moved beneath the slice. Treat the residual
as the price of skipping the bar at all, and when in doubt widen `Depends-On` rather than
leaning on the overlap term.

### The four replay classes

`slice-replay classify` assigns these from `stable(s)` plus the slice's own patch-id. The
distinction between the last two rows is the entire reason the influence set exists:

| class | own patch-id | influence set | the bar | prior review comments |
|---|---|---|---|---|
| `changed` | moved | any | runs | superseded — a finding was addressed here |
| `shape-changed` | moved | any | runs | may be **stale** — no finding targeted this slice |
| `context-changed` | unchanged | moved | **runs** | still describe the text; the verdict was never re-earned |
| `regenerated-identical` | unchanged | unchanged | **skipped** | still apply verbatim |

`regenerated-identical` is the only defensible skip: identical content, and nothing git can see
beneath it has moved since it was green. `context-changed` is the case a patch-id-only
comparison silently files as `regenerated-identical` — the slice reads the same and behaves
differently.

The two commands measure over different ranges, and both are correct. `slice-scope` compares
every slice in the ledger against the prior review's record, because any of them may have
moved since the last review. `slice-replay` measures only slices at or after the replay
start: the rewind does not reach anything earlier, so an `influences(s)` term naming an
earlier slice contributes "unchanged" without needing to be measured.

## 1c. The bar

"The bar" is one fixed thing, and every reference to it in `/build-sliced` means exactly
this:

> **The slice compiles and its own tests pass, run against the tree at that slice's commit.**

Not the full suite, and not a smoke check. Two consequences follow from the "at that
slice's commit" half, and they are the reason the classes above exist at all:

- A slice is read by a reviewer as a standalone commit, so it has to stand up as one.
- The bar is a claim about a **tree**, not about a patch. That is why a clean cherry-pick
  does not inherit yesterday's green bar, and why only `regenerated-identical` may skip it.

Determine the project's test command from the repo — `package.json` scripts, a `Makefile`
target, `pyproject.toml`, the CI config. If you cannot determine it, **ask**; do not guess,
and do not substitute a weaker check. If the runner is not in `/build-sliced`'s
`allowed-tools`, say so and stop rather than falling back to something you can run.

## 2. Replay cursor — crash-safety

The cursor is the only durable state outside git. `slice-replay` owns it: `plan` writes it,
`classify` reads it, `recover` reports it, `clear` deletes it.

`SLUG` is `<BRANCH>` with `/` and `_` collapsed to `-`, the same convention as
`pr-review-<branch>.md` — a branch called `feature/foo` would otherwise name a file inside a
`.plans/replay-feature/` directory that nothing creates. The cursor lives at
`{PLANS_DIR}/replay-<SLUG>` and the review file at `{PLANS_DIR}/review-<SLUG>.md`.

It carries `replayFrom`, `startIndex`, `parentSha`, `headBefore`, `started`, the ids that had
findings, and — the part that cannot be reconstructed — the **pre-rewind fingerprints** for
every slice from the start to the tip: each one's SHA, patch-id, and touched-file list.

- Written by `slice-replay plan`, **before** the first commit of a replay is rewritten.
- Deleted by `slice-replay clear`, **after** the replay completes and the branch is
  force-pushed.
- On resume, if the file **exists**, the previous replay died mid-flight. `slice-replay
  recover` reports it together with the worktree state the guard needs. Recover by
  hard-resetting to `headBefore`, then re-running the replay from `replayFrom`. The branch
  is a rebuildable cache; the cursor plus the ledger are the source of truth.

`headBefore` is also the baseline for the whole replay: the pre-replay ledger it names is
where the original per-slice SHAs are re-read from if the snapshot has to be rebuilt.

## 3. Review file — feedback the loop consumes

Written by `slice-review` at `{PLANS_DIR}/review-<SLUG>.md`. `slice-replay plan` parses it
to decide the replay start. Every actionable item is a checkbox keyed to a `Slice-Id`.

```markdown
# Sliced Review: <BRANCH>

- **Base**: <BASE>
- **Reviewed slices**: <s03, s04, s07 — prose, for humans, never parsed>
- **Generated**: <YYYY-MM-DD>

<!-- sliced-state: {"version":1,"base":"main","generated":"…","slicemap":{…},"changed":[…],"agentsRun":[…]} -->
```

One versioned machine-state blob, owned end to end by `slice-review`. It carries three
things and all three are read back:

- **`slicemap`** — every slice's `patchId` **and** `touched` list at the moment this file was
  written. Input to the *next* review's comparison. The file lists are load-bearing, not
  incidental: without them the overlap term cannot see a file a slice stopped touching (§1b).
- **`changed`** — the ids for which `stable(s)` was false, **in commit order**. It cannot be
  recomputed later — by replay time no patch-id has moved since this file was written, so the
  predicate would return the empty set — and the order is part of the contract, because
  `slice-replay` needs its *first* element to anchor `Unassigned` findings. Never parse the
  prose **Reviewed slices** header.
- **`agentsRun`** — which reviewers this pass actually ran, which is what makes the per-agent
  merge rule decidable.

The body sections:

```markdown
## Findings
Grouped by the **depth** of the slice they land in (§1a), shallowest first — that is the
order the build loop re-derives in once it has rewound. Within a depth, `Critical` first.
Placement is re-derived from the ledger on every write, so a stale grouping never outlives
the graph that produced it.

### Depth 0
- [ ] `s03` `file.ts:42` — <summary>. Fix: <recommendation>. (severity: high, source: diff-critic)

### Depth 1
- [ ] `s07` `file.ts:88` — <summary>. Fix: <recommendation>. (severity: medium, source: diff-security)

## Out of scope
Findings that resolved to a real `Slice-Id` outside the reviewed scope. They keep their
id — the build loop widens its replay start to include them rather than guessing.

- [ ] `s02` `file.ts:5` — <summary>. (severity: medium, source: diff-critic)

## Unassigned
Findings whose `file:line` resolved to **no** slice in range: a seam no single commit owns,
or a path absent from `HEAD`. The build loop anchors these to the earliest id in `changed`.

- [ ] `file.ts:12` — <summary>. (severity: high, source: diff-critic)

## Notes
Agents skipped by a gate (with reason), findings dropped as pre-`BASE`, retractions, seam
concerns, open questions.
```

The trailing parenthetical is metadata, not decoration. `source` is what makes the per-agent
merge rule possible: without it a finding cannot be matched to the agent whose coverage this
pass either had or lacked. Flags with no `key:` — `unverified`, `not re-reported` — carry the
merge outcome.

A line whose last change **predates `BASE`** resolves to no slice and does **not** belong in
Unassigned: that finding is about code this branch never touched. `slice-review` drops it and
notes the drop. Replaying from the earliest changed slice cannot fix code no slice in range
wrote.

### Finding states

The checkbox is a three-state field, and `slice-replay plan` keys its decision on it:

- `- [ ]` **open** — not yet addressed. Any open finding triggers a replay.
- `- [x]` **addressed** — the build loop re-derived the slice to fix it, or the finding was
  retracted (see below). Terminal.
- `- [~]` **declined** — judged not worth acting on. Terminal, and **not** a replay
  trigger.

Without the declined state a finding the user rejects stays `- [ ]` forever and pins
`/build-sliced` in a permanent replay loop, re-deriving slices to fix something nobody
intends to fix. **Only a human marks a finding declined**; the build loop never demotes an
open finding to skip work.

### Regenerating the file is a merge

`slice-review` rewrites this file on every run, and the agents that produce findings are
not deterministic. So the rewrite is a **merge against the prior file**, governed by one
rule: *a finding may only be removed by a pass that actually looked at the slice it names,
with the agent that produced it.*

| prior entry | this pass | result |
|---|---|---|
| `- [~]` declined | anything | carried forward verbatim |
| `- [x]` addressed | anything | dropped |
| `- [ ]` re-reported | — | stays open, text refreshed |
| `- [ ]` on a `stable` slice (§1b) | did not look | carried forward verbatim |
| `- [ ]` from an agent this pass **skipped** | did not look | carried forward, flagged `unverified` |
| `- [ ]` Unassigned, or a line the parser could not read | cannot tell | carried forward verbatim |
| `- [ ]` on a slice this pass reviewed, from an agent this pass ran | not re-reported | **retracted** to `- [x] (not re-reported)`, and noted |

Two rows deserve the emphasis.

**`unverified` tracks agent coverage, not slice coverage.** Every moved slice is in scope by
construction — scope *is* the not-`stable` set — so a moved slice is never skipped for being
out of scope. The only way a moved slice goes unexamined is the **per-agent gate**:
`/review-slices` runs `diff-critic` always but skips `diff-security` on a security-inert
diff. So the flag applies per finding according to which agent produced it, and a
`diff-security` finding on a slice this pass reviewed with `diff-critic` alone must not be
dropped.

**Retraction is recorded, never silent.** The stated reason to merge at all is that the
agents are non-deterministic — and a rule that lets one non-deterministic pass *delete* a
real finding contradicts its own premise. A retracted finding becomes `- [x]` with a
`not re-reported` flag and a line in Notes: it stops triggering a replay, and it stays
auditable. A `stable` slice cannot have been fixed, because nothing beneath it moved, so an
open finding on one is never retracted no matter what this pass reviewed.

Regenerating purely from what the current pass found loses every open finding the moment a
pass has nothing to look at, which is exactly what a second consecutive review is.

### What a finding cannot express

Findings are **within-slice** corrections: the loop can re-derive a slice's content, but not
change the slice set. There is no way to split a slice, merge two, delete one, or renumber
ids — `Slice-Id` is immutable and one commit per slice is an invariant. So a finding of the
form "these two slices are the wrong cut" has no representation, and the correct response is
`/build-sliced`'s plan-defect halt, not a replay. Say so plainly rather than approximating
the fix inside the existing cut.

`Unassigned` findings are the one category that cannot converge on their own. They are
anchored to the earliest changed slice because that is the best available guess, but
re-deriving that slice is not guaranteed to fix a seam no commit owns. If one survives a
replay, `/build-sliced` halts it as a plan defect — which is the right failure, but it means
an Unassigned finding is a human decision, not a loop the machine closes.
