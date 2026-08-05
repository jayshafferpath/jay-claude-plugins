// Per-ticket badges for signals the server already computes but nothing rendered.
//
// The stagnation findings were only visible in the global StagnationPanel, so a
// row in a stack gave no hint it was rotting — you had to cross-reference by key.
// These put the signal on the ticket itself.

// Compact glyph + tooltip per stagnation kind. Deliberately terse: these sit
// inline in a dense row, and the full detail is a hover away.
const STALL_BADGES = {
  "abandoned-in-flight": { glyph: "◷", label: "abandoned mid-run" },
  "unattended-failure": { glyph: "!", label: "unattended failure" },
  "rotting-pr": { glyph: "◑", label: "rotting PR" },
};

export function StallBadges({ findings }) {
  if (!findings?.length) return null;

  return (
    <>
      {findings.map((finding, i) => {
        const badge = STALL_BADGES[finding.kind] || {
          glyph: "•",
          label: finding.kind,
        };
        return (
          <span
            key={`${finding.kind}-${i}`}
            className={`stall-badge stall-badge--${finding.kind}`}
            title={finding.detail || badge.label}
          >
            {badge.glyph} {badge.label}
          </span>
        );
      })}
    </>
  );
}

// The repo a ticket belongs to. Only worth showing when a view actually mixes
// repos — a single-repo board would just repeat the same badge on every row —
// so callers pass `show`.
//
// A labelled-but-unresolved repo is called out rather than hidden: it's the
// reason the ticket has no branch, PR, or merge state, which otherwise reads as
// "nothing has happened yet".
export function RepoBadge({ repo, resolved, show }) {
  if (!show || !repo) return null;
  return (
    <span
      className={`repo-badge ${resolved ? "" : "repo-badge--unresolved"}`}
      title={
        resolved
          ? `repo: ${repo}`
          : `repo: ${repo} — not cloned locally, so branch and PR state are unavailable`
      }
    >
      {repo}
      {!resolved && " ⚠"}
    </span>
  );
}

// True when the tickets span more than one repo, or any names a repo that isn't
// cloned. Either way the repo column carries information.
export function shouldShowRepo(tickets) {
  const names = new Set();
  let hasUnresolved = false;
  for (const ticket of tickets || []) {
    if (ticket.repo) names.add(ticket.repo);
    if (ticket.repo && !ticket.repoResolved) hasUnresolved = true;
  }
  return names.size > 1 || hasUnresolved;
}
