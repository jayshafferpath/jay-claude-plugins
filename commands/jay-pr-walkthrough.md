---
description: Walk through PR changes file-by-file with explanations
argument-hint: [base-branch]
allowed-tools: Read, Grep, Glob, Bash(git:*), Bash(gh:*)
---

# PR Change Walkthrough

Interactively walk through all changes in the current branch, explaining each file's modifications clearly for reviewers or for your own understanding.

## Step 1: Determine Base Branch and Scope

1. If `$ARGUMENTS` is provided, use it as the base branch.
2. Otherwise, try `gh pr view --json baseRefName -q .baseRefName` to detect the base from an existing PR.
3. If no PR exists, fall back to `main`.
4. Run `git diff <base>...HEAD --stat` to get the list of changed files and a summary.
5. Run `git branch --show-current` to get the current branch name.

## Step 2: Provide a High-Level Summary

Before diving into files, give a brief overview:

- **Branch**: current branch name
- **Base**: the base branch being compared against
- **Total files changed**: count from the diff stat
- **Nature of changes**: 1-2 sentence summary of the overall purpose (feature, bugfix, refactor, etc.)

## Step 3: Walk Through Each Changed File

For each changed file (ordered logically — specs/schemas first, then models/types, then business logic, then routes/controllers, then tests):

1. **Read the full diff** for the file using `git diff <base>...HEAD -- <filepath>`.
2. **Read surrounding context** if needed — use the Read tool to look at unchanged parts of the file when the diff alone isn't clear enough to explain the change.
3. **Present the explanation** using this format:

```
### `<filepath>` (<change type>)

**What changed:** <1-3 sentence plain-language summary of the modifications>

**Why it matters:** <1-2 sentences on the purpose or impact of this change in the broader context of the PR>

**Key details:**
- <Notable implementation detail, decision, or pattern used>
- <Any potential concerns or things a reviewer should pay attention to>
```

Where `<change type>` is one of: `new file`, `modified`, `deleted`, `renamed`.

## Step 4: Call Out Cross-Cutting Concerns

After walking through all files, highlight any of these that apply:

- **Breaking changes**: API contract changes, schema changes, removed exports
- **Security considerations**: auth changes, input validation, PII handling
- **Performance implications**: new queries, changed indexes, large data operations
- **Testing gaps**: areas that changed but lack corresponding test updates
- **Configuration changes**: environment variables, feature flags, infrastructure

## Guidelines

- Order files for maximum comprehension — dependencies before dependents, schemas before implementations, types before usage.
- Use plain language. Avoid restating the diff mechanically ("added line 42"); instead explain the *intent* behind changes.
- When a change spans multiple files (e.g., a new field added to a type, model, repository, and route), connect the dots explicitly so the reader sees the full picture.
- If a file has many small changes, group them thematically rather than listing each one.
- If the diff is trivial (e.g., import reordering, formatting), say so briefly and move on.
- Never include PII or secrets in explanations.
- If there are more than 15 changed files, group them into logical sections (e.g., "API Layer", "Data Layer", "Tests") with a brief section intro before the file-level details.
