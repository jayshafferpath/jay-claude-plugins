import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

const {
  findBranch,
  findWorktree,
  getPrInfo,
  getRepoSlug,
  getPrDetails,
  getPrDiffStat,
  getWorktreeList,
  isAncestor,
  isMergedInto,
  getStageCommits,
  hasStageCommit,
  getLastStageCommitSha,
} = await import("../lib/git.js");

describe("findBranch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when repoRoot is falsy", () => {
    expect(findBranch("TICK-1", null)).toBeNull();
  });

  it("returns null when repoRoot does not exist", () => {
    existsSync.mockReturnValue(false);
    expect(findBranch("TICK-1", "/nope")).toBeNull();
  });

  it("returns the first matching branch", () => {
    existsSync.mockReturnValue(true);
    execSync.mockReturnValue("  TICK-1-feature\n* TICK-1-fix\n");
    expect(findBranch("TICK-1", "/repo")).toBe("TICK-1-feature");
  });

  it("returns null when no branches match", () => {
    existsSync.mockReturnValue(true);
    execSync.mockReturnValue("");
    expect(findBranch("TICK-1", "/repo")).toBeNull();
  });

  it("returns null when execSync throws", () => {
    existsSync.mockReturnValue(true);
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(findBranch("TICK-1", "/repo")).toBeNull();
  });
});

describe("findWorktree", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when repoRoot is falsy", () => {
    expect(findWorktree("TICK-1", null)).toBeNull();
  });

  it("returns null when repoRoot does not exist", () => {
    existsSync.mockReturnValue(false);
    expect(findWorktree("TICK-1", "/nope")).toBeNull();
  });

  it("returns candidate path when it exists and is a git dir", () => {
    existsSync.mockReturnValue(true);
    execSync.mockReturnValue(".git");
    const result = findWorktree("TICK-1", "/repo");
    expect(result).toBe("/TICK-1");
  });

  it("returns null when candidate exists but is not git dir", () => {
    existsSync.mockReturnValue(true);
    execSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(findWorktree("TICK-1", "/repo")).toBeNull();
  });
});

describe("getPrInfo", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when branchName is falsy", () => {
    expect(getPrInfo(null, "/repo")).toBeNull();
  });

  it("returns null when cwd is falsy", () => {
    expect(getPrInfo("branch", null)).toBeNull();
  });

  it("returns parsed JSON on success", () => {
    execSync.mockReturnValue('{"number":1,"url":"http://x","state":"OPEN"}');
    expect(getPrInfo("branch", "/repo")).toEqual({
      number: 1,
      url: "http://x",
      state: "OPEN",
    });
  });

  it("returns null when command fails", () => {
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(getPrInfo("branch", "/repo")).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    execSync.mockReturnValue("not json");
    expect(getPrInfo("branch", "/repo")).toBeNull();
  });
});

describe("getRepoSlug", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when cwd is falsy", () => {
    expect(getRepoSlug(null)).toBeNull();
  });

  it("returns slug on success", () => {
    execSync.mockReturnValue("owner/repo");
    expect(getRepoSlug("/repo")).toBe("owner/repo");
  });

  it("returns null on failure", () => {
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(getRepoSlug("/repo")).toBeNull();
  });
});

describe("getPrDetails", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when branchName is falsy", () => {
    expect(getPrDetails(null, "/repo")).toBeNull();
  });

  it("returns null when cwd is falsy", () => {
    expect(getPrDetails("b", null)).toBeNull();
  });

  it("returns parsed JSON on success", () => {
    execSync.mockReturnValue('{"number":2}');
    expect(getPrDetails("b", "/repo")).toEqual({ number: 2 });
  });

  it("returns null on invalid JSON", () => {
    execSync.mockReturnValue("bad");
    expect(getPrDetails("b", "/repo")).toBeNull();
  });
});

describe("getPrDiffStat", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when branchName is falsy", () => {
    expect(getPrDiffStat(null, "/repo")).toBeNull();
  });

  it("returns stat output on success", () => {
    execSync.mockReturnValue("3 files changed");
    expect(getPrDiffStat("b", "/repo")).toBe("3 files changed");
  });

  it("returns null on failure", () => {
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(getPrDiffStat("b", "/repo")).toBeNull();
  });
});

describe("getWorktreeList", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty array when repoRoot is falsy", () => {
    expect(getWorktreeList(null)).toEqual([]);
  });

  it("returns empty array when repoRoot does not exist", () => {
    existsSync.mockReturnValue(false);
    expect(getWorktreeList("/nope")).toEqual([]);
  });

  it("parses porcelain worktree output", () => {
    existsSync.mockReturnValue(true);
    execSync.mockReturnValue(
      "worktree /main\nbranch refs/heads/main\n\nworktree /feat\nbranch refs/heads/feat-1\n",
    );
    expect(getWorktreeList("/repo")).toEqual([
      { path: "/main", branch: "main" },
      { path: "/feat", branch: "feat-1" },
    ]);
  });

  it("returns empty array when command fails", () => {
    existsSync.mockReturnValue(true);
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(getWorktreeList("/repo")).toEqual([]);
  });
});

describe("isAncestor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns false when ancestor is falsy", () => {
    expect(isAncestor(null, "main", "/repo")).toBe(false);
  });

  it("returns true when command succeeds", () => {
    execSync.mockReturnValue("");
    expect(isAncestor("feat-1", "main", "/repo")).toBe(true);
  });

  it("returns false when command throws", () => {
    execSync.mockImplementation(() => {
      throw new Error("not ancestor");
    });
    expect(isAncestor("feat-1", "main", "/repo")).toBe(false);
  });
});

describe("isMergedInto", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns false when branch is falsy", () => {
    expect(isMergedInto(null, "main", "/repo")).toBe(false);
  });

  it("returns true when branch appears in merged list", () => {
    execSync.mockReturnValue(
      "  origin/feat-1\n  origin/feat-2\n  origin/main\n",
    );
    expect(isMergedInto("feat-1", "main", "/repo")).toBe(true);
  });

  it("returns false when branch not in merged list", () => {
    execSync.mockReturnValue("  origin/other\n  origin/main\n");
    expect(isMergedInto("feat-1", "main", "/repo")).toBe(false);
  });

  it("returns false when command throws", () => {
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(isMergedInto("feat-1", "main", "/repo")).toBe(false);
  });
});

describe("getStageCommits", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty array when ticketKey is falsy", () => {
    expect(getStageCommits(null, "/repo")).toEqual([]);
  });

  it("returns empty array when cwd is falsy", () => {
    expect(getStageCommits("TICK-1", null)).toEqual([]);
  });

  it("parses stage commit messages from git log", () => {
    execSync.mockReturnValue(
      "abc1234 [TICK-1] execute: TDD implementation\ndef5678 [TICK-1] plan: generated",
    );
    expect(getStageCommits("TICK-1", "/repo")).toEqual([
      "execute: TDD implementation",
      "plan: generated",
    ]);
  });

  it("returns empty array when command fails", () => {
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(getStageCommits("TICK-1", "/repo")).toEqual([]);
  });

  it("returns empty array when no matches", () => {
    execSync.mockReturnValue("");
    expect(getStageCommits("TICK-1", "/repo")).toEqual([]);
  });
});

describe("hasStageCommit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns false when ticketKey is falsy", () => {
    expect(hasStageCommit(null, "plan", "/repo")).toBe(false);
  });

  it("returns false when stagePrefix is falsy", () => {
    expect(hasStageCommit("TICK-1", null, "/repo")).toBe(false);
  });

  it("returns true when matching commit exists", () => {
    execSync.mockReturnValue("abc1234 [TICK-1] plan: generated");
    expect(hasStageCommit("TICK-1", "plan", "/repo")).toBe(true);
  });

  it("returns false when command returns empty string", () => {
    execSync.mockReturnValue("");
    expect(hasStageCommit("TICK-1", "plan", "/repo")).toBe(false);
  });

  it("returns false when command throws", () => {
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(hasStageCommit("TICK-1", "plan", "/repo")).toBe(false);
  });
});

describe("getLastStageCommitSha", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when ticketKey is falsy", () => {
    expect(getLastStageCommitSha(null, "main", "/repo")).toBeNull();
  });

  it("returns SHA of last stage commit when found", () => {
    execSync.mockReturnValue("abc123def456");
    expect(getLastStageCommitSha("TICK-1", "main", "/repo")).toBe(
      "abc123def456",
    );
  });

  it("falls back to merge-base when no stage commits", () => {
    execSync.mockReturnValueOnce("").mockReturnValueOnce("base789abc");
    expect(getLastStageCommitSha("TICK-1", "main", "/repo")).toBe("base789abc");
  });

  it("returns null when both git log and merge-base fail", () => {
    execSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(getLastStageCommitSha("TICK-1", "main", "/repo")).toBeNull();
  });
});
