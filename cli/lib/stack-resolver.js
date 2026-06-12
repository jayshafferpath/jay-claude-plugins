import { loadDevRoot } from "./config.js";
import { findBranch, isAncestor, isMergedInto } from "./git.js";
import { getIssue, searchIssues } from "./jira.js";
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

export function isFinished(labels, statusCategoryKey) {
  if (statusCategoryKey === "done") return true;
  if (labels.includes("ClaudeStackReady")) return true;
  if (labels.includes("ClaudeNeedsReview")) return true;
  if (labels.includes("ClaudeStackComplete")) return true;
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
      // ClaudeStackComplete blockers are stack-containers (Stories with their
      // own subtasks) that PR directly to main; their branch is not merged
      // into the parent's feature branch. Trust the completion label.
      if (blocker.labels.includes("ClaudeStackComplete")) return false;
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
