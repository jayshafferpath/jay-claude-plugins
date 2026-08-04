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

// Whether origin/{branch} and origin/{target} point at the very same commit.
//
// Distinguishes "merged" from "sitting at the base with no work yet". A branch
// freshly created from its base — or hard-reset back onto it by /rework — is
// trivially an ancestor of that base, so isAncestor alone reports it as merged
// when it has in fact contributed nothing. A genuinely merged branch is a
// *strict* ancestor: the base carries the merge (or squash) commit on top of it,
// so the two tips differ.
export function isSameCommit(branch, target, cwd) {
  if (!branch || !target || !cwd) return false;
  const left = run(`git rev-parse --verify origin/${branch}^{commit}`, cwd);
  const right = run(`git rev-parse --verify origin/${target}^{commit}`, cwd);
  if (!left || !right) return false;
  return left === right;
}

// Whether the work introduced by {sha} has since been reverted on origin/{target}.
//
// A merge can be undone after the fact — /rework on an already-merged ticket
// reverts it off the feature branch. That leaves two misleading traces behind:
// GitHub's merged-PR record is immutable, and the merge commit itself stays
// reachable. Both keep reporting "merged" while the code is gone, so ancestry
// alone over-reports merge state and downstream tickets read as unblocked by
// work that no longer exists.
//
// Git's `This reverts commit <sha>.` trailer is the only durable evidence, so
// the branch history is what we search. A revert that has itself been reverted
// is a re-land and cancels out, which is why this recurses: only a revert still
// standing counts against the original.
export function isRevertedOn(sha, target, cwd, depth = 0) {
  if (!sha || !target || !cwd) return false;
  // Guard against pathological revert chains (and any cycle a rewritten history
  // could produce) rather than recursing without bound.
  if (depth > 10) return false;

  const result = run(
    `git log origin/${target} --format=%H --grep="This reverts commit ${sha}"`,
    cwd,
  );
  if (!result) return false;

  const reverts = result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return reverts.some(
    (revert) => !isRevertedOn(revert, target, cwd, depth + 1),
  );
}

// Whether a revert of {ticketKey}'s merge is standing on origin/{target},
// located by ticket key rather than by a specific merge SHA.
//
// isRevertedOn needs the exact SHA the revert names, but the SHA a caller has
// is often not that one: GitHub's merged-PR record pins the merge commit as it
// existed at merge time, and a later feature-branch rewrite (cascade rebase,
// /cleanup's refresh) replays that merge under a fresh SHA. The revert then
// names the *rewritten* commit while the PR record still reports the original,
// so an exact-SHA match misses a revert that is plainly there.
//
// The ticket key is the stable link across a rewrite: /rework and /prune both
// write it into the revert body, and squash-merge subjects carry it by
// convention (`feat(KEY): …`), so `Revert "feat(KEY): …"` retains it. Matching
// both the revert trailer and the key keeps this from firing on an ordinary
// commit that merely mentions the ticket.
export function isTicketMergeRevertedOn(ticketKey, target, cwd) {
  if (!ticketKey || !target || !cwd) return false;

  const result = run(
    `git log origin/${target} --format=%H --grep="This reverts commit" --grep="${ticketKey}" --all-match`,
    cwd,
  );
  if (!result) return false;

  const reverts = result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // A revert no longer counts once the work is back on the branch. That happens
  // two ways: the revert was itself reverted, or — the common one — the ticket
  // simply re-merged afterwards under a brand-new PR. The second leaves no
  // revert-of-a-revert trailer to find, so ask whether any later commit
  // re-landed the ticket instead.
  return reverts.some(
    (revert) =>
      !isRevertedOn(revert, target, cwd) &&
      !hasTicketCommitAfter(ticketKey, revert, target, cwd),
  );
}

// Whether {ticketKey} has a commit on origin/{target} that landed strictly
// after {sha}.
//
// This is what distinguishes "reverted" from "reverted, then re-landed". A
// re-merge after a revert is an ordinary new squash commit — it carries no
// `This reverts commit` trailer, so the revert-of-a-revert recursion cannot see
// it and the ticket reads as reverted forever. NEV-1441 hit exactly this: PR
// #182 merged, was reverted, then re-merged as PR #191, and the resolver kept
// reporting mergedIntoFeature: false against work plainly on the branch.
//
// The `{sha}..origin/{target}` range is what makes this safe: it only sees
// commits that are descendants of the revert, so the original pre-revert merge
// can never be mistaken for the re-land. Reverts are excluded so a revert that
// happens to name the key doesn't count as its own re-land.
export function hasTicketCommitAfter(ticketKey, sha, target, cwd) {
  if (!ticketKey || !sha || !target || !cwd) return false;

  const result = run(
    `git log ${sha}..origin/${target} --format=%H --grep="${ticketKey}"`,
    cwd,
  );
  if (!result) return false;

  const candidates = result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (candidates.length === 0) return false;

  const reverting = run(
    `git log ${sha}..origin/${target} --format=%H --grep="This reverts commit" --grep="${ticketKey}" --all-match`,
    cwd,
  );
  const revertShas = new Set(
    (reverting || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );

  return candidates.some((candidate) => !revertShas.has(candidate));
}

// Whether {ticketKey}'s work is currently reverted off origin/{target} — the
// single question every caller actually wants answered.
//
// Both signals are consulted because each covers a gap in the other:
// isTicketMergeRevertedOn finds a revert across a feature-branch rewrite (which
// changes the merge SHA), while the SHA check still catches a revert whose
// subject was reworded and no longer carries the key. Either one is enough to
// call the work reverted.
//
// A standing revert found by SHA gets the same re-land test the key path
// already applies: the work may have re-merged afterwards under a new PR, in
// which case it is on the branch and not reverted at all.
export function isTicketMergeStandingRevertedOn(
  ticketKey,
  mergeSha,
  target,
  cwd,
) {
  if (!target || !cwd) return false;

  if (ticketKey && isTicketMergeRevertedOn(ticketKey, target, cwd)) return true;

  if (!mergeSha || !isRevertedOn(mergeSha, target, cwd)) return false;

  // Reverted by SHA — unless the ticket landed again after that merge.
  return !(ticketKey && hasTicketCommitAfter(ticketKey, mergeSha, target, cwd));
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
