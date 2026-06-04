import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("../lib/jira.js", () => ({
  getComments: vi.fn(),
  addComment: vi.fn(),
  updateComment: vi.fn(),
}));

const { readdirSync } = await import("node:fs");
const { getComments, addComment, updateComment } = await import(
  "../lib/jira.js"
);
const {
  readChecklist,
  readReviewPlan,
  readExecutionPlan,
  readExecutionPlanRaw,
  syncChecklistToJira,
  syncPlanToJira,
  readChecklistFromJira,
  readExecutionPlanFromJira,
  readPlanSectionsFromJira,
  markPlanTaskDone,
} = await import("../lib/checklist.js");

const CHECKLIST_MD = `---
ticket: TICK-1
stack: EPIC-1
---

- [x] 1. Plan
- [ ] 2. Approve plan
- [x] 3. Execute
`;

const PLAN_MD = `## Phase 1
- [x] Create schema
- [ ] Add migration

## Phase 2
- [ ] Write tests
`;

const REVIEW_MD = `# PR Review
- [x] Fix typo
- [ ] Handle edge case
- [ ] Add test
`;

describe("readChecklist", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads from worktree dir when file exists", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(CHECKLIST_MD);
    const result = readChecklist("/wt", "TICK-1");
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]).toEqual({ num: 1, done: true, label: "Plan" });
    expect(result.steps[1]).toEqual({
      num: 2,
      done: false,
      label: "Approve plan",
    });
    expect(result.frontmatter.ticket).toBe("TICK-1");
  });

  it("falls back to git show when worktree file missing", () => {
    existsSync.mockReturnValue(false);
    execSync.mockReturnValue(CHECKLIST_MD);
    const result = readChecklist(null, "TICK-1", {
      branch: "feat",
      repoRoot: "/repo",
    });
    expect(result.steps).toHaveLength(3);
  });

  it("returns null when nothing found", () => {
    existsSync.mockReturnValue(false);
    execSync.mockImplementation(() => {
      throw new Error("not found");
    });
    const result = readChecklist(null, "TICK-1", {
      branch: "feat",
      repoRoot: "/repo",
    });
    expect(result).toBeNull();
  });

  it("returns null when no worktree and no branch info", () => {
    existsSync.mockReturnValue(false);
    const result = readChecklist(null, "TICK-1");
    expect(result).toBeNull();
  });
});

describe("readReviewPlan", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads review plan from worktree", () => {
    existsSync.mockReturnValue(true);
    readdirSync.mockReturnValue(["pr-review-TICK-1.md"]);
    readFileSync.mockReturnValue(REVIEW_MD);
    const result = readReviewPlan("/wt", "TICK-1");
    expect(result).toEqual({ total: 3, resolved: 1, open: 2 });
  });

  it("falls back to git show", () => {
    existsSync.mockReturnValue(false);
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("pr-review-")) return REVIEW_MD;
      if (cmd.includes(".claude/plans")) return "pr-review-TICK-1.md\n";
      return "";
    });
    const result = readReviewPlan(null, "TICK-1", {
      branch: "feat",
      repoRoot: "/repo",
    });
    expect(result).toEqual({ total: 3, resolved: 1, open: 2 });
  });

  it("returns null when nothing found", () => {
    existsSync.mockReturnValue(false);
    execSync.mockImplementation(() => {
      throw new Error("not found");
    });
    const result = readReviewPlan(null, "TICK-1", {
      branch: "feat",
      repoRoot: "/repo",
    });
    expect(result).toBeNull();
  });
});

describe("readExecutionPlan", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads plan from worktree", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(PLAN_MD);
    const result = readExecutionPlan("/wt", "TICK-1");
    expect(result).toEqual({ total: 3, completed: 1 });
  });

  it("falls back to git show", () => {
    existsSync.mockReturnValue(false);
    execSync.mockReturnValue(PLAN_MD);
    const result = readExecutionPlan(null, "TICK-1", {
      branch: "feat",
      repoRoot: "/repo",
    });
    expect(result).toEqual({ total: 3, completed: 1 });
  });

  it("returns null when not found", () => {
    existsSync.mockReturnValue(false);
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    const result = readExecutionPlan(null, "TICK-1", {
      branch: "b",
      repoRoot: "/r",
    });
    expect(result).toBeNull();
  });
});

describe("readExecutionPlanRaw", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads raw content from worktree", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(PLAN_MD);
    expect(readExecutionPlanRaw("/wt", "TICK-1")).toBe(PLAN_MD);
  });

  it("falls back to git show", () => {
    existsSync.mockReturnValue(false);
    execSync.mockReturnValue(PLAN_MD);
    expect(
      readExecutionPlanRaw(null, "TICK-1", { branch: "b", repoRoot: "/r" }),
    ).toBe(PLAN_MD);
  });

  it("returns null when not found", () => {
    existsSync.mockReturnValue(false);
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(
      readExecutionPlanRaw(null, "TICK-1", { branch: "b", repoRoot: "/r" }),
    ).toBeNull();
  });
});

describe("syncChecklistToJira", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("does nothing when steps are empty", async () => {
    await syncChecklistToJira("TICK-1", []);
    expect(getComments).not.toHaveBeenCalled();
  });

  it("creates new comment when none exists", async () => {
    getComments.mockResolvedValue([]);
    addComment.mockResolvedValue({});
    await syncChecklistToJira("TICK-1", [
      { num: 1, done: true, label: "Plan" },
    ]);
    expect(addComment).toHaveBeenCalledWith(
      "TICK-1",
      expect.objectContaining({ type: "doc" }),
    );
  });

  it("updates existing comment when marker found", async () => {
    getComments.mockResolvedValue([
      {
        id: "42",
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "[claude-checklist-sync] " }],
            },
          ],
        },
      },
    ]);
    updateComment.mockResolvedValue({});
    await syncChecklistToJira("TICK-1", [
      { num: 1, done: true, label: "Plan" },
    ]);
    expect(updateComment).toHaveBeenCalledWith(
      "TICK-1",
      "42",
      expect.objectContaining({ type: "doc" }),
    );
  });
});

describe("syncPlanToJira", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("does nothing when planContent is falsy", async () => {
    await syncPlanToJira("TICK-1", null);
    expect(getComments).not.toHaveBeenCalled();
  });

  it("does nothing when no sections found", async () => {
    await syncPlanToJira("TICK-1", "no sections here");
    expect(getComments).not.toHaveBeenCalled();
  });

  it("creates new comment from plan content", async () => {
    getComments.mockResolvedValue([]);
    addComment.mockResolvedValue({});
    await syncPlanToJira("TICK-1", PLAN_MD);
    expect(addComment).toHaveBeenCalledWith(
      "TICK-1",
      expect.objectContaining({ type: "doc" }),
    );
  });

  it("updates existing plan comment", async () => {
    getComments.mockResolvedValue([
      {
        id: "99",
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "[claude-plan-sync] " }],
            },
          ],
        },
      },
    ]);
    updateComment.mockResolvedValue({});
    await syncPlanToJira("TICK-1", PLAN_MD);
    expect(updateComment).toHaveBeenCalledWith(
      "TICK-1",
      "99",
      expect.objectContaining({ type: "doc" }),
    );
  });
});

describe("readChecklistFromJira", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when no checklist comment exists", async () => {
    getComments.mockResolvedValue([]);
    expect(await readChecklistFromJira("TICK-1")).toBeNull();
  });

  it("parses checklist from ADF comment", async () => {
    getComments.mockResolvedValue([
      {
        id: "1",
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "[claude-checklist-sync] " }],
            },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "✅ 1. Plan" }],
                    },
                  ],
                },
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "⬜ 2. Execute" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ]);
    const result = await readChecklistFromJira("TICK-1");
    expect(result.steps).toEqual([
      { num: 1, done: true, label: "Plan" },
      { num: 2, done: false, label: "Execute" },
    ]);
  });
});

describe("readExecutionPlanFromJira", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when no plan comment exists", async () => {
    getComments.mockResolvedValue([]);
    expect(await readExecutionPlanFromJira("TICK-1")).toBeNull();
  });

  it("parses plan totals from ADF comment", async () => {
    getComments.mockResolvedValue([
      {
        id: "1",
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "[claude-plan-sync] " }],
            },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "✅ Do thing" }],
                    },
                  ],
                },
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "⬜ Other thing" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ]);
    const result = await readExecutionPlanFromJira("TICK-1");
    expect(result).toEqual({ total: 2, completed: 1 });
  });
});

describe("readPlanSectionsFromJira", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when no plan comment exists", async () => {
    getComments.mockResolvedValue([]);
    expect(await readPlanSectionsFromJira("TICK-1")).toBeNull();
  });

  it("parses sections from ADF comment", async () => {
    getComments.mockResolvedValue([
      {
        id: "1",
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "[claude-plan-sync] " }],
            },
            {
              type: "heading",
              attrs: { level: 3 },
              content: [{ type: "text", text: "Phase 1" }],
            },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "✅ Create schema" }],
                    },
                  ],
                },
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "⬜ Add migration" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ]);
    const result = await readPlanSectionsFromJira("TICK-1");
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].title).toBe("Phase 1");
    expect(result.total).toBe(2);
    expect(result.completed).toBe(1);
  });

  it("returns null when ADF body has no tasks", async () => {
    getComments.mockResolvedValue([
      {
        id: "1",
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "[claude-plan-sync] " }],
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: "No tasks here" }],
            },
          ],
        },
      },
    ]);
    const result = await readPlanSectionsFromJira("TICK-1");
    expect(result).toBeNull();
  });
});

describe("markPlanTaskDone", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const planComment = {
    id: "55",
    body: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "[claude-plan-sync] " }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Phase 1" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "✅ Create schema" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "⬜ Add migration" }],
                },
              ],
            },
          ],
        },
      ],
    },
  };

  it("marks the specified task as done and updates Jira", async () => {
    getComments.mockResolvedValue([planComment]);
    updateComment.mockResolvedValue({});
    const result = await markPlanTaskDone("TICK-1", "Add migration");
    expect(result.completed).toBe(2);
    expect(result.total).toBe(2);
    expect(result.sections[0].tasks[1].done).toBe(true);
    expect(updateComment).toHaveBeenCalledWith(
      "TICK-1",
      "55",
      expect.objectContaining({ type: "doc" }),
    );
  });

  it("throws when no plan exists in Jira", async () => {
    getComments.mockResolvedValue([]);
    await expect(markPlanTaskDone("TICK-1", "anything")).rejects.toThrow(
      "No plan found in Jira for TICK-1",
    );
  });

  it("throws when task label not found", async () => {
    getComments.mockResolvedValue([planComment]);
    await expect(
      markPlanTaskDone("TICK-1", "Nonexistent task"),
    ).rejects.toThrow('Task not found or already done: "Nonexistent task"');
  });

  it("throws when task is already done", async () => {
    getComments.mockResolvedValue([planComment]);
    await expect(
      markPlanTaskDone("TICK-1", "Create schema"),
    ).rejects.toThrow('Task not found or already done: "Create schema"');
  });

  it("creates new comment when no existing plan comment", async () => {
    const noMarkerComments = [
      { id: "1", body: { type: "doc", content: [] } },
    ];
    getComments
      .mockResolvedValueOnce([planComment])
      .mockResolvedValueOnce(noMarkerComments);
    addComment.mockResolvedValue({});
    const result = await markPlanTaskDone("TICK-1", "Add migration");
    expect(result.completed).toBe(2);
    expect(addComment).toHaveBeenCalled();
  });
});
