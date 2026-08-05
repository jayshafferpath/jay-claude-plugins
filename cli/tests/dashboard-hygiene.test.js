import { describe, expect, it } from "vitest";
import {
  classifyWorktrees,
  extractTicketKey,
  ticketKeyFor,
} from "../lib/dashboard-hygiene.js";

describe("extractTicketKey", () => {
  it.each([
    ["PROJ-123", "PROJ-123"],
    ["feature/PROJ-123", "PROJ-123"],
    ["PROJ-123-some-slug", "PROJ-123"],
    ["NEV-1443", "NEV-1443"],
    ["AB1-9", "AB1-9"],
  ])("finds the key in %s", (input, expected) => {
    expect(extractTicketKey(input)).toBe(expected);
  });

  it.each([
    ["main"],
    ["develop"],
    ["no-key-here"],
    [""],
    [null],
    [undefined],
  ])("returns null for %s", (input) => {
    expect(extractTicketKey(input)).toBeNull();
  });

  it("ignores a lowercase pseudo-key", () => {
    // Jira keys are uppercase; matching lowercase would claim branches like
    // "wip-1" as tickets.
    expect(extractTicketKey("wip-1")).toBeNull();
  });
});

describe("ticketKeyFor", () => {
  it("prefers the branch name over the directory name", () => {
    // The branch is what the lifecycle keys off; a directory can be moved.
    expect(ticketKeyFor({ path: "/dev/PROJ-1", branch: "PROJ-2" })).toBe(
      "PROJ-2",
    );
  });

  it("falls back to the directory leaf when there is no branch", () => {
    expect(ticketKeyFor({ path: "/dev/PROJ-1" })).toBe("PROJ-1");
  });

  it("returns null when neither carries a key", () => {
    expect(ticketKeyFor({ path: "/dev/scratch", branch: "main" })).toBeNull();
    expect(ticketKeyFor({})).toBeNull();
  });
});

describe("classifyWorktrees", () => {
  it("marks a worktree orphaned when no active ticket claims it", () => {
    const result = classifyWorktrees({
      worktrees: [{ path: "/dev/PROJ-9", branch: "PROJ-9" }],
      activeKeys: ["PROJ-1"],
      repoRoot: "/dev/repo",
    });
    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0]).toMatchObject({
      path: "/dev/PROJ-9",
      ticketKey: "PROJ-9",
      status: "orphaned",
    });
  });

  it("marks a worktree active when its ticket is on the board", () => {
    const result = classifyWorktrees({
      worktrees: [{ path: "/dev/PROJ-1", branch: "PROJ-1" }],
      activeKeys: ["PROJ-1"],
      repoRoot: "/dev/repo",
    });
    expect(result.counts).toMatchObject({ active: 1, orphaned: 0 });
  });

  it("never marks the main checkout orphaned", () => {
    // It appears in `git worktree list` but isn't a per-ticket worktree, and
    // suggesting its removal would be dangerous.
    const result = classifyWorktrees({
      worktrees: [{ path: "/dev/repo", branch: "main" }],
      activeKeys: [],
      repoRoot: "/dev/repo",
    });
    expect(result.worktrees[0].status).toBe("main");
    expect(result.orphaned).toEqual([]);
  });

  it("reports a keyless worktree as unknown, not orphaned", () => {
    // Someone made this by hand; the lifecycle has no claim either way, so
    // recommending deletion would overstep.
    const result = classifyWorktrees({
      worktrees: [{ path: "/dev/scratch", branch: "experiment" }],
      activeKeys: [],
      repoRoot: "/dev/repo",
    });
    expect(result.worktrees[0].status).toBe("unknown");
    expect(result.counts).toMatchObject({ unknown: 1, orphaned: 0 });
  });

  it("classifies a mixed list and counts each bucket", () => {
    const result = classifyWorktrees({
      worktrees: [
        { path: "/dev/repo", branch: "main" },
        { path: "/dev/PROJ-1", branch: "PROJ-1" },
        { path: "/dev/PROJ-8", branch: "PROJ-8" },
        { path: "/dev/PROJ-9", branch: "PROJ-9" },
        { path: "/dev/scratch", branch: "hack" },
      ],
      activeKeys: ["PROJ-1"],
      repoRoot: "/dev/repo",
    });
    expect(result.counts).toEqual({
      total: 5,
      active: 1,
      orphaned: 2,
      unknown: 1,
    });
  });

  it("skips entries with no path", () => {
    const result = classifyWorktrees({
      worktrees: [{ branch: "PROJ-1" }, { path: "/dev/PROJ-2" }],
      activeKeys: [],
      repoRoot: null,
    });
    expect(result.counts.total).toBe(1);
  });

  it("accepts activeKeys as an array or a Set", () => {
    const worktrees = [{ path: "/dev/PROJ-1", branch: "PROJ-1" }];
    expect(
      classifyWorktrees({ worktrees, activeKeys: ["PROJ-1"] }).counts.active,
    ).toBe(1);
    expect(
      classifyWorktrees({ worktrees, activeKeys: new Set(["PROJ-1"]) }).counts
        .active,
    ).toBe(1);
  });

  it("tolerates missing input", () => {
    const result = classifyWorktrees();
    expect(result.worktrees).toEqual([]);
    expect(result.counts.total).toBe(0);
  });

  it("treats every worktree as non-main without a repoRoot", () => {
    // A missing root shouldn't silently reclassify the main checkout as
    // orphaned; it has no key, so it lands in unknown instead.
    const result = classifyWorktrees({
      worktrees: [{ path: "/dev/repo", branch: "main" }],
      activeKeys: [],
    });
    expect(result.worktrees[0].status).toBe("unknown");
    expect(result.orphaned).toEqual([]);
  });
});
