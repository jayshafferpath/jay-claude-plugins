import { readdirSync } from "fs";

export function glob(dir, pattern) {
  try {
    return readdirSync(dir).filter((f) => pattern.test(f));
  } catch {
    return [];
  }
}

export function labelState(labels) {
  const STATES = [
    ["ClaudeFailed", "FAILED"],
    ["ClaudeNeedsReview", "PR open"],
    ["ClaudePRApproved", "PR approved"],
    ["ClaudeStackReady", "stack ready"],
    ["ClaudeExecuting", "executing..."],
    ["ClaudePlanApproved", "plan approved"],
    ["ClaudePlanNeedsApproval", "plan ready"],
    ["ClaudePlanning", "planning..."],
    ["ClaudeReady", "ready"],
  ];

  for (const [label, display] of STATES) {
    if (labels.includes(label)) return { label, display };
  }
  return { label: null, display: "unknown" };
}

export function actionHint(stateLabel) {
  if (stateLabel === "ClaudePlanNeedsApproval") return "approve plan?";
  if (stateLabel === "ClaudeStackReady") return "approve PR?";
  if (stateLabel === "ClaudeFailed") return "investigate";
  return null;
}

export function topologicalSort(tickets, links) {
  const graph = new Map();
  const inDegree = new Map();

  for (const t of tickets) {
    graph.set(t.key, []);
    inDegree.set(t.key, 0);
  }

  for (const { from, to } of links) {
    if (graph.has(from) && graph.has(to)) {
      graph.get(from).push(to);
      inDegree.set(to, (inDegree.get(to) || 0) + 1);
    }
  }

  const queue = [];
  for (const [key, deg] of inDegree) {
    if (deg === 0) queue.push(key);
  }
  queue.sort();

  const sorted = [];
  while (queue.length) {
    const node = queue.shift();
    sorted.push(node);
    for (const neighbor of graph.get(node) || []) {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1);
      if (inDegree.get(neighbor) === 0) queue.push(neighbor);
    }
    queue.sort();
  }

  return sorted;
}
