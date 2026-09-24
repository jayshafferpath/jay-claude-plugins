---
description: "Load an entire stack into context as one unit — a /build-sliced branch (whole ledger + whole diff) or a /ticket-work Epic/Story stack (every member ticket + the whole feature branch's diff) — then hand off for free-form conversation. Auto-detects which kind of stack it's looking at. Unlike /review-slices or /pr-chat, this never scopes down to a single slice, commit, or ticket: the aggregate diff and history are the primary artifact for the rest of the session."
argument-hint: "[ticket-key | container-key | branch-name] — omit to infer from the current branch"
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__getJiraIssueRemoteIssueLinks
  - mcp__atlassian__getConfluencePage
  - Bash(git *)
  - Bash(gh *)
  - Bash(resolve-stack *)
  - Bash(read-ledger *)
  - Bash(pr-state *)
  - Read
  - Glob
  - Grep
---

# Stack Chat

Load a whole stack into context — every commit, every ticket, the full aggregate diff — then hand control back to the user for free-form discussion. Use this when you want to reason about a feature as a single unit: "what does this whole thing do", "does the diff hang together", "draft the PR description for the whole stack", "is this ready to ship" — without manually stitching together `read-ledger` output or walking every ticket in a `resolve-stack` result yourself.

This is the opposite lens from `/review-slices` (scopes to changed slices) and `/pr-chat` (scopes to one ticket's PR). **For the rest of this session, the stack is one unit** — reason about the aggregate diff and full history, not about individual commits, slices, or tickets, unless the user explicitly asks to narrow scope.

This command **does not** plan, edit, or push. It loads context and prints a summary. The conversation continues normally afterward.

## Arguments

`$ARGUMENTS`

Optional: a Jira ticket key, a Jira container (Epic/Story) key, or a branch name.

If omitted, infer from the current branch: `git rev-parse --abbrev-ref HEAD` → `ARG`.

---

## Step 0: Detect Stack Kind

Bind `ARG` from `$ARGUMENTS`, or the current branch if empty.

Try each of the following in order. **First match wins.**

### 0a: Sliced-build branch

Resolve `CANDIDATE_BRANCH`:
- If `ARG` matches a Jira-shaped key (`[A-Z]+-\d+`), the sliced-build branch derived from it is that key lowercased (per `/build-sliced` Step 0). Check whether that branch exists locally or as `origin/{name}`. If so, `CANDIDATE_BRANCH` = that name.
- Otherwise `CANDIDATE_BRANCH = ARG`.

Run `git config branch.{CANDIDATE_BRANCH}.slicedSpec`. If it returns a value:

- **Mode = SLICED.**
- `BRANCH = CANDIDATE_BRANCH`.
- `BASE = git config branch.{BRANCH}.base` (default `main` if unset).
- `SPEC_REF` = the `slicedSpec` value.

Go to Step 1a.

### 0b: Jira ticket stack

Else, if `ARG` is Jira-shaped, run `resolve-stack {ARG} --repo-root {REPO_ROOT} --fetch`. If it resolves (does not error):

- **Mode = TICKET-STACK.**
- Bind per the Stack Context Resolution sub-procedure (`commands/_shared-stack-procedures.md`): `CONTAINER_KEY`, `CONTAINER_TYPE`, `CONTAINER_SUMMARY`, `FEATURE_BRANCH`, `CONTAINER_BASE`, `STACK_ORDER`.
- If `container` came back `null` (standalone ticket, no Epic/Story), still proceed — `FEATURE_BRANCH` = that ticket's own branch (from `stack[0]`), `CONTAINER_BASE` = its base branch. Note in the summary that this is a single-ticket "stack of one," not a container.

Go to Step 1b.

### 0c: Fallback — plain branch

Else, treat `ARG` as a bare branch name:

- **Mode = PLAIN.**
- `BRANCH = ARG`. If it doesn't exist locally or as `origin/{ARG}`, bail:
  ```
  /stack-chat could not resolve "{ARG}" as a sliced-build branch, a Jira ticket/container, or a git branch.
  Pass one of: a Jira ticket key, an Epic/Story key, or a branch name.
  ```
  Stop.
- `BASE = origin/main`.

Note the fallback prominently in the final summary — there's no lifecycle metadata backing this mode.

Go to Step 1c.

---

## Step 1a: SLICED mode — load the whole ledger + diff

1. `read-ledger --base {BASE} --head {BRANCH} --drift`.
   - Hold `slices[]` (id, subject, dependsOn, kind, depth, touched) as **structural metadata for narrative context only** — not a scoping mechanism. This command's job is to stop reasoning slice-by-slice.
   - If `ok` is false, report `violations` verbatim in the summary but **do not stop** — a chat-context loader tolerates a ledger the build/review commands would refuse.
   - If `drift.advanced` is true, note it in the summary (informational — this command doesn't rebase anything).
2. Resolve `SPEC_REF` the same way `/build-sliced` Step 1a does:
   - Jira key → `mcp__atlassian__getJiraIssue` with `fields=*all`.
   - `docs/tdds/{slug}.md` path → `Read` it (following `mode: consumer` frontmatter to the canonical body via `gh api` if present, same as `/pr-chat` Step 3a).
   - `.plans/ears-*.md` path → `Read` it.
3. If `.plans/review-{BRANCH}.md` exists, `Read` it in full — prior slice-tagged review findings (`commands/_sliced-format.md`).
4. Run, in parallel:
   - `git log {BASE}..{BRANCH} --pretty=format:"%h %s%n%b%n---"`
   - `git diff {BASE}...{BRANCH}` — full unified diff, the primary artifact.
   - `git diff {BASE}...{BRANCH} --name-only` → `CHANGED_FILES`.
5. `pr-state {BRANCH} --base {BASE} --cwd {REPO_ROOT}`. If a PR exists, `gh pr view {PR_NUMBER} --json body,reviews,comments,reviewRequests,statusCheckRollup,additions,deletions,changedFiles`.
6. For every path in `CHANGED_FILES`, `Read` it in full from `{REPO_ROOT}/{path}` (skip pure deletions, follow renames to the new path). Note unreadable/binary files in `SKIPPED_FILES`.

Go to Step 2.

---

## Step 1b: TICKET-STACK mode — load the whole feature branch

1. If `CONTAINER_KEY` is set, load it in full via `mcp__atlassian__getJiraIssue` (`fields=*all`): description/AC, status, labels, and every comment (activity log, checklist, human review notes) — same depth as `/pr-chat` Step 2.
2. For every entry in `STACK_ORDER`, load a **lighter** record via `mcp__atlassian__getJiraIssue` (`fields=summary,description,status,labels`) — title, AC, status only. Do not load per-ticket comment threads; the container's activity/checklist comments already narrate cross-ticket history, and loading every member's full comment log doesn't pay for itself at whole-stack altitude.
3. Load the TDD cited by the container ticket (or by `stack[0]`'s ticket if standalone) using the same two-path lookup as `/pr-chat` Step 3 (repo-based, including consumer-mode canonical body; or Confluence via description/comments/remote-links).
4. The aggregate diff is the **whole `FEATURE_BRANCH` vs `CONTAINER_BASE`** — not any member ticket's individual PR diff. Run, in parallel:
   - `git log {CONTAINER_BASE}..{FEATURE_BRANCH} --pretty=format:"%h %s%n%b%n---"`
   - `git diff {CONTAINER_BASE}...{FEATURE_BRANCH}` — full unified diff.
   - `git diff {CONTAINER_BASE}...{FEATURE_BRANCH} --name-only` → `CHANGED_FILES`.
5. For every path in `CHANGED_FILES`, `Read` it in full from `{REPO_ROOT}/{path}` (same rules as 1a). Note unreadable/binary files in `SKIPPED_FILES`.
6. Hold `STACK_ORDER` (branch, prTarget, mergedIntoMain, mergedIntoFeature per entry) as reference for "which ticket introduced what" — not as the primary lens.

Go to Step 2.

---

## Step 1c: PLAIN mode — minimal fallback load

1. `git log {BASE}..{BRANCH} --pretty=format:"%h %s%n%b%n---"`, `git diff {BASE}...{BRANCH}`, `git diff {BASE}...{BRANCH} --name-only` → `CHANGED_FILES`.
2. `pr-state {BRANCH} --base {BASE} --cwd {REPO_ROOT}` best-effort; load `gh pr view` details if one exists.
3. `Read` every path in `CHANGED_FILES` in full (same rules as 1a).

No ledger, no Jira ticket, no TDD lookup — this path exists to degrade gracefully, not to duplicate full lifecycle loading for an unmanaged branch.

Go to Step 2.

---

## Step 2: Print Context Summary and Hand Off

Print a compact summary shaped to the detected mode, e.g.:

```
Stack Chat ready — mode: {SLICED | TICKET-STACK | PLAIN}

  Branch:        {BRANCH or FEATURE_BRANCH} → {BASE or CONTAINER_BASE}
  PR:            #{PR_NUMBER} {PR_STATE}  {PR_URL}     (or "no PR open yet")
  Diff:          +{additions} -{deletions} across {N} files

  [SLICED]       Ledger: {N} slices ({violations summary, or "clean"})
                 Spec:   {SPEC_REF}
                 Review: {.plans/review-{BRANCH}.md loaded | "none found"}

  [TICKET-STACK] Container: {CONTAINER_KEY}: {CONTAINER_SUMMARY} (or "standalone")
                 Members:   {N} tickets loaded — {list of keys}
                 TDD:       {docs/tdds/{slug}.md | Confluence page title | "no TDD cited"}

  [PLAIN]        No lifecycle metadata found — loaded as a bare branch diff.

  Files loaded:  {N} full files
  Skipped:       {SKIPPED_FILES, or "none"}

For the rest of this session, treat {BRANCH or FEATURE_BRANCH} as one unit — the
aggregate diff and full history above, not any single commit, slice, or ticket
within it — unless you ask me to narrow scope.

Ready. Ask anything. Suggestions:
  - "Walk me through what this feature does end to end."
  - "Does the diff hang together as one coherent change?"
  - "Draft the PR description for the whole stack."
  - "What's risky across the whole thing?"
```

Then **stop**. Do not begin a walkthrough or analysis until the user asks for one.

---

## Notes

- This command is **read-only**. It must not modify git state, Jira state, or any file.
- The context loaded here is large by design, and scales with stack size — for a long-running Epic this can be substantial. If the user immediately follows with another large operation, warn them they may be near context limits.
- Re-running `/stack-chat` reloads from scratch — useful after new slices/commits land or a ticket in the stack changes state.
- If the stack spans multiple tickets that are only partially merged (some `mergedIntoFeature`, some not), the loaded diff still reflects `{FEATURE_BRANCH}`'s current tip — note in the summary which `STACK_ORDER` entries are and aren't merged in yet, so the user knows the diff isn't necessarily "the finished feature."
