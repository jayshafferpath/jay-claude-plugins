// Pure view-model assembly for the dashboard.
//
// The dashboard used to mirror Jira labels and re-derive a weaker version of
// what classify-actions and stagnation already compute. This module is the
// seam: callers fetch the raw signals (Jira issues, batch git/gh probes) and
// pass them in; everything here is a pure transform, so the rules are testable
// without Jira, gh, or a browser.
//
// Two responsibilities, deliberately kept apart from the I/O:
//   1. reshape a dashboard `stacks` array into the shape classify-actions and
//      stagnation expect (they were written for /orchestrate's snapshot, which
//      nests a `container` object the dashboard doesn't build)
//   2. fold their findings back onto the per-ticket objects the UI renders

import { classifyActions } from "./classify-actions.js";
// The presentation tables live in dashboard-queues.js so the browser bundle can
// import them without pulling in this module's server-only dependencies
// (classify-actions and stagnation). Imported here for use below, and
// re-exported because server-side callers already import them from this path.
import {
  ACTION_PRESENTATION,
  QUEUE_ORDER,
  QUEUE_TITLES,
} from "./dashboard-queues.js";
import { detectStagnation } from "./stagnation.js";

export { ACTION_PRESENTATION, QUEUE_ORDER, QUEUE_TITLES };

// Adapt the dashboard's flat stack shape to the snapshot shape the classifier
// and stagnation detector were written against.
//
// The dashboard stack carries containerKey/featureBranch as flat strings;
// /orchestrate passes a nested `container` object that also holds
// parentFeatureBranch and unmergedBlockers. Absent those, the classifier's
// phase-1 rules simply don't fire — which is correct, not a silent failure:
// without a parent feature branch there is no phase-1 to detect.
export function toClassifierSnapshot(stacks) {
  return (stacks || []).map((stack) => ({
    container: {
      key: stack.containerKey === "Standalone" ? null : stack.containerKey,
      featureBranch: stack.featureBranch || null,
      parentFeatureBranch: stack.parentFeatureBranch || null,
      unmergedBlockers: stack.unmergedBlockers || [],
    },
    tickets: stack.tickets || [],
  }));
}

// Index a classifyActions() result by ticket key.
//
// pendingProbes are folded in as an explicit "unknown" classification. The
// classifier removes those tickets from its queues entirely (it cannot judge
// them without a merge probe), and dropping them here would make a ticket
// silently vanish from the UI — worse than showing it as indeterminate.
export function indexClassifications(result) {
  const byKey = new Map();

  for (const stack of result?.stacks || []) {
    for (const c of stack.classifications || []) {
      if (c.pendingProbe) continue;
      byKey.set(c.key, c);
    }
  }

  for (const probe of result?.pendingProbes || []) {
    byKey.set(probe.key, {
      key: probe.key,
      nextAction: "unknown",
      autoSafe: false,
      reason: `awaiting merge probe of ${probe.branch} against ${probe.base}`,
    });
  }

  return byKey;
}

// Which queue a classification belongs to. Mirrors the bucketing inside
// classifyActions so the UI can group tickets without the caller re-deriving
// it, and so a pendingProbe ticket lands somewhere visible.
export function queueForClassification(classification) {
  if (!classification) return "idle";
  const { nextAction, autoSafe } = classification;
  if (autoSafe) return "autoSafe";
  if (nextAction === "unknown") return "unknown";
  if (nextAction === "failed" || nextAction === "ticket-work") return "asks";
  if (nextAction === "awaiting-review" || nextAction === "stranded") {
    return "manual";
  }
  if (
    nextAction === "blocked-on-container" ||
    nextAction === "blocked-on-stack"
  ) {
    return "blocked";
  }
  if (nextAction === "in-flight") return "inFlight";
  return "idle";
}

// Group stagnation findings by ticket key. A ticket can own more than one
// finding (a ClaudeFailed ticket with a rotting PR), and both matter, so this
// keeps every finding rather than picking a winner.
export function indexStagnation(result) {
  const byKey = new Map();
  for (const finding of result?.findings || []) {
    const existing = byKey.get(finding.key);
    if (existing) {
      existing.push(finding);
    } else {
      byKey.set(finding.key, [finding]);
    }
  }
  return byKey;
}

// Fold classifier + stagnation output onto each ticket, and return the queue
// grouping alongside. Does not mutate the input stacks.
//
// `now` is a required parameter rather than a Date.now() call so the stagnation
// rules stay deterministic under test.
export function buildDashboardView({ stacks, now, thresholds } = {}) {
  const source = stacks || [];
  const snapshot = toClassifierSnapshot(source);

  const classified = classifyActions({ stacks: snapshot });
  const byKey = indexClassifications(classified);

  const stagnation = detectStagnation({ stacks: snapshot, now, thresholds });
  const stagnationByKey = indexStagnation(stagnation);

  const queues = Object.fromEntries(QUEUE_ORDER.map((q) => [q, []]));

  const decorated = source.map((stack, stackIndex) => ({
    ...stack,
    // Zipped by index, not looked up by container key. classifyActions maps
    // 1:1 over the snapshot, and every standalone stack classifies to
    // `container: null` — matching on key made the flag unreachable for those
    // stacks and ambiguous whenever two of them coexisted.
    needsStackRebase:
      classified.stacks[stackIndex]?.stackFlags?.needsStackRebase || false,
    blockedOnContainer:
      classified.stacks[stackIndex]?.stackFlags?.blockedOnContainer || null,
    tickets: (stack.tickets || []).map((ticket) => {
      const classification = byKey.get(ticket.key) || null;
      const nextAction = classification?.nextAction || "idle";
      const presentation = ACTION_PRESENTATION[nextAction] || {
        hint: null,
        tone: "idle",
      };
      const queue = queueForClassification(classification);
      const findings = stagnationByKey.get(ticket.key) || [];

      queues[queue].push(ticket.key);

      return {
        ...ticket,
        nextAction,
        nextActionReason: classification?.reason || null,
        // Overrides the old label-derived hint. Kept on the same field name so
        // TicketRow needs no change beyond richer values.
        actionHint: presentation.hint,
        actionTone: presentation.tone,
        autoSafe: classification?.autoSafe === true,
        stagnation: findings,
      };
    }),
  }));

  return {
    stacks: decorated,
    queues,
    stagnation: {
      findings: stagnation.findings,
      counts: stagnation.counts,
    },
  };
}
