import { isReviewStatus } from "./labels.js";
import { topologicalSort } from "./util.js";

export function featureBranchFromContainer(containerKey) {
  if (!containerKey || containerKey === "Standalone") return null;
  return containerKey;
}

export async function attachFeatureBranches(stacks) {
  for (const stack of stacks) {
    stack.featureBranch = featureBranchFromContainer(stack.containerKey);
  }
  return stacks;
}

export function computeStackLayers(tickets) {
  const keySet = new Set(tickets.map((t) => t.key));
  const depth = new Map();

  const localBlockers = (t) => (t.blockers || []).filter((b) => keySet.has(b));

  function getDepth(ticket) {
    if (depth.has(ticket.key)) return depth.get(ticket.key);
    const parents = localBlockers(ticket);
    if (!parents.length) {
      depth.set(ticket.key, 0);
      return 0;
    }
    const maxParent = Math.max(
      ...parents.map((pKey) => {
        const parent = tickets.find((t) => t.key === pKey);
        return parent ? getDepth(parent) : 0;
      }),
    );
    depth.set(ticket.key, maxParent + 1);
    return maxParent + 1;
  }

  for (const t of tickets) getDepth(t);
  return depth;
}

export function buildStacks(issues) {
  const containerCache = new Map();
  const grouped = new Map();
  const blockingLinks = [];

  for (const issue of issues) {
    const key = issue.key;
    const fields = issue.fields;
    const labels = fields.labels || [];
    const parent = fields.parent;
    const issuetype = fields.issuetype?.name || "";

    let containerKey = null;
    if (parent && ["Sub-task", "Subtask"].includes(issuetype)) {
      containerKey = parent.key;
      if (!containerCache.has(containerKey)) {
        containerCache.set(containerKey, parent.fields?.summary || "");
      }
    } else if (parent?.fields?.issuetype?.name === "Epic") {
      containerKey = parent.key;
      if (!containerCache.has(containerKey)) {
        containerCache.set(containerKey, parent.fields?.summary || "");
      }
    } else {
      const epicLink = fields.issuelinks?.find(
        (l) =>
          l.type?.name === "Epic" ||
          l.outwardIssue?.fields?.issuetype?.name === "Epic",
      );
      if (epicLink?.outwardIssue) {
        containerKey = epicLink.outwardIssue.key;
        containerCache.set(
          containerKey,
          epicLink.outwardIssue.fields?.summary || "",
        );
      }
    }

    if (!containerKey) containerKey = "Standalone";
    if (!containerCache.has(containerKey)) {
      containerCache.set(containerKey, "");
    }

    if (!grouped.has(containerKey)) grouped.set(containerKey, []);

    const blockers = (fields.issuelinks || [])
      .filter((l) => l.type?.inward === "is blocked by" && l.inwardIssue)
      .map((l) => l.inwardIssue.key);

    const blocks = (fields.issuelinks || [])
      .filter((l) => l.type?.outward === "blocks" && l.outwardIssue)
      .map((l) => l.outwardIssue.key);

    for (const blocker of blockers) {
      blockingLinks.push({ from: blocker, to: key });
    }

    // Jira-only view (no repo access here), so review state comes from the
    // workflow status name rather than an open-PR probe.
    const isFinished = (k) =>
      issues.some(
        (i) =>
          i.key === k &&
          (i.fields.status?.statusCategory?.key === "done" ||
            i.fields.labels?.includes("ClaudeStackReady") ||
            isReviewStatus(i.fields.status?.name)),
      );

    const unfinishedBlockers = blockers.filter(
      (b) => issues.some((i) => i.key === b) && !isFinished(b),
    );

    grouped.get(containerKey).push({
      key,
      summary: fields.summary,
      labels,
      statusName: fields.status?.name || null,
      // Carried through for the stagnation rules, which need a time axis to
      // tell a ticket that just entered a state from one stuck in it. Absent
      // when the caller's JQL didn't request the `updated` field.
      updatedAt: fields.updated || null,
      blockers,
      blocks,
      waitingOn: unfinishedBlockers.length ? unfinishedBlockers[0] : null,
    });
  }

  const stacks = [];
  for (const [containerKey, tickets] of grouped) {
    const sorted = topologicalSort(tickets, blockingLinks);
    const orderedTickets = sorted
      .map((k) => tickets.find((t) => t.key === k))
      .filter(Boolean);
    const remaining = tickets.filter((t) => !sorted.includes(t.key));

    stacks.push({
      containerKey,
      containerSummary: containerCache.get(containerKey) || "",
      tickets: [...orderedTickets, ...remaining],
    });
  }

  stacks.sort((a, b) => a.containerKey.localeCompare(b.containerKey));
  return stacks;
}
