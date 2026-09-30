---
description: Generate a PR title and description following the team's PR template
argument-hint: [base-branch]
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(git *)
  - Bash(gh *)
  - mcp__atlassian__getAccessibleAtlassianResources
  - mcp__atlassian__getJiraIssue
---

# PR Description Generator

Generate a PR title and description for the current branch. Write the output to `./pr.md`.

## Step 1: Gather Context

**Important**: Only use context from the current branch. Do not read files, diffs, or history from other branches. All git commands must be scoped to the current branch's commits relative to the base branch.

Run these commands to understand the changes:

1. Check the current branch with `git branch --show-current`. If the result is empty (detached HEAD) or the branch is `main`/`master`, stop and tell the user: "You must be on a feature branch to generate a PR description."
2. Determine the base branch:
   - If `$ARGUMENTS` is provided, use it as the base branch.
   - Otherwise, try `gh pr view --json baseRefName -q .baseRefName` to detect the base from an existing PR.
   - If no PR exists, fall back to `main`.
3. Run `git log <base>..HEAD --oneline` to get commit history.
4. Run `git diff <base>...HEAD --stat` to see changed files summary.
5. Run `git diff <base>...HEAD` to see the full diff.
6. Extract any Jira ticket number (e.g., NEV-123, PET-456) from the branch name.

## Step 2: Fetch Jira Ticket Context

Skip this entire step if no Jira ticket number was found in Step 1.6 — the description is
written from the diff alone in that case.

### 2a: Resolve the Jira site

```
mcp__atlassian__getAccessibleAtlassianResources
```

Store the first resource's `id` as `CLOUD_ID` and its `url` as `JIRA_SITE_URL` (e.g.
`https://your-site.atlassian.net`). `JIRA_SITE_URL` is what every link in Step 4 is built
from — never hardcode a site domain, since this command runs across whatever Jira
instance the invoking user's Atlassian connection resolves to.

### 2b: Fetch the ticket and its ancestors

Use `mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={TICKET_KEY}`.
Extract:
- **Summary** (title)
- **Description** (acceptance criteria, requirements, context)
- **Issue type** (Story, Bug, Task, Sub-task, etc.)
- **Labels and components**
- **Linked issues** (blocks, is blocked by, relates to)
- **Parent field** — if the issue has a parent (subtask or child issue), note the parent key.

**If the ticket is a Sub-task** (issue type is `Sub-task`, or the ticket has a parent): call
`mcp__atlassian__getJiraIssue` with `cloudId={CLOUD_ID}`, `issueIdOrKey={PARENT_KEY}`.
Extract:
- **Summary** (title)
- **Description** in full — acceptance criteria, goals, motivation, business context
- **Issue type** of the parent (typically Story, but could be Epic or Task)
- **Parent field** of the parent — if the parent itself has a parent (e.g., a Story under
  an Epic), fetch that grandparent too and capture its Summary + a brief description
  excerpt for additional framing.

The goal is to surface the **overall Story** the subtask is part of, so the PR description
can explain how this subtask fits into the larger feature or initiative. Treat the parent's
description as primary context — reviewers need to understand the Story's scope, not just
the subtask's narrow slice.

### 2c: Compile a Jira Context Block

- Ticket link: `{JIRA_SITE_URL}/browse/{TICKET}` + brief summary
- Parent (Story) link + summary, **plus a 2–3 sentence synopsis of what the parent Story
  is trying to accomplish** (drawn from the parent's description). This synopsis is
  required when the ticket is a subtask.
- Grandparent (Epic) link + summary, if applicable
- One-line statement of how this subtask contributes to the parent Story

## Step 3: Determine PR Prefix and Title

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

## Step 4: Write Description

Use this exact template structure:

```markdown
<title line>

# TL;DR

<1-2 sentences: what this PR does and what it changes. Plain, concrete, no marketing tone. Reviewers should grasp the PR's purpose from this line alone.>

# Description

<2-5 sentences explaining what changed and why. Focus on the business reason, not implementation details. Mention key decisions made.>

<If Jira context was gathered, weave the ticket's requirements and parent context into the description naturally — don't just dump raw Jira text. The description should tell a coherent story: what the parent initiative is about, what this specific ticket contributes, and what the code changes accomplish.>

<If the ticket is a subtask, lead with **Story Context**: a short paragraph (2–4 sentences) that names the parent Story and explains what the overall Story is trying to deliver. Then describe what *this subtask* specifically does within that scope, and how it advances the parent's goals. Reviewers should be able to read the description alone and understand both the bigger picture and this PR's slice of it.>

# Jira Context

- **Ticket**: [<TICKET>](<JIRA_SITE_URL>/browse/<TICKET>) — <ticket summary>
- **Parent Story**: [<PARENT>](<JIRA_SITE_URL>/browse/<PARENT>) — <parent summary>  *(only if applicable)*
- **Epic**: [<EPIC>](<JIRA_SITE_URL>/browse/<EPIC>) — <epic summary>  *(only if the parent has a parent)*
- **Linked Issues**: <list any blocking/related tickets with links>  *(only if applicable)*

<If the ticket is a subtask, add a **Story Synopsis** subsection here with 2–3 sentences summarizing the parent Story's goals and acceptance criteria, so reviewers don't have to click through.>

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

If Step 2 was skipped (no Jira ticket found), omit the `# Jira Context` section entirely
rather than leaving it templated-but-empty.

## Guidelines

- The **TL;DR** is mandatory and must be 1-2 sentences. State what the PR does and what it changes — no story framing, no business justification, no hedging. If you can't say it in two sentences, the scope is the problem, not the blurb.
- Be concise but comprehensive in the description — reviewers should understand the PR without reading every line of code.
- Use the Jira ticket context to explain the *why* behind changes. Don't repeat the ticket verbatim — synthesize it into the description narrative.
- If the ticket is a subtask, frame the description in terms of the parent Story's goals so reviewers understand the bigger picture. Include a **Story Context** lead paragraph in the Description and a **Story Synopsis** in the Jira Context section. Do not assume reviewers will click through to Jira.
- The Jira Context section should always use clickable markdown links built from `JIRA_SITE_URL` — never a hardcoded domain.
- Omit the Parent line from Jira Context if there is no parent. Omit Linked Issues if there are none.
- Assess business impact honestly. Most code changes are Medium. Reserve Large/Extra Large for changes touching auth, data persistence, payment processing, or infrastructure.
- For risk mitigations, only list mitigations that actually apply. Do not fabricate mitigations.
- If the diff is large, group changes by area in the description (e.g., "API changes", "Data layer changes", "Test additions").
- Never include PII or secrets in the description.
- If there are database schema changes, call them out explicitly in the description.
- If there are OpenAPI spec changes, mention them in the description.

## Step 5: Write Output

Write the complete PR description to `./pr.md`. The first line of the file is the PR title. The rest is the body.
