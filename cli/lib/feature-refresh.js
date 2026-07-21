// Refresh a long-lived feature branch after a downstream cascade-rebase.
//
// Implements /cleanup Step 8 (8a-8f): detect orphan integration commits,
// detect dirty worktrees on the feature branch, capture the pre-refresh
// SHA, hard-reset to origin/{mergeTarget}, replay `git merge --no-ff`
// for each downstream branch in stack order, force-push.
//
// Outcome states (the caller renders messaging from these):
//   "refreshed"                       — full success
//   "skipped-orphans"                 — local-only commits would be lost
//   "skipped-orphan-check-failed"     — orphan check could not run (missing
//                                        ref, git log error); refuse rather
//                                        than fail open (NEV-863 fix)
//   "skipped-unresolvable-predecessor"— a mergedIntoFeature predecessor has
//                                        neither a branch nor a mergeSha to
//                                        replay (NEV-863 fix)
//   "skipped-unrecoverable-commits"   — pre-reset reachability check found
//                                        commits on the feature branch that
//                                        no downstream branch or mergeSha
//                                        covers (NEV-863 fix)
//   "skipped-dirty-worktree"          — secondary worktree on the feature
//                                        branch has uncommitted changes
//   "skipped-checkout-failed"         — primary worktree refused checkout
//   "partial-merge-conflict"          — one of the re-merges/cherry-picks
//                                        conflicted; stopped the loop and
//                                        pushed what merged cleanly
//   "pushed-failed"                   — local refresh succeeded but push
//                                        failed
//
// Step 8g (activity log append) is left to the caller — appendActivity
// already handles the side-effect, and the caller knows the right
// container key.

import { execSync } from "node:child_process";

// Parse a single `--downstreams` entry. The tuple is
// `ticket:branch:status[:summary[:mergeSha]]`. Summary may legitimately
// contain colons, so we decide whether the last segment is a mergeSha by
// matching SHA shape (7-40 hex chars).
export function parseDownstreamEntry(entry) {
  const parts = entry.split(":");
  const ticket = parts[0];
  const branch = parts[1] || null;
  const status = parts[2] || "rebased";
  let summary = "";
  let mergeSha = null;
  if (parts.length >= 4) {
    const last = parts[parts.length - 1];
    if (parts.length >= 5 && /^[0-9a-f]{7,40}$/i.test(last)) {
      mergeSha = last;
      summary = parts.slice(3, -1).join(":");
    } else {
      summary = parts.slice(3).join(":");
    }
  }
  return {
    ticket,
    branch: branch || null,
    status,
    summary,
    mergeSha: mergeSha || null,
  };
}

export function parseDownstreams(arg) {
  if (!arg) return [];
  return arg
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseDownstreamEntry);
}

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

function verifyRef(ref, repoRoot) {
  const r = runCapture(
    `git rev-parse --verify --quiet ${ref}^{commit}`,
    repoRoot,
  );
  return r.ok;
}

// Returns { ok, orphans?, missingRefs?, error? }.
// ok:true with orphans=[]  — check ran cleanly, nothing orphaned
// ok:true with orphans=[…] — real orphans found
// ok:false                 — check could not run; CALLER MUST refuse
function detectOrphans(
  repoRoot,
  featureBranch,
  mergeTarget,
  downstreamBranches,
) {
  const excludeRefs = [`origin/${mergeTarget}`, ...downstreamBranches];
  const missingRefs = excludeRefs.filter((ref) => !verifyRef(ref, repoRoot));
  if (missingRefs.length > 0) {
    return { ok: false, missingRefs };
  }
  if (!verifyRef(featureBranch, repoRoot)) {
    return { ok: false, missingRefs: [featureBranch] };
  }

  const exclude = excludeRefs.map((ref) => `^${ref}`).join(" ");
  const result = runCapture(
    `git log ${featureBranch} ${exclude} --oneline`,
    repoRoot,
  );
  if (!result.ok) {
    return { ok: false, error: result.stderr?.trim() || `exit ${result.code}` };
  }
  const orphans = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { ok: true, orphans };
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

// Commits about to be discarded by `git reset --hard origin/{mergeTarget}`:
// reachable from the current feature branch but not from origin/{mergeTarget}.
function commitsBeingDiscarded(repoRoot, featureBranch, mergeTarget) {
  const r = runCapture(
    `git rev-list ${featureBranch} ^origin/${mergeTarget}`,
    repoRoot,
  );
  if (!r.ok) return null;
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Commits reachable from the union of (downstream branch refs ∪ mergeSha SHAs)
// — i.e. what we will be able to replay back onto the freshly reset branch.
function commitsReplayable(repoRoot, mergeTarget, eligibleEntries) {
  const refs = [];
  for (const d of eligibleEntries) {
    if (d.branch && verifyRef(d.branch, repoRoot)) refs.push(d.branch);
    if (d.mergeSha && verifyRef(d.mergeSha, repoRoot)) refs.push(d.mergeSha);
  }
  if (refs.length === 0) return new Set();
  const r = runCapture(
    `git rev-list ${refs.join(" ")} ^origin/${mergeTarget}`,
    repoRoot,
  );
  if (!r.ok) return null;
  return new Set(
    r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// opts:
//   repoRoot           — repo path
//   featureBranch      — long-lived feature branch to refresh
//   mergeTarget        — branch to reset onto (origin/{mergeTarget})
//   downstreams        — [{ ticket, branch, summary, status, mergeSha }, ...]
//                        in stack order. `status` ∈ "rebased" |
//                        "pushed-failed" | "conflict" | "skipped" |
//                        "not-attempted" — we only replay "rebased" or
//                        "pushed-failed". `branch` may be null when the
//                        ticket's branch was deleted by a prior terminal
//                        cleanup; `mergeSha` then carries the squash commit
//                        for cherry-pick replay.
//   skipOnConflict     — when true (default) and Step 7 reported any conflict,
//                        return outcome:"skipped-cascade-conflict" without
//                        touching the feature branch
//   cascadeStatus      — optional precomputed Step 7 verdict; if "conflict",
//                        triggers the skipOnConflict guard
//
// Returns:
//   { outcome, oldSha, remerged: [{ ticket, branch?, mergeSha?, via }],
//     orphans?, missingRefs?, orphanCheckError?,
//     dirtyWorktrees?, conflictBranch?, conflictTicket?, conflictFiles?,
//     pushError?, unresolvable?, unrecoverableCommits? }
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

  // Tickets we will attempt to replay. A ticket is eligible when its Step 7
  // status indicates the local state is correct AND we have *something* to
  // replay (a branch ref or a mergeSha).
  const eligible = downstreams.filter(
    (d) =>
      (d.status === "rebased" || d.status === "pushed-failed") &&
      (d.branch || d.mergeSha),
  );

  // NEV-863 guard 1: refuse if any mergedIntoFeature predecessor in the
  // downstream list has no replay path. Caller marks these via
  // status="rebased"/"pushed-failed" but branch:null + mergeSha:null.
  const unresolvable = downstreams.filter(
    (d) =>
      (d.status === "rebased" || d.status === "pushed-failed") &&
      !d.branch &&
      !d.mergeSha,
  );
  if (unresolvable.length > 0) {
    return {
      outcome: "skipped-unresolvable-predecessor",
      unresolvable: unresolvable.map((d) => d.ticket),
      remerged: [],
    };
  }

  // Resolve which downstream branches actually exist locally — used for both
  // orphan detection and reachability.
  const downstreamBranches = eligible
    .map((d) => d.branch)
    .filter(Boolean)
    .filter((b) => verifyRef(b, repoRoot));

  // NEV-863 fix 1: orphan check that close-fails on missing refs.
  const orphanCheck = detectOrphans(
    repoRoot,
    featureBranch,
    mergeTarget,
    downstreamBranches,
  );
  if (!orphanCheck.ok) {
    return {
      outcome: "skipped-orphan-check-failed",
      missingRefs: orphanCheck.missingRefs || [],
      orphanCheckError: orphanCheck.error || null,
      remerged: [],
    };
  }
  if (orphanCheck.orphans.length > 0) {
    return {
      outcome: "skipped-orphans",
      orphans: orphanCheck.orphans,
      remerged: [],
    };
  }

  // NEV-863 fix 2: pre-reset reachability check. Every commit we are about
  // to discard MUST be reachable from the union of replay sources (branch
  // refs ∪ mergeSha tag SHAs). If anything would be lost, refuse.
  const discarded = commitsBeingDiscarded(repoRoot, featureBranch, mergeTarget);
  if (discarded === null) {
    // We could not even enumerate what would be discarded — refuse.
    return {
      outcome: "skipped-orphan-check-failed",
      missingRefs: [],
      orphanCheckError: `rev-list ${featureBranch} ^origin/${mergeTarget} failed`,
      remerged: [],
    };
  }
  if (discarded.length > 0) {
    const replayable = commitsReplayable(repoRoot, mergeTarget, eligible);
    if (replayable === null) {
      return {
        outcome: "skipped-orphan-check-failed",
        missingRefs: [],
        orphanCheckError: "rev-list across replay sources failed",
        remerged: [],
      };
    }
    const unrecoverable = discarded.filter((sha) => !replayable.has(sha));
    if (unrecoverable.length > 0) {
      return {
        outcome: "skipped-unrecoverable-commits",
        unrecoverableCommits: unrecoverable,
        remerged: [],
      };
    }
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

  // 8e — replay eligible downstream tickets
  const remerged = [];
  let conflictBranch = null;
  let conflictFiles = null;
  let conflictTicket = null;
  let conflictVia = null;

  for (const d of eligible) {
    const branchUsable = d.branch && verifyRef(d.branch, repoRoot);
    const summary = d.summary || "";
    const label = summary
      ? `Merge ${d.ticket}: ${summary} into ${featureBranch}`
      : `Merge ${d.ticket} into ${featureBranch}`;

    let replay;
    let via;
    if (branchUsable) {
      const escapedMsg = label.replace(/"/g, '\\"');
      replay = runCapture(
        `git merge --no-ff ${d.branch} -m "${escapedMsg}"`,
        repoRoot,
      );
      via = "merge";
    } else if (d.mergeSha) {
      // The mergeSha is itself a merge commit (squash from GitHub). Use -m 1
      // so cherry-pick takes the first-parent diff. Keep author/committer
      // consistent with `git merge --no-ff` semantics via -x for traceability.
      replay = runCapture(`git cherry-pick -m 1 -x ${d.mergeSha}`, repoRoot);
      via = "cherry-pick";
    } else {
      // Filtered out above; defensive.
      continue;
    }

    if (!replay.ok) {
      conflictFiles = listConflicts(repoRoot);
      runCapture(
        via === "cherry-pick" ? "git cherry-pick --abort" : "git merge --abort",
        repoRoot,
      );
      conflictBranch = d.branch || null;
      conflictTicket = d.ticket;
      conflictVia = via;
      break;
    }
    remerged.push({
      ticket: d.ticket,
      branch: d.branch || null,
      mergeSha: d.mergeSha || null,
      via,
    });
  }

  // 8f — push (even on partial completion)
  const push = runCapture(
    `git push --force-with-lease origin ${featureBranch}`,
    repoRoot,
  );

  let outcome;
  if (conflictTicket) {
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
  if (conflictTicket) {
    result.conflictBranch = conflictBranch;
    result.conflictTicket = conflictTicket;
    result.conflictFiles = conflictFiles;
    result.conflictVia = conflictVia;
  }
  if (!push.ok) {
    result.pushError = push.stderr.trim() || `exit ${push.code}`;
  }
  return result;
}
