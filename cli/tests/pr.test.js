import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
}));

const { checkPrExists, pushBranch, createPr, ensurePr, prState } = await import(
  "../lib/pr.js"
);

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

describe("prState", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when no PR matches the filter", () => {
    execSync.mockReturnValue("[]");
    expect(prState("feat-1", { cwd: "/repo" })).toBeNull();
  });

  it("returns a normalized PR record when one matches", () => {
    execSync.mockReturnValue(
      JSON.stringify([
        {
          number: 7,
          url: "https://gh/x/y/pull/7",
          state: "MERGED",
          title: "feat: x",
          headRefName: "feat-1",
          baseRefName: "main",
          mergeCommit: { oid: "abc123" },
          mergedAt: "2024-01-01T00:00:00Z",
        },
      ]),
    );
    const result = prState("feat-1", {
      base: "main",
      state: "merged",
      cwd: "/r",
    });
    expect(result).toMatchObject({
      number: 7,
      state: "MERGED",
      mergeCommit: "abc123",
      headRefName: "feat-1",
    });
  });

  it("returns null when gh fails", () => {
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(prState("feat-1", { cwd: "/r" })).toBeNull();
  });

  it("returns null when branch or cwd is missing", () => {
    expect(prState("", { cwd: "/r" })).toBeNull();
    expect(prState("feat", {})).toBeNull();
  });

  it("returns null when JSON parse fails", () => {
    execSync.mockReturnValue("not-json");
    expect(prState("feat", { cwd: "/r" })).toBeNull();
  });

  it("handles a string mergeCommit value (not an object)", () => {
    execSync.mockReturnValue(
      JSON.stringify([{ number: 1, mergeCommit: "abc" }]),
    );
    const result = prState("feat", { cwd: "/r" });
    expect(result.mergeCommit).toBe("abc");
  });

  it("supports custom field overrides", () => {
    execSync.mockReturnValue('[{"number":3}]');
    prState("feat", { cwd: "/r", fields: ["number"] });
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining("--json number"),
      expect.anything(),
    );
  });

  it("omits the --base flag when no base is provided", () => {
    execSync.mockReturnValue("[]");
    prState("feat", { cwd: "/r" });
    const cmd = execSync.mock.calls[0][0];
    expect(cmd).not.toContain("--base");
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

  it("returns create_failed when gh pr create fails", () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr list")) return "[]";
      if (cmd.includes("git push")) return "";
      if (cmd.includes("gh pr create")) throw new Error("create failed");
      return "";
    });

    const result = ensurePr({
      branch: "feat",
      base: "main",
      title: "Test",
      cwd: "/repo",
    });
    expect(result.action).toBe("create_failed");
    expect(result.pr).toBeNull();
    expect(result.pushed).toBe(true);
  });

  it("handles bodyFile not found gracefully", () => {
    readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr list")) return "[]";
      if (cmd.includes("git push")) return "";
      if (cmd.includes("gh pr create")) return "http://pr/13";
      if (cmd.includes("gh pr view"))
        return '{"number":13,"url":"http://pr/13","state":"OPEN"}';
      return "";
    });

    const result = ensurePr({
      branch: "feat",
      base: "main",
      bodyFile: "/nonexistent/pr.md",
      cwd: "/repo",
    });
    expect(result.action).toBe("created");
    expect(result.pr.number).toBe(13);
  });
});

describe("checkPrExists", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null on invalid JSON", () => {
    execSync.mockReturnValue("not json");
    expect(checkPrExists("feat", "main", "/repo")).toBeNull();
  });
});

describe("createPr", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when gh pr view returns invalid JSON", () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr create")) return "http://pr/1";
      if (cmd.includes("gh pr view")) return "not json";
      return "";
    });
    expect(
      createPr("feat", "main", "title", "body", false, "/repo"),
    ).toBeNull();
  });
});
