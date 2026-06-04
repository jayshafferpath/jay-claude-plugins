import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

const { findReviewPlanFile, formatSummary, postSummary } = await import(
  "../lib/review-summary.js"
);

describe("findReviewPlanFile", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when plans dir does not exist", () => {
    existsSync.mockReturnValue(false);
    expect(findReviewPlanFile("/plans", "T-1")).toBeNull();
  });

  it("finds pr-review-*.md file", () => {
    existsSync.mockReturnValue(true);
    readdirSync.mockReturnValue([
      "jira-T-1.md",
      "pr-review-2024-01-01.md",
      "other.md",
    ]);
    const result = findReviewPlanFile("/plans", "T-1");
    expect(result).toBe("/plans/pr-review-2024-01-01.md");
  });

  it("finds pr-{ticketKey}*.md file", () => {
    existsSync.mockReturnValue(true);
    readdirSync.mockReturnValue(["jira-T-1.md", "pr-T-1-review.md"]);
    const result = findReviewPlanFile("/plans", "T-1");
    expect(result).toBe("/plans/pr-T-1-review.md");
  });

  it("returns null when no matching file", () => {
    existsSync.mockReturnValue(true);
    readdirSync.mockReturnValue(["jira-T-1.md", "other.md"]);
    expect(findReviewPlanFile("/plans", "T-1")).toBeNull();
  });
});

describe("formatSummary", () => {
  it("parses checklist items into issues", () => {
    const content = `# PR Review Plan

## Issues

- [x] **Missing null check**: could crash on empty input
  - Added guard clause in handler.ts
- [ ] **Unused import**: lodash imported but not used
  - Remove the import
`;

    const result = formatSummary(content);
    expect(result.issuesFound).toBe(2);
    expect(result.issuesResolved).toBe(1);
    expect(result.markdown).toContain("## Claude Code Review Summary");
    expect(result.markdown).toContain("Missing null check");
    expect(result.markdown).toContain("**resolved**");
    expect(result.markdown).toContain("**open**");
  });

  it("returns null markdown when no issues found", () => {
    const content = "# PR Review Plan\n\nLooks good, no issues.";
    const result = formatSummary(content);
    expect(result.markdown).toBeNull();
    expect(result.issuesFound).toBe(0);
  });

  it("handles bold syntax in item titles", () => {
    const content = "- [x] **Bold title**: desc\n";
    const result = formatSummary(content);
    expect(result.issuesFound).toBe(1);
    expect(result.markdown).toContain("Bold title");
  });
});

describe("postSummary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns no_plan_file when file not found", () => {
    existsSync.mockReturnValue(false);
    const result = postSummary("feat-1", "/plans", "T-1", "/repo");
    expect(result).toEqual({ posted: false, reason: "no_plan_file" });
  });

  it("posts summary and returns success", () => {
    existsSync.mockReturnValue(true);
    readdirSync.mockReturnValue(["pr-review-plan.md"]);
    readFileSync.mockReturnValue(
      "- [x] **Issue one**: fixed\n- [ ] **Issue two**: pending\n",
    );
    execSync.mockReturnValue("");

    const result = postSummary("feat-1", "/plans", "T-1", "/repo");
    expect(result.posted).toBe(true);
    expect(result.issuesFound).toBe(2);
    expect(result.issuesResolved).toBe(1);
  });

  it("returns gh_comment_failed when gh command fails", () => {
    existsSync.mockReturnValue(true);
    readdirSync.mockReturnValue(["pr-review-plan.md"]);
    readFileSync.mockReturnValue("- [x] **Fix**: done\n");
    execSync.mockImplementation(() => {
      throw new Error("gh failed");
    });

    const result = postSummary("feat-1", "/plans", "T-1", "/repo");
    expect(result).toEqual({ posted: false, reason: "gh_comment_failed" });
  });
});
