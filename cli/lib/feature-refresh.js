// Refresh a long-lived feature branch after a downstream cascade-rebase.
//
// Implements /cleanup Step 8 (8a-8f): detect orphan integration commits,
// detect dirty worktrees on the feature branch, capture the pre-refresh
// SHA, hard-reset to origin/{mergeTarget}, replay `git merge --no-ff`
// for each downstream branch in stack order, force-push.
//
// Outcome states (the caller renders messaging from these):
//   "refreshed"               — full success
//   "skipped-orphans"         — local-only commits would be lost
//   "skipped-dirty-worktree"  — secondary worktree on the feature branch
//                                has uncommitted changes
//   "skipped-checkout-failed" — primary worktree refused checkout
//   "partial-merge-conflict"  — one of the re-merges conflicted; stopped
//                                the loop and pushed what merged cleanly
//   "pushed-failed"           — local refresh succeeded but push failed
//
// Step 8g (activity log append) is left to the caller — appendActivity
// already handles the side-effect, and the caller knows the right
// container key.

import { execSync } from "node:child_process";

function runCapture(cmd, cwd) {
  try {
    return {
      ok: true,
      stdout: execSync(cmd, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout?.toString?.() ?? "",
      stderr: err.stderr?.toString?.() ?? String(err),
      code: err.status ?? 1,
    };
  }
}

function detectOrphans(
  repoRoot,
  featureBranch,
  mergeTarget,
  downstreamBranches,
) {
  // Commits reachable from FEATURE_BRANCH but not from origin/{mergeTarget}
  // and not from any tracked downstream branch.
  const exclude = [`origin/${mergeTarget}`, ...downstreamBranches]
    .map((ref) => `^${ref}`)
    .join(" ");
  const result = runCapture(
    `git log ${featureBranch} ${exclude} --oneline`,
    repoRoot,
  );
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function findDirtyWorktrees(repoRoot, featureBranch) {
  const result = runCapture("git worktree list --porcelain", repoRoot);
  if (!result.ok) return [];

  const worktrees = [];
  let current = {};
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9) };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    }
  }
  if (current.path) worktrees.push(current);

  const dirty = [];
  for (const wt of worktrees) {
    if (wt.branch !== featureBranch) continue;
    if (wt.path === repoRoot) continue; // primary handled by checkout step
    const status = runCapture("git status --porcelain", wt.path);
    if (status.ok && status.stdout.trim().length > 0) {
      dirty.push(wt.path);
    }
  }
  return dirty;
}

function listConflicts(repoRoot) {
  const r = runCapture("git diff --name-only --diff-filter=U", repoRoot);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// opts:
//   repoRoot           — repo path
//   featureBranch      — long-lived feature branch to refresh
//   mergeTarget        — branch to reset onto (origin/{mergeTarget})
//   downstreams        — [{ ticket, branch, summary, status }, ...] in stack order.
//                        `status` ∈ "rebased" | "pushed-failed" | "conflict" |
//                        "skipped" | "not-attempted" — we only re-merge
//                        "rebased" or "pushed-failed" (correct local state).
//   skipOnConflict     — when true (default) and Step 7 reported any conflict,
//                        return outcome:"skipped-cascade-conflict" without
//                        touching the feature branch
//   cascadeStatus      — optional precomputed Step 7 verdict; if "conflict",
//                        triggers the skipOnConflict guard
//
// Returns:
//   { outcome, oldSha, remerged: [{ ticket, branch }],
//     orphans?, dirtyWorktrees?, conflictBranch?, conflictFiles?,
//     pushError? }
export function refreshFeatureBranch(opts) {
  const {
    repoRoot,
    featureBranch,
    mergeTarget,
    downstreams,
    skipOnConflict = true,
    cascadeStatus = null,
  } = opts;

  if (!repoRoot) throw new Error("refreshFeatureBranch: repoRoot is required");
  if (!featureBranch)
    throw new Error("refreshFeatureBranch: featureBranch is required");
  if (!mergeTarget)
    throw new Error("refreshFeatureBranch: mergeTarget is required");
  if (!Array.isArray(downstreams)) {
    throw new Error("refreshFeatureBranch: downstreams must be an array");
  }

  if (skipOnConflict && cascadeStatus === "conflict") {
    return {
      outcome: "skipped-cascade-conflict",
      remerged: [],
    };
  }

  const downstreamBranches = downstreams.map((d) => d.branch).filter(Boolean);

  // 8a — orphan detection
  const orphans = detectOrphans(
    repoRoot,
    featureBranch,
    mergeTarget,
    downstreamBranches,
  );
  if (orphans.length > 0) {
    return {
      outcome: "skipped-orphans",
      orphans,
      remerged: [],
    };
  }

  // 8b — dirty-worktree detection
  const dirtyWorktrees = findDirtyWorktrees(repoRoot, featureBranch);
  if (dirtyWorktrees.length > 0) {
    return {
      outcome: "skipped-dirty-worktree",
      dirtyWorktrees,
      remerged: [],
    };
  }

  // 8c — capture pre-refresh SHA
  const shaProbe = runCapture(`git rev-parse ${featureBranch}`, repoRoot);
  const oldSha = shaProbe.ok ? shaProbe.stdout.trim() : null;

  // 8d — reset to origin/{mergeTarget}
  runCapture("git fetch origin", repoRoot);
  const checkout = runCapture(`git checkout ${featureBranch}`, repoRoot);
  if (!checkout.ok) {
    return {
      outcome: "skipped-checkout-failed",
      oldSha,
      checkoutError: checkout.stderr.trim() || `exit ${checkout.code}`,
      remerged: [],
    };
  }

  const reset = runCapture(`git reset --hard origin/${mergeTarget}`, repoRoot);
  if (!reset.ok) {
    return {
      outcome: "skipped-checkout-failed",
      oldSha,
      checkoutError: reset.stderr.trim() || `exit ${reset.code}`,
      remerged: [],
    };
  }

  // 8e — re-merge eligible downstream branches
  const remerged = [];
  let conflictBranch = null;
  let conflictFiles = null;
  let conflictTicket = null;

  const eligible = downstreams.filter(
    (d) => d.branch && (d.status === "rebased" || d.status === "pushed-failed"),
  );

  for (const d of eligible) {
    const summary = d.summary || "";
    const message = summary
      ? `Merge ${d.ticket}: ${summary} into ${featureBranch}`
      : `Merge ${d.ticket} into ${featureBranch}`;
    const escapedMsg = message.replace(/"/g, '\\"');
    const merge = runCapture(
      `git merge --no-ff ${d.branch} -m "${escapedMsg}"`,
      repoRoot,
    );
    if (!merge.ok) {
      conflictFiles = listConflicts(repoRoot);
      runCapture("git merge --abort", repoRoot);
      conflictBranch = d.branch;
      conflictTicket = d.ticket;
      break;
    }
    remerged.push({ ticket: d.ticket, branch: d.branch });
  }

  // 8f — push (even on partial completion)
  const push = runCapture(
    `git push --force-with-lease origin ${featureBranch}`,
    repoRoot,
  );

  let outcome;
  if (conflictBranch) {
    outcome = "partial-merge-conflict";
  } else if (!push.ok) {
    outcome = "pushed-failed";
  } else {
    outcome = "refreshed";
  }

  const result = {
    outcome,
    oldSha,
    remerged,
  };
  if (conflictBranch) {
    result.conflictBranch = conflictBranch;
    result.conflictTicket = conflictTicket;
    result.conflictFiles = conflictFiles;
  }
  if (!push.ok) {
    result.pushError = push.stderr.trim() || `exit ${push.code}`;
  }
  return result;
}
