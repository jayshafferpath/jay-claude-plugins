// Classify each ticket's next lifecycle action from a stacks snapshot.
//
// Implements the 8-rule first-match decision table from /orchestrate Step 3.
// Pure data → next_action; the actual side effects (running /cleanup,
// /promote-to-main, etc.) stay in the orchestrator command.
//
// Rule 1a is the only rule that needs runtime PR state (a probe against
// the parent feature branch). To avoid baking `gh` calls into this lib,
// callers pass a precomputed `mergedToParentFeatureBranch` map keyed by
// branch name. Branches that need probing but are absent from the map
// are surfaced via `pendingProbes` so the caller can fetch and re-run.

const PROGRESS_LABELS_REQUIRING_HUMAN = new Set(["ClaudeFailed"]);

const TICKET_WORK_STEPS = ["S4.2", "S4.3", "S4.6"];

function hasLabel(ticket, label) {
  return Array.isArray(ticket.labels) && ticket.labels.includes(label);
}

function classifyTicket(ticket, ctx) {
  const { container, mergedToParentFeatureBranch } = ctx;
  const branch = ticket.branch || null;

  // Rule 1
  if (ticket.mergedIntoMain === true) {
    return {
      key: ticket.key,
      nextAction: "cleanup-terminal",
      autoSafe: true,
      reason: "mergedIntoMain=true",
    };
  }

  // Rule 1a — Story-container merged to parent Epic feature branch.
  // Needs a runtime probe; only gate on it when the prefilter matches.
  //
  // Phase-1 cleanup used to be suppressed by a ClaudePendingMainPromotion
  // label. That label only memoized "phase-1 already ran", which the
  // merged/{KEY} tag records durably in git — so the caller passes
  // `phaseOneDone` from the tag probe instead.
  const isFeatureContainer =
    branch && container?.featureBranch && branch === container.featureBranch;
  const hasParent = container?.parentFeatureBranch != null;
  const phaseOneDone = ticket.phaseOneDone === true;
  const pendingProbe =
    isFeatureContainer &&
    hasParent &&
    !phaseOneDone &&
    mergedToParentFeatureBranch?.[branch] === undefined;

  if (pendingProbe) {
    return {
      key: ticket.key,
      nextAction: null,
      autoSafe: false,
      reason: "needs probe",
      pendingProbe: { branch, base: container.parentFeatureBranch },
    };
  }

  if (
    isFeatureContainer &&
    hasParent &&
    !phaseOneDone &&
    mergedToParentFeatureBranch?.[branch] === true
  ) {
    return {
      key: ticket.key,
      nextAction: "cleanup-phase-1",
      autoSafe: true,
      reason: `merged into ${container.parentFeatureBranch}, mergedIntoMain=false`,
    };
  }

  // Phase-1 already ran (merged/{KEY} tag present) but the main PR hasn't
  // landed — the ticket is awaiting /promote-to-main.
  if (isFeatureContainer && hasParent && phaseOneDone) {
    return {
      key: ticket.key,
      nextAction: "promote-to-main",
      autoSafe: true,
      reason: "phase-1 cleanup done, awaiting main promotion",
    };
  }

  // Rule 2 — ClaudeStackReady means review passed and the PR is open (into the
  // feature branch for containered tickets, into main for standalone ones).
  // There is no label-gated PR-push step anymore, so the only thing left is a
  // human reviewing and merging that PR.
  if (hasLabel(ticket, "ClaudeStackReady")) {
    return {
      key: ticket.key,
      nextAction: "awaiting-review",
      autoSafe: false,
      reason: "ClaudeStackReady",
    };
  }

  // Rule 5
  if (hasLabel(ticket, "ClaudeFailed")) {
    return {
      key: ticket.key,
      nextAction: "failed",
      autoSafe: false,
      reason: "ClaudeFailed",
      // failed_step extraction is a separate concern (activity-log read);
      // orchestrator handles it after classification.
    };
  }

  // Rule 6
  if (
    hasLabel(ticket, "ClaudeExecuting") ||
    hasLabel(ticket, "ClaudePlanning")
  ) {
    return {
      key: ticket.key,
      nextAction: "in-flight",
      autoSafe: false,
      reason: hasLabel(ticket, "ClaudeExecuting")
        ? "ClaudeExecuting"
        : "ClaudePlanning",
    };
  }

  // Rules 7 & 8
  if (hasLabel(ticket, "ClaudeReady")) {
    if (ticket.eligible === true) {
      return {
        key: ticket.key,
        nextAction: "ticket-work",
        autoSafe: false,
        reason: "ClaudeReady && eligible",
      };
    }
    return {
      key: ticket.key,
      nextAction: "blocked-on-stack",
      autoSafe: false,
      reason: "ClaudeReady && !eligible",
    };
  }

  // Rule 9 — fallthrough
  return {
    key: ticket.key,
    nextAction: "idle",
    autoSafe: false,
    reason: "no actionable label",
  };
}

function classifyStack(stack, mergedToParentFeatureBranch) {
  const container = stack.container || null;
  const tickets = Array.isArray(stack.tickets) ? stack.tickets : [];

  const containerBlocked = Array.isArray(container?.unmergedBlockers)
    ? container.unmergedBlockers
    : [];
  const isBlockedOnContainer = containerBlocked.length > 0;

  let classifications;
  if (isBlockedOnContainer) {
    classifications = tickets.map((t) => ({
      key: t.key,
      nextAction: "blocked-on-container",
      autoSafe: false,
      reason: `container blocked on ${containerBlocked.join(", ")}`,
    }));
  } else {
    classifications = tickets.map((t) =>
      classifyTicket(t, {
        container,
        mergedToParentFeatureBranch,
      }),
    );
  }

  // Stack-level needs_stack_rebase: any ticket that hasn't merged yet but
  // whose blocker has merged is potentially stale-stacked. The orchestrator
  // surfaces this as informational (manual /stack-rebase).
  let needsStackRebase = false;
  for (const t of tickets) {
    if (t.mergedIntoFeature !== false) continue;
    const blockers = Array.isArray(t.blockers) ? t.blockers : [];
    for (const blockerKey of blockers) {
      const blocker = tickets.find((x) => x.key === blockerKey);
      if (blocker?.mergedIntoFeature === true) {
        needsStackRebase = true;
        break;
      }
    }
    if (needsStackRebase) break;
  }

  return {
    container: container?.key || null,
    classifications,
    stackFlags: {
      needsStackRebase,
      blockedOnContainer: isBlockedOnContainer ? containerBlocked : null,
    },
  };
}

export function classifyActions({ stacks, mergedToParentFeatureBranch = {} }) {
  if (!Array.isArray(stacks)) {
    throw new Error("classifyActions: stacks must be an array");
  }

  const stackResults = stacks.map((stack) =>
    classifyStack(stack, mergedToParentFeatureBranch),
  );

  const pendingProbes = [];
  const queues = {
    autoSafe: [],
    asks: [],
    manual: [],
    blocked: [],
    inFlight: [],
    idle: [],
  };

  for (const s of stackResults) {
    for (const c of s.classifications) {
      if (c.pendingProbe) {
        pendingProbes.push({ ...c.pendingProbe, key: c.key });
        continue;
      }
      if (c.autoSafe) {
        queues.autoSafe.push(c);
      } else if (c.nextAction === "failed" || c.nextAction === "ticket-work") {
        queues.asks.push(c);
      } else if (
        c.nextAction === "awaiting-review" ||
        c.nextAction === "blocked-on-container" ||
        c.nextAction === "blocked-on-stack"
      ) {
        if (c.nextAction === "awaiting-review") {
          queues.manual.push(c);
        } else {
          queues.blocked.push(c);
        }
      } else if (c.nextAction === "in-flight") {
        queues.inFlight.push(c);
      } else {
        queues.idle.push(c);
      }
    }
  }

  return {
    stacks: stackResults,
    queues,
    pendingProbes,
  };
}

// Heading-based extractor for the failed-step recommendation in rule 5.
// Pure string scan — keeps the classifier free of MCP coupling.
export function extractFailedStep(activityLogText) {
  if (!activityLogText || typeof activityLogText !== "string") {
    return { failedStep: null, recommendation: null };
  }
  const lines = activityLogText.split("\n");
  // Walk newest-first if the log is appended chronologically; safer to
  // check the *last* matching heading regardless of direction.
  let found = null;
  for (const line of lines) {
    for (const step of TICKET_WORK_STEPS) {
      if (line.includes(step)) found = step;
    }
  }
  if (!found) return { failedStep: null, recommendation: null };
  const recommendation =
    found === "S4.2" ? "rework" : found === "S4.3" ? "fix-drift" : "manual";
  return { failedStep: found, recommendation };
}

export const __test__ = {
  classifyTicket,
  classifyStack,
  PROGRESS_LABELS_REQUIRING_HUMAN,
};
