---
description: Generate a PR title and description following the team's PR template
argument-hint: [base-branch]
allowed-tools:
  - Bash(git log *)
  - Bash(git diff *)
  - Bash(git branch *)
  - Bash(gh pr view *)
  - Write
---

# PR Description Generator

Generate a PR title and description for the current branch. Write the output to `./pr.md`.

## Step 1: Gather Context

Run these commands to understand the changes:

1. Determine the base branch:
   - If `$ARGUMENTS` is provided, use it as the base branch.
   - Otherwise, try `gh pr view --json baseRefName -q .baseRefName` to detect the base from an existing PR.
   - If no PR exists, fall back to `main`.
2. Run `git log <base>..HEAD --oneline` to get commit history.
3. Run `git diff <base>...HEAD --stat` to see changed files summary.
4. Run `git diff <base>...HEAD` to see the full diff.
5. Check the current branch name with `git branch --show-current` — extract any Jira ticket number (e.g., NEV-123, PET-456) from the branch name.

## Step 2: Determine PR Prefix and Title

Construct the PR title:

1. **Prefix**: Determine a conventional commit prefix based on the nature of changes:
   - `feat:` — new feature or capability
   - `fix:` — bug fix
   - `chore:` — maintenance, dependency updates, config changes
   - `refactor:` — code restructuring without behavior change
   - `docs:` — documentation only
   - `test:` — test additions or changes
   - `ND` (No Deploy) — add this prefix if changes don't require deployment (docs, CI config, etc.)

2. **Ticket number**: Include the Jira ticket number if found in the branch name (e.g., `feat: NEV-123 Add employer onboarding endpoint`).

3. **Title**: Write a concise summary under 70 characters. Focus on the "what" at a high level.

## Step 3: Write Description

Use this exact template structure:

```markdown
<title line>

# Description

<2-5 sentences explaining what changed and why. Focus on the business reason, not implementation details. Mention key decisions made.>

# Business Impact of Affected Code

<One of the following impact levels with a brief justification:>

- **Small** — No user-facing impact (refactors, docs, dev tooling)
- **Medium** — May cause features not to work or small bugs
- **Large** — May cause a P1 outage or data corruption
- **Extra Large** — May cause a P0 outage or data corruption

# Risk Mitigations

<Bulleted list of applicable mitigations. Include all that apply:>

- Behind a feature flag
- Covered by automated tests
- Manual testing performed: <describe>
- Rollback strategy: <describe>
- Database migration is backwards-compatible
- No breaking API changes
```

## Guidelines

- Be concise but comprehensive in the description — reviewers should understand the PR without reading every line of code.
- Assess business impact honestly. Most code changes are Medium. Reserve Large/Extra Large for changes touching auth, data persistence, payment processing, or infrastructure.
- For risk mitigations, only list mitigations that actually apply. Do not fabricate mitigations.
- If the diff is large, group changes by area in the description (e.g., "API changes", "Data layer changes", "Test additions").
- Never include PII or secrets in the description.
- If there are database schema changes, call them out explicitly in the description.
- If there are OpenAPI spec changes, mention them in the description.

## Step 4: Write Output

Write the complete PR description to `./pr.md`. The first line of the file is the PR title. The rest is the body.
