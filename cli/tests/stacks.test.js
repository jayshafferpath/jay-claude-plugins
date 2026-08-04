import { describe, expect, it } from "vitest";
import {
  attachFeatureBranches,
  buildStacks,
  computeStackLayers,
  featureBranchFromContainer,
} from "../lib/stacks.js";

function issue(key, opts = {}) {
  return {
    key,
    fields: {
      summary: opts.summary || `Summary for ${key}`,
      labels: opts.labels || [],
      parent: opts.parent || null,
      issuetype: { name: opts.issuetype || "Task" },
      issuelinks: opts.issuelinks || [],
      status: opts.status || { statusCategory: { key: "indeterminate" } },
    },
  };
}

describe("buildStacks", () => {
  it("groups standalone issues into a Standalone stack", () => {
    const issues = [issue("A-1"), issue("A-2")];
    const stacks = buildStacks(issues);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].containerKey).toBe("Standalone");
    expect(stacks[0].tickets).toHaveLength(2);
  });

  it("groups subtasks under their parent", () => {
    const issues = [
      issue("SUB-1", {
        issuetype: "Sub-task",
        parent: { key: "PARENT-1", fields: { summary: "Parent task" } },
      }),
      issue("SUB-2", {
        issuetype: "Subtask",
        parent: { key: "PARENT-1", fields: { summary: "Parent task" } },
      }),
    ];
    const stacks = buildStacks(issues);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].containerKey).toBe("PARENT-1");
    expect(stacks[0].containerSummary).toBe("Parent task");
    expect(stacks[0].tickets).toHaveLength(2);
  });

  it("groups issues linked to an epic under that epic", () => {
    const issues = [
      issue("T-1", {
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
    ];
    const stacks = buildStacks(issues);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].containerKey).toBe("EPIC-1");
    expect(stacks[0].containerSummary).toBe("My Epic");
  });

  it("respects blocking link ordering via topological sort", () => {
    const issues = [
      issue("T-3", {
        issuelinks: [
          {
            type: { inward: "is blocked by" },
            inwardIssue: { key: "T-2" },
          },
        ],
      }),
      issue("T-1"),
      issue("T-2", {
        issuelinks: [
          {
            type: { inward: "is blocked by" },
            inwardIssue: { key: "T-1" },
          },
          {
            type: { outward: "blocks" },
            outwardIssue: { key: "T-3" },
          },
        ],
      }),
    ];
    const stacks = buildStacks(issues);
    const keys = stacks[0].tickets.map((t) => t.key);
    expect(keys.indexOf("T-1")).toBeLessThan(keys.indexOf("T-2"));
    expect(keys.indexOf("T-2")).toBeLessThan(keys.indexOf("T-3"));
  });

  it("sets waitingOn when a blocker is unfinished", () => {
    const issues = [
      issue("T-1"),
      issue("T-2", {
        issuelinks: [
          {
            type: { inward: "is blocked by" },
            inwardIssue: { key: "T-1" },
          },
        ],
      }),
    ];
    const stacks = buildStacks(issues);
    const t2 = stacks[0].tickets.find((t) => t.key === "T-2");
    expect(t2.waitingOn).toBe("T-1");
  });

  it("clears waitingOn when blocker is finished (done status)", () => {
    const issues = [
      issue("T-1", { status: { statusCategory: { key: "done" } } }),
      issue("T-2", {
        issuelinks: [
          {
            type: { inward: "is blocked by" },
            inwardIssue: { key: "T-1" },
          },
        ],
      }),
    ];
    const stacks = buildStacks(issues);
    const t2 = stacks[0].tickets.find((t) => t.key === "T-2");
    expect(t2.waitingOn).toBeNull();
  });

  it("clears waitingOn when blocker has ClaudeStackReady label", () => {
    const issues = [
      issue("T-1", { labels: ["ClaudeStackReady"] }),
      issue("T-2", {
        issuelinks: [
          {
            type: { inward: "is blocked by" },
            inwardIssue: { key: "T-1" },
          },
        ],
      }),
    ];
    const stacks = buildStacks(issues);
    const t2 = stacks[0].tickets.find((t) => t.key === "T-2");
    expect(t2.waitingOn).toBeNull();
  });

  it("clears waitingOn when blocker is in a review status", () => {
    const issues = [
      issue("T-1", {
        status: { name: "In Review", statusCategory: { key: "indeterminate" } },
      }),
      issue("T-2", {
        issuelinks: [
          {
            type: { inward: "is blocked by" },
            inwardIssue: { key: "T-1" },
          },
        ],
      }),
    ];
    const stacks = buildStacks(issues);
    const t2 = stacks[0].tickets.find((t) => t.key === "T-2");
    expect(t2.waitingOn).toBeNull();
  });

  it("keeps waitingOn set when the blocker only carries a stale ClaudeNeedsReview label", () => {
    const issues = [
      issue("T-1", { labels: ["ClaudeNeedsReview"] }),
      issue("T-2", {
        issuelinks: [
          {
            type: { inward: "is blocked by" },
            inwardIssue: { key: "T-1" },
          },
        ],
      }),
    ];
    const stacks = buildStacks(issues);
    const t2 = stacks[0].tickets.find((t) => t.key === "T-2");
    expect(t2.waitingOn).toBe("T-1");
  });

  it("ignores blockers not in the issue set", () => {
    const issues = [
      issue("T-2", {
        issuelinks: [
          {
            type: { inward: "is blocked by" },
            inwardIssue: { key: "EXTERNAL-1" },
          },
        ],
      }),
    ];
    const stacks = buildStacks(issues);
    const t2 = stacks[0].tickets.find((t) => t.key === "T-2");
    expect(t2.waitingOn).toBeNull();
  });

  it("sorts stacks alphabetically by containerKey", () => {
    const issues = [
      issue("Z-1", {
        issuetype: "Sub-task",
        parent: { key: "ZEBRA-1", fields: { summary: "" } },
      }),
      issue("A-1", {
        issuetype: "Sub-task",
        parent: { key: "ALPHA-1", fields: { summary: "" } },
      }),
    ];
    const stacks = buildStacks(issues);
    expect(stacks[0].containerKey).toBe("ALPHA-1");
    expect(stacks[1].containerKey).toBe("ZEBRA-1");
  });

  it("includes blocks array on each ticket", () => {
    const issues = [
      issue("T-1", {
        issuelinks: [
          {
            type: { outward: "blocks" },
            outwardIssue: { key: "T-2" },
          },
        ],
      }),
      issue("T-2"),
    ];
    const stacks = buildStacks(issues);
    const t1 = stacks[0].tickets.find((t) => t.key === "T-1");
    expect(t1.blocks).toEqual(["T-2"]);
  });
});

describe("featureBranchFromContainer", () => {
  it("returns the container key for non-Standalone containers", () => {
    expect(featureBranchFromContainer("EPIC-1")).toBe("EPIC-1");
    expect(featureBranchFromContainer("STORY-42")).toBe("STORY-42");
  });

  it("returns null for the Standalone container", () => {
    expect(featureBranchFromContainer("Standalone")).toBeNull();
  });

  it("returns null for empty/null input", () => {
    expect(featureBranchFromContainer(null)).toBeNull();
    expect(featureBranchFromContainer(undefined)).toBeNull();
    expect(featureBranchFromContainer("")).toBeNull();
  });
});

describe("attachFeatureBranches", () => {
  it("sets featureBranch to the container key on each stack", async () => {
    const stacks = [
      { containerKey: "EPIC-1", tickets: [] },
      { containerKey: "STORY-2", tickets: [] },
      { containerKey: "Standalone", tickets: [] },
    ];

    await attachFeatureBranches(stacks);

    expect(stacks[0].featureBranch).toBe("EPIC-1");
    expect(stacks[1].featureBranch).toBe("STORY-2");
    expect(stacks[2].featureBranch).toBeNull();
  });
});

describe("computeStackLayers", () => {
  it("assigns depth 0 to tickets with no in-stack blockers", () => {
    const tickets = [
      { key: "T-1", blockers: [] },
      { key: "T-2", blockers: [] },
    ];
    const depth = computeStackLayers(tickets);
    expect(depth.get("T-1")).toBe(0);
    expect(depth.get("T-2")).toBe(0);
  });

  it("increments depth for blocker chains", () => {
    const tickets = [
      { key: "T-1", blockers: [] },
      { key: "T-2", blockers: ["T-1"] },
      { key: "T-3", blockers: ["T-2"] },
    ];
    const depth = computeStackLayers(tickets);
    expect(depth.get("T-1")).toBe(0);
    expect(depth.get("T-2")).toBe(1);
    expect(depth.get("T-3")).toBe(2);
  });

  it("ignores blockers not in the ticket set", () => {
    const tickets = [{ key: "T-2", blockers: ["EXTERNAL-1"] }];
    const depth = computeStackLayers(tickets);
    expect(depth.get("T-2")).toBe(0);
  });

  it("uses the deepest parent when a ticket has multiple blockers", () => {
    const tickets = [
      { key: "T-1", blockers: [] },
      { key: "T-2", blockers: ["T-1"] },
      { key: "T-3", blockers: ["T-1", "T-2"] },
    ];
    const depth = computeStackLayers(tickets);
    expect(depth.get("T-3")).toBe(2);
  });
});
