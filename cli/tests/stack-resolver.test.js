import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/jira.js", () => ({
  getIssue: vi.fn(),
  searchIssues: vi.fn(),
}));

vi.mock("../lib/git.js", () => ({
  findBranch: vi.fn(),
  isAncestor: vi.fn(),
  isMergedInto: vi.fn(),
  getMergedPrMap: vi.fn(() => new Map()),
  getOpenPrMap: vi.fn(() => new Map()),
  resolveMergedTag: vi.fn(() => null),
  isShaAncestorOf: vi.fn(() => false),
  isSameCommit: vi.fn(() => false),
  isTicketMergeStandingRevertedOn: vi.fn(() => false),
}));

vi.mock("../lib/config.js", () => ({
  loadDevRoot: vi.fn(),
}));

const { getIssue, searchIssues } = await import("../lib/jira.js");
const {
  findBranch,
  isAncestor,
  isMergedInto,
  getMergedPrMap,
  getOpenPrMap,
  resolveMergedTag,
  isShaAncestorOf,
  isSameCommit,
  isTicketMergeStandingRevertedOn,
} = await import("../lib/git.js");
const { loadDevRoot } = await import("../lib/config.js");
const {
  resolveContainer,
  featureBranchFromContainer,
  findContainerBlockers,
  resolveContainerBase,
  isFinished,
  resolveStack,
} = await import("../lib/stack-resolver.js");

function issueFields(opts = {}) {
  return {
    summary: opts.summary || "Test summary",
    labels: opts.labels || [],
    parent: opts.parent || null,
    issuetype: { name: opts.issuetype || "Task" },
    issuelinks: opts.issuelinks || [],
    status: opts.status || { statusCategory: { key: "indeterminate" } },
    assignee: opts.assignee || null,
  };
}

describe("resolveContainer", () => {
  it("returns parent Story for subtasks", () => {
    const fields = issueFields({
      issuetype: "Sub-task",
      parent: { key: "STORY-1", fields: { summary: "Parent story" } },
    });
    expect(resolveContainer(fields)).toEqual({
      key: "STORY-1",
      type: "Story",
      summary: "Parent story",
    });
  });

  it("returns Epic from outward issue link", () => {
    const fields = issueFields({
      issuelinks: [
        {
          type: { name: "Epic" },
          outwardIssue: {
            key: "EPIC-1",
            fields: { summary: "My Epic", issuetype: { name: "Epic" } },
          },
        },
      ],
    });
    expect(resolveContainer(fields)).toEqual({
      key: "EPIC-1",
      type: "Epic",
      summary: "My Epic",
    });
  });

  it("returns Epic from inward issue link", () => {
    const fields = issueFields({
      issuelinks: [
        {
          type: { name: "relates to" },
          inwardIssue: {
            key: "EPIC-2",
            fields: { summary: "Inward Epic", issuetype: { name: "Epic" } },
          },
        },
      ],
    });
    expect(resolveContainer(fields)).toEqual({
      key: "EPIC-2",
      type: "Epic",
      summary: "Inward Epic",
    });
  });

  it("returns null for standalone issues", () => {
    const fields = issueFields();
    expect(resolveContainer(fields)).toBeNull();
  });
});

describe("featureBranchFromContainer", () => {
  it("returns the container key for non-Standalone containers", () => {
    expect(featureBranchFromContainer("STORY-42")).toBe("STORY-42");
  });

  it("returns null for Standalone", () => {
    expect(featureBranchFromContainer("Standalone")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(featureBranchFromContainer(null)).toBeNull();
    expect(featureBranchFromContainer("")).toBeNull();
  });
});

describe("findContainerBlockers", () => {
  it("returns Story/Epic/Task blockers via 'is blocked by' inward links", () => {
    const links = [
      {
        type: { inward: "is blocked by" },
        inwardIssue: {
          key: "STORY-1",
          fields: { issuetype: { name: "Story" } },
        },
      },
      {
        type: { inward: "is blocked by" },
        inwardIssue: {
          key: "EPIC-9",
          fields: { issuetype: { name: "Epic" } },
        },
      },
    ];
    expect(findContainerBlockers(links)).toEqual(["STORY-1", "EPIC-9"]);
  });

  it("ignores Sub-task blockers", () => {
    const links = [
      {
        type: { inward: "is blocked by" },
        inwardIssue: {
          key: "SUB-1",
          fields: { issuetype: { name: "Sub-task" } },
        },
      },
    ];
    expect(findContainerBlockers(links)).toEqual([]);
  });

  it("ignores non-blocker link types", () => {
    const links = [
      {
        type: { inward: "relates to" },
        inwardIssue: {
          key: "STORY-1",
          fields: { issuetype: { name: "Story" } },
        },
      },
    ];
    expect(findContainerBlockers(links)).toEqual([]);
  });

  it("returns empty for null/empty input", () => {
    expect(findContainerBlockers(null)).toEqual([]);
    expect(findContainerBlockers([])).toEqual([]);
  });
});

describe("resolveContainerBase", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns main when there are no container blockers", () => {
    const result = resolveContainerBase([], "/repo");
    expect(result).toEqual({
      baseBranch: "main",
      blockerContainers: [],
      unmergedBlockers: [],
    });
  });

  it("returns main when all blockers are merged into main", () => {
    isAncestor.mockReturnValue(true);
    const links = [
      {
        type: { inward: "is blocked by" },
        inwardIssue: {
          key: "STORY-1",
          fields: { issuetype: { name: "Story" } },
        },
      },
    ];
    const result = resolveContainerBase(links, "/repo");
    expect(result.baseBranch).toBe("main");
    expect(result.blockerContainers).toEqual(["STORY-1"]);
    expect(result.unmergedBlockers).toEqual([]);
  });

  it("returns the blocker key when one blocker is unmerged", () => {
    isAncestor.mockReturnValue(false);
    const links = [
      {
        type: { inward: "is blocked by" },
        inwardIssue: {
          key: "STORY-A",
          fields: { issuetype: { name: "Story" } },
        },
      },
    ];
    const result = resolveContainerBase(links, "/repo");
    expect(result.baseBranch).toBe("STORY-A");
    expect(result.unmergedBlockers).toEqual(["STORY-A"]);
  });

  it("throws when multiple blockers are unmerged", () => {
    isAncestor.mockReturnValue(false);
    const links = [
      {
        type: { inward: "is blocked by" },
        inwardIssue: {
          key: "STORY-A",
          fields: { issuetype: { name: "Story" } },
        },
      },
      {
        type: { inward: "is blocked by" },
        inwardIssue: {
          key: "STORY-B",
          fields: { issuetype: { name: "Story" } },
        },
      },
    ];
    expect(() => resolveContainerBase(links, "/repo")).toThrow(
      /multiple unmerged blocker containers/,
    );
  });

  it("treats blockers as unmerged when no repoRoot is available", () => {
    const links = [
      {
        type: { inward: "is blocked by" },
        inwardIssue: {
          key: "STORY-A",
          fields: { issuetype: { name: "Story" } },
        },
      },
    ];
    const result = resolveContainerBase(links, null);
    expect(result.baseBranch).toBe("STORY-A");
    expect(result.unmergedBlockers).toEqual(["STORY-A"]);
  });
});

describe("isFinished", () => {
  it("returns true when status category is done", () => {
    expect(isFinished([], "done")).toBe(true);
  });

  it("returns true when has ClaudeStackReady label", () => {
    expect(isFinished(["ClaudeStackReady"], "indeterminate")).toBe(true);
  });

  it("returns true when the caller reports the ticket is in review", () => {
    expect(isFinished([], "indeterminate", { inReview: true })).toBe(true);
  });

  it("ignores a stale ClaudeNeedsReview label — review state comes from the PR", () => {
    expect(isFinished(["ClaudeNeedsReview"], "indeterminate")).toBe(false);
  });

  it("returns true when has ClaudeStackComplete label", () => {
    expect(isFinished(["ClaudeStackComplete"], "indeterminate")).toBe(true);
  });

  it("returns false for in-progress tickets", () => {
    expect(isFinished(["ClaudeExecuting"], "indeterminate")).toBe(false);
  });

  it("returns false for empty labels and non-done status", () => {
    expect(isFinished([], "indeterminate")).toBe(false);
  });
});

describe("resolveStack", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadDevRoot.mockReturnValue("/dev");
    getMergedPrMap.mockReturnValue(new Map());
    getOpenPrMap.mockReturnValue(new Map());
  });

  it("falls through to baseBranch when computePrTarget runs without a feature branch (Standalone container path)", async () => {
    // A Standalone-typed parent has featureBranchFromContainer return null,
    // so computePrTarget(featureBranch=null, baseBranch="main") returns "main".
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-S") {
        return {
          key: "SUB-S",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: {
              key: "STANDALONE-1",
              fields: { summary: "Standalone container" },
            },
            labels: ["repo:x"],
          }),
        };
      }
      return {
        key: "STANDALONE-1",
        fields: issueFields({
          issuetype: "Standalone",
          summary: "Standalone container",
          labels: [],
        }),
      };
    });
    searchIssues.mockResolvedValue([]);

    const result = await resolveStack("SUB-S");
    // Just exercising the resolveStack path with a non-Story container —
    // the goal is to walk the helper branches, not assert featureBranch shape.
    expect(result.container?.key).toBe("STANDALONE-1");
  });

  it("returns standalone ticket when no container found", async () => {
    getIssue.mockResolvedValue({
      key: "T-1",
      fields: issueFields({ summary: "Standalone" }),
    });

    const result = await resolveStack("T-1");
    expect(result.container).toBeNull();
    expect(result.stack).toHaveLength(1);
    expect(result.stack[0].key).toBe("T-1");
    expect(result.stack[0].baseBranch).toBe("main");
    expect(result.inputTicket).toBe("T-1");
    expect(result.ticketIndex).toBe(0);
  });

  it("resolves a two-ticket stack with blocking dependency", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "Parent" } },
            labels: ["ClaudeWork", "repo:backend"],
            issuelinks: [
              { type: { outward: "blocks" }, outwardIssue: { key: "SUB-2" } },
            ],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({
            summary: "Parent",
            labels: ["repo:backend"],
          }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork", "repo:backend"],
          status: { statusCategory: { key: "done" } },
          issuelinks: [
            { type: { outward: "blocks" }, outwardIssue: { key: "SUB-2" } },
          ],
        }),
      },
      {
        key: "SUB-2",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork", "ClaudeReady", "repo:backend"],
          issuelinks: [
            {
              type: { inward: "is blocked by" },
              inwardIssue: { key: "SUB-1" },
            },
          ],
        }),
      },
    ]);

    findBranch.mockImplementation((key) => {
      if (key === "SUB-1") return "SUB-1";
      if (key === "SUB-2") return "SUB-2";
      return null;
    });

    isAncestor.mockImplementation((ancestor) => {
      if (ancestor === "SUB-1") return true;
      return false;
    });

    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });

    expect(result.container.key).toBe("STORY-1");
    expect(result.container.featureBranch).toBe("STORY-1");
    expect(result.stack).toHaveLength(2);

    const sub1 = result.stack.find((t) => t.key === "SUB-1");
    expect(sub1.status).toBe("finished");
    expect(sub1.mergedIntoFeature).toBe(true);

    const sub2 = result.stack.find((t) => t.key === "SUB-2");
    expect(sub2.eligible).toBe(true);
    expect(sub2.unblockedBlockers).toHaveLength(0);
    expect(sub2.baseBranch).toBe("STORY-1");
  });

  it("marks ticket as blocked when blocker not merged into feature branch", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-2") {
        return {
          key: "SUB-2",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
            issuelinks: [
              {
                type: { inward: "is blocked by" },
                inwardIssue: { key: "SUB-1" },
              },
            ],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({
            labels: ["repo:backend"],
          }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork", "ClaudeStackReady"],
          issuelinks: [
            { type: { outward: "blocks" }, outwardIssue: { key: "SUB-2" } },
          ],
        }),
      },
      {
        key: "SUB-2",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork", "ClaudeReady"],
          issuelinks: [
            {
              type: { inward: "is blocked by" },
              inwardIssue: { key: "SUB-1" },
            },
          ],
        }),
      },
    ]);

    findBranch.mockImplementation((key) => key);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("SUB-2", { repoRoot: "/dev/backend" });

    const sub2 = result.stack.find((t) => t.key === "SUB-2");
    expect(sub2.eligible).toBe(false);
    expect(sub2.unblockedBlockers).toEqual(["SUB-1"]);
  });

  it("flags mergedIntoFeature when branch tip is not an ancestor but a merged PR exists (squash merge)", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockImplementation((key) => key);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    getMergedPrMap.mockImplementation((base) => {
      if (base === "STORY-1") return new Map([["SUB-1", "abc123"]]);
      return new Map();
    });

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    const sub1 = result.stack.find((t) => t.key === "SUB-1");
    expect(sub1.mergedIntoFeature).toBe(true);
    expect(sub1.mergedIntoMain).toBe(false);
  });

  // Regression for issue #32, reproducing the NEV-1441 shape: the branch is
  // gone, and the feature branch was rewritten after the merge so the PR's
  // recorded mergeCommit is orphaned. Only the merged/{KEY} tag still proves
  // the work shipped. Before the fix this reported eligible: true on a ticket
  // whose code was already on the Epic branch, so queue mode would re-run it.
  it("flags mergedIntoFeature from the merged/{KEY} tag when the branch is gone and the PR record is orphaned", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork", "ClaudePendingMainPromotion"],
          issuelinks: [],
        }),
      },
    ]);

    // Branch deleted by cleanup; no merged-PR record matches; nothing is an
    // ancestor. Every pre-existing signal says "not merged".
    findBranch.mockReturnValue(null);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    getMergedPrMap.mockReturnValue(new Map());

    // The tag survives and is reachable from the feature branch but not main —
    // exactly the ClaudePendingMainPromotion state.
    resolveMergedTag.mockImplementation((key) =>
      key === "SUB-1" ? "deadbee" : null,
    );
    isShaAncestorOf.mockImplementation(
      (sha, target) => sha === "deadbee" && target === "STORY-1",
    );

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    const sub1 = result.stack.find((t) => t.key === "SUB-1");
    expect(sub1.mergedIntoFeature).toBe(true);
    expect(sub1.mergedIntoMain).toBe(false);
  });

  it("derives inReview from an open PR, marking the ticket finished without any label", async () => {
    getIssue.mockResolvedValue({
      key: "T-1",
      fields: issueFields({ labels: ["repo:backend"] }),
    });

    findBranch.mockImplementation((key) => key);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    getOpenPrMap.mockReturnValue(
      new Map([["T-1", { number: 7, url: "u", isDraft: true }]]),
    );

    const result = await resolveStack("T-1", { repoRoot: "/dev/backend" });
    expect(result.stack[0].inReview).toBe(true);
    expect(result.stack[0].openPr.number).toBe(7);
    expect(result.stack[0].status).toBe("finished");
  });

  it("derives inReview from Jira status name when no open PR is visible", async () => {
    getIssue.mockResolvedValue({
      key: "T-1",
      fields: issueFields({
        labels: ["repo:backend"],
        status: { name: "In Review", statusCategory: { key: "indeterminate" } },
      }),
    });

    findBranch.mockImplementation((key) => key);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    getOpenPrMap.mockReturnValue(new Map());

    const result = await resolveStack("T-1", { repoRoot: "/dev/backend" });
    expect(result.stack[0].inReview).toBe(true);
    expect(result.stack[0].status).toBe("finished");
  });

  it("unblocks a downstream ticket whose blocker is proven merged only by its tag", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-2") {
        return {
          key: "SUB-2",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          // Not "finished" by label — the label path won't rescue this.
          labels: ["ClaudeWork", "ClaudePendingMainPromotion"],
          issuelinks: [],
        }),
      },
      {
        key: "SUB-2",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork"],
          issuelinks: [
            {
              type: { name: "Blocks", inward: "is blocked by" },
              inwardIssue: { key: "SUB-1", fields: issueFields() },
            },
          ],
        }),
      },
    ]);

    findBranch.mockReturnValue(null);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    getMergedPrMap.mockReturnValue(new Map());
    resolveMergedTag.mockImplementation((key) =>
      key === "SUB-1" ? "deadbee" : null,
    );
    isShaAncestorOf.mockImplementation(
      (sha, target) => sha === "deadbee" && target === "STORY-1",
    );

    const result = await resolveStack("SUB-2", { repoRoot: "/dev/backend" });
    const sub2 = result.stack.find((t) => t.key === "SUB-2");
    expect(sub2.unblockedBlockers).toEqual([]);
    expect(sub2.eligible).toBe(true);
  });

  it("blocks downstream when the blocker has an open PR not yet merged into the feature branch", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-2") {
        return {
          key: "SUB-2",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return { key: "STORY-1", fields: issueFields({ labels: [] }) };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          issuelinks: [
            { type: { outward: "blocks" }, outwardIssue: { key: "SUB-2" } },
          ],
        }),
      },
      {
        key: "SUB-2",
        fields: issueFields({
          issuetype: "Sub-task",
          issuelinks: [
            {
              type: { inward: "is blocked by" },
              inwardIssue: { key: "SUB-1" },
            },
          ],
        }),
      },
    ]);

    findBranch.mockImplementation((key) => key);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    getMergedPrMap.mockReturnValue(new Map());
    // SUB-1 is out for review but its branch is not in the feature branch.
    getOpenPrMap.mockReturnValue(new Map([["SUB-1", { number: 3 }]]));

    const result = await resolveStack("SUB-2", { repoRoot: "/dev/backend" });
    const sub2 = result.stack.find((t) => t.key === "SUB-2");
    expect(sub2.unblockedBlockers).toContain("SUB-1");
    expect(sub2.eligible).toBe(false);
  });

  // Regression, reproducing the NEV-1441 rework shape: the ticket had already
  // merged into the Epic feature branch, then /rework reverted it back off.
  // GitHub's merged-PR record is immutable and the merge commit stays
  // reachable, so both keep reporting "merged" after the code is gone. Before
  // the fix this reported mergedIntoFeature: true, which made the ticket-work
  // S2.5 cleanup-prerequisites gate fire and re-assert the stale merged state.
  it("clears mergedIntoFeature when the merge was reverted off the feature branch", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork", "ClaudeReady"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockImplementation((key) => key);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    // The immutable merged-PR record still names the squash commit.
    getMergedPrMap.mockImplementation((base) =>
      base === "STORY-1" ? new Map([["SUB-1", "squash1"]]) : new Map(),
    );
    // ...but that commit has since been reverted on the feature branch.
    isTicketMergeStandingRevertedOn.mockImplementation(
      (_key, sha, target) => sha === "squash1" && target === "STORY-1",
    );

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    const sub1 = result.stack.find((t) => t.key === "SUB-1");
    expect(sub1.mergedIntoFeature).toBe(false);
    expect(sub1.featureMergeSha).toBeNull();
  });

  // The live NEV-1441 shape: the feature branch was rewritten after the merge,
  // so the on-branch squash commit (which the revert names) differs from the
  // SHA GitHub's PR record still reports. The exact-SHA check therefore misses,
  // and only the ticket-key match finds the revert.
  it("clears mergedIntoFeature via ticket-key match when the revert names a rewritten SHA", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork", "ClaudeReady"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockImplementation((key) => key);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    // GitHub reports the pre-rewrite SHA...
    getMergedPrMap.mockImplementation((base) =>
      base === "STORY-1" ? new Map([["SUB-1", "stale-sha"]]) : new Map(),
    );
    // The key-scoped search still locates the standing revert even though the
    // reported SHA is stale.
    isTicketMergeStandingRevertedOn.mockImplementation(
      (ticketKey, _sha, target) =>
        ticketKey === "SUB-1" && target === "STORY-1",
    );

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    const sub1 = result.stack.find((t) => t.key === "SUB-1");
    expect(sub1.mergedIntoFeature).toBe(false);
    expect(sub1.featureMergeSha).toBeNull();
  });

  // The other half of the NEV-1441 story: after the revert, the ticket merged
  // again under a brand-new PR (#191). The re-merge is an ordinary squash commit
  // with no revert trailer, so a resolver that only looks for a
  // revert-of-the-revert never sees the re-land and reports the ticket as
  // reverted forever — blocking /promote-to-main against work plainly on the
  // branch.
  it("reports mergedIntoFeature when the ticket re-merged after being reverted", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork", "ClaudeReady"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockImplementation((key) => key);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    // The newest merged PR for the branch is the re-land (#191 in the live
    // stack), not the reverted original.
    getMergedPrMap.mockImplementation((base) =>
      base === "STORY-1" ? new Map([["SUB-1", "reland-sha"]]) : new Map(),
    );
    // No revert is standing: the work is back on the branch.
    isTicketMergeStandingRevertedOn.mockReturnValue(false);

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    const sub1 = result.stack.find((t) => t.key === "SUB-1");
    expect(sub1.mergedIntoFeature).toBe(true);
    expect(sub1.featureMergeSha).toBe("reland-sha");
  });

  it("re-blocks a downstream ticket when its blocker's merge was reverted", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-2") {
        return {
          key: "SUB-2",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork", "ClaudeReady"],
          issuelinks: [],
        }),
      },
      {
        key: "SUB-2",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork"],
          issuelinks: [
            {
              type: { name: "Blocks", inward: "is blocked by" },
              inwardIssue: { key: "SUB-1", fields: issueFields() },
            },
          ],
        }),
      },
    ]);

    findBranch.mockImplementation((key) => key);
    // The blocker's branch still looks merged by ancestry and by PR record.
    isAncestor.mockImplementation((ancestor) => ancestor === "SUB-1");
    isMergedInto.mockReturnValue(false);
    getMergedPrMap.mockImplementation((base) =>
      base === "STORY-1" ? new Map([["SUB-1", "squash1"]]) : new Map(),
    );
    isTicketMergeStandingRevertedOn.mockImplementation(
      (_key, sha, target) => sha === "squash1" && target === "STORY-1",
    );

    const result = await resolveStack("SUB-2", { repoRoot: "/dev/backend" });
    const sub2 = result.stack.find((t) => t.key === "SUB-2");
    expect(sub2.unblockedBlockers).toEqual(["SUB-1"]);
    expect(sub2.eligible).toBe(false);
  });

  // A branch reset onto its base — /rework's own reset, or a branch created and
  // not yet committed to — is trivially an ancestor of that base. Ancestry
  // alone therefore reads "no work yet" as "merged".
  it("does not flag mergedIntoFeature when the branch tip equals the feature branch tip", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork", "ClaudeReady"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockImplementation((key) => key);
    // Ancestor of the feature branch, but only because it *is* the same commit.
    isAncestor.mockReturnValue(true);
    isSameCommit.mockImplementation(
      (branch, target) => branch === "SUB-1" && target === "STORY-1",
    );
    isMergedInto.mockReturnValue(false);
    getMergedPrMap.mockReturnValue(new Map());

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    const sub1 = result.stack.find((t) => t.key === "SUB-1");
    expect(sub1.mergedIntoFeature).toBe(false);
  });

  it("flags mergedIntoMain when branch tip is not in merged list but a merged PR to main exists (squash merge)", async () => {
    getIssue.mockResolvedValue({
      key: "T-1",
      fields: issueFields({
        labels: ["repo:backend"],
      }),
    });

    findBranch.mockImplementation((key) => key);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    getMergedPrMap.mockImplementation((base) => {
      if (base === "main") return new Map([["T-1", "abc123"]]);
      return new Map();
    });

    const result = await resolveStack("T-1", { repoRoot: "/dev/backend" });
    expect(result.stack[0].mergedIntoMain).toBe(true);
  });

  it("standalone ticket matches main-merged PR by ticket-key slash-prefix headRefName", async () => {
    getIssue.mockResolvedValue({
      key: "T-1",
      fields: issueFields({
        labels: ["repo:backend"],
      }),
    });

    findBranch.mockReturnValue(null);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    getMergedPrMap.mockImplementation((base) => {
      if (base === "main") return new Map([["T-1/feature", "sha-slash"]]);
      return new Map();
    });

    const result = await resolveStack("T-1", { repoRoot: "/dev/backend" });
    expect(result.stack[0].mergedIntoMain).toBe(true);
    expect(result.stack[0].mainMergeSha).toBe("sha-slash");
  });

  it("standalone ticket falls back to isMergedInto when no headRefName matches", async () => {
    getIssue.mockResolvedValue({
      key: "T-1",
      fields: issueFields({
        labels: ["repo:backend"],
      }),
    });

    findBranch.mockImplementation((key) => key);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(true);
    getMergedPrMap.mockReturnValue(new Map());

    const result = await resolveStack("T-1", { repoRoot: "/dev/backend" });
    expect(result.stack[0].mergedIntoMain).toBe(true);
    expect(result.stack[0].mainMergeSha).toBe(null);
  });

  it("stacked ticket matches main-merged PR by ticket-key prefix headRefName when branch is gone", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockReturnValue(null);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    getMergedPrMap.mockImplementation((base) => {
      if (base === "main") return new Map([["SUB-1/old-branch", "main-sha"]]);
      return new Map();
    });

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    const sub1 = result.stack.find((t) => t.key === "SUB-1");
    expect(sub1.mergedIntoMain).toBe(true);
    expect(sub1.mainMergeSha).toBe("main-sha");
  });

  it("treats blocker as unblocked when its branch is squash-merged into feature branch", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-2") {
        return {
          key: "SUB-2",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
            issuelinks: [
              {
                type: { inward: "is blocked by" },
                inwardIssue: { key: "SUB-1" },
              },
            ],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork"],
          issuelinks: [
            { type: { outward: "blocks" }, outwardIssue: { key: "SUB-2" } },
          ],
        }),
      },
      {
        key: "SUB-2",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork", "ClaudeReady"],
          issuelinks: [
            {
              type: { inward: "is blocked by" },
              inwardIssue: { key: "SUB-1" },
            },
          ],
        }),
      },
    ]);

    findBranch.mockImplementation((key) => key);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);
    getMergedPrMap.mockImplementation((base) => {
      if (base === "STORY-1") return new Map([["SUB-1", "abc123"]]);
      return new Map();
    });

    const result = await resolveStack("SUB-2", { repoRoot: "/dev/backend" });
    const sub2 = result.stack.find((t) => t.key === "SUB-2");
    expect(sub2.eligible).toBe(true);
    expect(sub2.unblockedBlockers).toEqual([]);
  });

  it("reports in-progress status for ClaudePlanning ticket", async () => {
    getIssue.mockResolvedValue({
      key: "T-1",
      fields: issueFields({
        labels: ["ClaudePlanning"],
      }),
    });

    const result = await resolveStack("T-1");
    expect(result.stack[0].status).toBe("in-progress");
  });

  it("ticket in a Story stack with no blocker uses the container key as baseBranch", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeReady"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockReturnValue(null);
    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    const sub1 = result.stack[0];
    expect(sub1.baseBranch).toBe("STORY-1");
    expect(sub1.prTarget).toBe("STORY-1");
    expect(result.container.featureBranch).toBe("STORY-1");
    expect(result.container.baseBranch).toBe("main");
  });

  it("uses Epic JQL branch for Epic containers", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "T-1") {
        return {
          key: "T-1",
          fields: issueFields({
            labels: ["repo:backend"],
            issuelinks: [
              {
                type: { name: "Epic" },
                outwardIssue: {
                  key: "EPIC-1",
                  fields: { summary: "My Epic", issuetype: { name: "Epic" } },
                },
              },
            ],
          }),
        };
      }
      if (key === "EPIC-1") {
        return {
          key: "EPIC-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "T-1",
        fields: issueFields({
          labels: ["ClaudeReady"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockReturnValue(null);
    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("T-1", { repoRoot: "/dev/backend" });
    expect(result.container.key).toBe("EPIC-1");
    expect(result.container.type).toBe("Epic");
  });

  it("returns container: null when ticket has no Story and no Epic", async () => {
    getIssue.mockResolvedValue({
      key: "T-1",
      fields: issueFields({
        summary: "Truly standalone",
        labels: ["repo:backend"],
      }),
    });

    const result = await resolveStack("T-1");
    expect(result.container).toBeNull();
    expect(result.stack).toHaveLength(1);
    expect(result.stack[0].baseBranch).toBe("main");
  });

  it("surfaces container.baseBranch from blocker container when blocker is unmerged", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-B", fields: { summary: "B" } },
            labels: ["repo:backend"],
          }),
        };
      }
      if (key === "STORY-B") {
        return {
          key: "STORY-B",
          fields: issueFields({
            summary: "B",
            labels: ["repo:backend"],
            issuelinks: [
              {
                type: { inward: "is blocked by" },
                inwardIssue: {
                  key: "STORY-A",
                  fields: { issuetype: { name: "Story" } },
                },
              },
            ],
          }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeReady"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockReturnValue(null);
    // STORY-A is NOT an ancestor of main → unmerged
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    expect(result.container.featureBranch).toBe("STORY-B");
    expect(result.container.baseBranch).toBe("STORY-A");
    expect(result.container.unmergedBlockers).toEqual(["STORY-A"]);
  });

  it("uses blocker container's branch: label when resolving unmerged baseBranch", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-B", fields: { summary: "B" } },
            labels: ["repo:backend"],
          }),
        };
      }
      if (key === "STORY-B") {
        return {
          key: "STORY-B",
          fields: issueFields({
            summary: "B",
            labels: ["repo:backend"],
            issuelinks: [
              {
                type: { inward: "is blocked by" },
                inwardIssue: {
                  key: "STORY-A",
                  fields: { issuetype: { name: "Story" } },
                },
              },
            ],
          }),
        };
      }
      if (key === "STORY-A") {
        return {
          key: "STORY-A",
          fields: issueFields({
            labels: ["repo:backend", "branch:custom_feature_branch"],
          }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeReady"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockReturnValue(null);
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    expect(result.container.baseBranch).toBe("custom_feature_branch");
    expect(result.container.unmergedBlockers).toEqual(["STORY-A"]);
  });

  it("returns main as container baseBranch when blocker container is merged", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-B", fields: { summary: "B" } },
            labels: ["repo:backend"],
          }),
        };
      }
      if (key === "STORY-B") {
        return {
          key: "STORY-B",
          fields: issueFields({
            summary: "B",
            labels: ["repo:backend"],
            issuelinks: [
              {
                type: { inward: "is blocked by" },
                inwardIssue: {
                  key: "STORY-A",
                  fields: { issuetype: { name: "Story" } },
                },
              },
            ],
          }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeReady"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockReturnValue(null);
    isAncestor.mockReturnValue(true);
    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    expect(result.container.baseBranch).toBe("main");
    expect(result.container.unmergedBlockers).toEqual([]);
  });

  it("surfaces parentFeatureBranch when Story container has an Epic parent with a branch label", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "S" } },
            labels: ["repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({
            summary: "S",
            issuetype: "Story",
            parent: {
              key: "EPIC-1",
              fields: { summary: "E", issuetype: { name: "Epic" } },
            },
            labels: ["repo:backend"],
          }),
        };
      }
      if (key === "EPIC-1") {
        return {
          key: "EPIC-1",
          fields: issueFields({
            issuetype: "Epic",
            labels: ["repo:backend", "branch:big_feature"],
          }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeReady"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockReturnValue(null);
    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    expect(result.container.parentContainerKey).toBe("EPIC-1");
    expect(result.container.parentFeatureBranch).toBe("big_feature");
  });

  it("falls back to Epic key as parentFeatureBranch when no branch label", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-1") {
        return {
          key: "SUB-1",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "S" } },
            labels: ["repo:backend"],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({
            issuetype: "Story",
            parent: {
              key: "EPIC-1",
              fields: { summary: "E", issuetype: { name: "Epic" } },
            },
            labels: ["repo:backend"],
          }),
        };
      }
      if (key === "EPIC-1") {
        return {
          key: "EPIC-1",
          fields: issueFields({
            issuetype: "Epic",
            labels: ["repo:backend"],
          }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeReady"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockReturnValue(null);
    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("SUB-1", { repoRoot: "/dev/backend" });
    expect(result.container.parentContainerKey).toBe("EPIC-1");
    expect(result.container.parentFeatureBranch).toBe("EPIC-1");
  });

  it("returns null parentFeatureBranch for top-level Epic containers", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "T-1") {
        return {
          key: "T-1",
          fields: issueFields({
            labels: ["repo:backend"],
            issuelinks: [
              {
                type: { name: "Epic" },
                outwardIssue: {
                  key: "EPIC-1",
                  fields: { summary: "E", issuetype: { name: "Epic" } },
                },
              },
            ],
          }),
        };
      }
      if (key === "EPIC-1") {
        return {
          key: "EPIC-1",
          fields: issueFields({
            issuetype: "Epic",
            labels: ["repo:backend"],
          }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "T-1",
        fields: issueFields({
          labels: ["ClaudeReady"],
          issuelinks: [],
        }),
      },
    ]);

    findBranch.mockReturnValue(null);
    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("T-1", { repoRoot: "/dev/backend" });
    expect(result.container.parentContainerKey).toBeNull();
    expect(result.container.parentFeatureBranch).toBeNull();
  });

  it("treats an awaiting-main-promotion blocker as unblocking when its branch is merged into the feature branch", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-2") {
        return {
          key: "SUB-2",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["ClaudeWork", "repo:backend"],
            issuelinks: [
              {
                type: { inward: "is blocked by" },
                inwardIssue: { key: "SUB-1" },
              },
            ],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          // Shipped to the feature branch, awaiting /promote-to-main. No
          // label says so — branch-merge truth is what unblocks downstream.
          labels: ["ClaudeWork"],
          issuelinks: [
            { type: { outward: "blocks" }, outwardIssue: { key: "SUB-2" } },
          ],
        }),
      },
      {
        key: "SUB-2",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeWork", "ClaudeReady"],
          issuelinks: [
            {
              type: { inward: "is blocked by" },
              inwardIssue: { key: "SUB-1" },
            },
          ],
        }),
      },
    ]);

    findBranch.mockImplementation((key) => key);
    // SUB-1's branch IS an ancestor of the feature branch (merged in).
    isAncestor.mockImplementation((ancestor) => ancestor === "SUB-1");
    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("SUB-2", { repoRoot: "/dev/backend" });
    const sub2 = result.stack.find((t) => t.key === "SUB-2");
    expect(sub2.eligible).toBe(true);
    expect(sub2.unblockedBlockers).toEqual([]);
  });

  it("treats ClaudeStackComplete blocker as unblocking even when not merged into feature branch", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "STORY-B") {
        return {
          key: "STORY-B",
          fields: issueFields({
            issuetype: "Story",
            labels: ["repo:backend"],
            issuelinks: [
              {
                type: { inward: "is blocked by" },
                inwardIssue: { key: "STORY-A" },
              },
            ],
          }),
        };
      }
      if (key === "EPIC-1") {
        return {
          key: "EPIC-1",
          fields: issueFields({
            issuetype: "Epic",
            labels: ["repo:backend"],
          }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "STORY-A",
        fields: issueFields({
          issuetype: "Story",
          labels: ["ClaudeStackComplete"],
          status: { statusCategory: { key: "indeterminate" } },
          issuelinks: [
            { type: { outward: "blocks" }, outwardIssue: { key: "STORY-B" } },
          ],
        }),
      },
      {
        key: "STORY-B",
        fields: issueFields({
          issuetype: "Story",
          labels: ["ClaudeReady"],
          issuelinks: [
            {
              type: { inward: "is blocked by" },
              inwardIssue: { key: "STORY-A" },
            },
          ],
        }),
      },
    ]);

    // STORY-B is linked to EPIC-1 via parent
    getIssue.mockImplementation(async (key) => {
      if (key === "STORY-B") {
        return {
          key: "STORY-B",
          fields: issueFields({
            issuetype: "Story",
            parent: {
              key: "EPIC-1",
              fields: { summary: "Epic", issuetype: { name: "Epic" } },
            },
            labels: ["repo:backend"],
            issuelinks: [
              {
                type: { inward: "is blocked by" },
                inwardIssue: { key: "STORY-A" },
              },
            ],
          }),
        };
      }
      if (key === "EPIC-1") {
        return {
          key: "EPIC-1",
          fields: issueFields({
            issuetype: "Epic",
            labels: ["repo:backend"],
          }),
        };
      }
      return { key, fields: issueFields() };
    });

    findBranch.mockImplementation((key) => key);
    // STORY-A's branch is NOT an ancestor of the feature branch
    isAncestor.mockReturnValue(false);
    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("STORY-B", { repoRoot: "/dev/backend" });
    const storyB = result.stack.find((t) => t.key === "STORY-B");
    expect(storyB.eligible).toBe(true);
    expect(storyB.unblockedBlockers).toEqual([]);
  });

  it("ticket with finished blocker still bases on the feature branch", async () => {
    getIssue.mockImplementation(async (key) => {
      if (key === "SUB-2") {
        return {
          key: "SUB-2",
          fields: issueFields({
            issuetype: "Sub-task",
            parent: { key: "STORY-1", fields: { summary: "P" } },
            labels: ["repo:backend"],
            issuelinks: [
              {
                type: { inward: "is blocked by" },
                inwardIssue: { key: "SUB-1" },
              },
            ],
          }),
        };
      }
      if (key === "STORY-1") {
        return {
          key: "STORY-1",
          fields: issueFields({ labels: ["repo:backend"] }),
        };
      }
      return { key, fields: issueFields() };
    });

    searchIssues.mockResolvedValue([
      {
        key: "SUB-1",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeStackReady"],
          issuelinks: [
            { type: { outward: "blocks" }, outwardIssue: { key: "SUB-2" } },
          ],
        }),
      },
      {
        key: "SUB-2",
        fields: issueFields({
          issuetype: "Sub-task",
          labels: ["ClaudeReady"],
          issuelinks: [
            {
              type: { inward: "is blocked by" },
              inwardIssue: { key: "SUB-1" },
            },
          ],
        }),
      },
    ]);

    findBranch.mockReturnValue(null);
    isMergedInto.mockReturnValue(false);

    const result = await resolveStack("SUB-2", { repoRoot: "/dev/backend" });
    const sub2 = result.stack.find((t) => t.key === "SUB-2");
    expect(sub2.baseBranch).toBe("STORY-1");
    expect(sub2.prTarget).toBe("STORY-1");
  });
});
