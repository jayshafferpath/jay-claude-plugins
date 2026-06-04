import { describe, expect, it } from "vitest";
import { actionHint, labelState, topologicalSort } from "../lib/util.js";

describe("labelState", () => {
  it("returns the highest-priority matching state", () => {
    const result = labelState(["ClaudeReady", "ClaudeFailed"]);
    expect(result).toEqual({ label: "ClaudeFailed", display: "FAILED" });
  });

  it("returns unknown when no labels match", () => {
    expect(labelState([])).toEqual({ label: null, display: "unknown" });
  });
});

describe("actionHint", () => {
  it("returns hint for plan needing approval", () => {
    expect(actionHint("ClaudePlanNeedsApproval")).toBe("approve plan?");
  });

  it("returns null for states without a hint", () => {
    expect(actionHint("ClaudeReady")).toBeNull();
  });
});

describe("topologicalSort", () => {
  it("sorts tickets respecting dependency order", () => {
    const tickets = [{ key: "A" }, { key: "B" }, { key: "C" }];
    const links = [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ];
    expect(topologicalSort(tickets, links)).toEqual(["A", "B", "C"]);
  });

  it("handles tickets with no dependencies", () => {
    const tickets = [{ key: "X" }, { key: "Y" }];
    const result = topologicalSort(tickets, []);
    expect(result).toEqual(["X", "Y"]);
  });
});
