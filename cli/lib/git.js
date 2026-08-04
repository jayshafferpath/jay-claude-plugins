import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function run(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

// Locate a ticket's branch by key prefix. Checks local branches first, then
// falls back to remote-tracking branches.
//
// The remote fallback matters because terminal cleanup deletes the local
// branch: without it, a ticket whose work is merged and pushed looks like it
// has no branch at all, which disables every downstream merge check and makes
// shipped work read as unstarted (issue #32).
//
// Returns a bare branch name with no `origin/` prefix — callers such as
// isAncestor and isMergedInto add the remote prefix themselves.
export function findBranch(ticketKey, repoRoot) {
  if (!repoRoot || !existsSync(repoRoot)) return null;

  const local = run(`git branch --list '${ticketKey}*'`, repoRoot);
  const localMatch = firstBranchName(local);
  if (localMatch) return localMatch;

  const remote = run(`git branch -r --list 'origin/${ticketKey}*'`, repoRoot);
  return firstBranchName(remote, { stripRemote: true });
}

// Parse `git branch` output into the first usable branch name. Drops the
// current-branch/worktree markers (`*`, `+`) and skips symbolic refs such as
// `origin/HEAD -> origin/main`, which are not branches we can reason about.
function firstBranchName(raw, { stripRemote = false } = {}) {
  if (!raw) return null;
  const names = raw
    .split("\n")
    .map((b) => b.replace(/^[*+]?\s+/, "").trim())
    .filter(Boolean)
    .filter((b) => !b.includes("->"))
    .map((b) => (stripRemote ? b.replace(/^origin\//, "") : b));
  return names[0] || null;
}

export function findWorktree(ticketKey, repoRoot) {
  if (!repoRoot || !existsSync(repoRoot)) return null;
  const candidates = [
    join(repoRoot, "..", ticketKey),
    join(repoRoot, ticketKey),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const gitDir = run("git rev-parse --git-dir", candidate);
      if (gitDir) return candidate;
    }
  }
  return null;
}

export function getPrInfo(branchName, cwd) {
  if (!branchName || !cwd) return null;
  const result = run(`gh pr view ${branchName} --json number,url,state`, cwd);
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

export function getRepoSlug(cwd) {
  if (!cwd) return null;
  const result = run(
    "gh repo view --json nameWithOwner --jq .nameWithOwner",
    cwd,
  );
  return result || null;
}

export function getPrDetails(branchName, cwd) {
  if (!branchName || !cwd) return null;
  const result = run(
    `gh pr view ${branchName} --json number,url,state,title,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,reviews,mergeable,headRefName,baseRefName`,
    cwd,
  );
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

export function getPrDiffStat(branchName, cwd) {
  if (!branchName || !cwd) return null;
  const result = run(`gh pr diff ${branchName} --stat`, cwd);
  return result || null;
}

export function isAncestor(ancestor, descendant, cwd) {
  if (!ancestor || !descendant || !cwd) return false;
  const result = run(
    `git merge-base --is-ancestor origin/${ancestor} origin/${descendant}`,
    cwd,
  );
  return result !== null;
}

export function isMergedInto(branch, target, cwd) {
  if (!branch || !target || !cwd) return false;
  const result = run(`git branch -r --merged origin/${target}`, cwd);
  if (!result) return false;
  return result.split("\n").some((line) => line.trim() === `origin/${branch}`);
}

// Resolve the `merged/{TICKET_KEY}` tag written by /cleanup Step 2d to the
// commit it points at, or null when the tag does not exist.
//
// This tag is the durable phase-1 merge marker: it survives branch deletion,
// which branch-based merge inference does not. /promote-to-main already treats
// it as authoritative when picking the next ticket, so the resolver consults
// it too rather than inferring merge state from branches alone (issue #32).
export function resolveMergedTag(ticketKey, cwd) {
  if (!ticketKey || !cwd) return null;
  return run(
    `git rev-parse --verify refs/tags/merged/${ticketKey}^{commit}`,
    cwd,
  );
}

// Whether a commit SHA is reachable from origin/{target}. Unlike isAncestor
// this takes a raw SHA rather than a branch name, so it works for commits
// whose branch has already been deleted.
export function isShaAncestorOf(sha, target, cwd) {
  if (!sha || !target || !cwd) return false;
  const result = run(
    `git merge-base --is-ancestor ${sha} origin/${target}`,
    cwd,
  );
  return result !== null;
}

export function getMergedPrMap(baseBranch, cwd) {
  if (!baseBranch || !cwd) return new Map();
  const result = run(
    `gh pr list --state merged --base ${baseBranch} --limit 200 --json headRefName,mergeCommit`,
    cwd,
  );
  if (!result) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    return new Map();
  }
  const map = new Map();
  for (const pr of parsed) {
    const head = pr?.headRefName;
    if (!head) continue;
    const sha = pr?.mergeCommit?.oid || null;
    if (!map.has(head)) map.set(head, sha);
  }
  return map;
}

// Every `merged/{KEY}` tag on origin, as a Set of ticket keys. One network
// call for the whole stack. These tags are created by /cleanup Step 2d and are
// the durable record that phase-1 cleanup ran — replacing the
// ClaudePendingMainPromotion label, which only memoized the same fact.
export function getMergedTagKeys(cwd) {
  if (!cwd) return new Set();
  const result = run("git ls-remote origin 'refs/tags/merged/*'", cwd);
  if (!result) return new Set();
  const keys = new Set();
  for (const line of result.split("\n")) {
    const match = line.match(/refs\/tags\/merged\/(\S+)$/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

// Bulk "is there an open PR for this branch" probe, keyed by head branch.
// One `gh` call for the whole stack — the open-PR equivalent of
// getMergedPrMap, and the replacement for the retired ClaudeNeedsReview
// label. Returns an empty Map when gh is unavailable, so callers degrade to
// "no known open PRs" rather than throwing.
export function getOpenPrMap(cwd) {
  if (!cwd) return new Map();
  const result = run(
    "gh pr list --state open --limit 200 --json headRefName,number,url,isDraft,reviewDecision,baseRefName",
    cwd,
  );
  if (!result) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    return new Map();
  }
  const map = new Map();
  for (const pr of parsed) {
    const head = pr?.headRefName;
    if (!head || map.has(head)) continue;
    map.set(head, {
      number: pr.number ?? null,
      url: pr.url ?? null,
      isDraft: pr.isDraft ?? false,
      reviewDecision: pr.reviewDecision || null,
      baseRefName: pr.baseRefName || null,
    });
  }
  return map;
}

export function getWorktreeList(repoRoot) {
  if (!repoRoot || !existsSync(repoRoot)) return [];
  const result = run("git worktree list --porcelain", repoRoot);
  if (!result) return [];

  const worktrees = [];
  let current = {};
  for (const line of result.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9) };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    }
  }
  if (current.path) worktrees.push(current);
  return worktrees;
}

export function getStageCommits(ticketKey, cwd) {
  if (!ticketKey || !cwd) return [];
  const result = run(`git log --oneline --grep="^\\[${ticketKey}\\]"`, cwd);
  if (!result) return [];
  return result
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\w+ \[.+?\] (.+)$/);
      return match ? match[1] : line;
    });
}

export function hasStageCommit(ticketKey, stagePrefix, cwd, baseBranch) {
  if (!ticketKey || !stagePrefix || !cwd) return false;
  const range = baseBranch ? ` origin/${baseBranch}..HEAD` : "";
  const result = run(
    `git log --oneline${range} --grep="^\\[${ticketKey}\\] ${stagePrefix}:"`,
    cwd,
  );
  return result !== null && result.trim().length > 0;
}

export function getLastStageCommitSha(ticketKey, baseBranch, cwd) {
  if (!ticketKey || !cwd) return null;
  const sha = run(`git log --grep="^\\[${ticketKey}\\]" -1 --format="%H"`, cwd);
  if (sha) return sha;
  return run(`git merge-base HEAD origin/${baseBranch || "main"}`, cwd);
}

export function getFeatureBranchMergeOrder(featureBranch, cwd) {
  if (!featureBranch || !cwd) return [];
  const result = run(
    `git log --oneline --first-parent origin/${featureBranch} --grep="^Merge "`,
    cwd,
  );
  if (!result) return [];

  const merges = [];
  for (const line of result.split("\n").filter(Boolean)) {
    const match = line.match(/^\w+ Merge ([A-Z]+-\d+)/);
    if (match) merges.push(match[1]);
  }
  // git log returns newest-first; reverse for chronological order
  return merges.reverse();
}
