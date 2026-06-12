import { describe, expect, it } from "vitest";

import { buildParentInheritancePatch, QUEUE_QUERIES } from "../lib/queue.js";

describe("QUEUE_QUERIES", () => {
  it("preserves the readyForPlanning JQL exactly as written in commands/ticket-work.md", () => {
    expect(QUEUE_QUERIES.readyForPlanning).toContain('labels = "ClaudeReady"');
    expect(QUEUE_QUERIES.readyForPlanning).toContain(
      'labels NOT IN ("ClaudeExecuting", "ClaudeNeedsReview", "ClaudeFailed")',
    );
    expect(QUEUE_QUERIES.readyForPlanning).toContain(
      "assignee = currentUser()",
    );
  });

  it("preserves the inFlight JQL", () => {
    expect(QUEUE_QUERIES.inFlight).toContain(
      'labels IN ("ClaudeExecuting", "ClaudePRApproved")',
    );
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
