---
description: Rebase the current feature branch onto origin/main and force-push.
allowed-tools:
  - Bash(git fetch *)
  - Bash(git status *)
  - Bash(git rev-parse *)
  - Bash(git symbolic-ref *)
  - Bash(git rev-list *)
  - Bash(git merge-base *)
  - Bash(git rebase *)
  - Bash(git push --force-with-lease *)
  - Bash(git diff *)
  - Bash(git log *)
  - AskUserQuestion
---

# Rebase on Main

Rebase the current feature branch onto `origin/main`, abort cleanly on conflict, and force-push with `--force-with-lease`.

No arguments. Always operates on the current branch.

## Step 1: Preflight

### 1a: Resolve current branch

```bash
git symbolic-ref --short HEAD
```

Store as `BRANCH`. If `BRANCH` is `main` or `master`, refuse:

```
Refusing to rebase {BRANCH} onto itself. This command is for feature branches.
```

Stop.

### 1b: Reject dirty tree

```bash
git status --porcelain
```

If output is non-empty, bail:

```
Working tree is dirty. Commit or stash before rebasing:
{list of files from git status}
```

Stop.

### 1c: Fetch

```bash
git fetch origin main
```

### 1d: Skip if up-to-date

```bash
git rev-list HEAD..origin/main
```

If empty AND `git merge-base --is-ancestor origin/main HEAD` exits 0, the branch already contains every commit on `origin/main`. Print:

```
{BRANCH} is already up-to-date with origin/main. Nothing to do.
```

Stop.

## Step 2: Rebase

```bash
git rebase origin/main
```

If the rebase exits non-zero:

1. Capture conflicting files: `git diff --name-only --diff-filter=U`
2. `git rebase --abort`
3. Print:

```
Rebase aborted due to conflicts in:
{conflict files}

Resolve manually:
  git rebase origin/main
  # fix conflicts
  git add {files}
  git rebase --continue
  git push --force-with-lease
```

Stop.

## Step 3: Confirm push

Show the rebased range:

```bash
git log --oneline origin/main..HEAD
```

Use `AskUserQuestion` with one question:

- Question: `Force-push the rebased {BRANCH} to origin?`
- Options:
  - `Yes, force-push` — proceed to Step 4.
  - `No, leave it local` — exit. Branch remains rebased locally; user can push manually later.

## Step 4: Push

```bash
git push --force-with-lease origin {BRANCH}
```

If push fails (e.g. lease check rejected), surface the git error and tell the user remote has moved — they need to investigate before pushing.

## Step 5: Summary

```
Rebased {BRANCH} onto origin/main

  New base: {origin/main SHA -- short}
  Commits:  {N} ({list from git log --oneline origin/main..HEAD})
  Pushed:   {yes/no}
```
