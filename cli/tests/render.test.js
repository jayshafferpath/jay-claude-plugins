import { describe, expect, it } from "vitest";
import { renderSummary, renderTree, renderVerbose } from "../lib/render.js";

describe("renderTree", () => {
  it("renders a stack with multiple tickets", () => {
    const stacks = [
      {
        containerKey: "EPIC-1",
        containerSummary: "My Epic",
        tickets: [
          { key: "T-1", summary: "First", labels: ["ClaudeReady"] },
          { key: "T-2", summary: "Second", labels: ["ClaudeFailed"] },
        ],
      },
    ];
    const output = renderTree(stacks);
    expect(output).toContain("EPIC-1: My Epic");
    expect(output).toContain("T-1: First");
    expect(output).toContain("T-2: Second");
    expect(output).toContain("[FAILED]");
  });

  it("renders waitingOn state", () => {
    const stacks = [
      {
        containerKey: "EPIC-1",
        containerSummary: "E",
        tickets: [
          { key: "T-1", summary: "Wait", labels: [], waitingOn: "T-0" },
        ],
      },
    ];
    const output = renderTree(stacks);
    expect(output).toContain("[waiting on T-0]");
  });

  it("renders action hints for applicable states", () => {
    const stacks = [
      {
        containerKey: "EPIC-1",
        containerSummary: "E",
        tickets: [
          { key: "T-1", summary: "Plan", labels: ["ClaudePlanNeedsApproval"] },
        ],
      },
    ];
    const output = renderTree(stacks);
    expect(output).toContain("approve plan?");
  });
});

describe("renderSummary", () => {
  it("reports total tickets and stacks", () => {
    const stacks = [
      {
        containerKey: "E",
        containerSummary: "E",
        tickets: [
          { key: "T-1", labels: [] },
          { key: "T-2", labels: [] },
        ],
      },
    ];
    const output = renderSummary(stacks);
    expect(output).toContain("2 tickets across 1 stacks");
  });

  it("reports plan approvals pending", () => {
    const stacks = [
      {
        containerKey: "E",
        containerSummary: "E",
        tickets: [{ key: "T-1", labels: ["ClaudePlanNeedsApproval"] }],
      },
    ];
    const output = renderSummary(stacks);
    expect(output).toContain("Plan approvals pending: T-1");
  });

  it("reports PR approvals pending", () => {
    const stacks = [
      {
        containerKey: "E",
        containerSummary: "E",
        tickets: [{ key: "T-1", labels: ["ClaudeStackReady"] }],
      },
    ];
    const output = renderSummary(stacks);
    expect(output).toContain("PR approvals pending: T-1");
  });

  it("reports failed tickets", () => {
    const stacks = [
      {
        containerKey: "E",
        containerSummary: "E",
        tickets: [{ key: "T-1", labels: ["ClaudeFailed"] }],
      },
    ];
    const output = renderSummary(stacks);
    expect(output).toContain("Failed: T-1");
  });

  it("reports no actions pending when clean", () => {
    const stacks = [
      {
        containerKey: "E",
        containerSummary: "E",
        tickets: [{ key: "T-1", labels: ["ClaudeReady"] }],
      },
    ];
    const output = renderSummary(stacks);
    expect(output).toContain("No actions pending.");
  });
});

describe("renderVerbose", () => {
  it("renders full ticket details", () => {
    const ticket = {
      key: "T-1",
      summary: "Do thing",
      stack: "EPIC-1",
      baseChain: "main",
      branch: "T-1-do-thing",
      worktree: "/wt/T-1",
      pr: { url: "http://pr", state: "OPEN" },
      status: "In Progress",
      labels: ["ClaudeExecuting"],
      blocks: ["T-2"],
      blockedBy: [],
      checklist: {
        steps: [
          { num: 1, done: true, label: "Plan" },
          { num: 2, done: false, label: "Approve" },
        ],
      },
      reviewPlan: null,
      execPlan: null,
    };
    const output = renderVerbose(ticket);
    expect(output).toContain("T-1: Do thing");
    expect(output).toContain("Stack:      EPIC-1");
    expect(output).toContain("Branch:     T-1-do-thing");
    expect(output).toContain("Worktree:   /wt/T-1");
    expect(output).toContain("http://pr (OPEN)");
    expect(output).toContain("Blocks:     T-2");
    expect(output).toContain("Blocked by: none");
    expect(output).toContain("[x]");
    expect(output).toContain("[ ]");
  });

  it("renders ticket without PR", () => {
    const ticket = {
      key: "T-1",
      summary: "X",
      stack: null,
      baseChain: null,
      branch: null,
      worktree: null,
      pr: null,
      status: "To Do",
      labels: [],
      blocks: [],
      blockedBy: ["T-0"],
      checklist: null,
      reviewPlan: null,
      execPlan: null,
    };
    const output = renderVerbose(ticket);
    expect(output).toContain("PR:         —");
    expect(output).toContain("Blocked by: T-0");
    expect(output).toContain("state inferred from Jira labels");
  });

  it("renders execPlan and reviewPlan extras", () => {
    const ticket = {
      key: "T-1",
      summary: "X",
      stack: null,
      baseChain: null,
      branch: null,
      worktree: null,
      pr: null,
      status: "To Do",
      labels: ["ClaudeExecuting"],
      blocks: [],
      blockedBy: [],
      checklist: {
        steps: [
          { num: 1, done: true, label: "Plan" },
          { num: 2, done: true, label: "Gate" },
          { num: 3, done: false, label: "Execute" },
          { num: 4, done: false, label: "Review" },
          { num: 5, done: false, label: "Fix" },
        ],
      },
      reviewPlan: { total: 3, resolved: 1, open: 2 },
      execPlan: { total: 10, completed: 7 },
    };
    const output = renderVerbose(ticket);
    expect(output).toContain("(7/10 tasks)");
    expect(output).toContain("(3 issues found)");
    expect(output).toContain("(1 resolved, 2 open)");
  });
});
