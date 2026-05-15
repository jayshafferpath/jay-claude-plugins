import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
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
  const candidate = join(repoRoot, "..", ticketKey);
  if (existsSync(candidate)) {
    const gitDir = run("git rev-parse --git-dir", candidate);
    if (gitDir) return candidate;
  }
  return null;
}

export function getPrInfo(branchName, cwd) {
  if (!branchName || !cwd) return null;
  const result = run(
    `gh pr view ${branchName} --json number,url,state`,
    cwd
  );
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
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
