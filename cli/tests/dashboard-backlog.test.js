import { describe, expect, it } from "vitest";
import {
  diffBacklog,
  pendingInheritance,
} from "../lib/dashboard-backlog.js";

function queueTicket(key, opts = {}) {
  return {
    key,
    summary: `Summary ${key}`,
    labels: opts.labels || ["ClaudeReady"],
    statusName: opts.statusName || "To Do",
    statusCategory: opts.statusCategory || "new",
    issueType: opts.issueType || "Sub-task",
    parentKey: opts.parentKey || null,
    via: opts.via || "direct",
    parentSeed: opts.parentSeed || null,
    ...opts,
  };
}

describe("diffBacklog", () => {
  it("returns only tickets the board isn't already showing", () => {
    const result = diffBacklog({
      queue: { tickets: [queueTicket("A-1"), queueTicket("A-2")] },
      knownKeys: new Set(["A-1"]),
    });
    expect(result.tickets.map((t) => t.key)).toEqual(["A-2"]);
  });

  it("counts already-visible tickets rather than dropping them silently", () => {
    // "0 new" and "the query found nothing" are different situations; the second
    // suggests the JQL or assignment is wrong.
    const result = diffBacklog({
      queue: { tickets: [queueTicket("A-1"), queueTicket("A-2")] },
      knownKeys: ["A-1", "A-2"],
    });
    expect(result.counts).toEqual({
      total: 0,
      direct: 0,
      viaParent: 0,
      alreadyOnBoard: 2,
      alreadyUnderway: 0,
    });
  });

  it("excludes tickets already out for review", () => {
    // Parent expansion sweeps up every non-excluded subtask of a ClaudeReady
    // parent, and SUBTASK_EXCLUSION_LABELS predates ClaudeNeedsReview's
    // retirement — so a finished subtask sitting In Review looked startable.
    // Against a real board this was most of the result set.
    const result = diffBacklog({
      queue: {
        tickets: [
          queueTicket("A-1", { statusName: "To Do" }),
          queueTicket("A-2", { statusName: "In Review", via: "parent", parentSeed: "P-1" }),
          queueTicket("A-3", { statusName: "Code Review" }),
        ],
      },
      knownKeys: [],
    });
    expect(result.tickets.map((t) => t.key)).toEqual(["A-1"]);
    expect(result.counts).toMatchObject({ total: 1, alreadyUnderway: 2 });
  });

  it("excludes finished subtasks swept up by parent expansion", () => {
    // The real cause of the noise: discoverQueue's `parent = KEY` query has no
    // status filter, so long-shipped subtasks came back as startable. Matching on
    // statusCategory rather than a name list handles per-project custom statuses
    // like "Complete" and "Shipped".
    const result = diffBacklog({
      queue: {
        tickets: [
          queueTicket("A-1", { statusName: "To Do", statusCategory: "new" }),
          queueTicket("A-2", {
            statusName: "Complete",
            statusCategory: "done",
            via: "parent",
            parentSeed: "P-1",
          }),
          queueTicket("A-3", {
            statusName: "Shipped",
            statusCategory: "done",
            via: "parent",
            parentSeed: "P-1",
          }),
        ],
      },
      knownKeys: [],
    });
    expect(result.tickets.map((t) => t.key)).toEqual(["A-1"]);
    expect(result.counts).toMatchObject({ total: 1, alreadyUnderway: 2 });
  });

  it("keeps in-progress tickets, excluding only done ones", () => {
    const result = diffBacklog({
      queue: {
        tickets: [
          queueTicket("A-1", { statusCategory: "indeterminate", statusName: "In Progress" }),
          queueTicket("A-2", { statusCategory: "done", statusName: "Done" }),
        ],
      },
      knownKeys: [],
    });
    expect(result.tickets.map((t) => t.key)).toEqual(["A-1"]);
  });

  it("excludes a ticket labelled ClaudeStackReady", () => {
    const result = diffBacklog({
      queue: {
        tickets: [queueTicket("A-1", { labels: ["ClaudeStackReady"] })],
      },
      knownKeys: [],
    });
    expect(result.tickets).toEqual([]);
    expect(result.counts.alreadyUnderway).toBe(1);
  });

  it("counts on-board and underway separately", () => {
    // A ticket already on the board is not also counted as underway, so the two
    // numbers can be read independently.
    const result = diffBacklog({
      queue: {
        tickets: [
          queueTicket("A-1"),
          queueTicket("A-2", { statusName: "In Review" }),
        ],
      },
      knownKeys: ["A-1"],
    });
    expect(result.counts).toMatchObject({
      total: 0,
      alreadyOnBoard: 1,
      alreadyUnderway: 1,
    });
  });

  it("separates directly-eligible tickets from parent-expanded ones", () => {
    const result = diffBacklog({
      queue: {
        tickets: [
          queueTicket("A-1"),
          queueTicket("A-2", { via: "parent", parentSeed: "P-1" }),
          queueTicket("A-3", { via: "parent", parentSeed: "P-1" }),
        ],
      },
      knownKeys: [],
    });
    expect(result.counts).toMatchObject({
      total: 3,
      direct: 1,
      viaParent: 2,
    });
  });

  it("accepts knownKeys as an array or a Set", () => {
    const queue = { tickets: [queueTicket("A-1"), queueTicket("A-2")] };
    expect(diffBacklog({ queue, knownKeys: ["A-1"] }).counts.total).toBe(1);
    expect(
      diffBacklog({ queue, knownKeys: new Set(["A-1"]) }).counts.total,
    ).toBe(1);
  });

  it("treats a missing board as showing nothing", () => {
    const result = diffBacklog({ queue: { tickets: [queueTicket("A-1")] } });
    expect(result.counts.total).toBe(1);
  });

  it("returns empty counts for a missing queue", () => {
    expect(diffBacklog({}).counts).toEqual({
      total: 0,
      direct: 0,
      viaParent: 0,
      alreadyOnBoard: 0,
      alreadyUnderway: 0,
    });
    expect(diffBacklog().tickets).toEqual([]);
  });

  it("treats a ticket with no status as startable", () => {
    // Absent status is not evidence of review; dropping it would hide real work.
    const result = diffBacklog({
      queue: { tickets: [queueTicket("A-1", { statusName: null })] },
      knownKeys: [],
    });
    expect(result.tickets.map((t) => t.key)).toEqual(["A-1"]);
  });

  it("preserves the fields the panel renders", () => {
    const result = diffBacklog({
      queue: {
        tickets: [
          queueTicket("A-1", { via: "parent", parentSeed: "P-1", issueType: "Sub-task" }),
        ],
      },
      knownKeys: [],
    });
    expect(result.tickets[0]).toMatchObject({
      key: "A-1",
      summary: "Summary A-1",
      issueType: "Sub-task",
      via: "parent",
      parentSeed: "P-1",
    });
  });
});

describe("pendingInheritance", () => {
  it("lists subtasks that still need a labels/assignee patch", () => {
    const result = pendingInheritance({
      subtaskExpansions: [
        { child: "A-1", parent: "P-1", patch: { labels: [{ add: "x" }] } },
        { child: "A-2", parent: "P-1", patch: null },
      ],
    });
    expect(result).toEqual([{ child: "A-1", parent: "P-1" }]);
  });

  it("treats an undefined patch as nothing pending", () => {
    const result = pendingInheritance({
      subtaskExpansions: [{ child: "A-1", parent: "P-1" }],
    });
    expect(result).toEqual([]);
  });

  it("tolerates a queue with no expansions", () => {
    expect(pendingInheritance({})).toEqual([]);
    expect(pendingInheritance()).toEqual([]);
  });
});
