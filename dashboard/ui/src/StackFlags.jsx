// Stack-level flags from the classifier.
//
// classifyActions has always emitted stackFlags.needsStackRebase, and
// buildDashboardView folded it onto each stack, but no component read it — so a
// stack whose sibling tickets went stale after a blocker merged looked healthy.

export function StackRebaseBanner({ needsStackRebase }) {
  if (!needsStackRebase) return null;
  return (
    <div className="stack-flag stack-flag--rebase">
      <span className="stack-flag-icon">⚠</span>
      <span className="stack-flag-text">
        A blocker merged and left siblings stacked on the old base
      </span>
      <code className="stack-flag-command">/stack-rebase</code>
    </div>
  );
}

// The container itself is blocked, so nothing in the stack can proceed
// regardless of individual ticket state. Distinct from a ticket being blocked
// on its own stack — this blocks every ticket at once.
export function BlockedOnContainerBanner({ blockedOnContainer }) {
  if (!blockedOnContainer?.length) return null;
  return (
    <div className="stack-flag stack-flag--blocked">
      <span className="stack-flag-icon">⛔</span>
      <span className="stack-flag-text">
        Container blocked on {blockedOnContainer.join(", ")}
      </span>
    </div>
  );
}
