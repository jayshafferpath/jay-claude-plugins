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

## Why the `merged/{KEY}` tag outlives a leaf ticket's branch

The tag's lifecycle keys on **whether the ticket reached main**, not on which
cleanup phase ran. `/cleanup` Step 2d writes it whenever
`MERGE_TARGET ≠ "main"`; only Step 4d's `MERGE_TARGET == "main"` pass retires it.

A leaf ticket that merged into its container's feature branch runs terminal
cleanup but keeps its tag — it has not reached main, and once Step 4b/4c delete
its branch the tag is the only durable record that it shipped. Retiring it there
would both starve the cleanup gate (re-triggering `/cleanup` indefinitely) and
destroy `featureMergeSha`, the Step 8 squash-replay source implicated in
NEV-863.

## Retired: subtask expansion and queue discovery

`ticket-work.md` used to expand a Story into its subtasks and fan them out as
parallel agents, and to discover work via JQL when invoked with no arguments.
Both paths were removed.

`agents/planner.md` Principle 1 is the reason:

> **Subtasks must not touch code.** Code-changing work is always a Story, never
> a Subtask — full stop.

The lifecycle treats Stories as the unit of independent promotion to main. A
Story-container's branch survives `DEFER_DESTRUCTIVE` cleanup so it can be
promoted; a Subtask's branch is deleted on cleanup and is unreachable to
`/promote-to-main`. A fan-out across code-touching subtasks therefore built
work that could not ship.

Story keys now behave like Epic keys: resolve the stack, pick the next unblocked
member, run it, stop. One rule for every invocation shape.

`cli/bin/discover-queue.js`, `buildParentInheritancePatch` and `QUEUE_QUERIES` in
`cli/lib/queue.js`, and `SUBTASK_EXCLUSION_LABELS` in `cli/lib/labels.js` lost
their last caller in that change. They are retained and marked `@legacy` because
the dashboard and README still reference the queue vocabulary; unpicking that is
a separate change.
