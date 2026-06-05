import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/jira.js", () => ({
  getIssue: vi.fn(),
  searchIssues: vi.fn(),
}));

vi.mock("../lib/git.js", () => ({
  findBranch: vi.fn(),
  isAncestor: vi.fn(),
  isMergedInto: vi.fn(),
}));

vi.mock("../lib/config.js", () => ({
  loadDevRoot: vi.fn(),
}));

const { getIssue, searchIssues } = await import("../lib/jira.js");
const { findBranch, isAncestor, isMergedInto } = await import("../lib/git.js");
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
