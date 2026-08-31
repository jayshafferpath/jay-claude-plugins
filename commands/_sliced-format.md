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
  of the dependency graph: it drives review scope ("changed slices + their dependents"),
  the depth grouping, and the foundation/leaf derivation below. An unrecorded edge is
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

Kind collapses a multi-level stack: in `s01 ← s02 ← s03`, both `s01` and `s02` are
`foundation`, but their depths are 0 and 1. Report counts with kind; order findings with
depth.

**Neither one orders a replay.** Replay rewinds by `git reset --hard`, which is
*positional* — it can only start at a commit and take everything after it. Depth does not
track position (a depth-0 slice can be committed after a depth-1 slice), so a replay
started at the shallowest slice with a finding can leave an earlier commit untouched and
its finding permanently unaddressed. The replay start is always the earliest slice in
**commit order**; see `/build-sliced` Step 4.

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

Two consumers depend on this:

- `/review-slices` records `Slice-Id → patch-id` in the review file's slicemap and treats
  a moved patch-id as "changed". Keying on SHA instead would mark every slice downstream
  of a replay as changed and re-review the whole tail.
- `/build-sliced` classifies each replayed slice from it, and skips re-running the test
  bar for any slice whose patch-id is unchanged. Unchanged content was green when it was
  committed, so re-running the bar cannot produce a different verdict. This is why there
  is no verdict-cache file: the fingerprint is derivable from git, so git stays the ledger.

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

`head_before` is also the baseline for the replay-diff: the pre-replay ledger it names is
where the "before" patch-ids (§1b) are read from.

Branch name with `/` and `_` collapsed to `-`, same convention as
`pr-review-<branch>.md`.

## 3. Review file — feedback the loop consumes

Written by `/review-slices` at `{PLANS_DIR}/review-<BRANCH>.md`. `/build-sliced` parses
it to decide the replay start point. Every actionable item is a checkbox keyed to a
`Slice-Id`.

```markdown
# Sliced Review: <BRANCH>

- **Base**: <BASE>
- **Reviewed slices**: <s03, s04, s07 — changed + dependents>
- **Generated**: <YYYY-MM-DD>

<!-- slicemap: s01=<patch-id> s02=<patch-id> ... -->

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
Findings whose `file:line` resolved to **no** slice in range (e.g. a seam that no single
commit owns, or a path absent from `HEAD`). The build loop treats these as touching the
earliest changed slice.

- [ ] `file.ts:12` — <summary>. (severity: high, source: diff-critic)

## Notes
Agents skipped by a gate (with reason), seam concerns, open questions.
```

### Finding states

The checkbox is a three-state field, and `/build-sliced` Step 2 keys its replay decision
on it:

- `- [ ]` **open** — not yet addressed. Any open finding triggers a replay.
- `- [x]` **addressed** — the build loop re-derived the slice to fix it.
- `- [~]` **declined** — judged not worth acting on. Terminal, and **not** a replay
  trigger.

Without the declined state a finding the user rejects stays `- [ ]` forever and pins
`/build-sliced` in a permanent replay loop, re-deriving slices to fix something nobody
intends to fix. Only a human marks a finding declined; the build loop never demotes an
open finding to skip work.

`/review-slices` overwrites this file on every run but **carries forward every `- [~]`
entry**, so a declined finding does not resurrect as open on the next pass.

### Resolving a finding's `Slice-Id`

A finding's `file:line` belongs to the slice whose commit last touched that line:

```bash
git log <BASE>..HEAD -1 -s \
  --format='%(trailers:key=Slice-Id,valueonly,separator=%x2C)' \
  -L<line>,<line>:<file>
```

- `-s` is **required**. `-L` implies `-p`, so without it the id arrives with a full diff
  hunk stapled to it and the value can't be used as-is.
- Empty output → no commit in range touched that line → **Unassigned**.
- A path that does not exist at `HEAD` (deleted file, or a bad path from an agent) makes
  this command **fail** with `fatal: There is no path …`, exit 128. That is not an empty
  result — tolerate the failure and record the finding as **Unassigned**.
