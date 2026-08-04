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
  isReviewStatus,
  LABEL_DISPLAY_ORDER,
  PROGRESS_LABELS,
  progressLabelsOn,
  REVIEW_STATUS_NAMES,
  STATUS_TRANSITIONS,
  SUBTASK_EXCLUSION_LABELS,
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
      "ClaudePlanning",
      "ClaudeExecuting",
      "ClaudeStackReady",
      "ClaudePRApproved",
      "ClaudeFailed",
    ]);
  });

  it("does not carry labels whose state is derivable from git, the PR, or Jira status", () => {
    for (const retired of [
      "ClaudeDriftChecked",
      "ClaudeNeedsReview",
      "ClaudePendingMainPromotion",
      "ClaudeMainPR",
      "ClaudePruned",
      "ClaudeDesignsCaptured",
    ]) {
      expect(ALL_LIFECYCLE_LABELS).not.toContain(retired);
    }
  });

  it("exports CONTAINER_LABELS containing ClaudeStackComplete", () => {
    expect(Object.isFrozen(CONTAINER_LABELS)).toBe(true);
    expect(CONTAINER_LABELS).toContain("ClaudeStackComplete");
  });

  it("ALL_LIFECYCLE_LABELS aggregates every bucket", () => {
    expect(ALL_LIFECYCLE_LABELS).toEqual([
      ...DURABLE_LABELS,
      ...PROGRESS_LABELS,
      ...CONTAINER_LABELS,
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
      "ClaudeFailed",
    ]);
  });

  it("STATUS_TRANSITIONS maps the review event to review-style transitions", () => {
    expect(Object.isFrozen(STATUS_TRANSITIONS)).toBe(true);
    expect(STATUS_TRANSITIONS.review).toEqual([
      "In Review",
      "Code Review",
      "Review",
    ]);
  });

  it("LABEL_DISPLAY_ORDER lists most-advanced state first", () => {
    expect(LABEL_DISPLAY_ORDER[0]).toEqual(["ClaudeFailed", "FAILED"]);
    expect(LABEL_DISPLAY_ORDER.at(-1)).toEqual(["ClaudeReady", "ready"]);
  });

  it("LABEL_DISPLAY_ORDER only references live labels", () => {
    for (const [label] of LABEL_DISPLAY_ORDER) {
      expect(ALL_LIFECYCLE_LABELS).toContain(label);
    }
  });
});

describe("isReviewStatus", () => {
  it("matches every configured review status name, case-insensitively", () => {
    for (const name of REVIEW_STATUS_NAMES) {
      expect(isReviewStatus(name)).toBe(true);
      expect(isReviewStatus(name.toUpperCase())).toBe(true);
    }
  });

  it("returns false for non-review statuses and empty input", () => {
    expect(isReviewStatus("In Progress")).toBe(false);
    expect(isReviewStatus("Done")).toBe(false);
    expect(isReviewStatus(null)).toBe(false);
    expect(isReviewStatus(undefined)).toBe(false);
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
