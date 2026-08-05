// Which slash command clears a ticket's next action, and whether the dashboard
// may run it unattended.
//
// The dashboard already knows a ticket needs /cleanup-main and that the step is
// mechanical (classify-actions marks it autoSafe). It just said so in prose and
// left you to go type it. This module is the pure half of closing that gap:
// nextAction → a runnable command. The spawning lives in the API layer.
//
// Two things are deliberately NOT collapsed together:
//
//   1. `autoSafe` (from the classifier) means "no human judgement is needed to
//      decide this is the right next step". It does NOT mean "safe to run
//      without being watched" — /cleanup-main deletes remote branches and
//      transitions Jira, and commands/cleanup.md explicitly tells humans to
//      review the plan instead of passing --yes.
//   2. `runnable` (here) means the dashboard is willing to spawn it at all.
//
// Everything else is copy-to-clipboard only. That's the honest default: these
// are LLM-driven skills, not deterministic scripts, so a headless run can make
// judgement calls nobody is watching.

// Commands the dashboard will spawn, keyed by the classifier's nextAction.
//
// `args` are appended after the ticket key. The cleanup commands take --yes
// because a headless run has no one to answer the prompt — which is exactly why
// running them requires an explicit opt-in (see isExecutionEnabled).
const RUNNABLE_ACTIONS = Object.freeze({
  "cleanup-terminal": {
    command: "cleanup-main",
    args: ["--yes"],
    label: "Run cleanup",
    // Shown in the confirm dialog. Written from the command's own docs so the
    // dialog states consequences rather than just naming the command.
    effects:
      "Deletes the local and remote branch, transitions the Jira ticket to Done, cascade-rebases downstream tickets, and refreshes the feature branch.",
  },
  "cleanup-phase-1": {
    command: "cleanup-feature",
    args: ["--yes"],
    label: "Run phase-1 cleanup",
    effects:
      "Cascade-rebases sibling tickets and refreshes the Epic feature branch. Retains this ticket's branch and Jira state for /promote-to-main.",
  },
  "promote-to-main": {
    command: "promote-to-main",
    args: [],
    label: "Promote to main",
    effects:
      "Rebases the ticket branch onto main and opens a PR targeting main. Does not merge.",
  },
});

// Commands worth surfacing as copy-paste for actions the dashboard won't run
// itself. A human is the bottleneck on these by definition.
const SUGGESTED_COMMANDS = Object.freeze({
  failed: "fix-drift",
  "ticket-work": "ticket-work",
  "awaiting-review": null, // nothing to run — someone has to review the PR
  "blocked-on-stack": "stack-rebase",
  "blocked-on-container": null,
  "in-flight": null,
  unknown: null,
  idle: null,
});

// Execution is opt-in via env, not a UI toggle: a toggle in a browser tab is
// too easy to leave on, and the blast radius (deleted branches, Jira
// transitions) outlives the tab.
export function isExecutionEnabled(env = process.env) {
  return env.DASHBOARD_ALLOW_ACTIONS === "true";
}

// The action a ticket offers, if any. Pure: returns a descriptor, never spawns.
//
// Returns null when there is nothing to offer, so callers can render
// conditionally without special-casing each nextAction.
export function resolveAction(ticket) {
  const nextAction = ticket?.nextAction;
  if (!nextAction) return null;

  const runnable = RUNNABLE_ACTIONS[nextAction];
  if (runnable) {
    return {
      nextAction,
      command: runnable.command,
      label: runnable.label,
      effects: runnable.effects,
      runnable: true,
      // What a human would type. Always provided, even for runnable actions —
      // the copy-paste path stays available when execution is disabled.
      slashCommand: formatSlashCommand(runnable.command, ticket.key, []),
    };
  }

  const suggested = SUGGESTED_COMMANDS[nextAction];
  if (!suggested) return null;

  return {
    nextAction,
    command: suggested,
    label: null,
    effects: null,
    runnable: false,
    slashCommand: formatSlashCommand(suggested, ticket.key, []),
  };
}

// The `/command KEY --flags` string a human would type.
export function formatSlashCommand(command, ticketKey, args = []) {
  return [`/${command}`, ticketKey, ...args].filter(Boolean).join(" ");
}

// Validate an execution request before anything is spawned.
//
// Keyed off the ticket's *current* classification rather than trusting the
// action name in the request: the dashboard polls every 10s, so a button can be
// clicked against a stale render. Re-deriving here means a ticket that has since
// moved on can't be cleaned up twice.
export function validateActionRequest({ ticket, action, env } = {}) {
  if (!isExecutionEnabled(env)) {
    return {
      ok: false,
      error:
        "Action execution is disabled. Set DASHBOARD_ALLOW_ACTIONS=true to enable it.",
    };
  }

  if (!ticket) {
    return { ok: false, error: "Unknown ticket" };
  }

  const resolved = resolveAction(ticket);
  if (!resolved?.runnable) {
    return {
      ok: false,
      error: `No runnable action for ${ticket.key} (next action: ${ticket.nextAction || "none"})`,
    };
  }

  // Guards against a click on a stale render: the UI asked for one action, but
  // the ticket has since reclassified into another.
  if (action && action !== resolved.nextAction) {
    return {
      ok: false,
      error: `${ticket.key} is no longer ${action} — it is now ${resolved.nextAction}`,
    };
  }

  const runnable = RUNNABLE_ACTIONS[resolved.nextAction];
  return {
    ok: true,
    command: runnable.command,
    args: runnable.args,
    prompt: formatSlashCommand(runnable.command, ticket.key, runnable.args),
  };
}

export const __test__ = { RUNNABLE_ACTIONS, SUGGESTED_COMMANDS };
