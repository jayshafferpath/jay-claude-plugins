import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/jira.js", () => ({
  searchIssues: vi.fn(),
  editIssue: vi.fn(),
  getIssue: vi.fn(),
}));

vi.mock("../lib/stack-resolver.js", () => ({
  resolveStack: vi.fn(),
  isFinished: vi.fn(),
}));

const { searchIssues, editIssue, getIssue } = await import("../lib/jira.js");
const { resolveStack, isFinished } = await import("../lib/stack-resolver.js");
const {
  applyParentInheritance,
  buildParentInheritancePatch,
  discoverQueue,
  promoteDownstream,
  QUEUE_QUERIES,
} = await import("../lib/queue.js");

describe("QUEUE_QUERIES", () => {
  it("preserves the readyForPlanning JQL exactly as written in commands/ticket-work.md", () => {
    expect(QUEUE_QUERIES.readyForPlanning).toContain('labels = "ClaudeReady"');
    expect(QUEUE_QUERIES.readyForPlanning).toContain("statusCategory != Done");
    expect(QUEUE_QUERIES.readyForPlanning).toContain(
      "assignee = currentUser()",
    );
  });

  it("preserves the inFlight JQL", () => {
    expect(QUEUE_QUERIES.inFlight).toContain(
      'labels IN ("ClaudeExecuting", "ClaudePRApproved")',
    );
  });

  it("does not filter on retired labels — progress labels are mutually exclusive", () => {
    for (const query of Object.values(QUEUE_QUERIES)) {
      expect(query).not.toContain("ClaudeNeedsReview");
      expect(query).not.toContain("ClaudeDriftChecked");
      expect(query).not.toContain("ClaudePendingMainPromotion");
    }
  });
});

describe("buildParentInheritancePatch edge cases", () => {
  it("handles missing labels arrays defensively", () => {
    const patch = buildParentInheritancePatch({}, {});
    expect(patch).toBeNull();
  });

  it("does not set assignee when parent assignee has no accountId", () => {
    const patch = buildParentInheritancePatch(
      { labels: ["X"], assignee: {} },
      { labels: [] },
    );
    expect(patch).toEqual({ labels: [{ add: "X" }] });
  });
});

describe("buildParentInheritancePatch", () => {
  it("copies parent labels missing on the subtask, skipping ClaudeStackComplete", () => {
    const patch = buildParentInheritancePatch(
      {
        labels: [
          "ClaudeWork",
          "ClaudeReady",
          "ClaudeStackComplete",
          "repo:foo",
        ],
      },
      { labels: ["repo:foo"] },
    );
    expect(patch.labels).toEqual([
      { add: "ClaudeWork" },
      { add: "ClaudeReady" },
    ]);
  });

  it("returns null when subtask already has every parent label and matching assignee", () => {
    const patch = buildParentInheritancePatch(
      { labels: ["ClaudeWork"], assignee: { accountId: "u1" } },
      { labels: ["ClaudeWork"], assignee: { accountId: "u1" } },
    );
    expect(patch).toBeNull();
  });

  it("copies parent assignee onto an unassigned subtask", () => {
    const patch = buildParentInheritancePatch(
      { labels: [], assignee: { accountId: "u1" } },
      { labels: [], assignee: null },
    );
    expect(patch.assignee).toEqual([{ set: { accountId: "u1" } }]);
  });

  it("does not overwrite an existing subtask assignee", () => {
    const patch = buildParentInheritancePatch(
      { labels: [], assignee: { accountId: "u1" } },
      { labels: [], assignee: { accountId: "u2" } },
    );
    expect(patch).toBeNull();
  });
});

describe("discoverQueue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty arrays when every Jira query returns nothing", async () => {
    searchIssues.mockResolvedValue([]);
    const result = await discoverQueue();
    expect(result.tickets).toEqual([]);
    expect(result.parents).toEqual([]);
    expect(result.subtaskExpansions).toEqual([]);
  });

  it("defends against parents/issues with missing fields object", async () => {
    searchIssues
      .mockResolvedValueOnce([{ key: "X-1" }])
      .mockResolvedValueOnce([{ key: "P-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const result = await discoverQueue();
    expect(result.tickets[0]).toMatchObject({ key: "X-1", summary: "" });
    expect(result.parents[0]).toEqual({
      key: "P-1",
      labels: [],
      assignee: null,
    });
  });

  it("merges ready/parent/in-flight queries and dedupes by key", async () => {
    const ready = [
      {
        key: "X-1",
        fields: { summary: "ready", labels: ["ClaudeReady"], assignee: null },
      },
    ];
    const parents = [
      {
        key: "P-1",
        fields: {
          summary: "parent",
          labels: ["ClaudeReady", "ClaudeWork"],
          assignee: { accountId: "u1" },
        },
      },
    ];
    const subtasks = [
      {
        key: "X-2",
        fields: { summary: "child", labels: [], assignee: null },
      },
      {
        key: "X-3",
        fields: {
          summary: "skipped",
          labels: ["ClaudeExecuting"],
          assignee: null,
        },
      },
    ];
    const inFlight = [
      {
        key: "X-1",
        fields: { summary: "ready", labels: ["ClaudeExecuting"] },
      },
      {
        key: "X-4",
        fields: { summary: "exec", labels: ["ClaudeExecuting"] },
      },
    ];

    searchIssues
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(parents)
      .mockResolvedValueOnce(inFlight)
      .mockResolvedValueOnce(subtasks);

    const result = await discoverQueue();

    expect(result.tickets.map((t) => t.key)).toEqual(["X-1", "X-2", "X-4"]);
    expect(result.tickets[1]).toMatchObject({
      key: "X-2",
      via: "parent",
      parentSeed: "P-1",
    });
    expect(result.subtaskExpansions).toHaveLength(1);
    expect(result.subtaskExpansions[0].child).toBe("X-2");
    expect(result.parents).toEqual([
      { key: "P-1", labels: ["ClaudeReady", "ClaudeWork"], assignee: "u1" },
    ]);
  });
});

describe("applyParentInheritance", () => {
  beforeEach(() => vi.resetAllMocks());

  it("applies non-null patches via editIssue and counts them", async () => {
    editIssue.mockResolvedValue();
    const expansions = [
      { child: "A-1", parent: "P-1", patch: { labels: [{ add: "X" }] } },
      { child: "A-2", parent: "P-1", patch: null },
      { child: "A-3", parent: "P-1", patch: { labels: [{ add: "Y" }] } },
    ];
    const applied = await applyParentInheritance(expansions);
    expect(applied).toBe(2);
    expect(editIssue).toHaveBeenCalledTimes(2);
    expect(editIssue).toHaveBeenCalledWith("A-1", { labels: [{ add: "X" }] });
  });
});

describe("promoteDownstream", () => {
  beforeEach(() => vi.resetAllMocks());

  it("promotes eligible downstreams and reports stack completion", async () => {
    searchIssues.mockResolvedValueOnce([
      { key: "DONE-1", fields: { summary: "" } },
    ]);
    resolveStack.mockResolvedValueOnce({
      container: { key: "EPIC-1", type: "Epic" },
      stack: [
        { key: "DONE-1", labels: ["ClaudeWork"], eligible: false },
        { key: "DOWN-1", labels: ["ClaudeWork"], eligible: true },
        // already in flight — must NOT be re-promoted
        {
          key: "DOWN-2",
          labels: ["ClaudeWork", "ClaudeExecuting"],
          eligible: true,
        },
      ],
    });
    getIssue.mockResolvedValue({ fields: { labels: [] } });
    isFinished.mockReturnValue(false);
    editIssue.mockResolvedValue();

    const result = await promoteDownstream({ repoRoot: "/r" });

    expect(result.promoted).toEqual([
      { key: "DOWN-1", unblockedBy: "DONE-1", container: "EPIC-1" },
    ]);
    expect(editIssue).toHaveBeenCalledWith("DOWN-1", {
      labels: [{ add: "ClaudeReady" }],
    });
  });

  it("captures editIssue errors as skipped entries", async () => {
    searchIssues.mockResolvedValueOnce([
      { key: "DONE-2", fields: { summary: "" } },
    ]);
    resolveStack.mockResolvedValueOnce({
      container: { key: "EPIC-2", type: "Epic" },
      stack: [
        { key: "DONE-2", labels: ["ClaudeWork"], eligible: false },
        { key: "DOWN-3", labels: ["ClaudeWork"], eligible: true },
      ],
    });
    getIssue.mockResolvedValue({ fields: { labels: [] } });
    isFinished.mockReturnValue(false);
    editIssue.mockRejectedValueOnce(new Error("Jira 500"));

    const result = await promoteDownstream();
    expect(result.promoted).toEqual([]);
    expect(result.skipped).toEqual([{ key: "DOWN-3", reason: "Jira 500" }]);
  });

  it("flags stack completion when every entry is finished and the container lacks ClaudeStackComplete", async () => {
    searchIssues.mockResolvedValueOnce([
      { key: "DONE-3", fields: { summary: "" } },
    ]);
    resolveStack.mockResolvedValueOnce({
      container: { key: "EPIC-3", type: "Story" },
      stack: [
        { key: "DONE-3", labels: ["ClaudeWork"], eligible: false },
        { key: "OTHER", labels: [], inReview: true, eligible: false },
      ],
    });
    getIssue.mockResolvedValue({ fields: { labels: [] } });
    isFinished.mockReturnValue(true);

    const result = await promoteDownstream();
    expect(result.stackComplete).toEqual([{ key: "EPIC-3", type: "Story" }]);
  });

  it("skips entries that isFinished considers finished", async () => {
    searchIssues.mockResolvedValueOnce([
      { key: "DONE-F", fields: { summary: "" } },
    ]);
    resolveStack.mockResolvedValueOnce({
      container: { key: "EPIC-F", type: "Epic" },
      stack: [
        { key: "DONE-F", labels: [], eligible: false },
        { key: "DOWN-F", labels: [], eligible: true },
      ],
    });
    getIssue.mockResolvedValue({ fields: { labels: [] } });
    // Mark DOWN-F as finished — should be skipped before editIssue is called.
    isFinished.mockReturnValue(true);
    editIssue.mockResolvedValue();

    const result = await promoteDownstream();
    expect(result.promoted).toEqual([]);
    expect(editIssue).not.toHaveBeenCalled();
  });

  it("skips containers when resolveStack returns no container (standalone)", async () => {
    searchIssues.mockResolvedValueOnce([
      { key: "STAND-1", fields: { summary: "" } },
    ]);
    resolveStack.mockResolvedValueOnce({ container: null, stack: [] });

    const result = await promoteDownstream();
    expect(result.promoted).toEqual([]);
    expect(result.stackComplete).toEqual([]);
    expect(getIssue).not.toHaveBeenCalled();
  });
});
