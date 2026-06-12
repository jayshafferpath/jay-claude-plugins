import { execSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

const { refreshFeatureBranch } = await import("../lib/feature-refresh.js");

function mockGit(handler) {
  execSync.mockImplementation((cmd) => {
    const out = handler(cmd);
    if (out instanceof Error) throw out;
    return out ?? "";
  });
}

describe("refreshFeatureBranch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("throws when required args missing", () => {
    expect(() =>
      refreshFeatureBranch({
        featureBranch: "f",
        mergeTarget: "main",
        downstreams: [],
      }),
    ).toThrow();
  });

  it("returns skipped-cascade-conflict when prior cascade conflicted", () => {
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [],
      cascadeStatus: "conflict",
    });
    expect(out.outcome).toBe("skipped-cascade-conflict");
  });

  it("skipped-orphans when feature branch has commits not in downstream", () => {
    mockGit((cmd) => {
      if (cmd.startsWith("git log feat")) return "abc1234 orphan integration\n";
      return "";
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [{ ticket: "T-1", branch: "t1", status: "rebased" }],
    });
    expect(out.outcome).toBe("skipped-orphans");
    expect(out.orphans).toEqual(["abc1234 orphan integration"]);
  });

  it("skipped-dirty-worktree when secondary worktree has uncommitted changes", () => {
    mockGit((cmd) => {
      if (cmd.startsWith("git log feat")) return "";
      if (cmd === "git worktree list --porcelain") {
        return "worktree /r\nbranch refs/heads/main\n\nworktree /wt\nbranch refs/heads/feat\n";
      }
      if (cmd === "git status --porcelain") return " M foo.ts\n";
      return "";
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [{ ticket: "T-1", branch: "t1", status: "rebased" }],
    });
    expect(out.outcome).toBe("skipped-dirty-worktree");
    expect(out.dirtyWorktrees).toEqual(["/wt"]);
  });

  it("returns refreshed on full success", () => {
    mockGit((cmd) => {
      if (cmd.startsWith("git log feat")) return "";
      if (cmd === "git worktree list --porcelain") return "";
      if (cmd.startsWith("git rev-parse")) return "deadbeef\n";
      if (cmd === "git fetch origin") return "";
      if (cmd.startsWith("git checkout")) return "";
      if (cmd.startsWith("git reset --hard")) return "";
      if (cmd.startsWith("git merge --no-ff")) return "";
      if (cmd.startsWith("git push --force-with-lease")) return "";
      return "";
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [
        { ticket: "T-1", branch: "t1", status: "rebased", summary: "x" },
        { ticket: "T-2", branch: "t2", status: "pushed-failed" },
      ],
    });
    expect(out.outcome).toBe("refreshed");
    expect(out.oldSha).toBe("deadbeef");
    expect(out.remerged).toEqual([
      { ticket: "T-1", branch: "t1" },
      { ticket: "T-2", branch: "t2" },
    ]);
  });

  it("skips downstream entries with status=conflict or skipped", () => {
    const merges = [];
    mockGit((cmd) => {
      if (cmd.startsWith("git log feat")) return "";
      if (cmd === "git worktree list --porcelain") return "";
      if (cmd.startsWith("git rev-parse")) return "abc\n";
      if (cmd.startsWith("git merge --no-ff")) {
        merges.push(cmd);
        return "";
      }
      return "";
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [
        { ticket: "T-1", branch: "t1", status: "rebased" },
        { ticket: "T-2", branch: "t2", status: "conflict" },
        { ticket: "T-3", branch: "t3", status: "skipped" },
        { ticket: "T-4", branch: "t4", status: "rebased" },
      ],
    });
    expect(out.outcome).toBe("refreshed");
    expect(merges).toHaveLength(2);
    expect(out.remerged.map((r) => r.ticket)).toEqual(["T-1", "T-4"]);
  });

  it("partial-merge-conflict captures conflictBranch + files", () => {
    mockGit((cmd) => {
      if (cmd.startsWith("git log feat")) return "";
      if (cmd === "git worktree list --porcelain") return "";
      if (cmd.startsWith("git rev-parse")) return "abc\n";
      if (cmd === "git fetch origin") return "";
      if (cmd.startsWith("git checkout")) return "";
      if (cmd.startsWith("git reset --hard")) return "";
      if (cmd.includes("git merge --no-ff t1")) return "";
      if (cmd.includes("git merge --no-ff t2")) {
        const err = new Error("conflict");
        err.status = 1;
        err.stderr = Buffer.from("CONFLICT");
        throw err;
      }
      if (cmd.includes("git diff --name-only --diff-filter=U")) {
        return "foo.ts\nbar.ts\n";
      }
      if (cmd === "git merge --abort") return "";
      if (cmd.startsWith("git push")) return "";
      return "";
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [
        { ticket: "T-1", branch: "t1", status: "rebased" },
        { ticket: "T-2", branch: "t2", status: "rebased" },
      ],
    });
    expect(out.outcome).toBe("partial-merge-conflict");
    expect(out.conflictBranch).toBe("t2");
    expect(out.conflictTicket).toBe("T-2");
    expect(out.conflictFiles).toEqual(["foo.ts", "bar.ts"]);
    expect(out.remerged).toEqual([{ ticket: "T-1", branch: "t1" }]);
  });

  it("skipped-checkout-failed when primary worktree refuses checkout", () => {
    mockGit((cmd) => {
      if (cmd.startsWith("git log feat")) return "";
      if (cmd === "git worktree list --porcelain") return "";
      if (cmd.startsWith("git rev-parse")) return "abc\n";
      if (cmd === "git fetch origin") return "";
      if (cmd.startsWith("git checkout")) {
        const err = new Error("dirty");
        err.status = 1;
        err.stderr = Buffer.from("error: would overwrite");
        throw err;
      }
      return "";
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [{ ticket: "T-1", branch: "t1", status: "rebased" }],
    });
    expect(out.outcome).toBe("skipped-checkout-failed");
    expect(out.checkoutError).toMatch(/would overwrite/);
  });

  it("pushed-failed when force-push fails after clean refresh", () => {
    mockGit((cmd) => {
      if (cmd.startsWith("git log feat")) return "";
      if (cmd === "git worktree list --porcelain") return "";
      if (cmd.startsWith("git rev-parse")) return "abc\n";
      if (cmd.startsWith("git push")) {
        const err = new Error("rejected");
        err.status = 1;
        err.stderr = Buffer.from("rejected non-fast-forward");
        throw err;
      }
      return "";
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [{ ticket: "T-1", branch: "t1", status: "rebased" }],
    });
    expect(out.outcome).toBe("pushed-failed");
    expect(out.pushError).toMatch(/rejected/);
  });
});
