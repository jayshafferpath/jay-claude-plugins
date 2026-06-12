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

function runOrThrow(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function branchExistsLocally(branch, cwd) {
  const out = run(`git branch --list ${branch}`, cwd);
  return Boolean(out && out.length > 0);
}

function remoteRefExists(refName, cwd) {
  // Probes origin/<refName>; any non-null, non-empty output means it exists.
  const out = run(`git ls-remote --heads origin ${refName}`, cwd);
  return Boolean(out && out.length > 0);
}

function resolveBaseRef(baseBranch, cwd) {
  // Branches that are `main`-like only exist as `origin/main` until checked
  // out; downstream ticket bases may also live remote-only on origin. Use the
  // remote ref when available, fall back to the local branch name otherwise.
  if (!baseBranch) return null;
  if (remoteRefExists(baseBranch, cwd)) return `origin/${baseBranch}`;
  if (branchExistsLocally(baseBranch, cwd)) return baseBranch;
  return `origin/${baseBranch}`;
}

// Ensure a working directory + branch is ready for a ticket.
// - In serial mode, this checks out (or creates) the ticket branch in repoRoot.
// - In worktree mode, this creates a worktree at <repoRoot>/../<ticketKey>
//   (matching the convention used by findWorktree() and the existing scripts).
//
// Returns: { workDir, branch, mode, created, fetched }
export function ensureWorkDir({
  ticketKey,
  repoRoot,
  branch,
  baseBranch,
  serial = false,
  fetch = true,
}) {
  if (!ticketKey) throw new Error("ticketKey is required");
  if (!repoRoot) throw new Error("repoRoot is required");
  if (!existsSync(repoRoot)) {
    throw new Error(`repoRoot does not exist: ${repoRoot}`);
  }

  const branchName = branch || ticketKey;
  let fetched = false;
  if (fetch) {
    runOrThrow("git fetch origin", repoRoot);
    fetched = true;
  }

  const baseRef = resolveBaseRef(baseBranch, repoRoot);
  const mode = serial ? "serial" : "worktree";

  if (serial) {
    if (branchExistsLocally(branchName, repoRoot)) {
      runOrThrow(`git checkout ${branchName}`, repoRoot);
      return {
        workDir: repoRoot,
        branch: branchName,
        mode,
        created: false,
        fetched,
      };
    }

    if (!baseRef) {
      throw new Error(
        `Cannot create branch ${branchName}: baseBranch is required when the branch does not exist`,
      );
    }
    runOrThrow(`git checkout -b ${branchName} ${baseRef}`, repoRoot);
    return {
      workDir: repoRoot,
      branch: branchName,
      mode,
      created: true,
      fetched,
    };
  }

  // Worktree mode.
  const workDir = join(repoRoot, "..", ticketKey);

  if (existsSync(workDir)) {
    const gitDir = run("git rev-parse --git-dir", workDir);
    if (!gitDir) {
      throw new Error(
        `Path ${workDir} exists but is not a git worktree. Resolve manually.`,
      );
    }
    return { workDir, branch: branchName, mode, created: false, fetched };
  }

  if (branchExistsLocally(branchName, repoRoot)) {
    // Branch already exists; attach a worktree to it.
    runOrThrow(`git worktree add ${workDir} ${branchName}`, repoRoot);
  } else {
    if (!baseRef) {
      throw new Error(
        `Cannot create worktree for ${branchName}: baseBranch is required when the branch does not exist`,
      );
    }
    if (baseBranch === "main" || baseRef === "origin/main") {
      // Historical form keeps the worktree's branch tracking unset, matching
      // how the existing scripts created `main`-based worktrees.
      runOrThrow(`git worktree add -b ${branchName} ${workDir}`, repoRoot);
    } else {
      runOrThrow(
        `git worktree add -b ${branchName} ${workDir} ${baseRef}`,
        repoRoot,
      );
    }
  }

  return { workDir, branch: branchName, mode, created: true, fetched };
}

// Ensure the feature branch (named after a Story/Epic container) exists locally
// and on origin. Subsumes ticket-work S2.0. Throws when bootstrapping requires
// a parent feature branch that hasn't been created yet.
export function ensureFeatureBranch({
  featureBranch,
  containerBase,
  unmergedBlockers = [],
  repoRoot,
  fetch = true,
}) {
  if (!featureBranch) throw new Error("featureBranch is required");
  if (!repoRoot) throw new Error("repoRoot is required");
  if (unmergedBlockers.length > 1) {
    throw new Error(
      `Container has multiple unmerged blocker containers: ${unmergedBlockers.join(", ")}. Resolve by merging one or chaining them via blocker links.`,
    );
  }
  if (fetch) runOrThrow("git fetch origin", repoRoot);

  if (remoteRefExists(featureBranch, repoRoot)) {
    // Mirror existing behavior: refresh local ref tracking origin's tip.
    run(`git fetch origin ${featureBranch}:${featureBranch}`, repoRoot) ||
      run(`git fetch origin ${featureBranch}`, repoRoot);
    return { action: "exists" };
  }

  // Create from container base. Validate base when it is not main.
  const base = containerBase || "main";
  if (base !== "main" && !remoteRefExists(base, repoRoot)) {
    throw new Error(
      `Blocker container has no branch yet (origin/${base} missing). Run /ticket-work against the blocker's first ticket to bootstrap it.`,
    );
  }

  runOrThrow(`git branch ${featureBranch} origin/${base}`, repoRoot);
  runOrThrow(`git push -u origin ${featureBranch}`, repoRoot);
  return { action: "created", base: `origin/${base}` };
}
