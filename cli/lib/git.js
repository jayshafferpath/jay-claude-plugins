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

  // A revert that was itself reverted is a re-land, so it no longer counts.
  return reverts.some((revert) => !isRevertedOn(revert, target, cwd));
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

// Committer date of a branch's tip, as an ISO 8601 string, or null when the
// branch is unknown. Prefers the remote ref: an abandoned agent may have left
// local commits, but a branch nobody pushed is exactly the stalled case the
// stagnation rules want to catch, so the local ref is only a fallback.
export function getBranchLastCommitAt(branch, cwd) {
  if (!branch || !cwd) return null;
  const remote = run(
    `git log -1 --format=%cI 'refs/remotes/origin/${branch}'`,
    cwd,
  );
  if (remote) return remote;
  return run(`git log -1 --format=%cI 'refs/heads/${branch}'`, cwd);
}

// Open PRs with the timestamps the stagnation rules need, keyed by head branch.
// One `gh` call for the whole repo, mirroring getOpenPrMap — that map is
// intentionally left alone because its callers only need existence, and adding
// review/commit payloads to it would slow every /ticket-status run.
//
// `behindBy` is not a field `gh pr list` exposes, so callers that need the
// base-moved rule compute it via countCommitsBehind below.
export function getOpenPrActivityMap(cwd) {
  if (!cwd) return new Map();
  const result = run(
    "gh pr list --state open --limit 200 --json " +
      "headRefName,number,url,updatedAt,baseRefName,commits,reviews,comments",
    cwd,
  );
  if (!result) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    return new Map();
  }

  // ISO 8601 sorts lexicographically, so the last entry is the newest.
  const newest = (items, field) => {
    const stamps = (items || [])
      .map((i) => i?.[field])
      .filter(Boolean)
      .sort();
    return stamps.length ? stamps[stamps.length - 1] : null;
  };

  const map = new Map();
  for (const pr of parsed) {
    const head = pr?.headRefName;
    if (!head || map.has(head)) continue;
    map.set(head, {
      number: pr.number ?? null,
      url: pr.url ?? null,
      state: "OPEN",
      baseRefName: pr.baseRefName || null,
      updatedAt: pr.updatedAt || null,
      lastCommitAt: newest(pr.commits, "committedDate"),
      lastReviewAt: newest(pr.reviews, "submittedAt"),
      lastCommentAt: newest(pr.comments, "createdAt"),
    });
  }
  return map;
}

// How many commits `base` is ahead of `branch` — i.e. how far the PR's diff has
// fallen behind what merging would actually produce. Returns null when either
// ref is unresolvable, which callers treat as "cannot judge".
export function countCommitsBehind(branch, base, cwd) {
  if (!branch || !base || !cwd) return null;
  const result = run(
    `git rev-list --count 'origin/${branch}..origin/${base}'`,
    cwd,
  );
  if (result === null) return null;
  const n = Number.parseInt(result, 10);
  return Number.isNaN(n) ? null : n;
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
