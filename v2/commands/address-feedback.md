---
description: "v2 — apply a slice PR's reviewer feedback. Agent reads the PR comments, makes the change on the slice branch, runs tests, pushes, links the change back to the comment. User reviews; cascade-rebase happens at merge time via /v2-cleanup."
allowed-tools:
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(gh *)
  - Bash(ls *)
  - Read
  - Write
  - Edit
  - AskUserQuestion
---

# Address Feedback (v2)

Address reviewer feedback on a **slice PR** (slice branch → main, opened during Phase 3). Single pass — agent attempts the fix, user reviews. If the reviewer leaves more comments, run again.

For feedback on a **story PR** (story branch → feature branch, before merge), use `/address-story-feedback` — that flow has different invariants (trailers, fast-forward to slice branch, re-run drift-gate). This skill refuses if invoked on a story PR.

The only invariant: **don't push broken code.**

## Arguments

`$ARGUMENTS` — required: a slice PR URL or PR number.

## What it does

1. **Read the PR** — `gh pr view <PR>` and `gh api .../pulls/<N>/comments` to gather:
   - PR base branch. If it's a feature branch (the head matches a story branch pattern, or the base matches `<EPIC_KEY>` exactly), refuse: "This is a story PR — use `/address-story-feedback` instead."
   - The slice ticket key (extracted from the description / branch name).
   - All review and inline comments.
   - Current `HEAD` of the PR branch.
2. **Identify unresolved feedback** — comments not already addressed (no resolution thread, no follow-up commit referencing them).
3. **Per comment** (or grouped if related):
   - Check out the slice branch.
   - Read the affected files at the comment's line range.
   - Make the change. Ambiguous → `AskUserQuestion` rather than guessing.
   - Run the project's test command. **Slice branches don't carry story-type identity** (trailers were stripped at fast-forward time), so default to the **behavior** path of the Test Command Detection rule in `drift-gate.md` — unit tests. If the slice ticket's title or any commit subject suggests this is the `epic-verification` slice, additionally run the verification path. Multiple matches → ask once per session.
   - On test failure → halt, surface output. Don't push broken code.
4. **Commit and push:**
   - Subject references the comment briefly (e.g., `Address review: return Result<T> from getUser`).
   - **No `Slice:` or `Story:` trailer** — branch identity is the slice now that we're past Phase 3.
   - `git push origin slice/<EPIC>/<slice-name>`.
5. **Link back:** reply to each addressed PR comment via `gh api` linking the new commit SHA. Comment on the slice ticket noting the feedback round.
6. **Return.** Done.

## Failure modes

- **Tests fail after the fix** → halt, surface output. User picks up manually.
- **Comment is ambiguous** → `AskUserQuestion` with the comment text.
- **PR branch force-pushed since the comment** → halt; comment may no longer apply.
- **Comment requires changes outside this slice's scope** → halt. The right answer may be a new slice or `/v2-rework` against an upstream slice; this skill won't speculate.
- **PR base is the feature branch** (story PR) → refuse with the redirect to `/address-story-feedback`.

This skill does not merge, does not cascade-rebase (`/v2-cleanup` does that post-merge), does not modify the slice graph or feature branch, and does not loop.
