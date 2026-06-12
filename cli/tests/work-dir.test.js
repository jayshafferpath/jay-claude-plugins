import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureFeatureBranch, ensureWorkDir } from "../lib/work-dir.js";

const ROOT = join(tmpdir(), `work-dir-test-${process.pid}-${Date.now()}`);

function makeRepo(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  // Bare "remote" we can fetch from / push to for branch ops.
  const remote = join(ROOT, `${name}.git`);
  execSync(`git init --bare --initial-branch=main ${remote}`, {
    stdio: "pipe",
  });

  execSync("git init --initial-branch=main", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@example.com", {
    cwd: dir,
    stdio: "pipe",
  });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "init\n");
  execSync("git add . && git commit -m initial", { cwd: dir, stdio: "pipe" });
  execSync(`git remote add origin ${remote}`, { cwd: dir, stdio: "pipe" });
  execSync("git push -u origin main", { cwd: dir, stdio: "pipe" });
  return { repoRoot: dir, remote };
}

beforeEach(() => {
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("ensureWorkDir (serial)", () => {
  it("creates a new branch from origin/main and checks it out", () => {
    const { repoRoot } = makeRepo("repo1");

    const result = ensureWorkDir({
      ticketKey: "TIK-1",
      repoRoot,
      baseBranch: "main",
      serial: true,
    });

    expect(result).toEqual({
      workDir: repoRoot,
      branch: "TIK-1",
      mode: "serial",
      created: true,
      fetched: true,
    });
    const head = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    expect(head).toBe("TIK-1");
  });

  it("checks out an existing branch without recreating it", () => {
    const { repoRoot } = makeRepo("repo2");
    execSync("git checkout -b TIK-2 main", { cwd: repoRoot, stdio: "pipe" });
    execSync("git checkout main", { cwd: repoRoot, stdio: "pipe" });

    const result = ensureWorkDir({
      ticketKey: "TIK-2",
      repoRoot,
      baseBranch: "main",
      serial: true,
    });

    expect(result.created).toBe(false);
    expect(result.branch).toBe("TIK-2");
  });

  it("uses --branch override when supplied", () => {
    const { repoRoot } = makeRepo("repo3");
    const result = ensureWorkDir({
      ticketKey: "TIK-3",
      repoRoot,
      branch: "custom/feature-branch",
      baseBranch: "main",
      serial: true,
    });
    expect(result.branch).toBe("custom/feature-branch");
  });
});

describe("ensureWorkDir (worktree)", () => {
  it("creates a worktree at <repoRoot>/../<key> from origin/main", () => {
    const { repoRoot } = makeRepo("repo-wt");

    const result = ensureWorkDir({
      ticketKey: "WT-1",
      repoRoot,
      baseBranch: "main",
    });

    expect(result.mode).toBe("worktree");
    expect(result.created).toBe(true);
    expect(result.workDir).toBe(join(repoRoot, "..", "WT-1"));
    expect(existsSync(result.workDir)).toBe(true);
  });

  it("returns existing worktree when one is already present", () => {
    const { repoRoot } = makeRepo("repo-wt2");
    ensureWorkDir({ ticketKey: "WT-2", repoRoot, baseBranch: "main" });

    const result = ensureWorkDir({
      ticketKey: "WT-2",
      repoRoot,
      baseBranch: "main",
    });
    expect(result.created).toBe(false);
  });
});

describe("ensureFeatureBranch", () => {
  it("creates the feature branch from origin/main and pushes when missing", () => {
    const { repoRoot, remote } = makeRepo("feat-repo");

    const result = ensureFeatureBranch({
      featureBranch: "EPIC-100",
      containerBase: "main",
      repoRoot,
    });

    expect(result.action).toBe("created");
    expect(result.base).toBe("origin/main");
    const remoteRefs = execSync(`git --git-dir=${remote} branch --list`, {
      encoding: "utf-8",
    });
    expect(remoteRefs).toContain("EPIC-100");
  });

  it("returns 'exists' when feature branch already lives on origin", () => {
    const { repoRoot } = makeRepo("feat-repo2");
    ensureFeatureBranch({
      featureBranch: "EPIC-200",
      containerBase: "main",
      repoRoot,
    });

    const result = ensureFeatureBranch({
      featureBranch: "EPIC-200",
      containerBase: "main",
      repoRoot,
    });
    expect(result.action).toBe("exists");
  });

  it("rejects multiple unmerged blocker containers", () => {
    const { repoRoot } = makeRepo("feat-repo3");
    expect(() =>
      ensureFeatureBranch({
        featureBranch: "EPIC-300",
        containerBase: "main",
        unmergedBlockers: ["A", "B"],
        repoRoot,
      }),
    ).toThrow(/multiple unmerged blocker/);
  });

  it("rejects when containerBase is not main and origin is missing", () => {
    const { repoRoot } = makeRepo("feat-repo4");
    expect(() =>
      ensureFeatureBranch({
        featureBranch: "EPIC-400",
        containerBase: "ghost-branch",
        repoRoot,
      }),
    ).toThrow(/Blocker container has no branch/);
  });
});
