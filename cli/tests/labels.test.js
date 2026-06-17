import { describe, expect, it } from "vitest";
import {
  ALL_LIFECYCLE_LABELS,
  COMPLEXITY_LABELS,
  COMPLEXITY_STANDARD,
  COMPLEXITY_TRIVIAL,
  CONTAINER_LABELS,
  clearProgressLabelsPatch,
  DURABLE_LABELS,
  getComplexity,
  IN_FLIGHT_LABELS,
  isInFlight,
  LABEL_DISPLAY_ORDER,
  LABEL_TO_STATUS_TRANSITIONS,
  PROGRESS_LABELS,
  progressLabelsOn,
  SUBTASK_EXCLUSION_LABELS,
  TERMINAL_LABELS,
} from "../lib/labels.js";

describe("labels.js label sets", () => {
  it("exports DURABLE_LABELS as a frozen array containing ClaudeWork", () => {
    expect(Object.isFrozen(DURABLE_LABELS)).toBe(true);
    expect(DURABLE_LABELS).toContain("ClaudeWork");
  });

  it("exports PROGRESS_LABELS as a frozen array with the expected lifecycle states", () => {
    expect(Object.isFrozen(PROGRESS_LABELS)).toBe(true);
    expect(PROGRESS_LABELS).toEqual([
      "ClaudeReady",
      "ClaudeDriftChecked",
      "ClaudePlanning",
      "ClaudeExecuting",
      "ClaudeStackReady",
      "ClaudePRApproved",
      "ClaudeNeedsReview",
      "ClaudePendingMainPromotion",
      "ClaudeMainPR",
      "ClaudeFailed",
    ]);
  });

  it("exports CONTAINER_LABELS containing ClaudeStackComplete", () => {
    expect(Object.isFrozen(CONTAINER_LABELS)).toBe(true);
    expect(CONTAINER_LABELS).toContain("ClaudeStackComplete");
  });

  it("exports TERMINAL_LABELS containing ClaudePruned", () => {
    expect(Object.isFrozen(TERMINAL_LABELS)).toBe(true);
    expect(TERMINAL_LABELS).toContain("ClaudePruned");
  });

  it("ALL_LIFECYCLE_LABELS aggregates all four buckets", () => {
    expect(ALL_LIFECYCLE_LABELS).toEqual([
      ...DURABLE_LABELS,
      ...PROGRESS_LABELS,
      ...CONTAINER_LABELS,
      ...TERMINAL_LABELS,
    ]);
  });

  it("IN_FLIGHT_LABELS only contains active-work signals", () => {
    expect(IN_FLIGHT_LABELS).toEqual(["ClaudePlanning", "ClaudeExecuting"]);
  });

  it("SUBTASK_EXCLUSION_LABELS matches the ticket-work parent-expansion filter", () => {
    expect(SUBTASK_EXCLUSION_LABELS).toEqual([
      "ClaudePlanning",
      "ClaudeExecuting",
      "ClaudeStackReady",
      "ClaudePRApproved",
      "ClaudeNeedsReview",
      "ClaudeFailed",
    ]);
  });

  it("LABEL_TO_STATUS_TRANSITIONS maps ClaudeNeedsReview to review-style transitions", () => {
    expect(Object.isFrozen(LABEL_TO_STATUS_TRANSITIONS)).toBe(true);
    expect(LABEL_TO_STATUS_TRANSITIONS.ClaudeNeedsReview).toEqual([
      "In Review",
      "Code Review",
      "Review",
    ]);
    // Every key must be a known progress label.
    for (const key of Object.keys(LABEL_TO_STATUS_TRANSITIONS)) {
      expect(PROGRESS_LABELS).toContain(key);
    }
  });

  it("LABEL_DISPLAY_ORDER lists most-advanced state first", () => {
    expect(LABEL_DISPLAY_ORDER[0]).toEqual(["ClaudeFailed", "FAILED"]);
    expect(LABEL_DISPLAY_ORDER.at(-1)).toEqual(["ClaudeReady", "ready"]);
  });
});

describe("progressLabelsOn", () => {
  it("returns the subset of PROGRESS_LABELS currently applied", () => {
    expect(
      progressLabelsOn(["ClaudeWork", "ClaudeExecuting", "repo:foo"]),
    ).toEqual(["ClaudeExecuting"]);
  });

  it("preserves PROGRESS_LABELS ordering, not input order", () => {
    expect(
      progressLabelsOn(["ClaudeFailed", "ClaudeReady", "ClaudeStackReady"]),
    ).toEqual(["ClaudeReady", "ClaudeStackReady", "ClaudeFailed"]);
  });

  it("returns an empty array for non-array input", () => {
    expect(progressLabelsOn(null)).toEqual([]);
    expect(progressLabelsOn(undefined)).toEqual([]);
  });

  it("returns an empty array when no progress labels are present", () => {
    expect(progressLabelsOn(["ClaudeWork", "repo:x"])).toEqual([]);
  });
});

describe("clearProgressLabelsPatch", () => {
  it("emits one remove entry per applied progress label", () => {
    expect(
      clearProgressLabelsPatch(["ClaudeExecuting", "ClaudeFailed"]),
    ).toEqual([{ remove: "ClaudeExecuting" }, { remove: "ClaudeFailed" }]);
  });

  it("returns [] when no progress labels are set", () => {
    expect(clearProgressLabelsPatch(["ClaudeWork"])).toEqual([]);
  });
});

describe("getComplexity / COMPLEXITY_LABELS", () => {
  it("exports COMPLEXITY_LABELS as a frozen list of the two tiers", () => {
    expect(Object.isFrozen(COMPLEXITY_LABELS)).toBe(true);
    expect(COMPLEXITY_LABELS).toEqual([
      "complexity:trivial",
      "complexity:standard",
    ]);
  });

  it("returns 'trivial' when complexity:trivial is present", () => {
    expect(getComplexity(["ClaudeWork", "complexity:trivial"])).toBe(
      COMPLEXITY_TRIVIAL,
    );
  });

  it("returns 'standard' when complexity:standard is present", () => {
    expect(getComplexity(["complexity:standard"])).toBe(COMPLEXITY_STANDARD);
  });

  it("defaults to 'standard' when no complexity label is present", () => {
    expect(getComplexity(["ClaudeWork", "repo:foo"])).toBe(COMPLEXITY_STANDARD);
  });

  it("prefers 'trivial' when both labels are set (defensive)", () => {
    expect(getComplexity(["complexity:trivial", "complexity:standard"])).toBe(
      COMPLEXITY_TRIVIAL,
    );
  });

  it("returns 'standard' for non-array input", () => {
    expect(getComplexity(null)).toBe(COMPLEXITY_STANDARD);
    expect(getComplexity(undefined)).toBe(COMPLEXITY_STANDARD);
  });
});

describe("isInFlight", () => {
  it("returns true when ClaudePlanning is set", () => {
    expect(isInFlight(["ClaudePlanning"])).toBe(true);
  });

  it("returns true when ClaudeExecuting is set", () => {
    expect(isInFlight(["ClaudeWork", "ClaudeExecuting"])).toBe(true);
  });

  it("returns false when neither in-flight label is set", () => {
    expect(isInFlight(["ClaudeWork", "ClaudeReady", "ClaudeStackReady"])).toBe(
      false,
    );
  });

  it("returns false for non-array input", () => {
    expect(isInFlight(null)).toBe(false);
  });
});
