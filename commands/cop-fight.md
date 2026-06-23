---
description: "Fight Copilot review comments with judgement: drive CI to green, then evaluate each Copilot comment on viability and value before deciding whether to implement or dismiss with an explanation. Replaces blind auto-fix loops."
allowed-tools:
  - Bash(git *)
  - Bash(cd *)
  - Bash(gh *)
  - Bash(jq *)
  - Bash(npx *)
  - Bash(npm *)
  - Bash(pnpm *)
  - Bash(yarn *)
  - Bash(make *)
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - mcp__github__add_reply_to_pull_request_comment
---

# Cop Fight

Drive a PR to a clean review state with judgement, not capitulation.

Two phases per round:
1. **CI phase** — wait for GitHub Actions; fix fixable categories (lint, format, type errors, shellcheck) and push.
2. **Copilot phase** — fetch unresolved Copilot comments. For each one, judge whether the suggestion is *correct* and *worth applying*. Implement the sound ones. **Dismiss the rest with a reply explaining why** — do not silently ignore them.

Loops until CI is green AND no unresolved Copilot comments remain (or `--rounds` is hit).

## Arguments

$ARGUMENTS

| Flag | Default | Meaning |
| --- | --- | --- |
| `--rounds N` | 5 | Max CI+Copilot cycles |
| `--interval N` | 30 | Seconds between Copilot polls |
| `--ci-only` | off | Run only the CI phase, skip Copilot |
| `--copilot-only` | off | Run only the Copilot phase, skip CI |
| `--strict` | off | Be more conservative — dismiss anything with non-trivial uncertainty |

## Step 1: Detect PR Context

```bash
gh pr view --json number,headRefName,headRefOid,baseRefName,url,headRepository,headRepositoryOwner
```

Parse: `PR_NUMBER`, `BRANCH`, `HEAD_SHA`, `BASE`, `PR_URL`, `OWNER` (`headRepositoryOwner.login`), `REPO` (`headRepository.name`).

If no PR exists for the current branch, stop and tell the user to open one first (e.g. `gh pr create --draft --fill`).

## Step 2: Initialize State

- `ROUND = 0`
- `ADDRESSED = {}` — map of Copilot comment ID → action taken (`"implemented"`, `"dismissed:<reason>"`, `"asked-user"`). Persists across rounds so we never re-judge the same comment.
- `CI_GREEN = false`
- `COPILOT_CLEAN = false`

## Step 3: Main Loop

While `ROUND < MAX_ROUNDS` and not (`CI_GREEN` and `COPILOT_CLEAN`):

### 3a: CI Phase (skip if `--copilot-only`)

Wait for the latest run on `HEAD_SHA`:

```bash
gh run list --branch {BRANCH} --commit {HEAD_SHA} --json databaseId,status,conclusion,name,workflowName --limit 20
```

Poll every `{POLL_INTERVAL}` seconds until every run has `status == "completed"` (timeout: 30 minutes — if hit, ask the user whether to keep waiting).

If every run's `conclusion == "success"`: set `CI_GREEN = true` and continue to 3b.

For each failing run, pull its failed job logs:

```bash
gh run view {RUN_ID} --log-failed
```

Classify each failure:

| Category | Fixable? | How |
| --- | --- | --- |
| markdownlint / prettier / biome / eslint formatting | Yes | Run the project's fix script (`npm run lint -- --fix`, `pnpm format`, `biome check --write`, etc.) |
| ESLint rule violations (non-formatting) | Sometimes | Read the rule, judge whether the rule is right; fix if sound, else add an inline `eslint-disable-next-line` *only if* the rule is genuinely wrong for this case |
| TypeScript `tsc` errors | Sometimes | Read each error; fix structurally. Never use `// @ts-ignore` or `any` to silence. If a fix would require a real refactor, surface it to the user instead. |
| shellcheck | Yes | Apply suggested fix unless it would change behavior |
| Test failures | No | Stop. Tests are the user's signal — surface the failure list and ask how to proceed. |
| Build / compile errors unrelated to types | No | Stop. Surface to the user. |
| Flaky / infrastructure failures | No | Re-trigger the workflow once with `gh run rerun {RUN_ID} --failed`. If still failing, surface to user. |

After applying fixes:

```bash
git add <changed files>
git commit -m "fix(ci): {short summary of categories addressed}"
git push origin {BRANCH}
HEAD_SHA=$(git rev-parse HEAD)
```

Set `CI_GREEN = false` (next loop will re-poll the new SHA).

If nothing in the failures was auto-fixable, **stop the command** and report the unfixed failures to the user. Do not advance to the Copilot phase with red CI.

### 3b: Copilot Phase (skip if `--ci-only`)

Only run when `CI_GREEN == true`. Re-requesting review before CI is green wastes Copilot's time and creates noise.

#### 3b-i: Request review (first round only) and wait

If this is the first round and Copilot hasn't reviewed `HEAD_SHA` yet, request a review:

```bash
gh pr edit {PR_NUMBER} --add-reviewer "copilot-pull-request-reviewer[bot]"
```

Then poll every `{POLL_INTERVAL}` seconds until a Copilot review on `HEAD_SHA` exists. Query:

```bash
gh api graphql -f query='
  query($owner:String!, $repo:String!, $pr:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        reviews(last:50) {
          nodes { author { login } commit { oid } state submittedAt }
        }
      }
    }
  }' -F owner={OWNER} -F repo={REPO} -F pr={PR_NUMBER}
```

Look for a review where `author.login` starts with `copilot` AND `commit.oid == HEAD_SHA`. If 10 minutes pass with no Copilot review, ask the user whether to keep waiting or move on.

#### 3b-ii: Fetch unresolved Copilot threads

```bash
gh api graphql -f query='
  query($owner:String!, $repo:String!, $pr:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        reviewThreads(first:100) {
          nodes {
            id
            isResolved
            isOutdated
            comments(first:10) {
              nodes {
                id
                databaseId
                author { login }
                body
                path
                line
                originalLine
                diffHunk
              }
            }
          }
        }
      }
    }
  }' -F owner={OWNER} -F repo={REPO} -F pr={PR_NUMBER}
```

Filter to threads where:
- `isResolved == false` AND
- `isOutdated == false` AND
- the first comment's author login matches Copilot AND
- the comment's `databaseId` is not in `ADDRESSED`.

Call this list `NEW_COMMENTS`. If empty, set `COPILOT_CLEAN = true` and exit the loop.

#### 3b-iii: Judge each comment

This is the core of the command. Do **not** auto-implement Copilot's suggestion. For each comment:

1. **Read the cited code.** Open `comment.path` around `comment.line`. Read enough surrounding context (≥20 lines) to understand the function, the invariants, and the call sites if relevant.

2. **Score on three axes** (each: yes / no / unsure):

   | Axis | Question |
   | --- | --- |
   | **Real** | Does the issue Copilot describes actually exist in the cited code? Or is it a hallucinated bug, a misread of the diff, or based on code that no longer exists? |
   | **Right** | Is Copilot's diagnosis technically correct? Would a human reviewer agree this is a problem worth raising? |
   | **Worth it** | Would applying the suggestion improve the code without regressing behavior, contradicting project conventions, or causing churn for marginal gain? |

3. **Decide the action:**

   | Pattern | Action |
   | --- | --- |
   | All three "yes" | **Implement** |
   | "Real" no | **Dismiss** — comment is based on a misread of the code. Reply: "Reviewed — the cited code does not have this issue ({1-line specific reason})." |
   | "Right" no (real issue, wrong diagnosis) | **Dismiss** — Copilot's reasoning is wrong. Reply: "{Specific counterargument citing the actual behavior or convention}." |
   | "Worth it" no (real issue, but suggestion is worse) | **Dismiss** — reply: "Acknowledged, but applying this would {regress X / contradict convention Y / churn for marginal gain}. Leaving as-is." |
   | Any axis "unsure" AND `--strict` not set | **Ask user** with `AskUserQuestion` — present comment body, the cited code, and your tentative read |
   | Any axis "unsure" AND `--strict` set | **Dismiss** — reply: "Unable to confirm this issue with confidence. Leaving for human review." |
   | Comment is a question, not a suggestion | **Ask user** — Copilot is requesting context |
   | Comment is a style nit that contradicts an obvious project convention | **Dismiss** — reply: "Project convention is {X}, see {file/pattern}." |

   **Be willing to disagree.** Copilot is wrong often enough that a command that always implements is a worse reviewer than a command that pushes back with reasoning. The bar for "implement" is: you'd defend the change in a code review.

4. **Record the decision** in `ADDRESSED[comment.databaseId]` with the action taken.

#### 3b-iv: Apply implementations

For comments marked **Implement**:
- Make the edit using Edit
- Stage only the files actually changed for this comment

After all Implement comments are applied:

```bash
git add <changed files>
git commit -m "fix: address Copilot review (round {ROUND+1})"
git push origin {BRANCH}
HEAD_SHA=$(git rev-parse HEAD)
```

Set `CI_GREEN = false` (push triggers a new CI run).

#### 3b-v: Reply to dismissed and asked-user threads

For each dismissed comment, post a reply to its thread using `mcp__github__add_reply_to_pull_request_comment` (or `gh api` POST to `/repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies` if the MCP tool is unavailable). The reply body is the rationale composed in 3b-iii.

For **Ask user** comments, present the comment body and the relevant code via `AskUserQuestion`. Apply the user's chosen action and post the reply they direct (or no reply if they chose to implement).

Reply rules:
- Keep replies to one or two sentences.
- Cite specifics — file paths, function names, conventions — not platitudes.
- Never reply with "thanks for the suggestion!" or other empty acknowledgement.

#### 3b-vi: Resolve all addressed threads

```bash
gh api graphql -f query='
  mutation($id:ID!) {
    resolveReviewThread(input:{threadId:$id}) { thread { isResolved } }
  }' -F id={THREAD_ID}
```

Run for every thread ID in `NEW_COMMENTS` (both implemented and dismissed). If any individual resolve fails, log it and continue.

### 3c: Loop

Increment `ROUND`. Loop back to 3a unless `CI_GREEN && COPILOT_CLEAN`.

## Step 4: Final Summary

```
=== Cop Fight Complete ===
Rounds: {ROUND}/{MAX_ROUNDS}
PR: {PR_URL}

CI: {green | red — {summary}}
Copilot: {clean | {N} comments unaddressed (max rounds hit)}

Comments judged: {total}
  - Implemented: {N}
  - Dismissed:   {N}
  - Asked user:  {N}
```

If max rounds were hit with comments still pending, list the remaining comment IDs with their file:line so the user can finish the fight by hand.

## Important Rules

- **Never force-push or amend.** Each round produces a new commit.
- **Never dismiss without a reply.** Silent dismissal is a reviewer-courtesy violation; the human reviewer needs to see Copilot's comment was considered.
- **Never implement a Copilot suggestion you can't defend.** "Copilot said so" is not a reason — if you can't articulate why the change is right, dismiss with that uncertainty noted.
- **Never silence a `tsc` error with `any` or `@ts-ignore`** to clear CI. Either fix structurally or stop and ask the user.
- **Do not modify code outside the comment's cited area** when implementing a fix. No drive-by refactors.
- **Do not advance to the Copilot phase with red CI.** Copilot's review is invalidated by every push, so spinning Copilot before CI is wasteful.
