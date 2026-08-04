// Detect tickets that have stalled in the lifecycle.
//
// classify-actions answers "what is this ticket's next action?" from label and
// merge state alone — it has no time dimension, so a ticket that entered
// ClaudeExecuting ten minutes ago is indistinguishable from one whose agent
// died there nine days back. This module adds that missing axis.
//
// Everything here is pure: callers pass a `now` timestamp and pre-fetched
// activity/PR timestamps, so the rules are testable without Jira or gh. The
// side effects (posting nudges, clearing stale labels) stay in the command.

import { IN_FLIGHT_LABELS } from "./labels.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Default thresholds, in the unit each rule naturally reads in.
//
// In-flight is measured in hours, not days: a ClaudeExecuting label means an
// agent claims to be running *right now*, so half a day of silence already
// means the claim is stale. The others are genuine multi-day judgements.
export const DEFAULT_THRESHOLDS = Object.freeze({
  inFlightHours: 12,
  failedDays: 3,
  prDays: 5,
  // Commits the PR's base has advanced before the diff under review counts as
  // misleading. Small enough to catch a real stack move, large enough that
  // routine churn on a busy base branch doesn't flag every open PR.
  staleBehindCommits: 25,
});

// Rule identifiers, exported so the command and tests share one vocabulary.
export const STAGNATION_KINDS = Object.freeze({
  ABANDONED_IN_FLIGHT: "abandoned-in-flight",
  UNATTENDED_FAILURE: "unattended-failure",
  ROTTING_PR: "rotting-pr",
});

// Parse an ISO-ish timestamp to epoch ms, or null when absent/unparseable.
// Jira and gh both emit ISO 8601; a null here means "no signal", which every
// rule below treats as "cannot judge" rather than "infinitely old".
export function parseTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// Most recent of a set of timestamps. Nulls are ignored; all-null → null.
export function latestTimestamp(values) {
  const parsed = (values || []).map(parseTimestamp).filter((v) => v !== null);
  return parsed.length ? Math.max(...parsed) : null;
}

function ageMs(since, now) {
  if (since === null) return null;
  return Math.max(0, now - since);
}

function hours(ms) {
  return ms / HOUR_MS;
}

function days(ms) {
  return ms / DAY_MS;
}

// Round to one decimal so digests read cleanly without lying about precision.
function round1(n) {
  return Math.round(n * 10) / 10;
}

function inFlightLabelOn(labels) {
  if (!Array.isArray(labels)) return null;
  return IN_FLIGHT_LABELS.find((l) => labels.includes(l)) || null;
}

// Rule A — abandoned in-flight.
//
// A ClaudePlanning/ClaudeExecuting ticket whose newest signal (activity-log
// append, branch commit, or Jira update) is older than `inFlightHours`. The
// label asserts an agent is mid-run; silence that long means it isn't.
//
// Deliberately takes the *latest* of the three signals: a long TDD execute step
// can go quiet in the activity log while still committing, and vice versa.
// Requiring all three to be stale keeps false positives down.
function checkAbandonedInFlight(ticket, now, thresholds) {
  const label = inFlightLabelOn(ticket.labels);
  if (!label) return null;

  const lastSignal = latestTimestamp([
    ticket.lastActivityAt,
    ticket.lastCommitAt,
    ticket.updatedAt,
  ]);
  if (lastSignal === null) return null;

  const age = ageMs(lastSignal, now);
  if (hours(age) < thresholds.inFlightHours) return null;

  return {
    key: ticket.key,
    kind: STAGNATION_KINDS.ABANDONED_IN_FLIGHT,
    label,
    ageHours: round1(hours(age)),
    thresholdHours: thresholds.inFlightHours,
    // The label is the lie; clearing it is what unblocks the queue.
    suggestedAction: "clear-stale-in-flight",
    detail: `${label} with no activity for ${round1(hours(age))}h (threshold ${thresholds.inFlightHours}h)`,
  };
}

// Rule B — unattended failure.
//
// ClaudeFailed is surfaced by /orchestrate on every run, which is exactly how
// it becomes wallpaper: seen daily, addressed never. Past `failedDays` the
// ticket needs an explicit decision (/fix-drift, /rework, or /prune), so it is
// escalated out of the routine needs-human list.
function checkUnattendedFailure(ticket, now, thresholds) {
  if (
    !Array.isArray(ticket.labels) ||
    !ticket.labels.includes("ClaudeFailed")
  ) {
    return null;
  }

  // failedSince is the label-application time when the caller can supply it
  // (from the Jira changelog); updatedAt is the cheaper approximation.
  const since = latestTimestamp([ticket.failedSince ?? ticket.updatedAt]);
  if (since === null) return null;

  const age = ageMs(since, now);
  if (days(age) < thresholds.failedDays) return null;

  return {
    key: ticket.key,
    kind: STAGNATION_KINDS.UNATTENDED_FAILURE,
    label: "ClaudeFailed",
    ageDays: round1(days(age)),
    thresholdDays: thresholds.failedDays,
    suggestedAction: "escalate-failure",
    detail: `ClaudeFailed untouched for ${round1(days(age))}d (threshold ${thresholds.failedDays}d)`,
  };
}

// Rule C — rotting PR.
//
// Two independent ways an open PR rots:
//   1. Nobody has touched it (no commits, reviews, or comments) for `prDays`.
//   2. Its base branch has moved `staleBehindCommits` ahead — the diff under
//      review no longer reflects what merging would produce.
//
// Both are reported under one kind with a `reasons` array, because the fix
// differs (ping a reviewer vs /stack-rebase) but the triage moment is the same.
function checkRottingPr(ticket, now, thresholds) {
  const pr = ticket.pr;
  if (pr?.state !== "OPEN") return null;

  const reasons = [];
  let ageDays = null;

  const lastTouch = latestTimestamp([
    pr.lastCommitAt,
    pr.lastReviewAt,
    pr.lastCommentAt,
    pr.updatedAt,
  ]);
  if (lastTouch !== null) {
    const age = ageMs(lastTouch, now);
    if (days(age) >= thresholds.prDays) {
      ageDays = round1(days(age));
      reasons.push({
        reason: "no-activity",
        ageDays,
        thresholdDays: thresholds.prDays,
        suggestedAction: "ping-review",
      });
    }
  }

  const behind = Number.isFinite(pr.behindBy) ? pr.behindBy : null;
  if (behind !== null && behind >= thresholds.staleBehindCommits) {
    reasons.push({
      reason: "base-moved",
      behindBy: behind,
      thresholdCommits: thresholds.staleBehindCommits,
      suggestedAction: "stack-rebase",
    });
  }

  if (!reasons.length) return null;

  return {
    key: ticket.key,
    kind: STAGNATION_KINDS.ROTTING_PR,
    prNumber: pr.number ?? null,
    prUrl: pr.url ?? null,
    ageDays,
    reasons,
    // Rebasing is mechanical and safe to suggest first; a review ping needs a
    // human to actually be nudged, so it loses the tie.
    suggestedAction: reasons.some((r) => r.reason === "base-moved")
      ? "stack-rebase"
      : "ping-review",
    detail: reasons
      .map((r) =>
        r.reason === "base-moved"
          ? `PR #${pr.number} is ${r.behindBy} commits behind its base`
          : `PR #${pr.number} untouched for ${r.ageDays}d (threshold ${r.thresholdDays}d)`,
      )
      .join("; "),
  };
}

const RULES = [checkAbandonedInFlight, checkUnattendedFailure, checkRottingPr];

// Evaluate every rule against one ticket. Unlike classify-actions' first-match
// table, all rules run: a ClaudeFailed ticket can simultaneously own a rotting
// PR, and suppressing the second finding would hide real work.
export function detectTicketStagnation(ticket, { now, thresholds } = {}) {
  if (!ticket?.key) {
    throw new Error("detectTicketStagnation: ticket.key is required");
  }
  const nowMs = typeof now === "number" ? now : parseTimestamp(now);
  if (nowMs === null) {
    throw new Error("detectTicketStagnation: now must be a timestamp");
  }
  const merged = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };

  return RULES.map((rule) => rule(ticket, nowMs, merged)).filter(Boolean);
}

// Fold the per-ticket findings over a stacks snapshot, shaped like the one
// classify-actions consumes so /triage-tickets can pass the same object to both.
//
// Returns findings sorted worst-first (by kind severity, then age) so a digest
// can print the top N without re-sorting.
const KIND_SEVERITY = Object.freeze({
  [STAGNATION_KINDS.ABANDONED_IN_FLIGHT]: 0,
  [STAGNATION_KINDS.UNATTENDED_FAILURE]: 1,
  [STAGNATION_KINDS.ROTTING_PR]: 2,
});

function findingAge(f) {
  if (typeof f.ageHours === "number") return f.ageHours;
  if (typeof f.ageDays === "number") return f.ageDays * 24;
  return 0;
}

export function detectStagnation({ stacks, now, thresholds } = {}) {
  if (!Array.isArray(stacks)) {
    throw new Error("detectStagnation: stacks must be an array");
  }

  const findings = [];
  for (const stack of stacks) {
    const containerKey = stack?.container?.key || null;
    for (const ticket of stack?.tickets || []) {
      for (const finding of detectTicketStagnation(ticket, {
        now,
        thresholds,
      })) {
        findings.push({ ...finding, container: containerKey });
      }
    }
  }

  findings.sort((a, b) => {
    const sev = KIND_SEVERITY[a.kind] - KIND_SEVERITY[b.kind];
    if (sev !== 0) return sev;
    const age = findingAge(b) - findingAge(a);
    if (age !== 0) return age;
    return a.key.localeCompare(b.key);
  });

  const byKind = {};
  for (const kind of Object.values(STAGNATION_KINDS)) {
    byKind[kind] = findings.filter((f) => f.kind === kind);
  }

  return {
    findings,
    byKind,
    counts: {
      total: findings.length,
      ...Object.fromEntries(
        Object.entries(byKind).map(([k, v]) => [k, v.length]),
      ),
    },
  };
}

export const __test__ = {
  checkAbandonedInFlight,
  checkUnattendedFailure,
  checkRottingPr,
  HOUR_MS,
  DAY_MS,
};
