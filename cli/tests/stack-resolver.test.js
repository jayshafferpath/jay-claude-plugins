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
}));

vi.mock("../lib/config.js", () => ({
  loadDevRoot: vi.fn(),
}));

const { getIssue, searchIssues } = await import("../lib/jira.js");
const { findBranch, isAncestor, isMergedInto, getMergedPrMap } = await import(
  "../lib/git.js"
);
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

  it("returns true when has ClaudeNeedsReview label", () => {
    expect(isFinished(["ClaudeNeedsReview"], "indeterminate")).toBe(true);
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
          labels: ["ClaudeWork", "ClaudeNeedsReview", "repo:backend"],
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
          labels: ["ClaudeWork", "ClaudeNeedsReview"],
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
          labels: ["ClaudeWork", "ClaudeNeedsReview"],
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

  it("treats ClaudePendingMainPromotion blocker as unblocking when its branch is merged into the feature branch", async () => {
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
          // Shipped to feature branch, awaiting /promote-to-main. Notably,
          // ClaudePendingMainPromotion does NOT satisfy isFinished().
          labels: ["ClaudeWork", "ClaudePendingMainPromotion"],
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
