import { loadDevRoot } from "./config.js";
import {
  findBranch,
  getMergedPrMap,
  getOpenPrMap,
  isAncestor,
  isMergedInto,
  isSameCommit,
  isShaAncestorOf,
  isTicketMergeStandingRevertedOn,
  resolveMergedTag,
} from "./git.js";
import { getIssue, searchIssues } from "./jira.js";
import { isReviewStatus } from "./labels.js";
import { featureBranchFromContainer } from "./stacks.js";
import { resolveRepoRoot, topologicalSort } from "./util.js";

export { featureBranchFromContainer };

export function resolveContainer(fields) {
  const issuetype = fields.issuetype?.name || "";
  const parent = fields.parent;

  if (parent && ["Sub-task", "Subtask"].includes(issuetype)) {
    return {
      key: parent.key,
      type: "Story",
      summary: parent.fields?.summary || "",
    };
  }

  if (parent && parent.fields?.issuetype?.name === "Epic") {
    return {
      key: parent.key,
      type: "Epic",
      summary: parent.fields?.summary || "",
    };
  }

  const issuelinks = fields.issuelinks || [];
  for (const link of issuelinks) {
    if (link.outwardIssue?.fields?.issuetype?.name === "Epic") {
      return {
        key: link.outwardIssue.key,
        type: "Epic",
        summary: link.outwardIssue.fields?.summary || "",
      };
    }
    if (link.inwardIssue?.fields?.issuetype?.name === "Epic") {
      return {
        key: link.inwardIssue.key,
        type: "Epic",
        summary: link.inwardIssue.fields?.summary || "",
      };
    }
  }

  return null;
}

const CONTAINER_ISSUE_TYPES = new Set(["Story", "Epic", "Task"]);

export function findContainerBlockers(issuelinks) {
  const blockers = [];
  for (const link of issuelinks || []) {
    if (link.type?.inward !== "is blocked by") continue;
    const inward = link.inwardIssue;
    if (!inward) continue;
    const blockerType = inward.fields?.issuetype?.name || "";
    if (!CONTAINER_ISSUE_TYPES.has(blockerType)) continue;
    blockers.push(inward.key);
  }
  return blockers;
}

export function resolveContainerBase(issuelinks, repoRoot) {
  const blockerContainers = findContainerBlockers(issuelinks);
  if (blockerContainers.length === 0) {
    return { baseBranch: "main", blockerContainers: [], unmergedBlockers: [] };
  }

  const unmergedBlockers = blockerContainers.filter((key) => {
    if (!repoRoot) return true;
    return !isAncestor(key, "main", repoRoot);
  });

  if (unmergedBlockers.length === 0) {
    return { baseBranch: "main", blockerContainers, unmergedBlockers: [] };
  }

  if (unmergedBlockers.length === 1) {
    return {
      baseBranch: unmergedBlockers[0],
      blockerContainers,
      unmergedBlockers,
    };
  }

  const list = unmergedBlockers.join(", ");
  throw new Error(
    `Container has multiple unmerged blocker containers: ${list}. ` +
      "A feature branch can have only one base — merge one, or chain them via blocker links.",
  );
}

// A ticket is "finished" for stacking purposes when downstream work may
// safely build on it. Three independent signals, any of which suffices:
//   - Jira status category is done
//   - ClaudeStackReady / ClaudeStackComplete label
//   - it is out for review — an open PR exists, or Jira status says so
//
// The review signal used to be the ClaudeNeedsReview label. It is now passed
// in by the caller from the real sources (getOpenPrMap / Jira status name) so
// there is no label to drift out of sync with the PR.
export function isFinished(
  labels,
  statusCategoryKey,
  { inReview = false } = {},
) {
  if (statusCategoryKey === "done") return true;
  if (labels.includes("ClaudeStackReady")) return true;
  if (labels.includes("ClaudeStackComplete")) return true;
  if (inReview) return true;
  return false;
}

function ticketStatus(labels, statusCategoryKey, opts = {}) {
  if (isFinished(labels, statusCategoryKey, opts)) return "finished";
  if (labels.includes("ClaudeExecuting") || labels.includes("ClaudePlanning")) {
    return "in-progress";
  }
  return "pending";
}

function computeBaseBranch(ticket, stackTickets, featureBranch) {
  const finishedBlocker = ticket.blockers.find((bKey) => {
    const blocker = stackTickets.find((t) => t.key === bKey);
    return blocker && blocker.status === "finished";
  });

  if (finishedBlocker && featureBranch) return featureBranch;
  if (finishedBlocker && !featureBranch) return finishedBlocker;
  if (!finishedBlocker && featureBranch) return featureBranch;
  return "main";
}

function computePrTarget(featureBranch, baseBranch) {
  if (featureBranch) return featureBranch;
  return baseBranch;
}

export async function resolveStack(ticketKey, opts = {}) {
  const { repoRoot: explicitRoot } = opts;

  const issue = await getIssue(ticketKey);
  const fields = issue.fields;
  const labels = fields.labels || [];

  const container = resolveContainer(fields);

  if (!container) {
    const devRoot = loadDevRoot();
    const standaloneRepoRoot = explicitRoot || resolveRepoRoot(labels, devRoot);
    const standaloneBranch = standaloneRepoRoot
      ? findBranch(ticketKey, standaloneRepoRoot)
      : null;
    let standaloneMergedIntoMain = false;
    let standaloneMainMergeSha = null;
    let standaloneOpenPr = null;
    if (standaloneRepoRoot) {
      const mainMerged = getMergedPrMap("main", standaloneRepoRoot);
      for (const [head, sha] of mainMerged) {
        if (
          (standaloneBranch && head === standaloneBranch) ||
          head === ticketKey ||
          head.startsWith(`${ticketKey}-`) ||
          head.startsWith(`${ticketKey}/`)
        ) {
          standaloneMergedIntoMain = true;
          if (!standaloneMainMergeSha) standaloneMainMergeSha = sha || null;
        }
      }
      if (standaloneBranch && !standaloneMergedIntoMain) {
        standaloneMergedIntoMain = isMergedInto(
          standaloneBranch,
          "main",
          standaloneRepoRoot,
        );
      }
      if (standaloneBranch) {
        standaloneOpenPr =
          getOpenPrMap(standaloneRepoRoot).get(standaloneBranch) || null;
      }
    }
    const standaloneInReview =
      standaloneOpenPr !== null || isReviewStatus(fields.status?.name);
    return {
      container: null,
      stack: [
        {
          key: ticketKey,
          summary: fields.summary,
          branch: standaloneBranch,
          baseBranch: "main",
          prTarget: "main",
          status: ticketStatus(labels, fields.status?.statusCategory?.key, {
            inReview: standaloneInReview,
          }),
          labels,
          openPr: standaloneOpenPr,
          inReview: standaloneInReview,
          blockers: [],
          unblockedBlockers: [],
          eligible: true,
          mergedIntoFeature: false,
          mergedIntoMain: standaloneMergedIntoMain,
          featureMergeSha: null,
          mainMergeSha: standaloneMainMergeSha,
        },
      ],
      inputTicket: ticketKey,
      ticketIndex: 0,
    };
  }

  const containerIssue = await getIssue(container.key);
  const containerLabels = containerIssue.fields.labels || [];
  const containerSummary = container.summary || containerIssue.fields.summary;
  const branchLabel = containerLabels.find((l) => l.startsWith("branch:"));
  const featureBranch = branchLabel
    ? branchLabel.slice("branch:".length)
    : featureBranchFromContainer(container.key);

  const devRoot = loadDevRoot();
  const repoRoot =
    explicitRoot ||
    resolveRepoRoot(containerLabels, devRoot) ||
    resolveRepoRoot(labels, devRoot);

  const containerBase = resolveContainerBase(
    containerIssue.fields.issuelinks || [],
    repoRoot,
  );

  let containerBaseBranch = containerBase.baseBranch;
  if (containerBase.unmergedBlockers.length === 1) {
    const blockerKey = containerBase.unmergedBlockers[0];
    const blockerIssue = await getIssue(blockerKey);
    const blockerLabels = blockerIssue.fields?.labels || [];
    const blockerBranchLabel = blockerLabels.find((l) =>
      l.startsWith("branch:"),
    );
    containerBaseBranch = blockerBranchLabel
      ? blockerBranchLabel.slice("branch:".length)
      : blockerKey;
  }

  let parentContainerKey = null;
  let parentFeatureBranch = null;
  if (container.type === "Story") {
    const parentField = containerIssue.fields.parent;
    if (parentField && parentField.fields?.issuetype?.name === "Epic") {
      parentContainerKey = parentField.key;
      const parentIssue = await getIssue(parentField.key);
      const parentLabels = parentIssue.fields?.labels || [];
      const parentBranchLabel = parentLabels.find((l) =>
        l.startsWith("branch:"),
      );
      parentFeatureBranch = parentBranchLabel
        ? parentBranchLabel.slice("branch:".length)
        : featureBranchFromContainer(parentField.key);
    }
  }

  const jql =
    container.type === "Story"
      ? `parent = ${container.key}`
      : `"Epic Link" = ${container.key} OR parent = ${container.key}`;

  const siblings = await searchIssues(jql, [
    "summary",
    "status",
    "labels",
    "issuelinks",
    "parent",
    "issuetype",
    "assignee",
  ]);

  const blockingLinks = [];
  const ticketMap = new Map();

  // One bulk probe for the whole stack — the open-PR half of "is this out for
  // review", which used to be the ClaudeNeedsReview label.
  const openPrs = repoRoot ? getOpenPrMap(repoRoot) : new Map();

  for (const sib of siblings) {
    const sibLabels = sib.fields.labels || [];
    const sibLinks = sib.fields.issuelinks || [];
    const sibStatusKey = sib.fields.status?.statusCategory?.key;

    const blockers = sibLinks
      .filter((l) => l.type?.inward === "is blocked by" && l.inwardIssue)
      .map((l) => l.inwardIssue.key)
      .filter((bKey) => siblings.some((s) => s.key === bKey));

    for (const blocker of blockers) {
      blockingLinks.push({ from: blocker, to: sib.key });
    }

    const sibBranch = repoRoot ? findBranch(sib.key, repoRoot) : null;
    const sibOpenPr = sibBranch ? openPrs.get(sibBranch) || null : null;
    const sibInReview =
      sibOpenPr !== null || isReviewStatus(sib.fields.status?.name);

    ticketMap.set(sib.key, {
      key: sib.key,
      summary: sib.fields.summary,
      labels: sibLabels,
      statusCategoryKey: sibStatusKey,
      status: ticketStatus(sibLabels, sibStatusKey, { inReview: sibInReview }),
      branch: sibBranch,
      openPr: sibOpenPr,
      inReview: sibInReview,
      blockers,
    });
  }

  const sortInput = siblings.map((s) => ({ key: s.key }));
  const sorted = topologicalSort(sortInput, blockingLinks);
  const remaining = [...ticketMap.keys()].filter((k) => !sorted.includes(k));
  const orderedKeys = [...sorted, ...remaining];

  const featureMergedPrs =
    repoRoot && featureBranch
      ? getMergedPrMap(featureBranch, repoRoot)
      : new Map();
  const mainMergedPrs = repoRoot ? getMergedPrMap("main", repoRoot) : new Map();

  const stack = [];
  for (const key of orderedKeys) {
    const ticket = ticketMap.get(key);
    if (!ticket) continue;

    const branch = ticket.branch;
    const baseBranch = computeBaseBranch(
      ticket,
      [...ticketMap.values()],
      featureBranch,
    );
    const prTarget = computePrTarget(featureBranch, baseBranch);

    let mergedIntoFeature = false;
    let mergedIntoMain = false;
    let featureMergeSha = null;
    let mainMergeSha = null;
    // Match on the live branch first, then fall back to any merged-PR
    // headRefName that starts with the ticket key (terminal cleanup may
    // have deleted the branch locally and on origin — the PR record on
    // GitHub still carries the original headRefName + mergeCommit).
    const branchKeys = branch ? [branch] : [];
    if (featureBranch) {
      for (const [head, sha] of featureMergedPrs) {
        if (
          branchKeys.includes(head) ||
          head === key ||
          head.startsWith(`${key}-`) ||
          head.startsWith(`${key}/`)
        ) {
          mergedIntoFeature = true;
          if (!featureMergeSha) featureMergeSha = sha || null;
        }
      }
      if (repoRoot && branch && !mergedIntoFeature) {
        // A branch that merely *equals* the feature branch tip has contributed
        // nothing — it was just created from it, or /rework reset it back onto
        // it. Require a strict ancestor so that degenerate case isn't read as a
        // merge.
        mergedIntoFeature =
          isAncestor(branch, featureBranch, repoRoot) &&
          !isSameCommit(branch, featureBranch, repoRoot);
      }
    }
    for (const [head, sha] of mainMergedPrs) {
      if (
        branchKeys.includes(head) ||
        head === key ||
        head.startsWith(`${key}-`) ||
        head.startsWith(`${key}/`)
      ) {
        mergedIntoMain = true;
        if (!mainMergeSha) mainMergeSha = sha || null;
      }
    }
    if (repoRoot && branch && !mergedIntoMain) {
      mergedIntoMain = isMergedInto(branch, "main", repoRoot);
    }

    // Final fallback: the merged/{KEY} tag written by /cleanup Step 2d. It
    // survives both branch deletion and feature-branch rewrites, either of
    // which defeats the branch- and PR-record checks above — a rewritten
    // feature branch leaves the original merge commit unreachable, so the PR's
    // recorded mergeCommit no longer proves anything. /promote-to-main already
    // treats this tag as authoritative, so agreeing with it keeps the two from
    // disagreeing about what has shipped (issue #32).
    if (repoRoot && !(mergedIntoFeature && mergedIntoMain)) {
      const taggedSha = resolveMergedTag(key, repoRoot);
      if (taggedSha) {
        if (!mergedIntoFeature && featureBranch) {
          mergedIntoFeature = isShaAncestorOf(
            taggedSha,
            featureBranch,
            repoRoot,
          );
          if (mergedIntoFeature && !featureMergeSha)
            featureMergeSha = taggedSha;
        }
        if (!mergedIntoMain) {
          mergedIntoMain = isShaAncestorOf(taggedSha, "main", repoRoot);
          if (mergedIntoMain && !mainMergeSha) mainMergeSha = taggedSha;
        }
      }
    }

    // Reverts undo every signal above. /rework on an already-merged ticket
    // reverts it off the feature branch, but the merged-PR record is immutable,
    // the merge commit stays reachable, and the merged/{KEY} tag may still be
    // present — so all three keep claiming the work shipped after the code is
    // gone. Left uncorrected, the ticket-work S2.5 cleanup-prerequisites gate
    // fires on the reverted ticket and re-asserts its stale merged state, and
    // downstream tickets read as unblocked by work no longer on the branch.
    //
    // Checked last, and against the merge SHA we actually resolved, so the
    // revert overrides whichever signal supplied it.
    // The SHA-based check is tried first, then a ticket-key match: a
    // feature-branch rewrite replays the merge under a new SHA, so the revert
    // names a commit the PR record has never heard of and only the key still
    // connects the two.
    if (repoRoot) {
      if (mergedIntoFeature && featureBranch) {
        if (
          isTicketMergeStandingRevertedOn(
            key,
            featureMergeSha,
            featureBranch,
            repoRoot,
          )
        ) {
          mergedIntoFeature = false;
          featureMergeSha = null;
        }
      }
      if (mergedIntoMain) {
        if (
          isTicketMergeStandingRevertedOn(key, mainMergeSha, "main", repoRoot)
        ) {
          mergedIntoMain = false;
          mainMergeSha = null;
        }
      }
    }

    const unblockedBlockers = ticket.blockers.filter((bKey) => {
      const blocker = ticketMap.get(bKey);
      if (!blocker) return false;

      const blockerBranch = featureBranch ? blocker.branch : null;
      // The blocker's own merged/{KEY} tag is checked alongside the branch, so
      // a blocker whose branch was deleted (or whose merge commit was orphaned
      // by a feature-branch rewrite) still counts as shipped rather than
      // silently blocking everything downstream of it (issue #32).
      const blockerTagSha =
        featureBranch && repoRoot ? resolveMergedTag(bKey, repoRoot) : null;
      // Same two corrections as the mergedIntoFeature inference above: a
      // blocker sitting at the feature-branch tip has shipped nothing, and a
      // blocker whose merge was reverted no longer unblocks anything. Without
      // the revert check, /rework on a merged blocker leaves everything
      // downstream of it eligible against code that is gone.
      const blockerShipped =
        blockerBranch &&
        (isAncestor(blockerBranch, featureBranch, repoRoot) ||
          featureMergedPrs.has(blockerBranch)) &&
        !isSameCommit(blockerBranch, featureBranch, repoRoot);
      const blockerMergeSha =
        (blockerBranch ? featureMergedPrs.get(blockerBranch) : null) ||
        blockerTagSha;
      const blockerReverted =
        featureBranch &&
        repoRoot &&
        isTicketMergeStandingRevertedOn(
          bKey,
          blockerMergeSha,
          featureBranch,
          repoRoot,
        );
      const branchInFeature =
        !blockerReverted &&
        (blockerShipped ||
          (blockerTagSha &&
            isShaAncestorOf(blockerTagSha, featureBranch, repoRoot)));

      // Branch-level merge truth wins over Jira state: if the blocker's branch
      // is already in the feature branch, downstream is unblocked even when the
      // blocker still has an open main-targeting PR (shipped to the Epic
      // feature branch, awaiting /promote-to-main).
      if (branchInFeature) return false;

      if (
        !isFinished(blocker.labels, blocker.statusCategoryKey, {
          inReview: blocker.inReview,
        })
      ) {
        return true;
      }
      // ClaudeStackComplete blockers are stack-containers (Stories with their
      // own subtasks) that PR directly to main; their branch is not merged
      // into the parent's feature branch. Trust the completion label.
      if (blocker.labels.includes("ClaudeStackComplete")) return false;
      // Finished with a branch that's NOT in the feature branch (e.g. an open
      // PR under review) — still blocked.
      if (blockerBranch) return true;
      // Finished, no branch found — trust the Jira-side signal.
      return false;
    });

    const eligible =
      ticket.status !== "finished" && unblockedBlockers.length === 0;

    stack.push({
      key,
      summary: ticket.summary,
      branch,
      baseBranch,
      prTarget,
      status: ticket.status,
      statusDetail: ticket.labels.find((l) => l.startsWith("Claude")) || null,
      labels: ticket.labels,
      openPr: ticket.openPr,
      inReview: ticket.inReview,
      blockers: ticket.blockers,
      unblockedBlockers,
      eligible,
      mergedIntoFeature,
      mergedIntoMain,
      featureMergeSha,
      mainMergeSha,
    });
  }

  const ticketIndex = stack.findIndex((t) => t.key === ticketKey);

  return {
    container: {
      key: container.key,
      type: container.type,
      summary: containerSummary,
      featureBranch,
      baseBranch: containerBaseBranch,
      blockerContainers: containerBase.blockerContainers,
      unmergedBlockers: containerBase.unmergedBlockers,
      parentContainerKey,
      parentFeatureBranch,
      repoRoot,
    },
    stack,
    inputTicket: ticketKey,
    ticketIndex: ticketIndex >= 0 ? ticketIndex : 0,
  };
}
