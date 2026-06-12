import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cascadeRebase } from "../lib/cascade-rebase.js";

const TMP_BASE = join(tmpdir(), `cascade-rebase-test-${Date.now()}`);

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function setupRepo(testName) {
  const repoRoot = join(TMP_BASE, testName, "repo");
  const remote = join(TMP_BASE, testName, "remote.git");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(remote, { recursive: true });

  git("init --bare --initial-branch=main", remote);
  git("init --initial-branch=main", repoRoot);
  git("config user.email test@example.com", repoRoot);
  git("config user.name Test", repoRoot);
  git("config commit.gpgsign false", repoRoot);
  git(`remote add origin ${remote}`, repoRoot);

  // main: c0 -> c1
  writeFileSync(join(repoRoot, "README.md"), "v1\n");
  git("add README.md", repoRoot);
  git("commit -m c0-main", repoRoot);
  writeFileSync(join(repoRoot, "README.md"), "v2\n");
  git("commit -am c1-main", repoRoot);
  git("push -u origin main", repoRoot);

  return { repoRoot, remote };
}

function makeBranch(repoRoot, name, base, file, content) {
  git(`checkout -b ${name} ${base}`, repoRoot);
  writeFileSync(join(repoRoot, file), content);
  git(`add ${file}`, repoRoot);
  git(`commit -m ${name}-commit`, repoRoot);
  git(`push -u origin ${name}`, repoRoot);
}

afterAll(() => {
  rmSync(TMP_BASE, { recursive: true, force: true });
});

describe("cascadeRebase", () => {
  it("rebases a 2-branch chain after origin merges to newRoot", () => {
    const { repoRoot } = setupRepo("happy-path");

    // Origin branch (the deleted one): a.txt
    makeBranch(repoRoot, "ABC-1", "main", "a.txt", "from-abc-1\n");
    // Downstream-1 stacked on ABC-1: b.txt
    makeBranch(repoRoot, "ABC-2", "ABC-1", "b.txt", "from-abc-2\n");
    // Downstream-2 stacked on ABC-2: c.txt
    makeBranch(repoRoot, "ABC-3", "ABC-2", "c.txt", "from-abc-3\n");

    // Simulate ABC-1 squash-merge to main
    git("checkout main", repoRoot);
    git("merge --squash ABC-1", repoRoot);
    git("commit -m squash-abc-1", repoRoot);
    git("push origin main", repoRoot);

    const out = cascadeRebase({
      repoRoot,
      originBranch: "ABC-1",
      newRoot: "main",
      downstreams: [
        { ticket: "ABC-2", branch: "ABC-2" },
        { ticket: "ABC-3", branch: "ABC-3" },
      ],
    });

    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({
      ticket: "ABC-2",
      status: "rebased",
      new_base: "main",
    });
    expect(out.results[1]).toMatchObject({
      ticket: "ABC-3",
      status: "rebased",
      new_base: "ABC-2",
    });

    // ABC-2 should now contain b.txt but not a.txt (a.txt is in main via squash)
    git("checkout ABC-2", repoRoot);
    const abc2Files = git("ls-tree -r --name-only HEAD", repoRoot)
      .split("\n")
      .sort();
    expect(abc2Files).toContain("b.txt");
    expect(abc2Files).toContain("README.md");
  });

  it("stops the chain at a conflict and marks remaining as not-attempted", () => {
    const { repoRoot } = setupRepo("conflict-stop");

    // Origin and downstream-1 both touch the same file → rebase will conflict
    makeBranch(repoRoot, "X-1", "main", "shared.txt", "from-x1\n");
    git("checkout -b X-2 X-1", repoRoot);
    writeFileSync(join(repoRoot, "shared.txt"), "from-x2\n");
    git("commit -am x2-modify-shared", repoRoot);
    git("push -u origin X-2", repoRoot);
    makeBranch(repoRoot, "X-3", "X-2", "downstream.txt", "from-x3\n");

    // Squash-merge X-1 with a *different* shared.txt content into main, so
    // when X-2 rebases onto main the patch on shared.txt will not apply
    git("checkout main", repoRoot);
    writeFileSync(join(repoRoot, "shared.txt"), "different-on-main\n");
    git("add shared.txt", repoRoot);
    git("commit -m main-shared-different", repoRoot);
    git("push origin main", repoRoot);

    const out = cascadeRebase({
      repoRoot,
      originBranch: "X-1",
      newRoot: "main",
      downstreams: [
        { ticket: "X-2", branch: "X-2" },
        { ticket: "X-3", branch: "X-3" },
      ],
    });

    expect(out.results[0]).toMatchObject({
      ticket: "X-2",
      status: "conflict",
    });
    expect(out.results[0].files).toContain("shared.txt");
    expect(out.results[1]).toMatchObject({
      ticket: "X-3",
      status: "not-attempted",
    });
  });

  it("skips a downstream entry without a branch but continues the chain", () => {
    const { repoRoot } = setupRepo("skip-null-branch");

    makeBranch(repoRoot, "Y-1", "main", "y1.txt", "y1\n");
    makeBranch(repoRoot, "Y-3", "Y-1", "y3.txt", "y3\n");

    git("checkout main", repoRoot);
    git("merge --squash Y-1", repoRoot);
    git("commit -m squash-y-1", repoRoot);
    git("push origin main", repoRoot);

    const out = cascadeRebase({
      repoRoot,
      originBranch: "Y-1",
      newRoot: "main",
      downstreams: [
        { ticket: "Y-2", branch: null },
        { ticket: "Y-3", branch: "Y-3" },
      ],
    });

    expect(out.results[0]).toMatchObject({
      ticket: "Y-2",
      branch: null,
      status: "skipped",
    });
    // The chain advances using "Y-1" → "main" semantics for Y-3 since Y-2 had no branch
    expect(out.results[1]).toMatchObject({
      ticket: "Y-3",
      status: "rebased",
      new_base: "main",
    });
  });

  it("returns empty results when given no downstreams", () => {
    const { repoRoot } = setupRepo("empty-downstreams");

    const out = cascadeRebase({
      repoRoot,
      originBranch: "main",
      newRoot: "main",
      downstreams: [],
    });

    expect(out.results).toEqual([]);
  });

  it("throws when required options are missing", () => {
    expect(() =>
      cascadeRebase({ originBranch: "x", newRoot: "y", downstreams: [] }),
    ).toThrow(/repoRoot/);
    expect(() =>
      cascadeRebase({ repoRoot: "/x", newRoot: "y", downstreams: [] }),
    ).toThrow(/originBranch/);
    expect(() =>
      cascadeRebase({ repoRoot: "/x", originBranch: "y", downstreams: [] }),
    ).toThrow(/newRoot/);
  });

  it("supports --no-push semantics (pushAfterRebase: false leaves remote untouched)", () => {
    const { repoRoot } = setupRepo("no-push");

    makeBranch(repoRoot, "Z-1", "main", "z1.txt", "z1\n");
    makeBranch(repoRoot, "Z-2", "Z-1", "z2.txt", "z2\n");

    git("checkout main", repoRoot);
    git("merge --squash Z-1", repoRoot);
    git("commit -m squash-z-1", repoRoot);
    git("push origin main", repoRoot);

    const beforeRemoteSha = git("rev-parse origin/Z-2", repoRoot);

    const out = cascadeRebase({
      repoRoot,
      originBranch: "Z-1",
      newRoot: "main",
      downstreams: [{ ticket: "Z-2", branch: "Z-2" }],
      pushAfterRebase: false,
    });

    expect(out.results[0].status).toBe("rebased");
    // Remote unchanged because we passed pushAfterRebase: false
    const afterRemoteSha = git("rev-parse origin/Z-2", repoRoot);
    expect(afterRemoteSha).toBe(beforeRemoteSha);
  });
});
