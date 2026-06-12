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
});
