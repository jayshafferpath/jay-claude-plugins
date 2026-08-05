// Disk state the lifecycle leaves behind.
//
// ensureWorkDir creates a worktree per ticket at <repoRoot>/../<KEY>, and
// /cleanup removes it when the ticket ships. Anything that skipped cleanup —
// an abandoned run, a /prune, a ticket someone finished by hand — leaves the
// worktree on disk with nothing pointing at it. Nothing in the dashboard has
// ever shown them, so they accumulate silently.
//
// Pure classification: the caller supplies getWorktreeList() output and the set
// of keys still on the board, and this decides which worktrees are orphaned.

// Worktrees git reports but that no active ticket claims.
//
// `activeKeys` is the board's ticket set. A worktree whose branch names a key
// that's gone from the board is a cleanup that didn't finish.
//
// The main checkout is always excluded: it's in `git worktree list` output but
// it isn't a per-ticket worktree, and suggesting its removal would be actively
// dangerous.
export function classifyWorktrees({ worktrees, activeKeys, repoRoot } = {}) {
  const active =
    activeKeys instanceof Set ? activeKeys : new Set(activeKeys || []);
  const entries = [];

  for (const wt of worktrees || []) {
    if (!wt?.path) continue;

    const isMain = repoRoot ? wt.path === repoRoot : false;
    const ticketKey = ticketKeyFor(wt);
    // No derivable key means this isn't a lifecycle worktree — someone made it
    // by hand. Reported as unknown rather than orphaned: the lifecycle has no
    // claim either way, so recommending deletion would overstep.
    const claimed = ticketKey ? active.has(ticketKey) : false;

    entries.push({
      path: wt.path,
      branch: wt.branch || null,
      ticketKey,
      isMain,
      status: isMain
        ? "main"
        : !ticketKey
          ? "unknown"
          : claimed
            ? "active"
            : "orphaned",
    });
  }

  const orphaned = entries.filter((e) => e.status === "orphaned");

  return {
    worktrees: entries,
    orphaned,
    counts: {
      total: entries.length,
      active: entries.filter((e) => e.status === "active").length,
      orphaned: orphaned.length,
      unknown: entries.filter((e) => e.status === "unknown").length,
    },
  };
}

// The ticket key a worktree belongs to.
//
// Prefers the branch name over the directory name: ensureWorkDir names the
// directory after the key, but a branch can be renamed or checked out elsewhere,
// and the branch is what the lifecycle actually keys off.
export function ticketKeyFor(worktree) {
  const fromBranch = extractTicketKey(worktree?.branch);
  if (fromBranch) return fromBranch;
  const leaf = (worktree?.path || "").split("/").filter(Boolean).pop();
  return extractTicketKey(leaf);
}

// PROJ-123 anywhere in a string. Branch names in this lifecycle are either the
// bare key or carry it as a prefix/segment.
const TICKET_KEY_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/;

export function extractTicketKey(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(TICKET_KEY_PATTERN);
  return match ? match[1] : null;
}
