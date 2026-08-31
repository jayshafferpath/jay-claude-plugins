# jay-claude-plugins

Claude Code tooling for Jira ticket automation, stacked PR management, and end-to-end TDD → Jira → PR → merge workflows.

Three surfaces, one lifecycle:

1. **Agents** (`@planner`, `@feature-planner`, `@tdd-builder`, `@refactor`, `@condensor`, `@condense-verified`) — long-lived, domain-specific subagents Claude Code dispatches when you `@` them.
2. **Slash commands** (`/ticket-work`, `/prework`, `/orchestrate`, …) — deterministic pipelines executed inside a Claude Code session.
3. **CLI tools** (`ticket-status`, `resolve-stack`, `sync-plan`, …) — Node scripts in `~/.local/bin/` that agents/commands call to touch Jira and git without going through an MCP round-trip.

Jira is the source of truth for stack structure, ticket state, and lifecycle labels. Git only knows about branches — never about parent/child relationships.

## Install

```bash
./install.sh
```

Does five things:

1. Symlinks `commands/*.md` → `~/.claude/commands/` and `agents/*.md` → `~/.claude/agents/`.
2. Creates `.env` from `.env.example` (project-level Jira creds) if missing.
3. Creates `~/.claude/.env` (machine-level, holds `DEV_ROOT`) if missing.
4. Runs `npm install` in `cli/`.
5. Generates a wrapper for each `cli/package.json` `bin` entry in `~/.local/bin/`. Wrappers embed an absolute node path so they survive `asdf reshim` and work in repos with a different `.tool-versions`.

Put `~/.local/bin` **ahead of** `~/.asdf/shims` on `PATH`. After install, fill in credentials:

- `.env` — `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_DOMAIN`
- `~/.claude/.env` — `DEV_ROOT` (parent directory of your repo clones), optional `SLACK_WEBHOOK_URL`

Tickets are routed to a repo via a `repo:<name>` label, resolved to `$DEV_ROOT/<name>`.

## Prerequisites

- [Claude Code](https://claude.ai/code)
- [Atlassian MCP server](https://mcp.atlassian.com) (`mcp__atlassian__*` tools)
- GitHub CLI (`gh`) authenticated
- Node 20+ (see `.tool-versions`)

## Module layout

```
agents/         @planner, @feature-planner, @tdd-builder, @refactor,
                @condensor, @condense-verified, @diff-critic, @diff-security
commands/       slash commands (/ticket-work, /prework, /orchestrate, ...)
  _*.md         shared reference fragments cited by commands; install.sh skips them
                _-prefixed files are shared fragments, not commands:
                _condense-docs.md, _shared-stack-procedures.md, ...
cli/
  bin/          Node CLI entry points (symlinked into ~/.local/bin/)
  lib/          shared libraries: jira, git, labels, stack-resolver, ...
  tests/        vitest suite
dashboard/      Vite browser dashboard for viewing stack state
docs/           architecture diagrams
install.sh      symlink commands/agents into ~/.claude/, generate the opencode
                copies via sync-opencode, install CLIs
```

### Two runtimes, one source

`agents/` and `commands/` are canonical in **Claude Code dialect** (`model: opus`,
`allowed-tools:`). `~/.claude/` gets symlinks, so editing a file here takes effect
immediately. **opencode gets generated copies** written by `sync-opencode`.

One file cannot serve both: `allowed-tools` is not an opencode field, and opencode routes
unknown frontmatter to the provider as model options while defaulting its permissions to
*allow* — so a shared file would silently give the read-only reviewers write access.
Generation costs nothing on that side, because opencode loads agents and commands at config
time and needs a restart to see a change either way. The loop is
`edit → sync-opencode → restart opencode`, and `sync-opencode --check` exits 2 when the
copies are stale.

The translation is not lossless, and says so on every run: commands have no permission field
in opencode (a command inherits the invoking agent's permissions), and a model alias chosen
to be *cheaper* than the default has no portable equivalent. Agent tool restrictions —
including per-MCP-tool allowlists — do carry over.


## Core concepts

### Stack architecture

Jira is the source of truth. A **stack** is a Story/Task/Epic (the "container") plus its children, topologically sorted by "is blocked by" links.

Every container gets a **feature branch** named after its Jira key (or `branch:<name>` label). Its children are stacked as git branches — each based on the previous — and PR into the shared feature branch. When Epic B is blocked by Epic A, B's feature branch bases on A's branch until A merges. Standalone tickets (no container) skip the feature branch and PR direct to `main`.

### Label state machine

Progress labels flow one-at-a-time via `set-ticket-state`, which clears the previous progress label:

```
ClaudeWork                 durable: Claude owns this ticket
ClaudeReady                eligible for planning
ClaudePlanning             /plan-ticket in progress
ClaudeExecuting            TDD execution in progress
ClaudeStackReady           review done; PR open, awaiting human review
ClaudeStackComplete        container-level rollup; triggers Mode C
ClaudeFailed               failure side-channel
```

To enqueue a ticket: tag it `ClaudeWork` + `ClaudeReady`. To finish it: run `/cleanup KEY` after merge to main.

The set is deliberately small. A state earns a label only when another *process* must see it — a peer agent (`ClaudePlanning`/`ClaudeExecuting` are distributed locks across parallel `/ticket-work` agents), a JQL query that has to find the ticket before anything can probe it, or a human handing work in (`ClaudeReady`). Everything else is read from the system that already records it:

| State | Read from |
| --- | --- |
| Out for review | An open PR (`getOpenPrMap`), or Jira status "In Review"/"Code Review"/"Review". `resolve-stack` surfaces `entry.inReview` and `entry.openPr`; `transition-jira {KEY} --event review` moves the status on PR push. |
| PR approved | GitHub review state on the PR itself. There is no approval label — every PR opens as a draft, and a human marking it ready and approving it is the gate. |
| Merged | `git merge-base` / merged-PR lists (`mergedIntoFeature`, `mergedIntoMain`). |
| Phase-1 cleanup ran | The `merged/{KEY}` git tag from `/cleanup` Step 2d. |
| Implementation Notes current | `drift-check` diffs the research baseline SHA against HEAD — idempotent, so no marker is needed. |
| Designs captured | The `h3. Designs` block in Implementation Notes plus `.designs/{KEY}/*.png`. |
| Abandoned | Jira status Cancelled, set by `/prune`. |
| Step progress | The per-ticket checklist (`.claude/plans/ticket-work-{KEY}.md`, mirrored to a Jira comment). |

### TDDs and research

`@planner` decomposes a TDD at `docs/tdds/{slug}.md` into Jira Epics/Stories/Subtasks. The TDD is the source of truth; tickets deep-link to it.

A TDD declares repos each capability touches via a `**Repos**:` line under each H2. Research runs per (capability, repo) against locally-cached clones, producing SHA-pinned permalinks stored in **Implementation Notes** on each ticket.

**Drift detection**: Implementation Notes carry a baseline SHA. `/ticket-work` at S3.5 diffs cited line ranges from `baseline_sha..HEAD`. If anything moved, notes are refreshed and a Jira comment posts old vs new — recommending `/rework` if the plan was already approved against stale notes. Manual trigger: `/refresh-research KEY`.

**Lazy decomposition**: the planner stops at the first unblocked unit. Within the first Epic, only parallel-startable Stories get full Gherkin + subtasks + Implementation Notes; everything else is a skeleton, fleshed out later via `@planner STORY-KEY` when its blockers close.

## Agents

Invoke with `@name <args-or-prompt>` in a Claude Code session.

### `@tdd-builder`

Conversational TDD drafter. Ingests a Jira PRD (plus linked Confluence pages) into repo-local reference files, researches the named repos via the planner clone cache, and drafts a planner-ready TDD at `docs/tdds/{slug}.md`. Proposes capabilities grounded in existing repo patterns rather than pattern-matching on the ticket. Stops at "draft ready" — you run `@planner init {slug}` next.

**Typical trigger**: you have a PRD in Jira and want a repo-aware technical design without hand-writing one.

### `@planner`

Decomposes a repo-based TDD into Gherkin-based Jira Epics/Stories/Subtasks with dependency-ordered blocker links. Populates the local clone cache, runs research per (capability, repo), writes sidecars at `docs/tdds/{slug}/{repo}.research.md`, and stamps the TDD frontmatter. Supports owner/consumer split: canonical TDD lives in one repo; other repos init via a pointer file with `mode: consumer`, `owner:`, `sha:` frontmatter and plan their own slice independently.

**Entry points**:
- `@planner init {path-or-slug}` — owner init (in owning repo). Relocates TDD to `docs/tdds/`, validates shape, runs research, writes sidecars, stamps frontmatter.
- `@planner init {owner-slug}:{tdd-slug}` — consumer init. Fetches owner TDD at pinned SHA, validates repo is in scope, runs research for this repo, writes a pointer file.
- `@planner {slug-or-key}` — decompose. Refuses if the local TDD isn't initialized. Given a Jira key, fleshes that skeleton.

### `@feature-planner`

Alternative decomposition for the same TDDs, sliced by **feature** rather than by PR size. Shares `@planner`'s init flow unchanged — a TDD initialized by `@planner init` needs no re-init.

Where `@planner` splits a capability when it grows large (3+ steps, several behaviors), this agent treats effort as irrelevant to slicing. A feature that lands as a 900-line PR is one ticket. Only two things split it: a **hard PR boundary** (one PR cannot span two repos) and a **genuinely distinct user-observable outcome** (a separate "so that").

**Hierarchy**: one Epic per `(feature, repo)` pair — the repo seam lands on the Epic because that is where the feature branch and repo root resolve. Stories under it are distinct outcomes within that one repo. Sibling Epics of a feature are linked by a `feature:{slug}` label plus `relates to` links, since Jira has no feature object. Subtasks stay non-code.

It is also the only thing in this repo that **writes the `repo:` label** — `/cleanup`, `/prune`, and `resolveRepoRoot` all consume it, but nothing else sets it.

**Entry points**:
- `@feature-planner init {path-or-slug}` / `init {owner-slug}:{tdd-slug}` — delegates to `@planner`'s init verbatim.
- `@feature-planner {slug-or-key}` — decompose, or flesh a skeleton Epic/Story.

**Pick one agent per TDD.** The two slice incompatibly, so each one's stale-ticket detection would flag the other's output wholesale; this agent detects that collision and stops rather than recommending a bulk prune.

### `@refactor`

Analyzes code for CRAP score, DRY violations, and refactoring opportunities. Scans repos or targeted files, presents prioritized findings, and — with approval — implements the accepted refactorings. Read-and-edit only; no Jira/git side effects.

**Typical trigger**: mid-`/ticket-work` at S4.4 (called by the pipeline), or manually against a file you're unhappy with.

### `@condensor` / `@condense-verified`

Rewrite a verbose document as a shorter version of *itself* — same voice, same claims, fewer words. Not summarizers: they never describe the document from the outside, and condensing is treated as closer to deletion than to rewriting.

- `@condensor` — the cheap pass, on Sonnet. Read-only. Use for chat output nobody stores.
- `@condense-verified` — dispatches `@condensor`, then verifies the result against the source on Opus and patches defects in place (dropped identifiers, softened prohibitions, reversed ordering, invented claims). One condense pass, one verify pass, no retry loop. Use for anything read downstream as authoritative.

**Every agent that writes a prose document to disk runs it through `@condense-verified`** — the rule and its dispatch shape live in `commands/_condense-docs.md`. A doc-writing agent writes at the length its research happened to reach, not the length the reader needs, so the condense pass is a separate cheap read whose only job is to cut. Current call sites:

| Writer | Artifact | Step |
|---|---|---|
| `@tdd-builder` | `docs/tdds/{slug}.md` | Phase 7d |
| `@planner init` | `docs/tdds/{slug}/{repo}.research.md` (one per repo, condensed in parallel) | Init Phase 4b.i |
| `@feature-planner init` | same sidecars — inherits `@planner`'s init verbatim | — |

Both call sites re-run their pre-write structural validation on the condensed output, and keep the full-length draft if it fails. These files are parsed, not only read: a sidecar H2 that no longer matches its TDD capability heading reads to `@planner` Phase 2c as a research gap, and a dropped `**Repos**:` line is a hard refusal in init.

Deliberately **not** condensed: the `/jay-pr-review` and `/plan-ticket` plan files (machine-parsed checkbox lists, already length-capped), Gherkin AC (a contract, kept verbatim), and ticket bodies and chat output (governed by the **Output Style** section of `agents/planner.md`, applied while writing).

## Slash commands

Every command lives at `ai/commands/{name}.md`; symlinked to `~/.claude/commands/{name}.md` by `install.sh`. Frontmatter declares the exact tool surface (Atlassian MCP calls, `Bash(...)` allowlist, etc.); reading a command's `.md` is the fastest way to see what it will touch.

### Lifecycle: plan → execute → review → ship

#### `/prework KEY`

Pre-`/ticket-work` setup: resolves the stack via `resolve-stack`, ensures the feature branch + working directory exist (`ensure-work-dir`), seeds the checklist from the plan (`seed-checklist`), runs a drift check, and captures Figma design context if the ticket has a Figma link. Stops before planning.

Use when you want to inspect a ticket's landing zone before turning `/ticket-work` loose on it.

#### `/plan-ticket KEY`

Lightweight plan generator. Reads AC + Implementation Notes from Jira, writes a short markdown checklist to a tmp file, syncs it into the ticket's managed plan comment via `sync-plan`, and cleans up. No EARS expansion, no Explore subagent — the heavy research lives upstream in `@planner`.

State lives in Jira as a comment, not in `.plans/`.

#### `/ticket-work [KEY...]`

The main engine. Idempotent — reads checklist state from Jira and resumes wherever it left off.

- **Leaf key** (`/ticket-work KEY`): runs one ticket through drift-check → plan → execute (TDD Red-Green-Refactor per plan task) → verify AC → combined review pass (`@refactor` + `diff-critic`, conditionally `diff-security`) → stack-ready.
- **Container key** (`/ticket-work EPIC-1` or a Story): resolves the stack and runs the next unblocked member — one per invocation; re-run to advance.
- **No discovery mode**: `/ticket-work` requires a key. `/orchestrate` is what finds eligible work across stacks.

**Complexity tiers**: two independent gates control which steps run.
- **Gate 1** (pre-execute, S3.4): sets `complexity:trivial`. Skips `/plan-ticket` and runs execute in no-plan mode (single-batch test authoring).
- **Gate 2** (post-execute, S4.3.5): decided from actual diff size. Skips the whole S4.4 combined review pass. In-memory only; no Jira label.

**Stack behavior**: containered tickets merge locally into their feature branch after review passes. Standalone tickets run straight through `ClaudeStackReady` and open a draft PR against `main`; the draft state is the checkpoint, so nothing merges until a human marks it ready and approves it.

**Mode C**: when a container's last child ships (`ClaudeStackComplete`), the feature branch is pushed as a single PR — to `main`, or to the parent Epic's branch for nested Stories — reusing the same PR push & review sub-procedure with a final draft → ready flip.

CI green and Copilot comments are **not** automatic — run `/cop-fight` on demand after the PR opens.

#### `/jay-pr-review [BASE]`

Generates a PR review plan at `.plans/pr-review-<branch>.md`. Fans out the two local review agents in parallel (via the `Agent` tool) and merges their findings into a single checklist file.

- `diff-critic` — always. Correctness defects, contract changes, test-coverage gaps.
- `diff-security` — skipped when the diff is security-inert (no auth, input handling, persistence, logging, secrets, crypto, IaC, shell-out, or new dependency).

Both are read-only and return JSON. Plan format lives in `commands/_pr-review-format.md`, shared with `/ticket-work` S4.4.

`/ticket-work` does **not** call this command — S4.4 runs its own fan-out over the same diff (adding the write-authorized `@refactor` agent) and writes the same artifact. Run `/jay-pr-review` manually against any branch.

Base defaults: `$ARGUMENTS` → `git config branch.<BRANCH>.base` → `gh pr view --json baseRefName` → `main`.

#### `/finalize`

Final pre-merge pass. Updates the PR description to reflect the actual shipped state, then posts a finalization comment with context downstream stacked-ticket agents can use (touched files, gotchas, follow-ups). Writes to Jira's activity log via `append-activity`.

### Sliced build: a peer pipeline to `/ticket-work`

An alternative execution loop for a single greenfield layered feature, where the commits themselves are the plan. No Jira stack, no squash, no manifest file: each slice is one commit carrying `Slice-Id` / `Depends-On` trailers, and `git log` is the ledger. Shared formats and the reasoning behind them live in `commands/_sliced-format.md`; every derivation over the ledger lives in four CLIs (`read-ledger`, `slice-scope`, `slice-replay`, `slice-review`) rather than in prose the agent is asked to reproduce.

#### `/build-sliced [spec ref] [BASE]`

Builds a whole feature as dependency-ordered commit slices on one branch, foundations (types, schemas, contracts) first, leaves last. `<spec ref>` is a Jira key, `docs/tdds/{slug}.md`, or `.plans/ears-{slug}.md` — never free text. Refuses work that isn't a greenfield layered feature and names the better home (`/refactor`, `/ticket-work`, or "too small to slice").

- **Kind and depth are derived**, never declared — `leaf` iff nothing names the slice in `Depends-On`, depth is its graph level. A trailer would have to predict slices that don't exist yet.
- **`read-ledger` refuses nine ways** before anything is built on a guess: a merge commit (caught by parent count), an empty `Slice-Id` (the multi-`-m` mis-commit, reported distinctly from a plain missing one), a duplicate id, an absent `Depends-On`, a self-edge, a dangling edge, a **forward edge** — a dependency on a later commit, which replay's positional rewind can never have satisfied — and a cycle.
- **Resume identity comes from the spec**, recorded at `git config branch.<BRANCH>.slicedSpec`. Re-invoke with no arguments to replay the current branch. Missing that config is a refusal even when a ledger exists — Step 1's gate is skipped on resume and Step 4 needs the spec to know where the feature is incomplete.
- **Replay**: `slice-replay plan` picks the earliest slice with an open finding in **commit** order (the rewind is positional, so a depth-ordered start leaves earlier findings permanently unreachable), captures the pre-rewind fingerprints, and writes the cursor — all before anything is rewritten. Slices carrying findings are re-derived; the rest are cherry-picked so their patch-ids survive, and re-derived only when a conflict or a red bar proves it was needed. `Slice-Id` is immutable across replays; force-pushes its own branch.
- **Crash-safe** via a cursor at `.plans/replay-<branch>` that carries the pre-rewind patch-ids and file lists — the one thing a `git reset --hard` makes unreconstructable. Deleted only after the replay pushes. Recovery guards the worktree *before* its own hard reset, clearing a conflicted cherry-pick first so "commit or stash" can't commit conflict markers.
- **The bar is one fixed thing**: the slice compiles and its own tests pass against the tree at its commit. A clean cherry-pick doesn't inherit yesterday's green bar, which is why only `regenerated-identical` may skip it.
- **Refuses a stale base** whenever the branch exists, not only on resume — an empty branch sits on a base too, and `git switch` does not fetch. A moved `origin/<BASE>` stops the command with `git rebase origin/<BASE>` as the named fix. A merge commit carries no `Slice-Id` and would make the ledger unreadable, so merging the base in is never the answer.
- Opens no PR. When the stack is settled it hands off to the normal PR flow.

#### `/review-slices [BASE]`

Reviews a sliced stack and writes slice-tagged findings to `.plans/review-<branch>.md`. Same two agents as `/jay-pr-review`, scoped by `slice-scope` to every slice that isn't **stable** — its own patch-id moved, or a patch-id in its **influence set** did. The influence set is the transitive `Depends-On` closure *plus* any earlier slice sharing a touched file, and it's the seam coverage: the closure puts every slice built on a changed foundation in scope even when their own patches are byte-identical, and the file-overlap term catches the coupling no edge expresses (replay is positional, so a slice is rebuilt against every earlier commit, not just its declared dependencies). Overlap is measured over the union of each slice's before and after file lists, so a slice that *stops* touching a file counts — otherwise a downstream reader of that file reads as stable while the file lost its content. Neither term makes it a proof — a coupling through a third file with no shared path stays invisible, which is why `regenerated-identical` is documented as the best skip git can justify rather than a guarantee.

Every finding resolves to the `Slice-Id` that owns its `file:line`, or lands in Unassigned. The file is a **merge**, not a regeneration — a finding is removed only by a pass that looked at its slice *with the agent that produced it*, so a `diff-security` finding survives a pass that skipped `diff-security` as security-inert. And because the agents are non-deterministic, a removal is *recorded* as `- [x] (not re-reported)` with a note rather than deleted: a single sampling failure never silently drops real work. Read-only.

### Post-merge: cleanup

#### `/cleanup KEY` (auto-dispatching)

Detects the merge target and runs the right phase:
- Terminal (PR merged to `main`) → `/cleanup-main`
- Phase-1 (Story-container PR merged into parent Epic's feature branch) → `/cleanup-feature`

Flags: `--no-rebase`, `--no-refresh-feature` to skip the cascade / refresh steps.

#### `/cleanup-main KEY`

Explicit terminal cleanup. Verifies the PR merged to `main` and the merge commit is reachable from `origin/main`. Deletes local + remote branch, transitions Jira → Done (or applies terminal labels if no Done transition exists), appends "Shipped" / "Stack complete" activity entries, cascade-rebases any unmerged downstream tickets (`cascade-rebase`), and refreshes the long-lived feature branch by resetting to `origin/main` and re-merging still-unmerged ticket branches with `--no-ff`.

Refuses if merge target was an Epic feature branch (wrong phase).

#### `/cleanup-feature KEY`

Explicit phase-1 cleanup. PR merged into a parent Epic's feature branch. Tags the merge commit as `merged/{KEY}` — load-bearing for `/promote-to-main`, and the durable record that phase-1 ran — retains the Story branch on disk + remote (must survive for `/promote-to-main`), leaves Jira in its current status and progress label, cascade-rebases siblings, refreshes the Epic feature branch.

Refuses if merge target was `main`.

#### `/promote-to-main KEY`

Promotes a stacked ticket to main. Walks the stack in dep order and, for each ticket, runs `git rebase --onto origin/main {prev} {curr}` to strip ancestor commits, opens a PR to main, and waits for merge before advancing.

Accepts a ticket key, container key, or feature branch name.

### Recovery / manual intervention

#### `/rebase-on-main`

Rebase current branch onto `origin/main` and `--force-with-lease` push. Aborts cleanly on conflict.

#### `/stack-rebase KEY`

Cascade-rebase a full stacked PR chain after its base moved. Wraps `cascade-rebase`, updates PR base refs via `gh pr edit`.

#### `/refresh-research KEY`

Manually re-run the per-ticket drift check. Diffs cited line ranges against the baseline SHA and updates Implementation Notes if anything moved. Fires when a blocker branch merges and pinned SHAs become unreachable.

#### `/fix-drift KEY`

Detects drift between Jira AC and the current implementation, then fixes the code to match the ticket. Resumes the ticket-work lifecycle after fixing.

#### `/rework KEY`

Resets the ticket's branch to its base, clears all progress labels and checklist, restarts the lifecycle from scratch. Use when the current implementation is unsalvageable and starting over is faster than fixing.

#### `/prune KEY`

Abandons a ticket. Reverts its merge from the feature branch, closes the PR, transitions the Jira ticket to Cancelled.

### Observability

#### `/ticket-status KEY`

Shows the full lifecycle state of a ticket: stack, branch, PR, Jira labels, checklist state, blocks/blocked-by. Thin wrapper around the `ticket-status` CLI's verbose mode.

#### `/orchestrate [KEY]`

Project-level coordinator across all active stacks. Surveys state, auto-runs safe lifecycle steps (cleanup merged tickets, promote PR-approved tickets), and surfaces decisions that need a human (failed tickets, drift, plan/PR approvals, cold-ticket kickoffs).

Three entry paths:
- **Lifecycle tickets** (`Claude*` labels) → advance along the state machine.
- **Cold tickets** (assigned, no `Claude*` labels) → offer to chain `/prework KEY` + `/ticket-work KEY` to enter the lifecycle. Pass `KEY` as a positional argument to scope to one ticket (equivalent to `--scope KEY`).
- **Initiatives** (`--scope INIT-KEY`) → expanded into child Epics (via `parent` and `relates to`) and surveyed as one group under an Initiative header.

Uses `classify-actions` to bucket tickets into safe-to-auto-run vs needs-human.

**The Epic is the orchestration ceiling.** The feature branch and repo root both resolve at the Epic, so an Initiative owns no branch and is never a container — it is a grouping for the status view, and every dispatched action targets an Epic or one of its members. `resolve-stack` refuses an Initiative key outright and points at `resolve-stack {KEY} --expand`; `/ticket-work` and `/prework` refuse it too. Project-wide mode does not expand Initiatives, since its container derivation already climbs to the Epic and stops — every Epic under an Initiative is surveyed on its own.

#### `/triage-tickets`

One triage pass over every active stack, built for unattended polling. Two halves:

- **Promotion** — delegates to `/orchestrate --no-loop`, which owns the label/merge decision table.
- **Stagnation** — the time dimension `/orchestrate` lacks. `classify-actions` reads labels and merge state only, so a ticket whose agent died in `ClaudeExecuting` nine days ago looks identical to one that entered the state a minute ago.

Three stagnation rules, from the `detect-stagnation` CLI:

| Rule | Fires when | Nudge |
|---|---|---|
| `abandoned-in-flight` | `ClaudePlanning`/`ClaudeExecuting` with no activity-log append, branch commit, or Jira update for `--in-flight-hours` (default 12) | Clears the stale label back to `ClaudeReady` and logs why, so the queue can pick it up again |
| `unattended-failure` | `ClaudeFailed` untouched for `--failed-days` (default 3) | Escalated in the digest — never auto-fixed, since `/fix-drift` and `/rework` both mutate the branch |
| `rotting-pr` | Open PR untouched for `--pr-days` (default 5), or its base moved `--behind-commits` ahead (default 25) | Runs `/stack-rebase` when the base moved; reports only when it just needs a reviewer |

Single-pass by design — wrap it in `/loop` for polling:

```
/loop 15m /triage-tickets
```

Start with `/triage-tickets --status` to see the digest without acting. `--no-promote` / `--no-nudge` narrow it to one half.

#### `/pr-chat KEY`

Loads full PR context (Jira ticket + linked TDD + PR metadata + diff + full contents of every changed file) into the conversation, then hands control back to you for free-form discussion. Useful for pre-review self-check, drafting PR copy, or reasoning about review comments.

### Auxiliary

#### `/ears-requirements [topic]`

Interactive EARS (Easy Approach to Requirements Syntax) drafter. Guides you through the five patterns (ubiquitous, event-driven, unwanted-behavior, state-driven, optional-feature) to produce unambiguous requirements.

#### `/cop-fight`

Post-PR-push helper. Drives CI to green, then evaluates each Copilot review comment on viability and value before deciding whether to implement or dismiss with an explanation. Replaces blind auto-fix loops.

## CLI tools

`ticket-status` is the only user-facing CLI; the rest are called by commands and agents. All are installed as wrappers in `~/.local/bin/` and read Jira credentials from `.env` / `~/.claude/.env`.

| Script | Purpose |
|---|---|
| `ticket-status` | View and manage Claude ticket stacks in Jira. Verbose mode powers `/ticket-status`. |
| `discover-queue` | **Legacy.** Queue-discovery JQL + parent/subtask expansion. Lost its last caller when `/ticket-work` dropped discovery mode; retained for the dashboard's queue vocabulary. |
| `resolve-stack` | Resolve stack ordering from Jira issue links. Returns container + ordered members + base branch. Refuses above-Epic keys (Initiatives); `--expand` lists an Initiative's child Epics instead. |
| `ensure-work-dir` | Resolve a ticket's working directory (`$DEV_ROOT/<repo>`) and ensure its branch exists (creating it based on `resolve-stack` output if needed). |
| `ensure-pr` | Create or update a draft PR for the current branch. Idempotent. |
| `pr-state` | Normalized `gh pr list` probe. Used by `/orchestrate` and cleanup. |
| `seed-checklist` | Initialize a ticket's checklist from its plan; pre-marks skipped steps per complexity tier. |
| `sync-checklist` | Sync checklist state between Jira and local files. |
| `sync-plan` | Sync plan content (as a managed Jira comment) between Jira and local files. |
| `set-ticket-state` | Move a ticket to a progress label (clearing the previous progress label) or add/remove arbitrary labels. Also moves Jira workflow status when the label→status map applies. |
| `append-activity` | Append a timestamped entry to the ticket's `[claude-activity-log]` managed comment. |
| `drift-check` | Diff cited line ranges against the baseline SHA; emit a drift report. Called by `/ticket-work` S3.5 and `/refresh-research`. |
| `cascade-rebase` | Cascade-rebase a chain of stacked branches after their base moved. |
| `promote-downstream` | Mark unblocked downstream dependents `ClaudeReady`; report stack completion. |
| `stage-squash` | Squash commits into a single `[{KEY}] {label}` commit and force-with-lease push. |
| `verify-merge` | Verify a PR merged and the merge commit is reachable from the expected target. |
| `classify-actions` | Bucket tickets into safe-to-auto-run vs needs-human for `/orchestrate`. |
| `detect-stagnation` | Add the time dimension `classify-actions` lacks: flag abandoned in-flight agents, unattended failures, and rotting PRs. Exits 2 when it finds something. Used by `/triage-tickets`. |
| `post-review-summary` | Post a PR review summary as a Jira comment. |
| `cleanup-feature-refresh` | Refresh an Epic feature branch by resetting to base + re-merging unmerged ticket branches. |
| `read-ledger` | Read the `Slice-Id`/`Depends-On` trailers in a range, validate the ledger (nine refusals), and derive kind, depth, patch-ids, touched files, and base drift. Exits 2 when the ledger is unreadable. |
| `slice-scope` | Compute `/review-slices`' scope: the `stable` predicate over every slice, its influence set, the diff range, and the changed-file union. |
| `slice-replay` | `plan` picks the replay start in commit order and writes the crash cursor with the pre-rewind fingerprints; `classify` assigns the four replay classes and says which slices skip the bar; `recover` / `clear` handle the cursor. |
| `slice-review` | Resolve each finding to the slice that owns its `file:line`, merge into the prior review file (never regenerate), and write it. |
| `sync-opencode` | Generate the opencode-dialect copies of `agents/` and `commands/` from the Claude Code canonical sources. `--check` exits 2 when they are stale; reports every restriction the translation could not carry. |

Run any CLI directly for its options: `ticket-status --help`, `resolve-stack --help`, etc.

## Real workflows

### 1. Greenfield: PRD → shipped feature

Starting from a PRD in Jira:

```
1. @tdd-builder PROJ-123
     ↳ drafts docs/tdds/{slug}.md grounded in repo patterns

2. @planner init {slug}
     ↳ runs research per repo, writes sidecars, stamps frontmatter

3. @planner {slug}
     ↳ decomposes into Epic → Stories → Subtasks with Gherkin AC
       and Implementation Notes (SHA-pinned research citations).
       Lazy: only unblocked units get fleshed out.

4. Tag first Story ClaudeWork + ClaudeReady.

5. /ticket-work EPIC-1
     ↳ resolves the stack, picks the next unblocked Story, and runs it through
       drift-check → plan → execute → refactor → review → merge-to-feature-branch.
       One Story per invocation; re-run to advance. The container's feature
       branch accumulates each one.

6. Last subtask done → ClaudeStackComplete on the container → Mode C
   opens a single PR for the whole feature branch.

7. Merge that PR into the parent Epic branch.

8. /cleanup KEY (or the phase auto-detects and runs /cleanup-feature)
     ↳ tags merged/{KEY} (marks phase-1 done), retains the Story
       branch, cascade-rebases sibling Stories.

9. /promote-to-main KEY
     ↳ rebases Story onto main, opens main-targeting PR, waits.

10. PR merges to main → /cleanup KEY (auto-runs /cleanup-main)
      ↳ deletes branch, transitions Jira → Done, refreshes Epic branch.

11. @planner {epic-key}   (fleshes next unblocked Story skeleton)
    → back to step 4.
```

### 2. Standalone bug ticket (no stack)

```
1. Tag ticket ClaudeWork + ClaudeReady in Jira.

2. /ticket-work KEY
     ↳ no container, so no feature branch. Runs the same pipeline and
       ends at ClaudeStackReady with a draft PR open against main.

3. Review the diff locally / in GitHub.
4. Mark the PR ready for review on GitHub when it looks right.

5. /cop-fight
     ↳ waits for CI, judges Copilot comments, dismisses noise, fixes real issues.

6. Merge in GitHub.
7. /cleanup KEY.
```

### 3. Mid-stack drift: blocker merged while a Story was in flight

```
State: STORY-B is executing. Its blocker STORY-A just merged. The pinned
SHAs in STORY-B's Implementation Notes are now unreachable from HEAD.

1. /ticket-work KEY resumes → S3.5 drift-check fires automatically
     ↳ diffs cited ranges baseline_sha..HEAD, detects moves.
     ↳ refreshes Implementation Notes; posts old-vs-new Jira comment.
     ↳ recommends /rework if the plan was already approved against stale notes.

2a. Small drift: /ticket-work continues from the updated notes.
2b. Big drift: /rework KEY → resets branch, clears labels, restarts.

Manual variant: /refresh-research KEY (same drift check without re-running
the pipeline).

Manual variant: /fix-drift KEY (AC drift, not research drift — fixes code
to match the ticket's Gherkin).
```

### 4. Rescue a broken stacked PR chain

```
State: PR-A (base of stack) got a fixup commit and was rebased.
PR-B and PR-C now point at the old PR-A tip.

1. /stack-rebase KEY   (KEY = any ticket in the chain)
     ↳ resolve-stack → cascade-rebase walks the chain in dep order.
     ↳ each branch rebased onto its parent's new tip.
     ↳ force-with-lease pushed.
     ↳ gh pr edit rewrites base refs for retargeted PRs.
```

### 5. Abandoning work mid-flight

```
STORY-B was merged into the Epic feature branch, but the product decision
changed — we're not shipping it.

1. /prune STORY-B
     ↳ reverts the merge commit from the feature branch.
     ↳ closes the PR.
     ↳ transitions the Jira ticket to Cancelled.
     ↳ cascade-rebases downstream siblings past the revert.
```

### 6. Multi-repo TDD (owner/consumer split)

```
Backend repo owns the TDD:
  cd $DEV_ROOT/backend
  @tdd-builder PROJ-500
  @planner init auth-migration
  # docs/tdds/auth-migration.md now canonical here

Frontend consumes it:
  cd $DEV_ROOT/frontend
  @planner init backend:auth-migration
    ↳ fetches owner TDD at pinned SHA
    ↳ validates this repo is in scope (repo listed under some capability)
    ↳ runs research for frontend's affected code
    ↳ writes docs/tdds/auth-migration.md as a pointer file
      with mode: consumer, owner: backend, sha: <pinned>

Now both repos can @planner {slug} → decompose their slice → generate
their own Epic tree in the same Jira project, with cross-repo blocker
links honored during promotion.
```

### 7. Nightly operator loop

```
Morning:
  /orchestrate
    ↳ auto-runs safe steps:
       - /cleanup for tickets whose PR merged overnight
       - /promote-to-main for containers whose phase-1 cleanup already ran
       - promote-downstream for freshly-unblocked dependents
    ↳ surfaces needs-human list:
       - ClaudeFailed tickets (investigate)
       - drift-detected tickets (review Jira comment, decide /rework?)
       - stack-ready tickets (review the open PR, mark ready + approve?)

Address the list, then:
  /ticket-work KEY     (run a freshly-Ready ticket; /orchestrate lists them)
```

Unattended variant — polls instead of waiting for you to run it:

```
/loop 15m /triage-tickets
  ↳ each pass:
     - delegates promotion to /orchestrate --no-loop
     - detects stagnation the label table can't see:
        · agents that died mid-run (label cleared, work re-queued)
        · ClaudeFailed tickets nobody has addressed in days
        · open PRs gone quiet, or whose base has moved far ahead
     - prints one digest; stays quiet when everything is healthy
```

## Dashboard

Local browser dashboard for viewing stack state.

```bash
cd dashboard
npm install
npm run dev
```

Opens at `http://localhost:5173`. Reads Jira via the same credentials as the CLI.

`npm run dev` runs the API (port 3789) and Vite under `concurrently`. If an older
server still holds 3789 — a previous run that outlived its terminal — the new API
exits on `EADDRINUSE` while Vite keeps serving and proxying to the stale one. Any
panel newer than that server then 404s. The server now says so on startup, and a
404 in the on-demand panels reports it as a stale server rather than a missing
route. To clear it:

```bash
lsof -nP -iTCP:3789 -sTCP:LISTEN
kill <pid>
```

Note that `npm run dev:api` uses `node --watch`, which does not retry the bind —
once its child has died on a port conflict, restart the command.

The dashboard renders the same inference the CLI runs, rather than mirroring
Jira labels:

| Panel | Source | Answers |
|---|---|---|
| **Stalled** | `lib/stagnation.js` | which tickets have stopped moving — an in-flight label with no activity for 12h, a failure untouched for 3d, a PR rotting or left behind by its base |
| **Next actions** | `lib/classify-actions.js` | what each ticket needs next, bucketed as needs-you / awaiting-review / ready-to-run / in-flight / blocked / indeterminate |
| **Available to start** | `lib/queue.js` | what could I pick up that isn't on the board — the board queries `ClaudeWork`, so `ClaudeReady` work never tagged into a stack is otherwise invisible |
| **Activity** | per-ticket activity logs | what did the agents do overnight, as one chronological stream across every ticket |
| **Worktrees** | `git worktree list` | which worktrees are left on disk with no active ticket claiming them |
| **Check Drift** (per ticket) | `lib/drift-check.js` | has the code moved under this ticket's research baseline |

The always-on panels are fed by batched probes (`lib/dashboard-signals.js`): one
`gh pr list` per repo rather than a Jira round-trip per ticket, with the
expensive per-ticket git calls gated to tickets that could actually trigger a
rule. Polling pauses while the tab is hidden.

Three things never ride the 10s refresh, because each costs real work per ticket
or per citation: **Check Drift** (git ops per citation), **Available to start**
(three Jira searches plus one per `ClaudeReady` parent), and **Activity** (one
Jira read per ticket, so it only loads when you open it).

The view-model assembly (`lib/dashboard-view.js`) is pure and unit-tested, as are
the action, backlog, hygiene, and timeline folds — so the rules can be verified
without Jira, gh, or a browser.

### Running commands from the dashboard

Every ticket shows the slash command that clears its next action, as
copy-to-clipboard. The dashboard can also *run* the mechanical ones
(`/cleanup-main`, `/cleanup-feature`, `/promote-to-main`) as headless
`claude -p` jobs, with a log panel for their output.

That is **off by default** and enabled with `DASHBOARD_ALLOW_ACTIONS=true`. It's
an env var rather than a UI toggle deliberately: these commands delete remote
branches and transition Jira, a headless run passes `--yes` with nobody
reviewing the plan, and a toggle in a browser tab is too easy to leave on. Each
run also re-derives the ticket's classification server-side before spawning, so a
button clicked against a stale render is rejected rather than replayed.

## Development

```bash
cd cli
npm install
npm test           # vitest
npm run lint       # biome check .
npm run lint:fix   # biome check --write .
```

CI enforces 90% branch coverage.

Command and agent bodies (`ai/commands/*.md`, `ai/agents/*.md`) are plain markdown with YAML frontmatter — edits take effect on next Claude Code session invocation via the symlinks.

## Configuration reference

| Variable | Location | Required | Description |
|---|---|---|---|
| `JIRA_EMAIL` | `.env` | Yes | Atlassian account email |
| `JIRA_API_TOKEN` | `.env` | Yes | API token (id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_DOMAIN` | `.env` | Yes | e.g. `your-org.atlassian.net` |
| `DEV_ROOT` | `~/.claude/.env` | Yes | Parent directory containing all repo clones |
| `SLACK_WEBHOOK_URL` | `~/.claude/.env` | No | Webhook for notifications |

Env files are loaded without overriding existing env vars: project `.env` first, then `~/.claude/.env`.

Tickets need a `repo:<name>` label that maps to `$DEV_ROOT/<name>`.
