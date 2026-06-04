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

export function findBranch(ticketKey, repoRoot) {
  if (!repoRoot || !existsSync(repoRoot)) return null;
  const result = run(`git branch --list '${ticketKey}*'`, repoRoot);
  if (!result) return null;
  const branches = result
    .split("\n")
    .map((b) => b.replace(/^\*?\s+/, "").trim())
    .filter(Boolean);
  return branches[0] || null;
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
