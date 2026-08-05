# PR review plan format

Reference fragment, not a slash command. `install.sh` skips `_`-prefixed files so
this is never symlinked into `~/.claude/commands/`.

Cited by `/jay-pr-review` Step 5 and by `/ticket-work` S4.4, which both write the same
artifact at `{PLANS_DIR}/pr-review-{BRANCH_NAME}.md`.

Downstream consumers — `post-review-summary`, `pr-execute-plan`, and the S4.6b
unresolved-issues gate — parse this file. Keep every actionable item a `- [ ]` checkbox
and keep the filename exact; both are load-bearing.

```markdown
# PR Review Plan: <BRANCH>

- **Base**: <BASE>
- **Files changed**: <N> (<+>/<->)
- **PR**: <#NUM URL> or "Not yet opened"
- **Generated**: <YYYY-MM-DD>

## Summary
<2-3 sentences from commits + diff.>

## Findings
Group by severity, `Critical` first. Omit empty sections.

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

If not analyzed: "Test coverage not analyzed."

## Notes
Open questions, architectural concerns needing a decision, and any agent skipped by a
gate (with the reason).
```

Findings already fixed in the same pass that wrote the plan — `/ticket-work` S4.4 gives
its `refactor` agent write authority — are recorded as `- [x]` with
`(fixed in review pass)` rather than dropped, so the plan stays a full record of what
the review found.
