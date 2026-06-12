// Cascade-rebase a chain of branches.
//
// Used by /cleanup (Step 7) and /stack-rebase (Scenario A) — both of which
// were maintaining nearly-identical inline implementations before this
// extraction. The shape is:
//
//   given (origin: <branch removed from main / merged>),
//        (downstreams: [{ ticket, branch }, ...] in stack order),
//        (newRoot: branch the first downstream should rebase onto)
//   →    rebase the first downstream `--onto newRoot origin firstDownstream`,
//        push --force-with-lease, then for each subsequent downstream rebase
//        `--onto previousDownstream previousOriginalBase nextDownstream`.
//
// On conflict the chain stops and remaining downstreams are reported as
// `not-attempted`.

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

function listConflicts(repoRoot) {
  const r = runCapture("git diff --name-only --diff-filter=U", repoRoot);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Cascade-rebase a downstream chain.
//
// opts:
//   repoRoot       — repo path
//   originBranch   — the branch the first downstream was *originally* based on
//                    (the branch we just merged/deleted)
//   newRoot        — what the first downstream should rebase onto
//                    (typically `main` or the parent feature branch)
//   downstreams    — [{ ticket, branch }, ...] in stack order
//   pushAfterRebase — when true (default) force-with-lease push each rebased
//                     branch; when false, callers must push themselves
//
// Returns { results: [{ ticket, branch, status, ... }, ...] }
//   status ∈ "rebased" | "pushed-failed" | "conflict" | "not-attempted" | "skipped"
export function cascadeRebase({
  repoRoot,
  originBranch,
  newRoot,
  downstreams,
  pushAfterRebase = true,
}) {
  const results = [];

  if (!repoRoot) throw new Error("cascadeRebase: repoRoot is required");
  if (!originBranch) throw new Error("cascadeRebase: originBranch is required");
  if (!newRoot) throw new Error("cascadeRebase: newRoot is required");
  if (!Array.isArray(downstreams)) {
    throw new Error("cascadeRebase: downstreams must be an array");
  }

  let previousBase = newRoot;
  let previousOriginalBase = originBranch;
  let stopped = false;

  for (const entry of downstreams) {
    const { ticket, branch } = entry;

    if (stopped) {
      results.push({ ticket, branch, status: "not-attempted" });
      continue;
    }

    if (!branch) {
      results.push({
        ticket,
        branch: null,
        status: "skipped",
        reason: "no branch on record",
      });
      continue;
    }

    const checkout = runCapture(`git checkout ${branch}`, repoRoot);
    if (!checkout.ok) {
      results.push({
        ticket,
        branch,
        status: "skipped",
        reason: `checkout failed: ${checkout.stderr.trim() || "unknown"}`,
      });
      continue;
    }

    const rebase = runCapture(
      `git rebase --onto ${previousBase} ${previousOriginalBase} ${branch}`,
      repoRoot,
    );

    if (!rebase.ok) {
      const files = listConflicts(repoRoot);
      runCapture("git rebase --abort", repoRoot);
      results.push({
        ticket,
        branch,
        status: "conflict",
        files,
      });
      stopped = true;
      continue;
    }

    let push = null;
    if (pushAfterRebase) {
      push = runCapture(
        `git push --force-with-lease origin ${branch}`,
        repoRoot,
      );
    }

    if (push && !push.ok) {
      results.push({
        ticket,
        branch,
        status: "pushed-failed",
        new_base: previousBase,
        error: push.stderr.trim() || `exit ${push.code}`,
      });
    } else {
      results.push({
        ticket,
        branch,
        status: "rebased",
        new_base: previousBase,
      });
    }

    previousOriginalBase = branch;
    previousBase = branch;
  }

  return { results };
}
