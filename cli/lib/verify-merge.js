// Verify whether a branch was merged (via PR) into a target and whether the
// resulting merge commit is reachable from origin/{target}.
//
// Used by /cleanup (Step 1b second-pass probe + Step 2 strict refusal) and
// /promote-to-main (Step 1d non-strict probe). Both call sites previously
// re-implemented this in prose: probe `gh pr list --state merged`, pull
// `mergeCommit`, run `git merge-base --is-ancestor`. Folding it into one
// CLI means the agent does not have to chain three fragile commands and
// re-derive refusal copy.
//
// Strict mode: if `merged === false` or `ancestorOfTarget === false`, populate
// `refusalReason` so the caller can `if (out.refusalReason) stop`.
// Non-strict mode: same data, no refusalReason. Caller decides.

import { execSync } from "node:child_process";

import { prState } from "./pr.js";

function isAncestor(sha, target, cwd) {
  if (!sha || !target || !cwd) return false;
  try {
    execSync(`git merge-base --is-ancestor ${sha} origin/${target}`, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function verifyMerge({ branch, base, cwd, strict = false }) {
  if (!branch || !base || !cwd) {
    throw new Error("verifyMerge: branch, base, and cwd are required");
  }

  const pr = prState(branch, { base, state: "merged", cwd });

  if (!pr) {
    return {
      merged: false,
      prNumber: null,
      prUrl: null,
      prState: null,
      mergeSha: null,
      ancestorOfTarget: false,
      refusalReason: strict
        ? `no merged PR to ${base} found for ${branch}`
        : null,
    };
  }

  const mergeSha = pr.mergeCommit || null;

  if (!mergeSha) {
    return {
      merged: true,
      prNumber: pr.number,
      prUrl: pr.url,
      prState: pr.state,
      mergeSha: null,
      ancestorOfTarget: false,
      refusalReason: strict
        ? `merged PR ${pr.url} has no merge commit SHA on record`
        : null,
    };
  }

  const ancestor = isAncestor(mergeSha, base, cwd);

  return {
    merged: true,
    prNumber: pr.number,
    prUrl: pr.url,
    prState: pr.state,
    mergeSha,
    ancestorOfTarget: ancestor,
    refusalReason:
      strict && !ancestor
        ? `merge commit ${mergeSha} (PR ${pr.url}) is not reachable from origin/${base}`
        : null,
  };
}
