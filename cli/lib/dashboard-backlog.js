// Work that exists but the board can't see.
//
// The dashboard's JQL is `labels = ClaudeWork AND assignee = currentUser()`, so
// it only shows tickets already tagged into a stack. cli/lib/queue.js answers a
// different question — "what am I eligible to start?" — via ClaudeReady, and
// finds two things the board structurally cannot:
//
//   1. ClaudeReady tickets never tagged ClaudeWork
//   2. subtasks of a ClaudeReady parent, which inherit eligibility from the
//      parent rather than carrying labels of their own
//
// This module is the pure fold: given a discoverQueue() result and the keys
// already on the board, decide what's genuinely new. The Jira I/O stays in the
// caller, so the diff is testable without a network.

import { isReviewStatus } from "./labels.js";

// Finished or in-progress work that parent expansion sweeps back up.
//
// discoverQueue's subtask expansion queries `parent = KEY` with no status filter
// at all (queue.js), and then screens only on SUBTASK_EXCLUSION_LABELS — a list
// of *labels* that predates the retirement of ClaudeNeedsReview. So a subtask
// that shipped months ago and sits in a Done status still comes back as
// eligible. Against a real board this was 45 of 48 results.
//
// Filtered here rather than by changing discoverQueue: that function and
// SUBTASK_EXCLUSION_LABELS are documented as kept in lockstep with
// commands/ticket-work.md's resolution filter, so tightening them would change
// what the CLI picks up, not just what this panel shows.
function isAlreadyUnderway(ticket) {
  // statusCategory is the reliable signal — it collapses every project's custom
  // Done-ish status name ("Complete", "Shipped", "Closed") into one key.
  if (ticket.statusCategory === "done") return true;
  if (isReviewStatus(ticket.statusName)) return true;
  // Redundant with SUBTASK_EXCLUSION_LABELS for the parent-expansion path, but
  // this function also sees directly-queried tickets, which that filter never
  // touches.
  return (ticket.labels || []).includes("ClaudeStackReady");
}

// Tickets in the queue that the board isn't already showing and that aren't
// already underway.
//
// `via` is preserved from discoverQueue: "direct" means the ticket carried
// ClaudeReady itself, "parent" means it was reached by expanding a ClaudeReady
// parent. Worth surfacing — a parent-expanded subtask may not be labelled yet,
// which is why the board missed it.
export function diffBacklog({ queue, knownKeys } = {}) {
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys || []);
  const tickets = queue?.tickets || [];

  const unseen = tickets.filter((t) => !known.has(t.key));
  const underway = unseen.filter(isAlreadyUnderway);
  const fresh = unseen.filter((t) => !isAlreadyUnderway(t));

  return {
    tickets: fresh,
    counts: {
      total: fresh.length,
      direct: fresh.filter((t) => t.via !== "parent").length,
      viaParent: fresh.filter((t) => t.via === "parent").length,
      // Already visible on the board. Reported rather than dropped silently so
      // "0 new" is distinguishable from "the query found nothing at all".
      alreadyOnBoard: tickets.length - unseen.length,
      // Swept up by parent expansion but already in review. Counted so the
      // filtering is visible rather than looking like the query missed them.
      alreadyUnderway: underway.length,
    },
  };
}

// Subtasks that would need a label/assignee patch before they could be worked.
//
// discoverQueue computes these patches but applies nothing; a null patch means
// the subtask already inherited everything. Surfacing the non-null ones tells
// you which tickets aren't actually ready to start despite appearing eligible.
export function pendingInheritance(queue) {
  return (queue?.subtaskExpansions || [])
    .filter((e) => e.patch !== null && e.patch !== undefined)
    .map((e) => ({ child: e.child, parent: e.parent }));
}
