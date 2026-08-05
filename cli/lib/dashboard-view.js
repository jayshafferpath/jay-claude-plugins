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
import { detectStagnation } from "./stagnation.js";

// Human-readable label + urgency for each nextAction the classifier emits.
// The dashboard's old two-case actionHint() only knew about "awaiting review"
// and "investigate"; these are the remaining states it silently rendered as
// "idle". `tone` drives colour, so the UI never has to re-derive severity.
export const ACTION_PRESENTATION = Object.freeze({
  "cleanup-terminal": { hint: "run /cleanup-main", tone: "ready" },
  "cleanup-phase-1": { hint: "run /cleanup-feature", tone: "ready" },
  "promote-to-main": { hint: "run /promote-to-main", tone: "ready" },
  "awaiting-review": { hint: "awaiting review", tone: "review" },
  failed: { hint: "investigate", tone: "failed" },
  "in-flight": { hint: "agent working", tone: "active" },
  "ticket-work": { hint: "ready to start", tone: "ready" },
  "blocked-on-stack": { hint: "blocked on stack", tone: "blocked" },
  "blocked-on-container": { hint: "blocked on container", tone: "blocked" },
  idle: { hint: null, tone: "idle" },
});

// Ordering for the grouped queue view, worst/most-actionable first. `asks` and
// `manual` come before `autoSafe` because a human is the bottleneck there,
// whereas auto-safe work is mechanical and can be batched.
export const QUEUE_ORDER = Object.freeze([
  "asks",
  "manual",
  "autoSafe",
  "inFlight",
  "blocked",
  "idle",
]);

export const QUEUE_TITLES = Object.freeze({
  asks: "Needs you",
  manual: "Awaiting review",
  autoSafe: "Ready to run",
  inFlight: "In flight",
  blocked: "Blocked",
  idle: "Idle",
});

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
  if (nextAction === "failed" || nextAction === "ticket-work") return "asks";
  if (nextAction === "awaiting-review") return "manual";
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

  const decorated = source.map((stack) => ({
    ...stack,
    needsStackRebase:
      classified.stacks.find((s) => s.container === stack.containerKey)
        ?.stackFlags?.needsStackRebase || false,
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
