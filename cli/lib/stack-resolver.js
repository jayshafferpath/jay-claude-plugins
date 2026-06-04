import { loadDevRoot } from "./config.js";
import { findBranch, isAncestor, isMergedInto } from "./git.js";
import { getIssue, searchIssues } from "./jira.js";
import { resolveRepoRoot, topologicalSort } from "./util.js";

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

export function detectFeatureBranch(labels) {
  const branchLabel = (labels || []).find((l) => l.startsWith("branch:"));
  return branchLabel ? branchLabel.slice(7) : null;
}

export function isFinished(labels, statusCategoryKey) {
  if (statusCategoryKey === "done") return true;
  if (labels.includes("ClaudeStackReady")) return true;
  if (labels.includes("ClaudeNeedsReview")) return true;
  return false;
}

function ticketStatus(labels, statusCategoryKey) {
  if (isFinished(labels, statusCategoryKey)) return "finished";
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
    return {
      container: null,
      stack: [
        {
          key: ticketKey,
          summary: fields.summary,
          branch: null,
          baseBranch: "main",
          prTarget: "main",
          status: ticketStatus(labels, fields.status?.statusCategory?.key),
          labels,
          blockers: [],
          unblockedBlockers: [],
          eligible: true,
          mergedIntoFeature: false,
          mergedIntoMain: false,
        },
      ],
      inputTicket: ticketKey,
      ticketIndex: 0,
    };
  }

  const containerIssue = await getIssue(container.key);
  const containerLabels = containerIssue.fields.labels || [];
  const featureBranch = detectFeatureBranch(containerLabels);

  const devRoot = loadDevRoot();
  const repoRoot =
    explicitRoot ||
    resolveRepoRoot(containerLabels, devRoot) ||
    resolveRepoRoot(labels, devRoot);

  let jql;
  if (container.type === "Story") {
    jql = `parent = ${container.key}`;
  } else {
    jql = `"Epic Link" = ${container.key} OR parent = ${container.key}`;
  }

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

    ticketMap.set(sib.key, {
      key: sib.key,
      summary: sib.fields.summary,
      labels: sibLabels,
      statusCategoryKey: sibStatusKey,
      status: ticketStatus(sibLabels, sibStatusKey),
      blockers,
    });
  }

  const sortInput = siblings.map((s) => ({ key: s.key }));
  const sorted = topologicalSort(sortInput, blockingLinks);
  const remaining = [...ticketMap.keys()].filter((k) => !sorted.includes(k));
  const orderedKeys = [...sorted, ...remaining];

  const stack = [];
  for (const key of orderedKeys) {
    const ticket = ticketMap.get(key);
    if (!ticket) continue;

    const branch = repoRoot ? findBranch(key, repoRoot) : null;
    const baseBranch = computeBaseBranch(
      ticket,
      [...ticketMap.values()],
      featureBranch,
    );
    const prTarget = computePrTarget(featureBranch, baseBranch);

    let mergedIntoFeature = false;
    let mergedIntoMain = false;
    if (repoRoot && branch) {
      if (featureBranch) {
        mergedIntoFeature = isAncestor(branch, featureBranch, repoRoot);
      }
      mergedIntoMain = isMergedInto(branch, "main", repoRoot);
    }

    const unblockedBlockers = ticket.blockers.filter((bKey) => {
      const blocker = ticketMap.get(bKey);
      if (!blocker) return false;
      if (!isFinished(blocker.labels, blocker.statusCategoryKey)) return true;
      if (featureBranch && repoRoot) {
        const blockerBranch = findBranch(bKey, repoRoot);
        if (
          blockerBranch &&
          !isAncestor(blockerBranch, featureBranch, repoRoot)
        ) {
          return true;
        }
      }
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
      blockers: ticket.blockers,
      unblockedBlockers,
      eligible,
      mergedIntoFeature,
      mergedIntoMain,
    });
  }

  const ticketIndex = stack.findIndex((t) => t.key === ticketKey);

  return {
    container: {
      key: container.key,
      type: container.type,
      summary: container.summary || containerIssue.fields.summary,
      featureBranch,
      repoRoot,
    },
    stack,
    inputTicket: ticketKey,
    ticketIndex: ticketIndex >= 0 ? ticketIndex : 0,
  };
}
