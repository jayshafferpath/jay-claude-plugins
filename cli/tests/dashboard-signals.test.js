import { describe, expect, it, vi } from "vitest";
import {
  attachBranches,
  attachFreshness,
  attachSignals,
  collectRepoSignals,
  groupTicketsByRepo,
} from "../lib/dashboard-signals.js";

// Stub probe set so the batching logic is testable without git or gh.
function fakeProbes(overrides = {}) {
  return {
    openPrActivityMap: vi.fn(() => new Map()),
    mergedPrMap: vi.fn(() => new Map()),
    mergedTagKeys: vi.fn(() => new Set()),
    branchLastCommitAt: vi.fn(() => "2026-08-01T00:00:00Z"),
    commitsBehind: vi.fn(() => 30),
    branchFor: vi.fn((key) => `${key}-branch`),
    ...overrides,
  };
}

function signals({ openPrs = [], mergedPrs = [], mergedTags = [] } = {}) {
  return {
    openPrs: new Map(openPrs),
    mergedPrs: new Map(mergedPrs),
    mergedTags: new Set(mergedTags),
  };
}

function openPr(overrides = {}) {
  return {
    number: 7,
    url: "https://github.com/o/r/pull/7",
    baseRefName: "main",
    updatedAt: "2026-08-01T00:00:00Z",
    lastCommitAt: "2026-08-01T00:00:00Z",
    lastReviewAt: null,
    lastCommentAt: null,
    ...overrides,
  };
}

describe("groupTicketsByRepo", () => {
  it("buckets tickets with no resolvable repo under null", () => {
    const tickets = [{ key: "A-1", labels: [] }];
    const grouped = groupTicketsByRepo(tickets, "/nonexistent-dev-root");
    expect(grouped.get(null)).toHaveLength(1);
  });

  it("groups every ticket exactly once", () => {
    const tickets = [
      { key: "A-1", labels: [] },
      { key: "A-2", labels: [] },
      { key: "A-3", labels: [] },
    ];
    const grouped = groupTicketsByRepo(tickets, null);
    const total = [...grouped.values()].reduce((n, b) => n + b.length, 0);
    expect(total).toBe(3);
  });

  it("tolerates missing input", () => {
    expect(groupTicketsByRepo(undefined, null).size).toBe(0);
  });
});

describe("attachSignals", () => {
  it("attaches an open PR with the timestamps the stagnation rules read", () => {
    const tickets = [{ key: "A-1", branch: "A-1" }];
    attachSignals(tickets, signals({ openPrs: [["A-1", openPr()]] }));

    expect(tickets[0].pr).toMatchObject({
      number: 7,
      state: "OPEN",
      baseRef: "main",
      lastCommitAt: "2026-08-01T00:00:00Z",
    });
  });

  it("nulls the PR when no open PR matches the branch", () => {
    const tickets = [{ key: "A-1", branch: "A-1" }];
    attachSignals(tickets, signals());
    expect(tickets[0].pr).toBeNull();
  });

  it("preserves a previously computed behindBy across refreshes", () => {
    const tickets = [{ key: "A-1", branch: "A-1", pr: { behindBy: 42 } }];
    attachSignals(tickets, signals({ openPrs: [["A-1", openPr()]] }));
    expect(tickets[0].pr.behindBy).toBe(42);
  });

  it("sets mergedIntoMain from the merged PR map", () => {
    const tickets = [{ key: "A-1", branch: "A-1" }];
    attachSignals(tickets, signals({ mergedPrs: [["A-1", "abc123"]] }));
    expect(tickets[0].mergedIntoMain).toBe(true);
  });

  it("reads phaseOneDone from the merged/{KEY} tag, not the branch", () => {
    const tickets = [{ key: "A-1", branch: "feature-xyz" }];
    attachSignals(tickets, signals({ mergedTags: ["A-1"] }));
    expect(tickets[0].phaseOneDone).toBe(true);
  });

  it("leaves mergedIntoFeature null for standalone tickets", () => {
    // null rather than false: the stack-rebase rule tests `!== false`, so
    // false here would make standalone tickets look rebase-eligible.
    const tickets = [{ key: "A-1", branch: "A-1" }];
    attachSignals(tickets, signals(), { featureBranch: null });
    expect(tickets[0].mergedIntoFeature).toBeNull();
  });

  it("computes mergedIntoFeature when the stack has a feature branch", () => {
    const tickets = [{ key: "A-1", branch: "A-1" }];
    attachSignals(tickets, signals({ mergedPrs: [["A-1", "abc"]] }), {
      featureBranch: "EPIC-1",
    });
    expect(tickets[0].mergedIntoFeature).toBe(true);
  });

  it("treats a branchless ticket as unmerged rather than throwing", () => {
    const tickets = [{ key: "A-1", branch: null }];
    attachSignals(tickets, signals({ mergedPrs: [["A-1", "abc"]] }));
    expect(tickets[0].pr).toBeNull();
    expect(tickets[0].mergedIntoMain).toBe(false);
  });

  it("tolerates missing tickets", () => {
    expect(() => attachSignals(undefined, signals())).not.toThrow();
  });
});

describe("collectRepoSignals", () => {
  it("makes exactly one call per probe — the batching guarantee", () => {
    const probes = fakeProbes();
    collectRepoSignals("/repo", { probes });

    expect(probes.openPrActivityMap).toHaveBeenCalledTimes(1);
    expect(probes.mergedPrMap).toHaveBeenCalledTimes(1);
    expect(probes.mergedTagKeys).toHaveBeenCalledTimes(1);
  });

  it("probes the requested base branch", () => {
    const probes = fakeProbes();
    collectRepoSignals("/repo", { baseBranch: "develop", probes });
    expect(probes.mergedPrMap).toHaveBeenCalledWith("develop", "/repo");
  });

  it("returns empty maps and probes nothing without a repo root", () => {
    const probes = fakeProbes();
    const result = collectRepoSignals(null, { probes });

    expect(result.openPrs.size).toBe(0);
    expect(result.mergedPrs.size).toBe(0);
    expect(result.mergedTags.size).toBe(0);
    expect(probes.openPrActivityMap).not.toHaveBeenCalled();
  });
});

describe("attachBranches", () => {
  it("resolves a branch only for tickets that lack one", () => {
    const probes = fakeProbes();
    const tickets = [{ key: "A-1" }, { key: "A-2", branch: "existing" }];
    attachBranches(tickets, "/repo", { probes });

    expect(tickets[0].branch).toBe("A-1-branch");
    expect(tickets[1].branch).toBe("existing");
    expect(probes.branchFor).toHaveBeenCalledTimes(1);
  });
});

describe("attachFreshness", () => {
  it("only fetches last-commit for in-flight tickets", () => {
    // This gating is what keeps the poll cheap: each call is a git subprocess,
    // so an idle stack must cost zero.
    const probes = fakeProbes();
    const tickets = [
      { key: "A-1", branch: "A-1" },
      { key: "A-2", branch: "A-2" },
    ];
    attachFreshness(tickets, "/repo", {
      inFlightKeys: new Set(["A-1"]),
      probes,
    });

    expect(tickets[0].lastCommitAt).toBe("2026-08-01T00:00:00Z");
    expect(tickets[1].lastCommitAt).toBeUndefined();
    expect(probes.branchLastCommitAt).toHaveBeenCalledTimes(1);
  });

  it("computes behindBy only for open PRs", () => {
    const probes = fakeProbes();
    const tickets = [
      { key: "A-1", branch: "A-1", pr: { state: "OPEN", baseRef: "main" } },
      { key: "A-2", branch: "A-2", pr: null },
    ];
    attachFreshness(tickets, "/repo", { probes });

    expect(tickets[0].pr.behindBy).toBe(30);
    expect(probes.commitsBehind).toHaveBeenCalledTimes(1);
  });

  it("skips an open PR with no known base ref", () => {
    const probes = fakeProbes();
    const tickets = [
      { key: "A-1", branch: "A-1", pr: { state: "OPEN", baseRef: null } },
    ];
    attachFreshness(tickets, "/repo", { probes });
    expect(probes.commitsBehind).not.toHaveBeenCalled();
  });

  it("probes nothing without a repo root", () => {
    const probes = fakeProbes();
    const tickets = [{ key: "A-1", branch: "A-1" }];
    attachFreshness(tickets, null, {
      inFlightKeys: new Set(["A-1"]),
      probes,
    });
    expect(probes.branchLastCommitAt).not.toHaveBeenCalled();
  });

  it("does not require inFlightKeys", () => {
    const probes = fakeProbes();
    const tickets = [{ key: "A-1", branch: "A-1" }];
    expect(() => attachFreshness(tickets, "/repo", { probes })).not.toThrow();
    expect(probes.branchLastCommitAt).not.toHaveBeenCalled();
  });
});
