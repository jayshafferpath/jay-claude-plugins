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

  // `phaseOneDone` is the `merged/{KEY}` tag probe: the durable record that
  // phase-1 cleanup has run. Read up here because both the branchless rules
  // below and rules 1a/1b/1c all discriminate on it.
  const phaseOneDone = ticket.phaseOneDone === true;

  // A ticket merged to MAIN with no branch on record has already been cleaned.
  //
  // Branch deletion is what terminal cleanup does, and /cleanup Step 1b refuses
  // outright ("No branch on record") when the branch is gone — so dispatching
  // cleanup here can only ever halt. Queueing it as auto-safe made /orchestrate
  // hand the batch a guaranteed refusal every round.
  //
  // Branch presence is the honest discriminator rather than a proxy: findBranch
  // checks remote-tracking refs as well as local ones, and cleanup deletes both.
  // A null branch alongside a positive merge signal cannot mean "repo root
  // unresolved" — both mergedIntoMain and mergedIntoFeature are themselves
  // derived from git, so they are false when there is no repo to read.
  //
  // Scoped to mergedIntoMain deliberately. This rule used to fire on
  // `mergedIntoMain || mergedIntoFeature`, which conflated two opposite states:
  // work that has shipped, and work that merged only into a feature branch and
  // still owes a main promotion. The latter classified as `cleaned` with
  // `autoSafe: false`, so nothing in the state machine ever revisited it — the
  // self-defeating outcome rule 1c's comment warns about, reached by a different
  // route. Three commits sat unshippable on an Epic branch with no open PR to
  // main and no rule that would ever produce one.
  if (!branch && ticket.mergedIntoMain === true) {
    return {
      key: ticket.key,
      nextAction: "cleaned",
      autoSafe: false,
      reason: "merged to main with no branch on record — cleanup already ran",
    };
  }

  // Merged into a feature branch only, with no branch left on record. Phase-1
  // cleanup ran (that is what removed the branch); the main promotion has not.
  //
  // The `merged/{KEY}` tag is what makes this recoverable: /promote-to-main's
  // preferred tag-based replay cherry-picks the tagged squash commit onto fresh
  // main, which needs the tag and not the original branch. Without a tag there
  // is nothing left to replay from, so that case is surfaced for a human
  // instead of dispatched into a refusal.
  if (!branch && ticket.mergedIntoFeature === true) {
    if (phaseOneDone) {
      return {
        key: ticket.key,
        nextAction: "promote-to-main",
        autoSafe: true,
        reason:
          "merged into feature branch, branch cleaned up, merged/{KEY} tag available for replay",
      };
    }
    return {
      key: ticket.key,
      nextAction: "stranded",
      autoSafe: false,
      reason:
        "merged into feature branch but no branch and no merged/{KEY} tag — nothing left to replay onto main",
    };
  }

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

  // Rule 1c — leaf ticket merged into its container's feature branch.
  //
  // Rules 1a/1b describe a *stack-container* — a Story whose own feature branch
  // was PR'd into a parent Epic's branch — so they gate on the ticket's branch
  // BEING the container's feature branch. A leaf (a Story with no children, or a
  // subtask) has `branch !== container.featureBranch` and a null
  // `parentFeatureBranch`, so neither rule fires. Rule 1 doesn't either, since
  // `mergedIntoMain` is false. Execution used to fall through to rule 2, where
  // the still-present ClaudeStackReady label reported `awaiting-review` — "PR
  // open, waiting on a human" — for work that had already merged. A default
  // /orchestrate run skipped those tickets and reported them as blocked on the
  // user, so cleanup never ran and the `merged/{KEY}` tag it mints never
  // appeared. That tag gates the Ensure Cleanup Prerequisites sub-procedure, so
  // the omission surfaced far from its cause, in whichever later command
  // backfilled it.
  //
  // Keyed on merge state rather than branch-name shape: `mergedIntoFeature` is
  // exactly the fact resolve-stack already establishes (and already backs with
  // the merged/{KEY} tag).
  //
  // The action is `cleanup-phase-1`, NOT `cleanup-terminal`. This rule used to
  // emit terminal on the premise that a leaf "never goes through
  // /promote-to-main" and reaches main implicitly when the Epic branch does.
  // That premise is false: /promote-to-main Step 1c takes a *leaf* ticket key
  // as its argument ("If {RESOLVED_KEY} matches a ticket key in STACK_ORDER
  // (i.e. a leaf, not the container)"), and its container-key path promotes
  // leaves one at a time off GIT_MERGE_ORDER. Leaves are the ordinary unit of
  // promotion, so a leaf merged only into a feature branch has NOT shipped.
  //
  // Terminal cleanup on that state did two irreversible things too early:
  // transitioned the ticket to Done while its code sat on an unmerged feature
  // branch, and deleted the branch that Step 2a's rebase fallback still needs
  // as an UPSTREAM_BRANCH for its successor. It was also self-defeating —
  // deleting the branch makes the next classify pass hit rule 0 (`cleaned`,
  // `autoSafe: false`), so nothing ever revisits the ticket to mark it Done for
  // real once the work does land on main.
  //
  // Phase-1 is exactly the right shape: retain branch + Jira state, cascade
  // rebase siblings, refresh the Epic branch, and leave the merged/{KEY} tag in
  // place. Rule 1 then fires on the same ticket once mergedIntoMain flips,
  // running terminal cleanup when it is actually true.
  //
  // Gated on `phaseOneDone` for the same reason rule 1a is: phase-1 cleanup is
  // not idempotent as a *classification*. Once its merged/{KEY} tag exists there
  // is nothing left for it to do, and re-emitting it every pass starved the leaf
  // of the promote-to-main step that actually ships it — the branch survives
  // phase-1, so the ticket never reached the branchless rules above either. The
  // tag is exactly what /promote-to-main Step 2a needs, so a tagged leaf is
  // promotable now.
  if (
    ticket.mergedIntoFeature === true &&
    ticket.mergedIntoMain !== true &&
    !isFeatureContainer
  ) {
    if (phaseOneDone) {
      return {
        key: ticket.key,
        nextAction: "promote-to-main",
        autoSafe: true,
        reason: "phase-1 cleanup done, awaiting main promotion",
      };
    }
    return {
      key: ticket.key,
      nextAction: "cleanup-phase-1",
      autoSafe: true,
      reason: "merged into feature branch, awaiting main promotion",
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

// Whether a ticket's branch has actually diverged from the base it would rebase
// onto. `hasUniqueCommits` is supplied by the caller (the CLI probes git); when
// it's absent we can't tell, and the flag stays permissive so a real staleness
// case isn't hidden by a missing probe.
function isStaleAgainstBase(ticket) {
  return ticket.hasUniqueCommits !== false;
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

  // Stack-level needs_stack_rebase: a ticket that hasn't merged yet, whose
  // blocker HAS merged, and whose branch has actually diverged from the base.
  //
  // The first two conditions alone aren't staleness. A branch cut fresh from the
  // feature branch after its blocker merged satisfies both while being
  // byte-identical to its base — nothing to rebase. Without the third condition
  // the flag fires on every freshly-created downstream branch, so /orchestrate
  // offers a no-op /stack-rebase whose only signal value is noise.
  //
  // The orchestrator surfaces this as informational (manual /stack-rebase).
  let needsStackRebase = false;
  for (const t of tickets) {
    if (t.mergedIntoFeature !== false) continue;
    if (!isStaleAgainstBase(t)) continue;
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
        c.nextAction === "stranded" ||
        c.nextAction === "blocked-on-container" ||
        c.nextAction === "blocked-on-stack"
      ) {
        // `stranded` joins the manual queue rather than blocked/idle: the work
        // has merged somewhere and cannot be recovered mechanically, so a human
        // has to decide how to get it onto main. Bucketing it as idle is what let
        // the original strand go unnoticed.
        if (c.nextAction === "awaiting-review" || c.nextAction === "stranded") {
          queues.manual.push(c);
        } else {
          queues.blocked.push(c);
        }
      } else if (c.nextAction === "in-flight") {
        queues.inFlight.push(c);
      } else {
        // `cleaned` lands here alongside `idle`: nothing is owed on either, and
        // the distinction is carried on nextAction for the renderers.
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
