# Sliced-build formats

Reference fragment, not a slash command. `install.sh` skips `_`-prefixed files so this
is never symlinked into `~/.claude/commands/`.

Cited by `/build-sliced` and `/review-slices`. Defines the four load-bearing artifacts:
the **commit trailer** (the ledger), the **slice fingerprint** (content identity across
replays), the **replay cursor** (crash-safety), and the **review file** (feedback the
build loop consumes). All four are parsed by tooling and by the commands themselves —
keep the shapes exact, and use the exact command forms given here. Each one below has a
failure mode that returns plausible-looking wrong output rather than an error.

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
  `none`. A slice that consumes two foundations names both. This field is the only record
  of the dependency graph: it drives review scope (every slice whose content *or dependency
  closure* moved — §1b), the depth grouping, and the foundation/leaf derivation below. An
  unrecorded edge is invisible to all three, so under-reporting here silently narrows every
  downstream decision.

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

This failure is silent — the commit succeeds and looks right in `git log`. Only a
trailer-aware read reveals the empty field.

### Reading the ledger

```bash
git log <BASE>..HEAD \
  --format='%H%x00%(trailers:key=Slice-Id,valueonly,separator=%x2C)%x00%(trailers:key=Depends-On,valueonly,separator=%x2C)%x00%s'
```

NUL-delimited fields, one commit per line, newest first. Reverse for build order.

`separator=` is **required**, not cosmetic. Without it `valueonly` terminates each value
with a newline, so every record straddles three lines and any line-oriented parse
mis-splits it. `%x2C` (a comma) is the separator for the rare commit carrying a repeated
trailer key; a well-formed slice has one of each.

## 1a. Deriving kind and depth

Neither kind nor depth is declared in a trailer. Both are derived from the recorded
edges, and they are **different axes** — do not use one where the other is meant.

**Kind** is binary, and answers "does anything build on this?":

```
kind(s) = leaf         if no t in SLICES names s.id in t.dependsOn
          foundation   otherwise
```

**Depth** is the slice's level in the graph, and is what the review file groups by:

```
depth(s) = 0                                      if s.dependsOn == none
           1 + max(depth(d) for d in s.dependsOn) otherwise
```

Both derivations assume every recorded edge resolves and the graph is acyclic. Git checks
neither, and `depth` has no base case when either fails, so both ledger readers **stop and
report** rather than derive:

- A `Depends-On` id that names no slice in range — a typo, or a dependency below `BASE`.
- A cycle. A derivation that cannot terminate is not a warning.

Same class as an empty `Slice-Id` (§1): the ledger is unreadable, and every decision keyed
on it would be plausible-looking and wrong.

Kind collapses a multi-level stack: in `s01 ← s02 ← s03`, both `s01` and `s02` are
`foundation`, but their depths are 0 and 1. Report counts with kind; order findings with
depth.

**Neither one orders a replay.** Replay rewinds by `git reset --hard`, which is
*positional* — it can only start at a commit and take everything after it. Depth does not
track position (a depth-0 slice can be committed after a depth-1 slice), so a replay
started at the shallowest slice with a finding can leave an earlier commit untouched and
its finding permanently unaddressed. The replay start is always the earliest slice in
**commit order**; see `/build-sliced` Step 5.

A trailer cannot carry kind. It would have to be set when the slice is committed, on a
claim about slices that do not exist yet ("is anything going to build on me?"), which the
builder cannot know and nothing reconciles afterward — a slice committed as a leaf that
later acquires a dependent would stay mislabeled forever. The derivation is exact, is
computed from recorded edges, and self-corrects as the graph grows. That is why
`Depends-On` must name *all* dependencies.

**Timing.** Both derivations are only meaningful against a **complete** slice set.
Mid-build every slice not yet depended upon looks like a leaf, so any decision keyed on
kind or depth belongs after the last slice is committed, not at commit time.

## 1b. Slice fingerprint — content identity across replays

A replay rewinds and re-commits, so **every replayed slice gets a fresh SHA** even when
its content is untouched: the parent moved, and the committer timestamp advanced. SHA
therefore cannot answer the question both commands need to ask — *did this slice's content
actually change?*

The fingerprint is the slice's **patch-id**, which hashes the change itself and is
independent of parent and timestamp:

```bash
git diff-tree -p --no-commit-id <sha> | git patch-id --stable
```

Take the first field of the output (the second is the commit id and is `000…` here).

A slice whose content is regenerated identically keeps its patch-id across a replay; a
slice whose content changed, or whose diff context shifted because an upstream slice
moved, gets a new one. That second case is a genuine `shape-changed` — the slice's diff
really does read differently now — so the sensitivity is wanted, not a false positive.

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

So content identity is defined over the slice **and everything beneath it**:

```
closure(s) = s.dependsOn ∪ ⋃ closure(d) for d in s.dependsOn
stable(s)  = patchid(s) unchanged  ∧  ∀ d ∈ closure(s): patchid(d) unchanged
```

`stable` is computed entirely from `Depends-On` edges and patch-ids, both already in git —
which is why there is no verdict-cache file. It is also why `Depends-On` must name **every**
dependency: an unrecorded edge drops a slice out of the closure, and the predicate then
answers confidently about a tree it never looked at.

### The four replay classes

Both commands classify a replayed slice from `stable(s)` plus the slice's own patch-id. The
distinction between the last two rows is the entire reason the closure exists:

| class | own patch-id | closure | test bar | prior review comments |
|---|---|---|---|---|
| `changed` | moved | any | runs | superseded — a finding was addressed here |
| `shape-changed` | moved | any | runs | may be **stale** — no finding targeted this slice |
| `context-changed` | unchanged | moved | **runs** | still describe the text; the verdict was never re-earned |
| `regenerated-identical` | unchanged | unchanged | **skipped** | still apply verbatim |

`regenerated-identical` is the only sound skip: identical content on an identical foundation
was green when it was committed, and nothing it can see has moved. `context-changed` is the
case a patch-id-only comparison silently files as `regenerated-identical` — the slice reads
the same and behaves differently.

Two consumers depend on this:

- `/review-slices` records `Slice-Id → patch-id` in the review file's slicemap and treats
  any slice that is not `stable` as changed. Keying on SHA instead would mark every slice
  downstream of a replay as changed and re-review the whole tail; keying on patch-id alone
  would miss every `context-changed` slice.
- `/build-sliced` classifies each replayed slice and skips the test bar for
  `regenerated-identical` only.

## 2. Replay cursor — crash-safety

The only durable state outside git. One line at `{PLANS_DIR}/replay-<BRANCH>`:

```
replay_from=<slice-id> started=<YYYY-MM-DDTHH:MM:SSZ> head_before=<sha>
```

- Written **before** the first commit of a replay is rewritten.
- Cleared (file deleted) **after** the replay completes and the branch is force-pushed.
- On resume, if the file **exists**, the previous replay died mid-flight. Recover by
  hard-resetting to `head_before`, then re-running the replay from `replay_from`. The
  branch is a rebuildable cache; `head_before` + the ledger are the source of truth.

`head_before` is also the baseline for the whole replay: the pre-replay ledger it names is
where the "before" patch-ids (§1b) and the original per-slice SHAs are read from — the
patch-ids to classify against, the SHAs to cherry-pick from.

Branch name with `/` and `_` collapsed to `-`, same convention as
`pr-review-<branch>.md`.

## 3. Review file — feedback the loop consumes

Written by `/review-slices` at `{PLANS_DIR}/review-<BRANCH>.md`. `/build-sliced` parses
it to decide the replay start point. Every actionable item is a checkbox keyed to a
`Slice-Id`.

```markdown
# Sliced Review: <BRANCH>

- **Base**: <BASE>
- **Reviewed slices**: <s03, s04, s07 — prose, for humans, never parsed>
- **Generated**: <YYYY-MM-DD>

<!-- slicemap: s01=<patch-id> s02=<patch-id> ... -->
<!-- changed: s03,s04 -->
```

Two comments, one job each, and both are parsed:

- **`slicemap`** is the input to the *next* review's comparison — every slice's patch-id at
  the moment this file was written.
- **`changed`** is the output of *this* review: the ids for which `stable(s)` was false
  (§1b). `/build-sliced` reads it to place `Unassigned` findings. It cannot be recomputed
  later — by replay time no patch-id has moved since this file was written, so the predicate
  would return the empty set — and the prose header above is written for humans, not parsing.
  Record it explicitly and never parse the prose.

The body sections:

```markdown
## Findings
Grouped by the **depth** of the slice they land in (§1a), shallowest first — that is the
order the build loop re-derives in once it has rewound. Within a depth, `Critical` first.
Depth is derived, never read from a trailer.

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
or a path absent from `HEAD`. The build loop treats these as touching the earliest id in the
`changed:` comment.

- [ ] `file.ts:12` — <summary>. (severity: high, source: diff-critic)

## Notes
Agents skipped by a gate (with reason), findings dropped as pre-`BASE`, seam concerns, open
questions.
```

A line whose last change **predates `BASE`** also resolves to no slice, and does **not**
belong in Unassigned: that finding is about code this branch never touched. Drop it and note
the drop. Replaying from the earliest changed slice cannot fix code no slice in range wrote.

### Finding states

The checkbox is a three-state field, and `/build-sliced` Step 3 keys its replay decision
on it:

- `- [ ]` **open** — not yet addressed. Any open finding triggers a replay.
- `- [x]` **addressed** — the build loop re-derived the slice to fix it.
- `- [~]` **declined** — judged not worth acting on. Terminal, and **not** a replay
  trigger.

Without the declined state a finding the user rejects stays `- [ ]` forever and pins
`/build-sliced` in a permanent replay loop, re-deriving slices to fix something nobody
intends to fix. Only a human marks a finding declined; the build loop never demotes an
open finding to skip work.

### Regenerating the file is a merge

`/review-slices` rewrites this file on every run, and the agents that produce findings are
not deterministic. So the rewrite is a **merge against the prior file**, governed by one
rule: *a finding may only be removed by a pass that actually looked at the slice it names.*

| prior entry | this pass | result |
|---|---|---|
| `- [~]` declined | anything | carried forward verbatim |
| `- [x]` addressed | anything | dropped |
| `- [ ]` on a `stable` slice (§1b) | did not look | carried forward verbatim |
| `- [ ]` on a slice this pass reviewed | not re-reported | dropped — the pass is authoritative |
| `- [ ]` on a slice that moved, outside this pass's scope | did not look | carried forward, marked `unverified` |

A `stable` slice cannot have been fixed, because nothing beneath it moved — so an open
finding on one survives untouched no matter what this pass reviewed. Regenerating purely
from what the current pass found loses every open finding the moment a pass has nothing to
look at, which is exactly what a second consecutive review is.

### Resolving a finding's `Slice-Id`

A finding's `file:line` belongs to the slice whose commit last touched that line:

```bash
git log <BASE>..HEAD -1 -s \
  --format='%(trailers:key=Slice-Id,valueonly,separator=%x2C)' \
  -L<line>,<line>:<file>
```

- `-s` is **required**. `-L` implies `-p`, so without it the id arrives with a full diff
  hunk stapled to it and the value can't be used as-is.
- Empty output → no commit **in range** touched that line. Two causes, and they are not the
  same finding: a seam no single commit owns → **Unassigned**; a line whose last change
  predates `BASE` → pre-existing code, **dropped** with a note. Separate them by asking for
  the owning commit over full history instead of the trailer over the range:

  ```bash
  git log -1 -s --format='%H' -L<line>,<line>:<file>          # no range
  git merge-base --is-ancestor <that sha> <BASE>              # exit 0 → pre-BASE, drop it
  ```

  Ask for `%H`, not the trailer — a pre-`BASE` commit carries no `Slice-Id`, so the trailer
  format comes back empty in both cases and distinguishes nothing.
- A path that does not exist at `HEAD` (deleted file, or a bad path from an agent) makes
  this command **fail** with `fatal: There is no path …`, exit 128. That is not an empty
  result — tolerate the failure and record the finding as **Unassigned**.
