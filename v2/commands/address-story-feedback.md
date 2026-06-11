---
description: "v2 — apply reviewer feedback on a story PR (story branch → feature branch). Reads PR comments, makes the fix on the story branch with Story:+Slice: trailers, fast-forwards each new commit to the slice branch, re-runs drift-gate, pushes. Single pass. Use when the story PR is in review and the reviewer leaves comments before merge."
allowed-tools:
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(gh *)
  - Bash(ls *)
  - Read
  - Write
  - Edit
  - AskUserQuestion
---

# Address Story Feedback (v2)

Apply reviewer feedback on a **story PR** (story branch → feature branch). Sibling to `/address-feedback`, which handles **slice PRs** (slice branch → main). The two skills exist because the lifecycle phases have different invariants:

| | `/address-story-feedback` (this skill) | `/address-feedback` |
|---|---|---|
| PR base | feature branch | main |
| Lifecycle phase | story is open, not yet merged | slice PR is open after Phase 3 |
| Trailer requirement | every commit needs `Story:` + `Slice:` | none — branch identity is the slice |
| Fast-forward to slice branch | yes — every new commit | n/a |
| Drift-gate re-run | yes | no |

If you invoke this on a slice PR by accident, it refuses and points at `/address-feedback`.

## Arguments

`$ARGUMENTS` — required: a story PR URL or PR number.

## What it does

1. **Read the PR.** `gh pr view <PR>` and `gh api .../pulls/<N>/comments` to gather:
   - PR base branch. If it's `main` (or any branch matching `slice/*`), refuse: "This is a slice PR — use `/address-feedback` instead."
   - The story key (extracted from the description / branch name).
   - The epic key (from the story's parent in Jira).
   - All review and inline comments.
   - Current `HEAD` of the PR branch.
2. **Resolve context.**
   - Fetch the story via `getJiraIssue`. Confirm `V2StoryNeedsReview` label is present (or warn if not — the story is in an unexpected state).
   - Determine story type (behavior vs verification) from the `V2Verification` label.
   - Resolve the slice graph from Jira (children of the epic with `V2Slice`, "is blocked by" links).
   - Identify the **most recently used slice on this story** by reading the `Slice:` trailer of the story branch's HEAD commit. That's the default slice for new commits unless the comment clearly targets a different one.
3. **Identify unresolved feedback** — comments not already addressed (no resolution thread, no follow-up commit referencing them).
4. **Per comment** (or grouped if related):
   - Check out the story branch.
   - Read the affected files at the comment's line range.
   - Determine the slice for the change:
     - If the change touches only files already covered by an existing slice (matched by tracing the original `Slice:` trailers on those files' commits), use that slice.
     - If it spans multiple slices, split the fix into per-slice commits.
     - If it requires a new slice (rare; reviewer asked for a structural change), halt with `needs_human` and ask.
   - Make the change. Ambiguous → `AskUserQuestion` rather than guessing.
   - Stage and commit on the story branch with trailers:
     ```
     <subject>

     Address review: <brief comment ref>

     Story: <STORY_KEY>
     Slice: <SLICE_KEY>
     ```
   - **Fast-forward to the slice branch**: cherry-pick onto `slice/<EPIC_KEY>/<slice-name>`, strip both `Story:` and `Slice:` trailers from the cherry-picked copy. (Same mechanic as story-worker S4.)
   - On cherry-pick conflict → halt with `needs_human`. Surface the conflicting hunk and the slice that owns it.
5. **Re-run drift-gate** — `/drift-gate <STORY_KEY>`. Same checks story-worker uses. On any failure → halt, surface output. Don't push broken code.
6. **Push** the story branch: `git push origin <STORY_KEY>`. (Slice branches were already updated by the fast-forwards in step 4 but are not pushed here — they're pushed at finalize. If you want the slice branch on origin pre-finalize for visibility, that's a manual `git push`.)
7. **Link back:** reply to each addressed PR comment via `gh api` linking the new commit SHA. Append an activity comment on the story noting the feedback round.
8. **Return.** Done.

## Failure modes

- **Tests / drift-gate fail** → halt, surface output. User picks up manually.
- **Cherry-pick conflict** → halt; surface conflicting hunk + owning slice. Recovery: `/v2-rework <STORY>` if extensive, or manual fix + re-run.
- **Comment is ambiguous** → `AskUserQuestion` with the comment text.
- **Comment requires a new slice** → halt; the right answer may be to revise the slice graph by hand or `/v2-rework` the story. This skill won't speculate.
- **PR branch force-pushed since the comment** → halt; comment may no longer apply.
- **PR base is main** (slice PR) → refuse with the redirect to `/address-feedback`.

## What this skill does *not* do

- It does not merge the story PR — that's the human's job (per-story merge gate).
- It does not modify the slice graph — graph changes belong to story-worker, `/v2-rework`, or manual Jira edits.
- It does not loop. Single pass per invocation. Run again for the next round of comments.
