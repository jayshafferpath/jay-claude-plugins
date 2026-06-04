import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  if (stateLabel === "ClaudeStackReady") return "ready for PR?";
  if (stateLabel === "ClaudeFailed") return "investigate";
  return null;
}

export function detectWorkDir(workDir, relPath) {
  const explicit = join(workDir, relPath);
  if (existsSync(explicit)) return workDir;

  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", {
      cwd: workDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const inRepo = join(repoRoot, relPath);
    if (existsSync(inRepo)) return repoRoot;
  } catch {}

  return null;
}

export function resolveRepoRoot(labels, devRoot) {
  if (!devRoot) return null;
  const repoLabel = labels.find((l) => l.startsWith("repo:"));
  if (!repoLabel) return null;
  const candidate = join(devRoot, repoLabel.slice(5));
  return existsSync(candidate) ? candidate : null;
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
