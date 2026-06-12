import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveStageStartSha, stageSquash } from "../lib/stage-squash.js";

const ROOT = join(tmpdir(), `stage-squash-test-${process.pid}-${Date.now()}`);

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function makeRepo(name) {
  const dir = join(ROOT, name);
  const remote = join(ROOT, `${name}.git`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(remote, { recursive: true });
  git(`init --bare --initial-branch=main`, remote);
  git("init --initial-branch=main", dir);
  git("config user.email t@e.com", dir);
  git("config user.name T", dir);
  git("config commit.gpgsign false", dir);
  writeFileSync(join(dir, "f"), "0\n");
  git("add f", dir);
  git('commit -m "initial"', dir);
  git(`remote add origin ${remote}`, dir);
  git("push -u origin main", dir);
  git("checkout -b TIK-1 main", dir);
  return dir;
}

beforeEach(() => {
  mkdirSync(ROOT, { recursive: true });
});
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("stageSquash", () => {
  it("squashes commits since base into a single [KEY] label commit", () => {
    const cwd = makeRepo("repo1");
    writeFileSync(join(cwd, "f"), "1\n");
    git("commit -am one", cwd);
    writeFileSync(join(cwd, "f"), "2\n");
    git("commit -am two", cwd);

    const result = stageSquash({
      ticketKey: "TIK-1",
      label: "plan: generated",
      baseBranch: "main",
      cwd,
      push: false,
    });

    expect(result.action).toBe("squashed");
    const headMessage = git("log -1 --format=%s", cwd);
    expect(headMessage).toBe("[TIK-1] plan: generated");
    const commitsSinceMain = git("log --oneline main..HEAD", cwd)
      .split("\n")
      .filter(Boolean);
    expect(commitsSinceMain).toHaveLength(1);
  });

  it("returns noop when there are no new commits since the start SHA", () => {
    const cwd = makeRepo("repo2");
    const result = stageSquash({
      ticketKey: "TIK-2",
      label: "plan: generated",
      baseBranch: "main",
      cwd,
      push: false,
    });
    expect(result.action).toBe("noop");
  });

  it("derives STAGE_START_SHA from the most recent stage commit when present", () => {
    const cwd = makeRepo("repo3");
    writeFileSync(join(cwd, "f"), "1\n");
    git("commit -am one", cwd);
    git('commit --allow-empty -m "[TIK-3] plan: generated"', cwd);
    writeFileSync(join(cwd, "f"), "2\n");
    git("commit -am two", cwd);

    const sha = deriveStageStartSha("TIK-3", "main", cwd);
    const stageSha = git('log --grep="^\\[TIK-3\\] plan" -1 --format=%H', cwd);
    expect(sha).toBe(stageSha);
  });

  it("falls back to merge-base when no stage commits exist", () => {
    const cwd = makeRepo("repo4");
    const sha = deriveStageStartSha("TIK-4", "main", cwd);
    const expected = git("merge-base HEAD origin/main", cwd);
    expect(sha).toBe(expected);
  });

  it("throws when ticketKey, label, or cwd is missing", () => {
    expect(() => stageSquash({ label: "x", cwd: "/r" })).toThrow(/ticketKey/);
    expect(() => stageSquash({ ticketKey: "T", cwd: "/r" })).toThrow(/label/);
    expect(() => stageSquash({ ticketKey: "T", label: "x" })).toThrow(/cwd/);
  });

  it("pushes via force-with-lease when push is enabled", () => {
    const cwd = makeRepo("repo-push");
    writeFileSync(join(cwd, "f"), "1\n");
    git("commit -am one", cwd);

    const result = stageSquash({
      ticketKey: "TIK-P",
      label: "plan: generated",
      baseBranch: "main",
      branch: "TIK-1",
      cwd,
      push: true,
    });
    expect(result.action).toBe("squashed");
    expect(result.pushed).toBe(true);
    expect(result.branch).toBe("TIK-1");
  });

  it("returns 'push-failed' when the push to origin fails", () => {
    const cwd = makeRepo("repo-push-fail");
    writeFileSync(join(cwd, "f"), "1\n");
    git("commit -am one", cwd);
    // Point origin at a path that doesn't exist so push fails.
    git("remote set-url origin /tmp/no-such-remote-here.git", cwd);

    const result = stageSquash({
      ticketKey: "TIK-PF",
      label: "plan: generated",
      baseBranch: "main",
      branch: "TIK-1",
      cwd,
      push: true,
    });
    expect(result.action).toBe("push-failed");
    expect(result.pushed).toBe(false);
  });

  it("throws when stage-start-sha cannot be derived", () => {
    const cwd = makeRepo("repo-no-base");
    // Detach so origin/<base> can't be resolved and there are no [KEY] commits.
    git("checkout --detach HEAD", cwd);
    git("branch -D main", cwd);
    git("remote remove origin", cwd);

    expect(() =>
      stageSquash({
        ticketKey: "TIK-X",
        label: "plan: generated",
        baseBranch: "ghost",
        cwd,
        push: false,
      }),
    ).toThrow(/Cannot derive STAGE_START_SHA/);
  });
});
