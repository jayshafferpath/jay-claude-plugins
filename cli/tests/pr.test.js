import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
}));

const { checkPrExists, pushBranch, ensurePr } = await import("../lib/pr.js");

describe("checkPrExists", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns PR object when PR exists", () => {
    execSync.mockReturnValue(
      '[{"number":42,"url":"https://github.com/org/repo/pull/42","state":"OPEN"}]',
    );
    const result = checkPrExists("feat-1", "main", "/repo");
    expect(result).toEqual({
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      state: "OPEN",
    });
  });

  it("returns null when no PR exists", () => {
    execSync.mockReturnValue("[]");
    expect(checkPrExists("feat-1", "main", "/repo")).toBeNull();
  });

  it("returns null when command fails", () => {
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(checkPrExists("feat-1", "main", "/repo")).toBeNull();
  });
});

describe("pushBranch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns true on success", () => {
    execSync.mockReturnValue("");
    expect(pushBranch("feat-1", "/repo")).toBe(true);
  });

  it("returns false on failure", () => {
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(pushBranch("feat-1", "/repo")).toBe(false);
  });

  it("uses force-with-lease when force is true", () => {
    execSync.mockReturnValue("");
    pushBranch("feat-1", "/repo", true);
    expect(execSync).toHaveBeenCalledWith(
      "git push --force-with-lease origin feat-1",
      expect.anything(),
    );
  });

  it("uses -u flag when force is false", () => {
    execSync.mockReturnValue("");
    pushBranch("feat-1", "/repo", false);
    expect(execSync).toHaveBeenCalledWith(
      "git push -u origin feat-1",
      expect.anything(),
    );
  });
});

describe("ensurePr", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns exists when PR already open", () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr list")) {
        return '[{"number":10,"url":"http://pr/10","state":"OPEN"}]';
      }
      return "";
    });

    const result = ensurePr({
      branch: "feat",
      base: "main",
      cwd: "/repo",
    });
    expect(result.action).toBe("exists");
    expect(result.pr.number).toBe(10);
  });

  it("creates PR when none exists", () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr list")) return "[]";
      if (cmd.includes("git push")) return "";
      if (cmd.includes("gh pr create")) return "http://pr/11";
      if (cmd.includes("gh pr view"))
        return '{"number":11,"url":"http://pr/11","state":"OPEN"}';
      return "";
    });

    const result = ensurePr({
      branch: "feat",
      base: "main",
      title: "My PR",
      draft: true,
      cwd: "/repo",
    });
    expect(result.action).toBe("created");
    expect(result.pr.number).toBe(11);
    expect(result.pushed).toBe(true);
  });

  it("reads title from body file first line", () => {
    readFileSync.mockReturnValue("# PR Title\n\nBody content here");
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr list")) return "[]";
      if (cmd.includes("git push")) return "";
      if (cmd.includes("gh pr create")) return "http://pr/12";
      if (cmd.includes("gh pr view"))
        return '{"number":12,"url":"http://pr/12","state":"OPEN"}';
      return "";
    });

    const result = ensurePr({
      branch: "feat",
      base: "main",
      bodyFile: "/repo/pr.md",
      cwd: "/repo",
    });
    expect(result.action).toBe("created");
  });

  it("returns push_failed when push fails and no existing PR", () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr list")) return "[]";
      if (cmd.includes("git push")) throw new Error("push failed");
      return "";
    });

    const result = ensurePr({
      branch: "feat",
      base: "main",
      cwd: "/repo",
    });
    expect(result.action).toBe("push_failed");
    expect(result.pushed).toBe(false);
  });
});
