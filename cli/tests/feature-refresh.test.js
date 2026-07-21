import { execSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

const { refreshFeatureBranch, parseDownstreamEntry, parseDownstreams } =
  await import("../lib/feature-refresh.js");

// Default mock that satisfies all the new probes (rev-parse --verify for every
// exclude ref + the feature branch, rev-list for discarded commits, empty
// orphan log). Tests can layer specific overrides on top.
function mockGit(overrides) {
  execSync.mockImplementation((cmd) => {
    if (overrides) {
      const out = overrides(cmd);
      if (out instanceof Error) throw out;
      if (out !== undefined) return out;
    }
    if (cmd.startsWith("git rev-parse --verify")) return "abc\n";
    if (cmd.startsWith("git rev-parse ")) return "deadbeef\n";
    if (cmd.startsWith("git rev-list")) return "";
    if (cmd.startsWith("git log ")) return "";
    if (cmd === "git worktree list --porcelain") return "";
    if (cmd === "git fetch origin") return "";
    if (cmd.startsWith("git checkout")) return "";
    if (cmd.startsWith("git reset --hard")) return "";
    if (cmd.startsWith("git merge --no-ff")) return "";
    if (cmd.startsWith("git cherry-pick")) return "";
    if (cmd.startsWith("git push")) return "";
    return "";
  });
}

describe("refreshFeatureBranch — input validation", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws when required args missing", () => {
    expect(() =>
      refreshFeatureBranch({
        featureBranch: "f",
        mergeTarget: "main",
        downstreams: [],
      }),
    ).toThrow(/repoRoot/);
    expect(() =>
      refreshFeatureBranch({
        repoRoot: "/r",
        mergeTarget: "main",
        downstreams: [],
      }),
    ).toThrow(/featureBranch/);
    expect(() =>
      refreshFeatureBranch({
        repoRoot: "/r",
        featureBranch: "f",
        downstreams: [],
      }),
    ).toThrow(/mergeTarget/);
    expect(() =>
      refreshFeatureBranch({
        repoRoot: "/r",
        featureBranch: "f",
        mergeTarget: "main",
        downstreams: "not-array",
      }),
    ).toThrow(/array/);
  });
});

describe("refreshFeatureBranch — pre-flight guards", () => {
  beforeEach(() => vi.resetAllMocks());

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
      if (cmd === "git worktree list --porcelain") {
        return "worktree /r\nbranch refs/heads/main\n\nworktree /wt\nbranch refs/heads/feat\n";
      }
      if (cmd === "git status --porcelain") return " M foo.ts\n";
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
});

describe("refreshFeatureBranch — happy path", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns refreshed on full success", () => {
    mockGit(() => undefined);
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
      { ticket: "T-1", branch: "t1", mergeSha: null, via: "merge" },
      { ticket: "T-2", branch: "t2", mergeSha: null, via: "merge" },
    ]);
  });

  it("skips downstream entries with status=conflict or skipped", () => {
    const merges = [];
    mockGit((cmd) => {
      if (cmd.startsWith("git merge --no-ff")) {
        merges.push(cmd);
        return "";
      }
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

  it("renders merge message without summary when none provided", () => {
    const seen = [];
    mockGit((cmd) => {
      if (cmd.startsWith("git merge --no-ff")) {
        seen.push(cmd);
        return "";
      }
    });
    refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [{ ticket: "T-1", branch: "t1", status: "rebased" }],
    });
    expect(seen[0]).toContain("Merge T-1 into feat");
    expect(seen[0]).not.toMatch(/Merge T-1: /);
  });
});

describe("refreshFeatureBranch — checkout / push failures", () => {
  beforeEach(() => vi.resetAllMocks());

  it("skipped-checkout-failed when reset --hard fails", () => {
    mockGit((cmd) => {
      if (cmd.startsWith("git reset --hard")) {
        const err = new Error("reset failed");
        err.status = 1;
        err.stderr = Buffer.from("error: refusing reset");
        throw err;
      }
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [{ ticket: "T-1", branch: "t1", status: "rebased" }],
    });
    expect(out.outcome).toBe("skipped-checkout-failed");
    expect(out.checkoutError).toMatch(/refusing reset/);
  });

  it("skipped-checkout-failed when primary worktree refuses checkout", () => {
    mockGit((cmd) => {
      if (cmd.startsWith("git checkout")) {
        const err = new Error("dirty");
        err.status = 1;
        err.stderr = Buffer.from("error: would overwrite");
        throw err;
      }
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
      if (cmd.startsWith("git push")) {
        const err = new Error("rejected");
        err.status = 1;
        err.stderr = Buffer.from("rejected non-fast-forward");
        throw err;
      }
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

  it("pushed-failed surfaces exit-code fallback when stderr is empty", () => {
    mockGit((cmd) => {
      if (cmd.startsWith("git push")) {
        const err = new Error("rejected");
        err.status = 7;
        err.stderr = Buffer.from("");
        throw err;
      }
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [{ ticket: "T-1", branch: "t1", status: "rebased" }],
    });
    expect(out.outcome).toBe("pushed-failed");
    expect(out.pushError).toBe("exit 7");
  });

  it("partial-merge-conflict captures conflictBranch + files", () => {
    mockGit((cmd) => {
      if (cmd.includes("git merge --no-ff t1")) return "";
      if (cmd.includes("git merge --no-ff t2")) {
        const err = new Error("conflict");
        err.status = 1;
        err.stderr = Buffer.from("CONFLICT");
        throw err;
      }
      if (cmd === "git diff --name-only --diff-filter=U") {
        return "foo.ts\nbar.ts\n";
      }
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
    expect(out.conflictVia).toBe("merge");
    expect(out.conflictFiles).toEqual(["foo.ts", "bar.ts"]);
    expect(out.remerged.map((r) => r.ticket)).toEqual(["T-1"]);
  });
});

describe("refreshFeatureBranch — NEV-863 regressions", () => {
  beforeEach(() => vi.resetAllMocks());

  it("close-fails when origin/{mergeTarget} does not resolve", () => {
    mockGit((cmd) => {
      if (cmd.startsWith("git rev-parse --verify --quiet origin/main")) {
        const err = new Error("not a ref");
        err.status = 128;
        err.stderr = Buffer.from("fatal: bad revision");
        throw err;
      }
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [{ ticket: "T-1", branch: "t1", status: "rebased" }],
    });
    expect(out.outcome).toBe("skipped-orphan-check-failed");
    expect(out.missingRefs).toContain("origin/main");
  });

  it("close-fails when feature branch ref does not resolve", () => {
    mockGit((cmd) => {
      if (cmd.startsWith("git rev-parse --verify --quiet feat^{commit}")) {
        const err = new Error("not a ref");
        err.status = 128;
        err.stderr = Buffer.from("fatal: bad revision");
        throw err;
      }
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [{ ticket: "T-1", branch: "t1", status: "rebased" }],
    });
    expect(out.outcome).toBe("skipped-orphan-check-failed");
    expect(out.missingRefs).toContain("feat");
  });

  it("refuses with skipped-unresolvable-predecessor when status=rebased but branch+mergeSha both null", () => {
    mockGit(() => undefined);
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [
        // A leaf ticket that was already terminal-cleaned: branch deleted,
        // and the caller failed to pass mergeSha. Refresh MUST refuse
        // rather than silently drop the squash from the feature branch.
        { ticket: "NEV-1010", branch: null, mergeSha: null, status: "rebased" },
      ],
    });
    expect(out.outcome).toBe("skipped-unresolvable-predecessor");
    expect(out.unresolvable).toEqual(["NEV-1010"]);
  });

  it("cherry-picks the squash when branch is gone but mergeSha is known", () => {
    const cherryPicks = [];
    mockGit((cmd) => {
      // The feature branch carries the squash commit; without replay it
      // would be discarded by the reset. Reachability check confirms the
      // mergeSha covers it.
      if (cmd === "git rev-list feat ^origin/main") return "deadbeef\n";
      if (cmd.startsWith("git rev-list")) return "deadbeef\n";
      if (cmd.startsWith("git cherry-pick")) {
        cherryPicks.push(cmd);
        return "";
      }
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [
        {
          ticket: "NEV-1010",
          branch: null,
          mergeSha: "bfc799d2",
          status: "rebased",
          summary: "prospect handler",
        },
      ],
    });
    expect(out.outcome).toBe("refreshed");
    expect(cherryPicks).toHaveLength(1);
    expect(cherryPicks[0]).toContain("cherry-pick -m 1 -x bfc799d2");
    expect(out.remerged).toEqual([
      {
        ticket: "NEV-1010",
        branch: null,
        mergeSha: "bfc799d2",
        via: "cherry-pick",
      },
    ]);
  });

  it("refuses with skipped-unrecoverable-commits when reset would discard work nothing replays", () => {
    mockGit((cmd) => {
      // 2 commits would be discarded by the reset; replay sources cover
      // only 1 of them.
      if (cmd === "git rev-list feat ^origin/main") {
        return "aaaa1111\nbbbb2222\n";
      }
      // rev-list across replay sources returns only one of the discarded shas
      if (
        cmd.startsWith("git rev-list t1") ||
        cmd.startsWith("git rev-list ")
      ) {
        return "aaaa1111\n";
      }
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [{ ticket: "T-1", branch: "t1", status: "rebased" }],
    });
    expect(out.outcome).toBe("skipped-unrecoverable-commits");
    expect(out.unrecoverableCommits).toEqual(["bbbb2222"]);
  });

  it("returns skipped-orphan-check-failed when the discarded-commits rev-list fails", () => {
    mockGit((cmd) => {
      if (cmd === "git rev-list feat ^origin/main") {
        const err = new Error("rev-list failed");
        err.status = 128;
        throw err;
      }
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [{ ticket: "T-1", branch: "t1", status: "rebased" }],
    });
    expect(out.outcome).toBe("skipped-orphan-check-failed");
    expect(out.orphanCheckError).toMatch(/rev-list feat/);
  });

  it("returns skipped-orphan-check-failed when the replay-sources rev-list fails", () => {
    mockGit((cmd) => {
      if (cmd === "git rev-list feat ^origin/main") return "aaaa1111\n";
      if (cmd.startsWith("git rev-list t1 ")) {
        const err = new Error("rev-list failed");
        err.status = 128;
        throw err;
      }
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [{ ticket: "T-1", branch: "t1", status: "rebased" }],
    });
    expect(out.outcome).toBe("skipped-orphan-check-failed");
    expect(out.orphanCheckError).toMatch(/replay sources/);
  });

  it("NEV-863 mirror — mix of live branches + gone branches with mergeSha replays all", () => {
    const replays = [];
    mockGit((cmd) => {
      // Three prior squashes on the feature branch: NEV-888 (branch gone,
      // mergeSha known), NEV-890 (branch gone, mergeSha known), NEV-1015
      // (branch live). All three are mergedIntoFeature=true; all three
      // squash commits exist on `feat`.
      if (cmd === "git rev-list feat ^origin/main") {
        return "sha888\nsha890\nsha1015\n";
      }
      if (cmd.startsWith("git rev-list")) {
        return "sha888\nsha890\nsha1015\n";
      }
      if (
        cmd.startsWith("git cherry-pick") ||
        cmd.startsWith("git merge --no-ff")
      ) {
        replays.push(cmd);
        return "";
      }
      // 888 + 890 branches don't resolve — they were deleted on origin
      if (cmd.startsWith("git rev-parse --verify --quiet nev-888")) {
        const err = new Error("missing");
        err.status = 128;
        throw err;
      }
      if (cmd.startsWith("git rev-parse --verify --quiet nev-890")) {
        const err = new Error("missing");
        err.status = 128;
        throw err;
      }
    });
    const out = refreshFeatureBranch({
      repoRoot: "/r",
      featureBranch: "feat",
      mergeTarget: "main",
      downstreams: [
        {
          ticket: "NEV-888",
          branch: "nev-888",
          mergeSha: "sha888",
          status: "rebased",
        },
        {
          ticket: "NEV-890",
          branch: "nev-890",
          mergeSha: "sha890",
          status: "rebased",
        },
        {
          ticket: "NEV-1015",
          branch: "nev-1015",
          mergeSha: "sha1015",
          status: "rebased",
        },
      ],
    });
    expect(out.outcome).toBe("refreshed");
    expect(replays).toHaveLength(3);
    // 888 + 890 replay via cherry-pick (their branches were deleted),
    // 1015 replays via merge --no-ff (branch is live).
    expect(replays[0]).toContain("cherry-pick -m 1 -x sha888");
    expect(replays[1]).toContain("cherry-pick -m 1 -x sha890");
    expect(replays[2]).toContain("git merge --no-ff nev-1015");
    expect(out.remerged.map((r) => r.via)).toEqual([
      "cherry-pick",
      "cherry-pick",
      "merge",
    ]);
  });
});

describe("parseDownstreamEntry — tuple shape", () => {
  it("parses bare 3-tuple", () => {
    expect(parseDownstreamEntry("NEV-1:nev-1:rebased")).toEqual({
      ticket: "NEV-1",
      branch: "nev-1",
      status: "rebased",
      summary: "",
      mergeSha: null,
    });
  });

  it("parses 4-tuple with summary", () => {
    expect(parseDownstreamEntry("NEV-1:nev-1:rebased:add feature")).toEqual({
      ticket: "NEV-1",
      branch: "nev-1",
      status: "rebased",
      summary: "add feature",
      mergeSha: null,
    });
  });

  it("parses 5-tuple with mergeSha", () => {
    expect(
      parseDownstreamEntry("NEV-1:nev-1:rebased:add feature:abc1234"),
    ).toEqual({
      ticket: "NEV-1",
      branch: "nev-1",
      status: "rebased",
      summary: "add feature",
      mergeSha: "abc1234",
    });
  });

  it("treats null branch (empty middle field) as null", () => {
    expect(parseDownstreamEntry("NEV-1::rebased::bfc799d2")).toEqual({
      ticket: "NEV-1",
      branch: null,
      status: "rebased",
      summary: "",
      mergeSha: "bfc799d2",
    });
  });

  it("preserves colons in summary when last segment is not SHA-shaped", () => {
    expect(
      parseDownstreamEntry("NEV-1:nev-1:rebased:fix bug: edge case in foo"),
    ).toEqual({
      ticket: "NEV-1",
      branch: "nev-1",
      status: "rebased",
      summary: "fix bug: edge case in foo",
      mergeSha: null,
    });
  });

  it("treats SHA-shaped final segment as mergeSha even with colons in summary", () => {
    const out = parseDownstreamEntry(
      "NEV-1:nev-1:rebased:fix bug: edge case:deadbeef1234567",
    );
    expect(out.summary).toBe("fix bug: edge case");
    expect(out.mergeSha).toBe("deadbeef1234567");
  });

  it("does not misclassify a short non-hex final segment as mergeSha", () => {
    const out = parseDownstreamEntry("NEV-1:nev-1:rebased:fix:zzzzzzz");
    expect(out.summary).toBe("fix:zzzzzzz");
    expect(out.mergeSha).toBeNull();
  });

  it("defaults status to rebased when omitted", () => {
    expect(parseDownstreamEntry("NEV-1:nev-1:").status).toBe("rebased");
  });
});

describe("parseDownstreams — splitting + filtering", () => {
  it("returns [] for empty / nullish arg", () => {
    expect(parseDownstreams("")).toEqual([]);
    expect(parseDownstreams(undefined)).toEqual([]);
    expect(parseDownstreams(null)).toEqual([]);
  });

  it("splits on commas and trims whitespace", () => {
    const out = parseDownstreams(
      "NEV-1:nev-1:rebased, NEV-2:nev-2:rebased, ,NEV-3:nev-3:conflict",
    );
    expect(out.map((d) => d.ticket)).toEqual(["NEV-1", "NEV-2", "NEV-3"]);
    expect(out[2].status).toBe("conflict");
  });
});
