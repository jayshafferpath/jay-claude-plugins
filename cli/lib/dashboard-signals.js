// Batch signal collection for the dashboard.
//
// The dashboard polls every 10s. It used to call getPrFromDevStatus() per
// ticket, which is two Jira HTTP round-trips each (issue id, then the
// undocumented /rest/dev-status/latest endpoint) — ~41 calls per tick at 20
// tickets, half of them against an endpoint with no rate-limit contract.
//
// Everything here collapses to *per-repo* calls instead of per-ticket: one
// `gh pr list` for open PRs, one for merged, one `git ls-remote` for tags. A
// stack spanning two repos costs two of each, not two per ticket.
//
// The pure fold (signals → ticket fields) is separated from the I/O so it can
// be tested without gh or git; see attachSignals.

import {
  countCommitsBehind,
  findBranch,
  getBranchLastCommitAt,
  getMergedPrMap,
  getMergedTagKeys,
  getOpenPrActivityMap,
} from "./git.js";
import { resolveRepoRoot } from "./util.js";

// Group ticket keys by the repo root their `repo:` label resolves to. Tickets
// with no resolvable repo are returned under a null key so the caller can still
// render them (label state works without git access).
export function groupTicketsByRepo(tickets, devRoot) {
  const byRoot = new Map();
  for (const ticket of tickets || []) {
    const root = resolveRepoRoot(ticket.labels || [], devRoot);
    const bucket = byRoot.get(root) || [];
    bucket.push(ticket);
    byRoot.set(root, bucket);
  }
  return byRoot;
}

// The repo a ticket belongs to, from its `repo:` label.
//
// Distinct from resolveRepoRoot, which returns null both when the label is
// missing and when it names a clone that isn't on disk. The UI needs to tell
// those apart: "no repo label" is a tagging gap, while "labelled but not
// cloned" explains why the ticket has no git-derived signals.
export function repoIdentity(labels, devRoot) {
  const repoLabel = (labels || []).find((l) => l.startsWith("repo:"));
  if (!repoLabel) return { name: null, resolved: false };
  const name = repoLabel.slice(5);
  if (!name) return { name: null, resolved: false };
  return { name, resolved: resolveRepoRoot(labels, devRoot) !== null };
}

// Fold repo identity onto each ticket. Pure apart from the existsSync inside
// resolveRepoRoot, which the caller has already paid for when grouping.
export function attachRepoIdentity(tickets, devRoot) {
  for (const ticket of tickets || []) {
    const { name, resolved } = repoIdentity(ticket.labels || [], devRoot);
    ticket.repo = name;
    ticket.repoResolved = resolved;
  }
  return tickets;
}

// Default probe set. Injectable so the batching logic can be tested without
// spawning git or gh — the real implementations live in git.js.
const DEFAULT_PROBES = Object.freeze({
  openPrActivityMap: getOpenPrActivityMap,
  mergedPrMap: getMergedPrMap,
  mergedTagKeys: getMergedTagKeys,
  branchLastCommitAt: getBranchLastCommitAt,
  commitsBehind: countCommitsBehind,
  branchFor: findBranch,
});

// One round of probes for a single repo. Returns the raw maps; the caller folds
// them onto tickets via attachSignals.
//
// A null repoRoot yields empty maps rather than throwing: a ticket whose
// `repo:` label doesn't resolve to a local clone still renders from Jira label
// state, just without git-derived signals.
export function collectRepoSignals(
  repoRoot,
  { baseBranch = "main", probes = DEFAULT_PROBES } = {},
) {
  if (!repoRoot) {
    return {
      openPrs: new Map(),
      mergedPrs: new Map(),
      mergedTags: new Set(),
    };
  }
  return {
    openPrs: probes.openPrActivityMap(repoRoot),
    mergedPrs: probes.mergedPrMap(baseBranch, repoRoot),
    mergedTags: probes.mergedTagKeys(repoRoot),
  };
}

// Fold one repo's signal maps onto its tickets. Pure — no git or gh here.
//
// Mutates the passed ticket objects in place, matching how buildStacks already
// attaches `pr`. Fields written are exactly the inputs classify-actions and
// stagnation read: branch, pr (with activity timestamps), mergedIntoMain,
// mergedIntoFeature, phaseOneDone, lastCommitAt.
export function attachSignals(tickets, signals, { featureBranch = null } = {}) {
  const { openPrs, mergedPrs, mergedTags } = signals;

  for (const ticket of tickets || []) {
    const branch = ticket.branch || null;

    const openPr = branch ? openPrs.get(branch) || null : null;
    ticket.pr = openPr
      ? {
          number: openPr.number,
          url: openPr.url,
          state: "OPEN",
          baseRef: openPr.baseRefName,
          updatedAt: openPr.updatedAt,
          lastCommitAt: openPr.lastCommitAt,
          lastReviewAt: openPr.lastReviewAt,
          lastCommentAt: openPr.lastCommentAt,
          behindBy: ticket.pr?.behindBy ?? null,
        }
      : null;

    // A merged PR into main is the authoritative terminal signal; the
    // merged/{KEY} tag records that phase-1 cleanup already ran.
    ticket.mergedIntoMain = branch ? mergedPrs.has(branch) : false;
    ticket.phaseOneDone = mergedTags.has(ticket.key);

    // mergedIntoFeature is only meaningful when there *is* a feature branch.
    // Left null (not false) otherwise so the stack-rebase rule, which tests
    // `!== false`, doesn't fire on standalone tickets.
    ticket.mergedIntoFeature = featureBranch
      ? mergedPrs.has(branch) || mergedTags.has(ticket.key)
      : null;
  }

  return tickets;
}

// Resolve branches for tickets that don't have one yet. One git call per
// ticket, but cheap (local ref lookup) and unavoidable — branch names are
// derived from ticket keys by prefix match, not stored in Jira.
export function attachBranches(
  tickets,
  repoRoot,
  { probes = DEFAULT_PROBES } = {},
) {
  for (const ticket of tickets || []) {
    if (!ticket.branch) {
      ticket.branch = probes.branchFor(ticket.key, repoRoot);
    }
  }
  return tickets;
}

// Per-ticket freshness signals for the stagnation rules. Only computed for
// tickets that could actually trigger a rule, because each is a git subprocess:
//   - lastCommitAt: needed by the abandoned-in-flight rule, so only for
//     tickets carrying an in-flight label
//   - behindBy: needed by the rotting-PR base-moved rule, so only for open PRs
//
// This gating is what keeps the poll cheap: an idle stack costs zero calls here.
export function attachFreshness(
  tickets,
  repoRoot,
  { inFlightKeys, probes = DEFAULT_PROBES } = {},
) {
  if (!repoRoot) return tickets;

  for (const ticket of tickets || []) {
    if (inFlightKeys?.has(ticket.key) && ticket.branch) {
      ticket.lastCommitAt = probes.branchLastCommitAt(ticket.branch, repoRoot);
    }
    if (ticket.pr?.state === "OPEN" && ticket.branch && ticket.pr.baseRef) {
      ticket.pr.behindBy = probes.commitsBehind(
        ticket.branch,
        ticket.pr.baseRef,
        repoRoot,
      );
    }
  }

  return tickets;
}
