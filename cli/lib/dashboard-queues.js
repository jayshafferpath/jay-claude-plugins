// Presentation constants shared by the dashboard API and the browser bundle.
//
// Deliberately dependency-free. dashboard-view.js pulls in classify-actions and
// stagnation, which are server-only; the UI needs just these tables, so they
// live apart to stay safe to bundle. dashboard-view.js re-exports them, so
// server-side callers keep importing from one place.

// Human-readable label + urgency for each nextAction the classifier emits.
// `tone` drives colour, so the UI never has to re-derive severity.
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
  // Emitted by indexClassifications for tickets the classifier could not judge
  // without a merge probe. Rendered explicitly so such a ticket never looks
  // idle when it is in fact indeterminate.
  unknown: { hint: "state unknown", tone: "unknown" },
  // Merged to main with no branch left on disk — cleanup already ran.
  // Distinguished from idle so a shipped ticket doesn't read as one nobody has
  // started.
  cleaned: { hint: "cleaned up", tone: "idle" },
  // Merged into a feature branch, but neither the branch nor the merged/{KEY}
  // tag survives — there is nothing left to replay onto main. Toned as `failed`
  // because unshippable merged work is a worse state than blocked work: no
  // command recovers it, so it needs a human before it is silently lost.
  stranded: { hint: "unshippable — needs recovery", tone: "failed" },
  idle: { hint: null, tone: "idle" },
});

// Ordering for the grouped queue view, worst/most-actionable first. `asks` and
// `manual` come before `autoSafe` because a human is the bottleneck there,
// whereas auto-safe work is mechanical and can be batched.
// `unknown` sits just above idle: it needs no immediate decision, but it must
// not hide in the idle column, which the UI collapses when actionable work
// exists. A ticket the classifier couldn't judge is a gap in the picture.
export const QUEUE_ORDER = Object.freeze([
  "asks",
  "manual",
  "autoSafe",
  "inFlight",
  "blocked",
  "unknown",
  "idle",
]);

export const QUEUE_TITLES = Object.freeze({
  asks: "Needs you",
  manual: "Awaiting review",
  autoSafe: "Ready to run",
  inFlight: "In flight",
  blocked: "Blocked",
  unknown: "Indeterminate",
  idle: "Idle",
});
