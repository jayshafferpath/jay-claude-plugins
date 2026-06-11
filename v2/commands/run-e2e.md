---
description: "v2 — re-run an epic's verification stories' integration/e2e tests against the current branch. Useful for ad-hoc validation after slice merges or feature-branch rebases. Non-gating; reports only."
allowed-tools:
  - mcp__atlassian__getJiraIssue
  - mcp__atlassian__searchJiraIssuesUsingJql
  - mcp__atlassian__addCommentToJiraIssue
  - Bash(git *)
  - Bash(append-activity *)
  - Read
  - AskUserQuestion
---

# Run E2E (v2)

Re-run the integration/e2e tests defined by an epic's **verification stories** against whichever branch the user is currently on. **Not gating** — does not change Jira labels, does not halt any pipeline.

## Arguments

`$ARGUMENTS` — required: `<EPIC_KEY>`. Current branch is whatever the user has checked out — `/run-e2e` does not switch branches.

Common targets: feature branch, slice branch, main.

## What it does

1. **Resolve verification stories** — query Jira for children of `<EPIC_KEY>` with `V2Verification`.
2. **Halt if none found.** Surface: "EPIC-<KEY> has no verification stories. v2 epics are required to have at least one — check Phase 1 output."
3. **Detect the test command.** Use the **Test Command Detection** section in `drift-gate.md` with story type = verification. Detection is per-run (project files only, not Jira-stored), so the same command runs as in drift-gate. If multiple matches and no remembered answer for the session, ask once.
4. **Run the command.** Stream output to terminal — don't capture and replay; e2e runs are long.
5. **Report:** branch under test, command, exit code. On pass: short summary. On fail: failing test names + relevant log excerpts.
6. **Append activity comment on the epic:**
   ```bash
   append-activity <EPIC_KEY> --heading "Ad-hoc /run-e2e" --body "Branch: <BRANCH>
   Command: <COMMAND>
   Result: pass | fail (<n> failures)"
   ```

## Failure modes

- **No verification stories** → halt with the explanation above.
- **No e2e command detected** → halt; surface the project files inspected and ask the user how to run integration tests.
- **Multiple e2e commands detected** → ask which to run; remember within the session only.
- **Test exits non-zero** → report verbatim, exit non-zero so chained invocations notice.

## When to use

- After a slice PR merges, before merging the next: `git checkout slice/<EPIC>/<next> && /run-e2e <EPIC>` to confirm the rebased downstream still passes.
- After resolving an `/address-feedback` change: re-run to confirm integration coverage holds.
- Periodically against the feature branch during long-lived epics, to catch drift between feature branch and main.
