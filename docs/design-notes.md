# Design notes

Rationale behind the ticket lifecycle's non-obvious decisions. Extracted from
`commands/ticket-work.md` so the runtime instructions stay lean — the agent does
not need to re-read *why* on every invocation, but a human editing the flow does.

Each note records a decision that looks arbitrary until you know what it is
defending against. If you are about to "simplify" one of these, read its note
first.

---

## Why derivable state gets no label

A state earns a `Claude*` label only when another process — a peer agent, a JQL
query, a human handing work back — has no cheaper way to see it. Anything
derivable from git, the GitHub PR, or the checklist is read from that source
instead. Adding a label for derivable state means two sources of truth and a
sync bug waiting to happen.

- **"Out for review" is not a label.** An open PR is the signal; the Jira
  *status* is its JQL-queryable stand-in. `resolve-stack` surfaces
  `entry.inReview` / `entry.openPr` for readers, and `isReviewStatus(statusName)`
  is the Jira-only fallback. `transition-jira {KEY} --event review` is
  best-effort by design: a workflow with no matching transition leaves the status
  alone and still exits 0, because the PR remains ground truth either way.
- **"Drift checked" is not a label.** `drift-check` compares the research
  baseline SHA against the code at HEAD, so re-running it is idempotent and
  cheap. Running it on every resume is correct behavior — it re-fires precisely
  when upstream has moved.
- **"Phase-1 cleanup ran" is not a label.** The `merged/{KEY}` git tag created by
  `/cleanup` Step 2d is the durable record.
- **"Cancelled" is not a label.** `/prune` moves the Jira status instead.

## Why the cleanup gate is not inside `resolve-stack`

The **Ensure Cleanup Prerequisites** sub-procedure is opt-in per command: any
future command that consumes `STACK_ORDER` must wire it up explicitly. This is a
convention, not an enforced invariant.

The alternative — putting the gate inside `resolve-stack` so every consumer
inherits it — was considered and rejected. It would turn a read-only resolver
into something that mutates git state and pushes tags as a side effect of being
asked a question. A resolver that writes is a resolver you cannot call from a
dry-run, a status display, or the dashboard.

## Why `/orchestrate` does not call the cleanup gate

`/orchestrate` runs its own equivalent tag sweep at Step 3a
(`git ls-remote origin 'refs/tags/merged/*'` → `phaseOneDone`) and feeds that
into `classifyTicket`, which dispatches `cleanup-phase-1` / `cleanup-terminal`
as first-class actions.

That is a deliberate difference in kind, not duplication to be collapsed: the
orchestrator *surfaces and queues* cleanup as a visible action the user sees
before it runs, whereas the sub-procedure *silently backfills* to unblock a
single command. Converging them would mean either hiding cleanups from the
orchestrator's queue display or making the gate interactive.

If they do converge later, `cli/lib/classify-actions.js` is the place to share
the detection — not the prose.

## Why `--no-rebase` is load-bearing on the gate's inline `/cleanup`

The gate's backfill runs `/cleanup --yes --no-rebase --no-refresh-feature`.

`--no-rebase` is about re-entrancy, not just scope. `/cleanup` Step 7 shells out
to `cascade-rebase`, the same library `/stack-rebase` Step 4 uses. Since
`/stack-rebase` gates on this sub-procedure at its Step 1.5, dropping
`--no-rebase` would let cleanup's cascade re-enter the caller.

## Why the queue skips a blocked group but the single-ticket path stops

At Q4.5, a group whose `/cleanup` could not produce its tag is skipped and the
rest of the queue continues. At S1d, the same failure stops outright.

Deliberate asymmetry: one stack blocked on a human should not stall the other
stacks in a queue, but the single-ticket path has only one stack to work on, so
there is nothing to continue to.

## Why `resolve-stack --fetch` matters before the cleanup gate

The gate decides which predecessors need a tag from `mergedIntoFeature` /
`mergedIntoMain`, and those flags are computed against **local** origin refs.
Resolving without `--fetch` can report a predecessor as unmerged when its merge
already landed, silently skipping the backfill the gate exists to perform.

The gate's own tag probe uses `git ls-remote`, which reads the remote directly
and needs no fetch. It is the stack resolution — not the probe — that goes stale.

### Why `--fetch` prunes, and why it happens in the resolver

`stack[*].branch` goes stale the same way, and worse: staleness there is
**non-convergent** rather than merely wrong once.

`findBranch` checks local branches, then falls back to `git branch -r --list`.
That fallback reads remote-tracking refs, which are a *local cache*. GitHub
deletes the head branch on squash-merge and terminal cleanup deletes it
explicitly, but `origin/{KEY}` survives both until something prunes it — plain
`git fetch origin` does not. So `findBranch` keeps reporting a branch that exists
nowhere.

That phantom branch defeats `classify-actions` rule 0, which reads branch-absence
as "terminal cleanup already ran" (`cleaned`, not auto-safe). With a branch on
record rule 0 cannot fire, control falls to rule 1 (`mergedIntoMain` →
`cleanup-terminal`, auto-safe), and **nothing a cleanup run does clears the stale
ref** — so every subsequent `/orchestrate` re-queues the same finished cleanup.
Observed on NEV-1442/NEV-1616/NEV-1446: `git ls-remote --heads origin` returned
empty while `git branch -r --list` still listed them. The cost is not just wasted
round-trips; a genuinely actionable ticket gets buried in a queue of permanent
false positives. Same family as the NEV-863 note below, where a bad branch/tag
assumption silently starved a gate.

Two decisions follow:

- **`--fetch` runs `git fetch --prune origin`.** `--fetch` exists precisely to
  refresh remote state, and pruning is what "refresh" should have meant. The
  alternative — verifying each remote hit against `git ls-remote --heads` — adds a
  network call per ticket to fix a cache that one prune per repo fixes wholesale.
- **The prune lives in `resolveStack`, not `bin/resolve-stack.js`.** The repo root
  is resolved *inside* `resolveStack` from the ticket's labels plus the dev root.
  A CLI-level fetch could only run when the caller happened to pass
  `--repo-root`, so every label-resolving caller silently skipped the refresh and
  read stale refs anyway — the flag looked honored while doing nothing. Doing it
  in the resolver means one prune per resolve, against the same root the branch
  lookups below will use, and it fires before the first git read.

**A locked worktree is out of reach of this fix.** Its branch is a *local* ref, so
it takes the `git branch --list` path and no prune can clear it; it resolves only
once the worktree is released. NEV-1616 was exactly that case.

## Why Mode C and the multi-ticket runner live in their own file

Both were ~225 lines inside `commands/ticket-work.md`, loading into every single
invocation while being unreachable from the common path: Mode C fires only when a
container key carries `ClaudeStackComplete`, and the Q3–Q8 runner only from S6b when
one completed ticket unblocks two or more downstreams. Neither is dead code — both
are cited from `Mode A` and `S6b` respectively — but paying their token cost on every
routine single-ticket run bought nothing.

They now live in `commands/_container-flows.md`, read on demand when their entry
condition actually fires. The `_` prefix keeps `install.sh` from symlinking the file
as a slash command (`install.sh` skips `_*`), matching how
`_shared-stack-procedures.md` already works.

The earlier `.plans/ticket-work-diet.md` round declined to move Mode C on the grounds
of "no runtime gain." That reasoning measured branches taken rather than tokens
loaded; the gain is per-invocation context, not fewer steps executed.

## Why Mode C stores its checklist in a file, not Jira

The per-ticket flow's resume state lives in Jira (the checklist on the ticket
itself, via `sync-checklist`). Mode C's lives in a local file at
`{REPO_ROOT}/.claude/plans/ticket-work-{CONTAINER_KEY}-pr.md`.

The reason is that a container has no per-step checklist of its own — its
checklist is the *roll-up* of its members. The intent is for both flows to
converge on Jira-comment storage eventually; until then the shared PR Push &
Review sub-procedure treats `STORAGE` as a black box.

## Why step 7 is retired but its slot is retained

There is no PR-approval gate. `seed-checklist` pre-marks slot 7 done with a
` (skipped: retired)` suffix so the S4 loop never opens it.

The slot survives to keep step numbering stable for the S4.8–S4.10 names, the
S4.6b slot mapping, and historical Jira checklists that already have 10 items.
Renumbering would silently corrupt resume for every in-flight ticket.

Standalone tickets flow straight from S4.6a into S4.8 and open their draft PR
against `main` without waiting for a human label. **The draft state is the
checkpoint** — nothing merges until a human marks the PR ready and approves it
on GitHub.

## Why S4.5 was merged into S4.4, and why its slot is retained

The same diff used to be read three times: S4.4 launched the `refactor` agent over
the changed files, S4.5 ran `/jay-pr-review`, which fanned out `code-reviewer` and
`security-auditor` (plus `architect-review` / `test-automator` conditionally) over
that identical diff, and `/cop-fight` reviewed it a third time after the PR opened.
The agent sets overlapped heavily — a correctness bug found by `code-reviewer` and a
structural smell found by `refactor` are usually the same finding phrased twice —
and each pass paid its own diff read plus, in S4.4's case, its own full-suite run.

S4.4 now does both jobs in one fan-out: the review agents report, the `refactor`
agent has write authority to fix the clear ones, and the aggregated findings are
written to the same `pr-review-*.md` path the old S4.5 produced. Downstream
consumers (`post-review-summary`, `pr-execute-plan`, the S4.6b unresolved-issues
gate) are unchanged because the artifact is unchanged.

Slot 5 is retained and stamped done alongside slot 4, for the same reason slot 7 is
retained: renumbering would corrupt resume for every in-flight ticket whose Jira
checklist already has 10 items. Branches created before this change carry the old
`review: PR review plan generated` stage-commit label; treat it as equivalent to
`review: combined review pass` when detecting prior progress.

Gate 2's thresholds were widened at the same time (50 → 200 LOC, 2 → 5 non-test
files) and given a public-API veto. The narrow original window meant most real
tickets missed the skip and paid all three passes; the risk-path and API vetoes
carry the safety load, and anything skipped is still covered by CI and `/cop-fight`.

## Why the review agents are local and lean

`/jay-pr-review` and S4.4 used to spawn the vendored `rula-plugins` reviewers:
`quality:code-reviewer` (192 lines), `quality:security-auditor` (156),
`quality:architect-review` (161), and `testing:test-automator` (238). Those prompts are
written as capability résumés — "Integration with modern AI review tools (Trag, Bito,
Codiga)", "Low-Code/No-Code Testing Platforms", `## Example Interactions` — and every
spawn paid for all 747 lines to get maybe 75 lines of applicable instruction. Their
scopes also overlapped: `code-reviewer` already covers security basics, test quality,
and architecture, so three of the four largely re-derived the first one's findings from
the same diff.

They are replaced by two local agents, `diff-critic` and `diff-security` (~62 lines
each), split by lens rather than by specialty so they don't overlap. `architect-review`'s
one load-bearing concern — a changed public API whose consumers weren't updated — folded
into `diff-critic` as its "contract changes" section, and `test-automator`'s review role
folded in as "test coverage". `test-automator` was never the right agent for a review
pass anyway: it is built to *write* test suites, and giving a review step write authority
over tests invites diff enlargement.

Both new agents are read-only and return a JSON array rather than prose, so merging two
agents' findings is a data operation instead of a summarization. `diff-security` is now
gated on the diff being security-relevant at all, so a docs-only or pure-refactor branch
spawns one agent instead of four.

The vendored agents are left installed and untouched — other consumers may reference
them, and this repo doesn't own that cache.

## Why the plan format lives in its own fragment

Two callers write `pr-review-{BRANCH}.md`: `/jay-pr-review` Step 5 and `/ticket-work`
S4.4. S4.4 used to cite "the plan format in `commands/jay-pr-review.md` Step 5" — a
cross-command reference to a *step number*, which breaks silently the moment either
command is renumbered. The format now lives in `commands/_pr-review-format.md` and both
cite it by filename. The `_` prefix keeps `install.sh` from linking it as a slash
command.

## Why the inner loop runs a narrowed test scope

S4.2's per-task cycle used to run the **full suite** after every task, then again at
step 7, again at S4.3, and again after S4.4's refactor — eight full-suite runs on a
five-task ticket. Most projects wrap their test entry point in lint, dependency
refresh, container setup, and security scanning: appropriate once as a merge gate,
pure waste repeated eight times. In `employer-backend`, `scripts/test.sh` runs
pre-commit, a localstack docker cycle, avro validation, and a security scan around
every invocation, all toggleable via `RUN_*` env vars it already reads.

The lifecycle now resolves two commands (`FAST_TEST`, `FULL_TEST`) once and names
the tier at each call site. The inner loop uses `FAST_TEST`; `FULL_TEST` runs at
S4.2's exit gate, and again after S4.4 only when the review pass changed code. S4.3
no longer re-runs it at all — it sits immediately after a green full suite with no
intervening code change, so a second run cannot fail differently. Where a path does
change code after a gate (S4.3's coverage-gap branch), it closes with its own
`FULL_TEST` before marking done.

This trades a narrower regression net *during* the loop for the same net at the
gate. Nothing merges without a green `FULL_TEST`, and CI remains the final word.

## Migration note: legacy local merges

Tickets that ran S4.6b (formerly S4.7b) under the old local-merge flow already
have their work on `{FEATURE_BRANCH}` and have no PR to open. The
PR-into-feature-branch flow only applies to tickets reaching S4.6b after that
rewrite landed.

To finish a legacy in-flight stack, run it through the old workflow manually:
checkout the ticket branch, merge into the feature branch locally, then
`/promote-to-main`. The Step 1c tag walk in `/promote-to-main` skips commits with
no `merged/*` tag, so legacy local merges are not promotable through the current
gate without a backfill.

## Why the `merged/{KEY}` tag keys on the merge target, not the cleanup phase

The tag's lifecycle keys on **whether the ticket reached main**. `/cleanup`
Step 2d writes it whenever `MERGE_TARGET ≠ "main"`; only Step 4d's
`MERGE_TARGET == "main"` pass retires it. Retiring it before the ticket reaches
main would both starve the cleanup gate (re-triggering `/cleanup` indefinitely)
and destroy `featureMergeSha`, the Step 8 squash-replay source implicated in
NEV-863.

Keeping the two conditions distinct is what let the tag stay correct while the
*phase* rule around it was wrong. Until the fix below, a leaf that merged into
its container's feature branch ran **terminal** cleanup, and only Step 4d's
independent `MERGE_TARGET` check kept its tag alive after Step 4b/4c deleted its
branch.

## A feature-branch merge is never terminal — for leaves either

`DEFER_DESTRUCTIVE` keys purely on `MERGE_TARGET ≠ "main"`. It used to *also*
require `BRANCH_NAME === FEATURE_BRANCH`, so only stack-containers deferred, and
a leaf merged into its container's feature branch ran full terminal cleanup:
Jira → Done, branch deleted.

That rested on the premise that a leaf is never promoted separately and reaches
main implicitly when the Epic branch does. The premise is false.
`/promote-to-main` Step 1c takes a **leaf ticket key** as its argument ("If
`{RESOLVED_KEY}` matches a ticket key in `STACK_ORDER` (i.e. a leaf, not the
container)"), and its container-key path promotes leaves one at a time off
`GIT_MERGE_ORDER`. Leaves are the ordinary unit of promotion.

Three consequences, all observed on NEV-1446 (merged into Epic branch
NEV-1352):

1. **Premature Done.** The Story was transitioned to Done while its code sat on
   an unmerged feature branch.
2. **A branch `/promote-to-main` still needed was deleted.** Step 2a's rebase
   fallback uses a predecessor's branch as `UPSTREAM_BRANCH`.
3. **No self-correction.** With the branch gone, `classifyTicket` rule 0 reports
   `cleaned` (`autoSafe: false`), so nothing ever revisited the ticket to mark it
   Done once the work genuinely landed on main.

Now every feature-branch merge — container or leaf — takes phase-1: retain the
branch and Jira state, cascade-rebase siblings, refresh the feature branch, keep
the tag. Classifier rule 1c emits `cleanup-phase-1`, and rule 1 fires on the same
ticket later, once `mergedIntoMain` flips, to run terminal cleanup when it is
actually true.

## Retired: subtask expansion and queue discovery

`ticket-work.md` used to expand a Story into its subtasks and fan them out as
parallel agents, and to discover work via JQL when invoked with no arguments.
Both paths were removed.

`agents/planner.md` Principle 1 is the reason:

> **Subtasks must not touch code.** Code-changing work is always a Story, never
> a Subtask — full stop.

The lifecycle treats Stories as the unit of independent promotion to main, and
`/promote-to-main` selects its target from `STACK_ORDER` — Story-level entries,
not subtasks. A fan-out across code-touching subtasks therefore built work with
no promotion path of its own.

(Since the `DEFER_DESTRUCTIVE` fix above, *any* ticket that merged into a feature
branch keeps its branch and Jira state, so a subtask's branch is no longer
deleted early either. That removes one symptom, not the reason: the promotion
unit is still the Story.)

Story keys now behave like Epic keys: resolve the stack, pick the next unblocked
member, run it, stop. One rule for every invocation shape.

`cli/bin/discover-queue.js`, `buildParentInheritancePatch` and `QUEUE_QUERIES` in
`cli/lib/queue.js`, and `SUBTASK_EXCLUSION_LABELS` in `cli/lib/labels.js` lost
their last caller in that change. They are retained and marked `@legacy` because
the dashboard and README still reference the queue vocabulary; unpicking that is
a separate change.
