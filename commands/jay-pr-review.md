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

- `git diff <BASE>...HEAD --numstat`
- `git log <BASE>..HEAD --oneline`
- `gh pr view --json number,title,body` (tolerate failure)

`--numstat` yields the changed-file list and the per-file counts in one call — don't
also run `--stat` or `--name-only`.

## Step 3: Fan out review agents (single message, parallel)

Pass each agent `BASE`, the range `<BASE>...HEAD`, and the file list. Pass file paths,
never file contents — the agents read what they need.

- `diff-critic` — always. Correctness defects, contract changes, test gaps.
- `diff-security` — unless the diff is **security-inert**: no changed file touches
  auth, input handling, persistence, logging, secrets, crypto, IaC, or shells out,
  and no dependency was added. When skipped, note it in the plan's Notes.

Prefix every agent prompt with:

> Only flag issues introduced or worsened by this branch. Do not report pre-existing
> issues in unchanged code. Project-local conventions in the surrounding files win over
> any general guide. Return `[]` rather than inventing findings.

Both agents are read-only and return a JSON array of
`{severity, file, line, summary, fix}`. Merge the arrays; when both report the same
`file:line`, keep the higher severity and one summary.

## Step 4: PR reviewer comments (skip if no PR)

- `gh pr view --json number -q .number` → `PR_NUM`; skip this step if it fails
- `gh api repos/{owner}/{repo}/pulls/<PR_NUM>/comments --paginate`

Capture author, `file:line`, body, and bot flag (`user.login` ends in `[bot]`). Do not
classify bot comments — that's `/cop-fight`'s job.

## Step 5: Write the plan

Follow the structure in `commands/_pr-review-format.md`. Every actionable item must be a `- [ ]`
checkbox so `post-review-summary` and `pr-execute-plan` can parse it.

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
