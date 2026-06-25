---
description: Generate a focused PR review plan for the current branch by fanning out specialist review agents and aggregating their findings into a checklist file.
argument-hint: [base-branch]
allowed-tools: Read, Write, Grep, Glob, Agent, Bash(git:*), Bash(gh:*), Bash(mkdir:*), Bash(echo:*)
---

# PR Review

Generate a review plan for the current branch at `.plans/pr-review-<branch>.md`. Spawns review agents in parallel and aggregates findings into a checklist.

## Step 1: Resolve branch, base, plan path

- `BRANCH` = `git branch --show-current`
- `BASE` = `$ARGUMENTS` → else `git config branch.<BRANCH>.base` → else `gh pr view --json baseRefName -q .baseRefName` → else `main`
- `PLAN_FILE` = `.plans/pr-review-<BRANCH with / and _ → ->.md` (mkdir `.plans` if missing)

Overwrite `PLAN_FILE` if it exists.

## Step 2: Gather diff context (parallel)

- `git diff <BASE>...HEAD --stat`
- `git diff <BASE>...HEAD --name-only`
- `git log <BASE>..HEAD --oneline`
- `gh pr view --json number,title,body,reviews,comments` (tolerate failure)

## Step 3: Fan out review agents (single message, parallel)

Pass each agent the file list and diff range — let them read what they need.

**Always:**
- `quality:code-reviewer` — correctness bugs, error handling, dropped Promises, null cases. Skip style.
- `quality:security-auditor` — secrets, input validation, auth bypass, PII in logs, unsafe exec/SQL.

**Conditional:**
- `quality:architect-review` — if 3+ source files changed or any public API signature changed.
- `testing:test-automator` — if any source file changed without a matching test change.

Each agent returns findings as `{severity, file, line, summary, fix}` where severity ∈ `critical | high | medium | low`. No style nits. No invented findings — say "clean" if nothing.

## Step 4: PR reviewer comments (if PR exists)

- `PR_NUM` from `gh pr view`
- `owner/repo` from `gh repo view --json nameWithOwner -q .nameWithOwner`
- `gh api repos/<owner>/<repo>/pulls/<PR_NUM>/comments --paginate`
- `gh api repos/<owner>/<repo>/pulls/<PR_NUM>/reviews`

Capture author, file:line, body, bot flag (`user.login` ends in `[bot]`). Do not classify bot comments — that's `/cop-fight`'s job. Skip step if no PR.

## Step 5: Write the plan

```markdown
# PR Review Plan: <BRANCH>

- **Base**: <BASE>
- **Files changed**: <N> (<+>/<->)
- **PR**: <#NUM URL> or "Not yet opened"
- **Generated**: <YYYY-MM-DD>

## Summary
<2-3 sentences from commits + diff.>

## Findings
Group by severity. Omit empty sections.

### Critical
- [ ] `file.ts:42` — <summary>. Fix: <recommendation>. (source: <agent>)

### High / Medium / Low
- [ ] ...

## Reviewer Comments
- [ ] `file.ts:42` — @reviewer: "<body>". <Agree | Disagree | Needs decision> — <rationale>.
- [ ] `file.ts:42` — github-copilot[bot]: "<claim>". Needs review by /cop-fight.

If no PR: "No PR open — skipped."

## Missing Tests
- [ ] `file.ts` — no test file. Cover: <functions>.

If skipped: "Test coverage not analyzed."

## Notes
Open questions, architectural concerns needing a decision.
```

Every actionable item must be a `- [ ]` checkbox so `pr-execute-plan` can parse it.

## Step 6: Report

```
PR review plan written to <PLAN_FILE> — <N critical, M high, K reviewer comments>.
```

If zero critical/high and zero reviewer comments: append "Review is clean — safe to proceed."

## Guidelines

- One message, multiple Agent calls — parallel is the point.
- Pass file lists, not file contents.
- Don't invent severity.
- Filename must match `.plans/pr-review-<branch>.md` exactly.
