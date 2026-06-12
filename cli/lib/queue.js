import { editIssue, getIssue, searchIssues } from "./jira.js";
import {
  CONTAINER_LABELS,
  PROGRESS_LABELS,
  SUBTASK_EXCLUSION_LABELS,
} from "./labels.js";
import { isFinished, resolveStack } from "./stack-resolver.js";

const FIELDS = [
  "summary",
  "status",
  "labels",
  "parent",
  "issuetype",
  "assignee",
];

// JQL queries that drive the eligible-tickets discovery (Q2 in ticket-work).
// Kept as pure constants so they can be inspected/tested without hitting Jira.
export const QUEUE_QUERIES = Object.freeze({
  readyForPlanning:
    'labels = "ClaudeReady" AND labels NOT IN ("ClaudeExecuting", "ClaudeNeedsReview", "ClaudeFailed") AND assignee = currentUser()',
  readyParents:
    'labels = "ClaudeReady" AND issueType IN (Story, Task) AND assignee = currentUser()',
  inFlight:
    'labels IN ("ClaudeExecuting", "ClaudePRApproved") AND labels NOT IN ("ClaudeNeedsReview", "ClaudeFailed") AND assignee = currentUser()',
});

// Pure helper. Given a parent issue and its subtask issue, build the labels
// patch that copies parent labels (minus ClaudeStackComplete) onto the subtask
// and inherits assignment when the subtask is unassigned.
export function buildParentInheritancePatch(parentFields, subtaskFields) {
  const parentLabels = parentFields.labels || [];
  const subtaskLabels = subtaskFields.labels || [];
  const skip = new Set(CONTAINER_LABELS);

  const labelsToAdd = parentLabels.filter(
    (l) => !skip.has(l) && !subtaskLabels.includes(l),
  );

  const patch = {};
  if (labelsToAdd.length > 0) {
    patch.labels = labelsToAdd.map((l) => ({ add: l }));
  }
  if (
    parentFields.assignee &&
    parentFields.assignee.accountId &&
    !subtaskFields.assignee
  ) {
    patch.assignee = [{ set: { accountId: parentFields.assignee.accountId } }];
  }

  return Object.keys(patch).length === 0 ? null : patch;
}

function summarize(issue, opts = {}) {
  return {
    key: issue.key,
    summary: issue.fields?.summary || "",
    labels: issue.fields?.labels || [],
    issueType: issue.fields?.issuetype?.name || null,
    parentKey: issue.fields?.parent?.key || null,
    assignee: issue.fields?.assignee?.accountId || null,
    via: opts.via || "direct",
    parentSeed: opts.parentSeed || null,
  };
}

// Run Q2 discovery: combine readyForPlanning, readyParents (expanded into
// non-excluded subtasks), and inFlight queries, dedupe by key.
//
// Returns: { tickets: [...], parents: [...] }
//
// The parents array carries full parent fields so a caller can apply Q2e
// (parent inheritance) without re-fetching them.
export async function discoverQueue() {
  const ready = await searchIssues(QUEUE_QUERIES.readyForPlanning, FIELDS);
  const parents = await searchIssues(QUEUE_QUERIES.readyParents, FIELDS);
  const inFlight = await searchIssues(QUEUE_QUERIES.inFlight, FIELDS);

  const subtasks = [];
  for (const parent of parents) {
    const children = await searchIssues(`parent = ${parent.key}`, FIELDS);
    for (const child of children) {
      const childLabels = child.fields?.labels || [];
      if (SUBTASK_EXCLUSION_LABELS.some((l) => childLabels.includes(l))) {
        continue;
      }
      subtasks.push({ child, parent });
    }
  }

  const seen = new Map();
  const push = (issue, opts = {}) => {
    if (!issue || seen.has(issue.key)) return;
    seen.set(issue.key, summarize(issue, opts));
  };

  for (const issue of ready) push(issue);
  for (const { child, parent } of subtasks) {
    push(child, { via: "parent", parentSeed: parent.key });
  }
  for (const issue of inFlight) push(issue);

  return {
    tickets: [...seen.values()],
    parents: parents.map((p) => ({
      key: p.key,
      labels: p.fields?.labels || [],
      assignee: p.fields?.assignee?.accountId || null,
    })),
    subtaskExpansions: subtasks.map(({ child, parent }) => ({
      child: child.key,
      parent: parent.key,
      patch: buildParentInheritancePatch(parent.fields, child.fields),
    })),
  };
}

// Apply Q2e inheritance (labels + assignee) for every parent → subtask pair
// produced by discoverQueue(). Skipped when the patch is null (subtask already
// matches the parent).
export async function applyParentInheritance(expansions) {
  let applied = 0;
  for (const { child, patch } of expansions) {
    if (!patch) continue;
    await editIssue(child, patch);
    applied += 1;
  }
  return applied;
}

// Find tickets that are now done and promote their unblocked downstream
// dependents by adding ClaudeReady. Uses the same isFinished/eligible rules
// that resolve-stack honors. Returns a structured report (no throwing).
export async function promoteDownstream({ repoRoot } = {}) {
  const done = await searchIssues(
    'labels = "ClaudeWork" AND statusCategory = Done AND assignee = currentUser()',
    FIELDS,
  );

  const promoted = [];
  const skipped = [];
  const stackComplete = [];

  for (const ticket of done) {
    const stack = await resolveStack(ticket.key, { repoRoot });
    if (!stack.container) continue;

    const containerIssue = await getIssue(stack.container.key);
    const containerLabels = containerIssue?.fields?.labels || [];

    for (const entry of stack.stack) {
      if (!entry.eligible) continue;
      const labels = entry.labels || [];
      // Don't re-promote tickets already in motion or finished.
      if (PROGRESS_LABELS.some((l) => labels.includes(l))) continue;
      if (isFinished(labels, undefined)) continue;
      if (entry.key === ticket.key) continue;
      try {
        await editIssue(entry.key, { labels: [{ add: "ClaudeReady" }] });
        promoted.push({
          key: entry.key,
          unblockedBy: ticket.key,
          container: stack.container.key,
        });
      } catch (err) {
        skipped.push({ key: entry.key, reason: err.message });
      }
    }

    // Detect stack completion (Q7c). isFinished is the gate.
    const allFinished = stack.stack.every((s) =>
      isFinished(s.labels, undefined),
    );
    if (
      allFinished &&
      stack.container.key &&
      !containerLabels.includes("ClaudeStackComplete")
    ) {
      stackComplete.push({
        key: stack.container.key,
        type: stack.container.type,
      });
    }
  }

  return { promoted, skipped, stackComplete };
}
