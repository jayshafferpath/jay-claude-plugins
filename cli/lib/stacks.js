import { topologicalSort } from "./util.js";

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

    const isFinished = (k) =>
      issues.some(
        (i) =>
          i.key === k &&
          (i.fields.status?.statusCategory?.key === "done" ||
            i.fields.labels?.includes("ClaudeStackReady") ||
            i.fields.labels?.includes("ClaudeNeedsReview")),
      );

    const unfinishedBlockers = blockers.filter(
      (b) => issues.some((i) => i.key === b) && !isFinished(b),
    );

    grouped.get(containerKey).push({
      key,
      summary: fields.summary,
      labels,
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
