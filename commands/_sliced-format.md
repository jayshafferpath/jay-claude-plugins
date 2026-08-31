# Sliced-build formats

Reference fragment, not a slash command. `install.sh` skips `_`-prefixed files so this
is never symlinked into `~/.claude/commands/`.

Cited by `/build-sliced` and `/review-slices`. Defines the three load-bearing
artifacts: the **commit trailer** (the ledger), the **replay cursor** (crash-safety),
and the **review file** (feedback the build loop consumes). All three are parsed by
tooling and by the commands themselves — keep the shapes exact.

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
  the replay start point, and the foundation/leaf derivation below. An unrecorded edge is
  invisible to all three, so under-reporting here silently narrows every downstream
  decision.

Read the ledger with:

```bash
git log <BASE>..HEAD --format='%H%x00%(trailers:key=Slice-Id,valueonly)%x00%(trailers:key=Depends-On,valueonly)%x00%s'
```

NUL-delimited fields, one commit per line, newest first. Reverse for build order.

## 1a. Deriving kind — foundation vs leaf

Kind is **derived from the graph, never declared in a trailer**:

```
kind(s) = leaf         if no t in SLICES names s.id in t.dependsOn
          foundation   otherwise
```

Foundation slices are built first because nothing blocks them; leaves last. Depth for the
review file's grouping is read from this derivation.

A trailer cannot carry this. Kind would have to be set when the slice is committed, on a
claim about slices that do not exist yet ("is anything going to build on me?"), which the
builder cannot know and nothing reconciles afterward — a slice committed as a leaf that
later acquires a dependent would stay mislabeled forever. The derivation is exact, is
computed from recorded edges, and self-corrects as the graph grows. That is why
`Depends-On` must name *all* dependencies.

**Timing.** Kind is only meaningful against a **complete** slice set. Mid-build every slice
not yet depended upon looks like a leaf, so any decision keyed on kind belongs after the
last slice is committed, not at commit time.

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

Branch name with `/` and `_` collapsed to `-`, same convention as
`pr-review-<branch>.md`.

## 3. Review file — feedback the loop consumes

Written by `/review-slices` at `{PLANS_DIR}/review-<BRANCH>.md`. `/build-sliced` parses
it to decide the replay start point. Every actionable item is a `- [ ]` checkbox keyed
to a `Slice-Id`.

```markdown
# Sliced Review: <BRANCH>

- **Base**: <BASE>
- **Reviewed slices**: <s03, s04, s07 — changed + dependents>
- **Generated**: <YYYY-MM-DD>

## Findings
Grouped by the depth of the slice they land in — **foundation first**, because the
build loop replays from the earliest-depth touched slice and everything downstream is
regenerated. Depth is the derived kind (§1a), not a trailer. Within a depth, `Critical`
first.

### Foundation
- [ ] `s03` `file.ts:42` — <summary>. Fix: <recommendation>. (severity: high, source: diff-critic)

### Leaf
- [ ] `s07` `file.ts:88` — <summary>. Fix: <recommendation>. (severity: medium, source: diff-security)

## Unassigned
Findings whose `file:line` could not be resolved to a slice (e.g. a seam that no single
commit owns). The build loop treats these as touching the **earliest** changed slice.

- [ ] `file.ts:12` — <summary>. (severity: high, source: diff-critic)

## Notes
Agents skipped by a gate (with reason), seam concerns, open questions.
```

**Resolving a finding's `Slice-Id`**: a finding's `file:line` belongs to the slice
whose commit last touched that line. Resolve with
`git log <BASE>..HEAD -1 --format='%(trailers:key=Slice-Id,valueonly)' -L<line>,<line>:<file>`
(or `git blame -L<line>,<line> <file>` then map the blamed SHA to its `Slice-Id`). A
line no commit in range touched → **Unassigned**.
