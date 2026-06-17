// Canonical Claude lifecycle labels.
//
// Single source of truth shared by CLIs and consumed (by reference) from the
// command markdown files. Anything in /commands/*.md that enumerates Claude
// lifecycle labels MUST cite this file rather than re-listing the labels
// inline — that's the rule that keeps cleanup.md, rework.md, prune.md, and
// ticket-work.md from drifting out of sync.

// Durable tags. Set once and never removed by the lifecycle.
export const DURABLE_LABELS = Object.freeze(["ClaudeWork"]);

// Per-ticket progress states. At most one of these is "active" at a time;
// the lifecycle promotes through them in order. /rework and /prune both
// remove every entry in this list before re-applying their own marker.
export const PROGRESS_LABELS = Object.freeze([
  "ClaudeReady",
  "ClaudeDriftChecked",
  "ClaudePlanning",
  "ClaudeExecuting",
  "ClaudeStackReady",
  "ClaudePRApproved",
  "ClaudeNeedsReview",
  "ClaudePendingMainPromotion",
  "ClaudeMainPR",
  "ClaudeFailed",
]);

// Container-level (Story/Epic) signals.
export const CONTAINER_LABELS = Object.freeze(["ClaudeStackComplete"]);

// Terminal abandonment marker applied by /prune.
export const TERMINAL_LABELS = Object.freeze(["ClaudePruned"]);

// Every Claude-prefixed label the lifecycle ever touches.
export const ALL_LIFECYCLE_LABELS = Object.freeze([
  ...DURABLE_LABELS,
  ...PROGRESS_LABELS,
  ...CONTAINER_LABELS,
  ...TERMINAL_LABELS,
]);

// Labels that mean "another agent is mid-flight on this ticket". Used by
// queue gating and by the orchestrator's classifier.
export const IN_FLIGHT_LABELS = Object.freeze([
  "ClaudePlanning",
  "ClaudeExecuting",
]);

// Labels that disqualify a subtask from being picked up via parent expansion.
// Mirrors the exclusion filter in commands/ticket-work.md "Standard ticket
// resolution" — keep these in lockstep.
export const SUBTASK_EXCLUSION_LABELS = Object.freeze([
  "ClaudePlanning",
  "ClaudeExecuting",
  "ClaudeStackReady",
  "ClaudePRApproved",
  "ClaudeNeedsReview",
  "ClaudeFailed",
]);

// Complexity tier labels. Set once at intake (manually, or by ticket-work's
// classification step when no label is present) and never removed by the
// lifecycle. Drives which steps in S4 actually run — `complexity:trivial`
// drops S4.1 (plan), S4.4 (refactor), S4.5/S4.6 (pr-review). Absent label
// means standard.
export const COMPLEXITY_LABELS = Object.freeze([
  "complexity:trivial",
  "complexity:standard",
]);

export const COMPLEXITY_TRIVIAL = "trivial";
export const COMPLEXITY_STANDARD = "standard";

// Returns the complexity tier for a ticket given its labels. Defaults to
// "standard" when no complexity label is set. If both trivial and standard
// are set (shouldn't happen, but defensive), trivial wins — the lighter
// path is the more conservative choice when the human signal is ambiguous.
export function getComplexity(labels) {
  if (!Array.isArray(labels)) return COMPLEXITY_STANDARD;
  if (labels.includes("complexity:trivial")) return COMPLEXITY_TRIVIAL;
  return COMPLEXITY_STANDARD;
}

// Optional Jira workflow status transitions triggered when a progress label
// is set. Keys are PROGRESS_LABELS; values are candidate transition names
// matched case-insensitively (first match wins). Used by setTicketState to
// keep Jira status in sync with the lifecycle label. Tickets stuck in a
// workflow without any matching transition fall through with a warning —
// the label change still applies.
export const LABEL_TO_STATUS_TRANSITIONS = Object.freeze({
  ClaudeNeedsReview: Object.freeze(["In Review", "Code Review", "Review"]),
});

// Display ordering for label-state classifiers. First match wins, so the
// most-advanced state appears first.
export const LABEL_DISPLAY_ORDER = Object.freeze([
  ["ClaudeFailed", "FAILED"],
  ["ClaudeNeedsReview", "PR open"],
  ["ClaudePRApproved", "PR approved"],
  ["ClaudeStackReady", "stack ready"],
  ["ClaudeExecuting", "executing..."],
  ["ClaudePlanning", "planning..."],
  ["ClaudeReady", "ready"],
]);

// Returns the set of progress labels currently applied to a ticket.
export function progressLabelsOn(labels) {
  if (!Array.isArray(labels)) return [];
  return PROGRESS_LABELS.filter((l) => labels.includes(l));
}

// Returns the JSON-Patch-style label removals for clearing every progress
// label that's currently set. Useful for /rework and /prune so they don't
// have to enumerate the list themselves.
export function clearProgressLabelsPatch(labels) {
  return progressLabelsOn(labels).map((label) => ({ remove: label }));
}

// True when any in-flight label is present.
export function isInFlight(labels) {
  if (!Array.isArray(labels)) return false;
  return IN_FLIGHT_LABELS.some((l) => labels.includes(l));
}
