---
description: "Load full PR context for conversational review: Jira ticket (description, AC, comments, Implementation Notes), linked TDD (Confluence or repo-based), PR metadata, commits, diff, and full contents of every changed file. After loading, the user chats with Claude directly — Claude has complete ticket + TDD + code context to answer questions, challenge decisions, draft PR copy, and reason about reviewer feedback."
allowed-tools:
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__getJiraIssueRemoteIssueLinks
  - mcp__atlassian__getConfluencePage
  - Bash(git *)
  - Bash(gh *)
  - Bash(resolve-stack *)
  - Bash(pr-state *)
  - Read
  - Glob
  - Grep
---

# PR Chat

Load complete context for a ticket's PR into the conversation, then hand control back to the user for free-form discussion. Use this when you want to talk through a PR — pre-review self-check, walking a reviewer through changes, drafting PR description copy, or reasoning about review comments — with Claude holding the full ticket + TDD + code picture in working memory.

This command **does not** plan, edit, or push. It loads context and prints a summary. The conversation continues normally afterward.

## Arguments

`$ARGUMENTS`

Optional: a single Jira ticket key (e.g., `PROJ-123`).

If omitted, infer the ticket from the current branch:
1. `git rev-parse --abbrev-ref HEAD` to get `BRANCH_NAME`.
2. Extract a Jira-shaped key (`[A-Z]+-\d+`) from `BRANCH_NAME`. If multiple match, take the last one (closest to the leaf scope).
3. If no key can be extracted, print:
   ```
   /pr-chat could not infer a ticket key from branch "{BRANCH_NAME}".
   Pass one explicitly: /pr-chat PROJ-123
   ```
   Stop.

If `$ARGUMENTS` is set but is not a single Jira-shaped key, bail with:
```
/pr-chat takes exactly one ticket key. Got: "{$ARGUMENTS}"
```

---

## Step 1: Resolve Cloud + Stack Context

Use `mcp__atlassian__getAccessibleAtlassianResources` to bind `CLOUD_ID`.

Run `resolve-stack {TICKET_KEY} --repo-root {REPO_ROOT} --fetch` to bind:
- `BRANCH_NAME` (the ticket's working branch)
- `BASE_BRANCH` (the branch this PR targets — feature branch for stacked tickets, `main` otherwise)
- `CONTAINER_KEY`, `FEATURE_BRANCH` (if part of a Story/Epic stack)
- `SUMMARY` (ticket title)

If `resolve-stack` fails (ticket not found, not yet under lifecycle management, etc.), fall back to:
- `BRANCH_NAME = current branch`
- `BASE_BRANCH = origin/main`

Surface the fallback in the final summary.

---

## Step 2: Load Jira Ticket

Use `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`, and `fields=*all` to pull:

- Description (Gherkin acceptance criteria, scope, links)
- Status, labels, assignee
- Comments — every comment, in order. Pay attention to:
  - The activity log comment (marker `[claude-activity-log]`) — narrative history of what's happened on this ticket.
  - The checklist comment (marker `[claude-checklist]`) — current lifecycle progress.
  - Any human-authored review notes or design discussion.
- The `h2. Implementation Notes` block in the description, if present — contains sha-pinned permalinks to code the planner identified as load-bearing.

Hold this in working context. Do not summarize it back to the user yet.

---

## Step 3: Load TDD

A ticket can cite a TDD in two ways. Try both and load whichever exists.

### 3a: Repo-based TDD (`docs/tdds/{slug}.md`)

Scan the ticket description and Implementation Notes for references to `docs/tdds/...md` paths. For each match:
- If the path exists relative to `{REPO_ROOT}`, `Read` it in full.
- If the file's frontmatter has `mode: consumer`, follow `owner_repo` + `owner_path` + `owner_sha` and pull the canonical body via `gh api repos/{owner_repo}/contents/{owner_path}?ref={owner_sha}` (decoded from base64). Hold both the consumer pointer and the canonical body.
- Also `Read` any sidecar research files under `{REPO_ROOT}/docs/tdds/{slug}/*.research.md`.

### 3b: Confluence TDD

Look for Confluence URLs in two places:
1. The ticket description and comments (regex: `https://[^/]+\.atlassian\.net/wiki/[^\s)]+`).
2. Remote issue links: `mcp__atlassian__getJiraIssueRemoteIssueLinks` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`. Collect any link whose URL matches Confluence.

For each unique Confluence page URL, extract the page ID (the numeric segment after `/pages/`) and call `mcp__atlassian__getConfluencePage` with `cloudId={CLOUD_ID}` and `pageId={PAGE_ID}`. Hold the body.

If the TDD page links to child pages or sibling design docs and they look directly relevant (referenced explicitly by the ticket), fetch those too. Do **not** crawl the whole space.

### 3c: No TDD found

If neither path produces a TDD, note it and continue. Don't fail.

---

## Step 4: Load PR Metadata

Run `pr-state {BRANCH_NAME} --base {BASE_BRANCH} --cwd {REPO_ROOT}`.

If output is `null`, no PR exists yet. Note "No PR open" and continue with branch state only.

If a PR exists, bind `PR_NUMBER`, `PR_URL`, `PR_TITLE`, `PR_STATE`. Then:

- `gh pr view {PR_NUMBER} --json body,reviews,comments,reviewRequests,statusCheckRollup,additions,deletions,changedFiles` — full PR body, review threads, CI status.

Hold all of it. Don't echo the PR body back yet.

---

## Step 5: Load Commits + Diff

Run, in parallel:
- `git log {BASE_BRANCH}..{BRANCH_NAME} --pretty=format:"%h %s%n%b%n---"` — commit messages with bodies.
- `git diff {BASE_BRANCH}...{BRANCH_NAME}` — full unified diff.
- `git diff {BASE_BRANCH}...{BRANCH_NAME} --name-only` — list of changed files.

Bind `CHANGED_FILES` from the third call. Note `additions` / `deletions` / file count for the summary.

---

## Step 6: Load Full File Contents

For every path in `CHANGED_FILES`:
- If the file still exists on `{BRANCH_NAME}` (not a pure deletion), `Read` it in full from `{REPO_ROOT}/{path}`.
- For pure deletions, the diff already shows the removed content — don't try to read.
- For renames, read the new path.

Read all of them. Do not truncate, sample, or skip large files unless `Read` itself errors. The user explicitly opted into full-file loading for this command.

If a file is binary or `Read` rejects it (image, lockfile too large, etc.), note it in a `skipped_files` list to surface in the summary.

---

## Step 7: Print Context Summary and Hand Off

Print a compact summary so the user knows what's loaded:

```
PR Chat ready — {TICKET_KEY}: {SUMMARY}

  Branch:        {BRANCH_NAME} → {BASE_BRANCH}
  PR:            #{PR_NUMBER} {PR_STATE}  {PR_URL}     (or "no PR open yet")
  Diff:          +{additions} -{deletions} across {changedFiles} files
  Jira:          description + {N} comments loaded (incl. activity log, checklist)
  TDD:           {one of: "docs/tdds/{slug}.md (+ N sidecars)" |
                          "Confluence: {page title} ({url})" |
                          "no TDD cited"}
  Files loaded:  {N} full files
  Skipped:       {list of skipped binaries/large files, or "none"}

Stack:
  Container:     {CONTAINER_KEY or "standalone"}
  Feature branch: {FEATURE_BRANCH or "n/a"}

Ready. Ask anything — I have the ticket, TDD, PR, commits, diff, and full file contents loaded.
Suggestions:
  - "Walk me through the changes file by file."
  - "Does this satisfy AC scenario {N}?"
  - "Reviewer asked: {paste comment} — how should I respond?"
  - "Draft the PR description."
  - "What's risky here?"
```

Then **stop**. Do not begin a walkthrough or analysis until the user asks for one — they may want to lead the conversation themselves.

---

## Notes

- This command is **read-only**. It must not modify git state, Jira state, or any file. If a future iteration adds writes, gate them behind explicit confirmation.
- The context loaded here is large by design. If the user runs `/pr-chat` and immediately follows with another large operation, warn them they may be near context limits.
- Re-running `/pr-chat` for the same ticket reloads from scratch — useful after pushing new commits or after a reviewer adds comments.
