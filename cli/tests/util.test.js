import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionHint, labelState, topologicalSort } from "../lib/util.js";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

const { detectWorkDir, resolveRepoRoot } = await import("../lib/util.js");

describe("labelState", () => {
  it("returns the highest-priority matching state", () => {
    const result = labelState(["ClaudeReady", "ClaudeFailed"]);
    expect(result).toEqual({ label: "ClaudeFailed", display: "FAILED" });
  });

  it("returns unknown when no labels match", () => {
    expect(labelState([])).toEqual({ label: null, display: "unknown" });
  });

  it("derives 'PR open' from an open PR when no label matches", () => {
    expect(labelState([], { openPr: { number: 4 } })).toEqual({
      label: null,
      display: "PR open",
    });
  });

  it("derives 'PR open' from a review-flavored Jira status", () => {
    expect(labelState([], { statusName: "In Review" })).toEqual({
      label: null,
      display: "PR open",
    });
  });

  it("prefers an explicit label over the derived PR state", () => {
    expect(labelState(["ClaudeFailed"], { openPr: { number: 4 } })).toEqual({
      label: "ClaudeFailed",
      display: "FAILED",
    });
  });
});

describe("actionHint", () => {
  it("returns hint for stack ready", () => {
    expect(actionHint("ClaudeStackReady")).toBe("awaiting review");
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

describe("resolveRepoRoot", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when devRoot is falsy", () => {
    expect(resolveRepoRoot(["repo:my-app"], null)).toBeNull();
  });

  it("returns null when no repo: label found", () => {
    expect(resolveRepoRoot(["ClaudeWork"], "/dev")).toBeNull();
  });

  it("returns the path when directory exists", () => {
    existsSync.mockReturnValue(true);
    expect(resolveRepoRoot(["repo:my-app"], "/dev")).toBe(
      join("/dev", "my-app"),
    );
  });

  it("returns null when directory does not exist", () => {
    existsSync.mockReturnValue(false);
    expect(resolveRepoRoot(["repo:my-app"], "/dev")).toBeNull();
  });
});

describe("detectWorkDir", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns workDir when file exists at explicit path", () => {
    existsSync.mockReturnValue(true);
    expect(detectWorkDir("/work", ".claude/plans/jira-T-1.md")).toBe("/work");
  });

  it("falls back to git repo root when file exists there", () => {
    existsSync.mockImplementation(
      (p) => p === join("/repo", ".claude/plans/jira-T-1.md"),
    );
    execSync.mockReturnValue("/repo\n");
    expect(detectWorkDir("/work", ".claude/plans/jira-T-1.md")).toBe("/repo");
  });

  it("returns null when file not found anywhere", () => {
    existsSync.mockReturnValue(false);
    execSync.mockReturnValue("/repo\n");
    expect(detectWorkDir("/work", ".claude/plans/jira-T-1.md")).toBeNull();
  });

  it("returns null when git command fails", () => {
    existsSync.mockReturnValue(false);
    execSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(detectWorkDir("/work", ".claude/plans/jira-T-1.md")).toBeNull();
  });
});
