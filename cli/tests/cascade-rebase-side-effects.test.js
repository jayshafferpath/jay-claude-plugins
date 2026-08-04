import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/checklist.js", () => ({
  appendActivityLog: vi.fn(),
}));

const { appendActivityLog } = await import("../lib/checklist.js");
const { cascadeRebase } = await import("../lib/cascade-rebase.js");

const ROOT = join(
  tmpdir(),
  `cascade-side-effects-${process.pid}-${Date.now()}`,
);

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function setupRepo(name) {
  const dir = join(ROOT, name);
  const remote = join(ROOT, `${name}.git`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(remote, { recursive: true });
  git("init --bare --initial-branch=main", remote);
  git("init --initial-branch=main", dir);
  git("config user.email t@e.com", dir);
  git("config user.name T", dir);
  git("config commit.gpgsign false", dir);
  writeFileSync(join(dir, "f"), "0\n");
  git("add f", dir);
  git('commit -m "initial"', dir);
  git(`remote add origin ${remote}`, dir);
  git("push -u origin main", dir);
  return dir;
}

function makeBranch(repo, name, base, file, content) {
  git(`checkout -b ${name} ${base}`, repo);
  writeFileSync(join(repo, file), content);
  git(`add ${file}`, repo);
  git(`commit -m ${name}`, repo);
  git(`push -u origin ${name}`, repo);
}

beforeEach(() => {
  mkdirSync(ROOT, { recursive: true });
  vi.resetAllMocks();
});
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("cascadeRebase activityLog side effect", () => {
  it("appends a 'Branch rebased' entry per rebased ticket when activityLog is set", async () => {
    const repo = setupRepo("act");
    makeBranch(repo, "ABC-1", "main", "a.txt", "A\n");
    makeBranch(repo, "ABC-2", "ABC-1", "b.txt", "B\n");
    git("checkout main", repo);
    git("merge --squash ABC-1", repo);
    git('commit -m "squash"', repo);
    git("push origin main", repo);

    appendActivityLog.mockResolvedValue();

    const out = await cascadeRebase({
      repoRoot: repo,
      originBranch: "ABC-1",
      newRoot: "main",
      downstreams: [{ ticket: "ABC-2", branch: "ABC-2" }],
      activityLog: { note: "(test note)" },
    });

    expect(out.results[0].status).toBe("rebased");
    expect(appendActivityLog).toHaveBeenCalledWith(
      "ABC-2",
      "Branch rebased",
      expect.stringContaining("(test note)"),
    );
  });

  it("records 'no open PR' warning when gh returns an empty list", async () => {
    const repo = setupRepo("retarget-empty");
    makeBranch(repo, "E-1", "main", "a.txt", "A\n");
    makeBranch(repo, "E-2", "E-1", "b.txt", "B\n");
    git("checkout main", repo);
    git("merge --squash E-1", repo);
    git('commit -m "squash"', repo);
    git("push origin main", repo);

    const shimDir = join(ROOT, "shims-empty");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "gh"), `#!/bin/bash\necho '[]'\n`, {
      mode: 0o755,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath}`;
    appendActivityLog.mockResolvedValue();

    try {
      const out = await cascadeRebase({
        repoRoot: repo,
        originBranch: "E-1",
        newRoot: "main",
        downstreams: [{ ticket: "E-2", branch: "E-2" }],
        retargetFirstPr: { newBase: "main" },
      });
      expect(out.results[0].pr_retarget_warning).toBe(
        "no open PR found for head-of-chain",
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("treats invalid gh JSON as 'no open PR'", async () => {
    const repo = setupRepo("retarget-bad-json");
    makeBranch(repo, "BJ-1", "main", "a.txt", "A\n");
    makeBranch(repo, "BJ-2", "BJ-1", "b.txt", "B\n");
    git("checkout main", repo);
    git("merge --squash BJ-1", repo);
    git('commit -m "squash"', repo);
    git("push origin main", repo);

    const shimDir = join(ROOT, "shims-bad-json");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "gh"), `#!/bin/bash\necho 'not json'\n`, {
      mode: 0o755,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath}`;
    appendActivityLog.mockResolvedValue();

    try {
      const out = await cascadeRebase({
        repoRoot: repo,
        originBranch: "BJ-1",
        newRoot: "main",
        downstreams: [{ ticket: "BJ-2", branch: "BJ-2" }],
        retargetFirstPr: { newBase: "main" },
      });
      expect(out.results[0].pr_retarget_warning).toBe(
        "no open PR found for head-of-chain",
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("skips activity-log emission for entries that are skipped/conflict", async () => {
    const repo = setupRepo("act-mixed");
    // No downstream branch → status: skipped (no branch on record).
    appendActivityLog.mockResolvedValue();

    await cascadeRebase({
      repoRoot: repo,
      originBranch: "main",
      newRoot: "main",
      downstreams: [{ ticket: "MIX-1", branch: null }],
      activityLog: { note: "test" },
    });
    // Should not have been called for the skipped entry.
    expect(appendActivityLog).not.toHaveBeenCalled();
  });

  it("retargets the head-of-chain PR when a fake gh returns an open PR number", async () => {
    const repo = setupRepo("retarget-ok");
    makeBranch(repo, "RT-1", "main", "a.txt", "A\n");
    makeBranch(repo, "RT-2", "RT-1", "b.txt", "B\n");
    git("checkout main", repo);
    git("merge --squash RT-1", repo);
    git('commit -m "squash"', repo);
    git("push origin main", repo);

    // Drop a fake `gh` shim into a tmp PATH that returns a number for `pr list`
    // and succeeds for the REST retarget. Retargeting goes through
    // `gh api --method PATCH …/pulls/{n}` rather than `gh pr edit`, which
    // needs read:org and fails on a repo-scoped token (issue #35).
    const shimDir = join(ROOT, "shims-ok");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, "gh"),
      `#!/bin/bash
case "$*" in
  *"pr list"*) echo '[{"number":42}]' ;;
  *"--method PATCH"*) echo "ok" ;;
esac
`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath}`;
    appendActivityLog.mockResolvedValue();

    try {
      const out = await cascadeRebase({
        repoRoot: repo,
        originBranch: "RT-1",
        newRoot: "main",
        downstreams: [{ ticket: "RT-2", branch: "RT-2" }],
        retargetFirstPr: { newBase: "main" },
      });
      expect(out.results[0].pr_retargeted).toEqual({
        number: 42,
        new_base: "main",
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("retargets via gh api REST PATCH, never gh pr edit", async () => {
    const repo = setupRepo("retarget-uses-rest");
    makeBranch(repo, "RS-1", "main", "a.txt", "A\n");
    makeBranch(repo, "RS-2", "RS-1", "b.txt", "B\n");
    git("checkout main", repo);
    git("merge --squash RS-1", repo);
    git('commit -m "squash"', repo);
    git("push origin main", repo);

    // Record every gh invocation so we can assert on the command shape. `pr
    // edit` deliberately exits non-zero: if the implementation regresses to it,
    // the retarget fails and the assertions below catch it.
    const shimDir = join(ROOT, "shims-record");
    const logFile = join(ROOT, "gh-calls.log");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, "gh"),
      `#!/bin/bash
echo "$*" >> ${logFile}
case "$*" in
  *"pr list"*) echo '[{"number":99}]' ;;
  *"--method PATCH"*) echo "ok" ;;
  *"pr edit"*) echo "should not be called" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath}`;
    appendActivityLog.mockResolvedValue();

    try {
      const out = await cascadeRebase({
        repoRoot: repo,
        originBranch: "RS-1",
        newRoot: "main",
        downstreams: [{ ticket: "RS-2", branch: "RS-2" }],
        retargetFirstPr: { newBase: "main" },
      });
      expect(out.results[0].pr_retargeted).toMatchObject({ number: 99 });

      const calls = readFileSync(logFile, "utf-8");
      expect(calls).toContain("--method PATCH");
      expect(calls).toContain("repos/{owner}/{repo}/pulls/99");
      expect(calls).toContain("base=main");
      expect(calls).not.toContain("pr edit");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("records a pr_retarget_warning when the fake gh's REST retarget fails", async () => {
    const repo = setupRepo("retarget-edit-fail");
    makeBranch(repo, "RF-1", "main", "a.txt", "A\n");
    makeBranch(repo, "RF-2", "RF-1", "b.txt", "B\n");
    git("checkout main", repo);
    git("merge --squash RF-1", repo);
    git('commit -m "squash"', repo);
    git("push origin main", repo);

    const shimDir = join(ROOT, "shims-edit-fail");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, "gh"),
      `#!/bin/bash
case "$*" in
  *"pr list"*) echo '[{"number":7}]' ;;
  *"--method PATCH"*) echo "edit failed" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath}`;
    appendActivityLog.mockResolvedValue();

    try {
      const out = await cascadeRebase({
        repoRoot: repo,
        originBranch: "RF-1",
        newRoot: "main",
        downstreams: [{ ticket: "RF-2", branch: "RF-2" }],
        retargetFirstPr: { newBase: "main" },
      });
      expect(out.results[0].pr_retarget_warning).toBeDefined();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("attempts PR retarget when retargetFirstPr is set; surfaces warning when no PR is open", async () => {
    const repo = setupRepo("retarget");
    makeBranch(repo, "Y-1", "main", "a.txt", "A\n");
    makeBranch(repo, "Y-2", "Y-1", "b.txt", "B\n");
    git("checkout main", repo);
    git("merge --squash Y-1", repo);
    git('commit -m "squash"', repo);
    git("push origin main", repo);

    appendActivityLog.mockResolvedValue();

    const out = await cascadeRebase({
      repoRoot: repo,
      originBranch: "Y-1",
      newRoot: "main",
      downstreams: [{ ticket: "Y-2", branch: "Y-2" }],
      retargetFirstPr: { newBase: "main" },
    });

    // gh isn't installed/authed in the test sandbox, so the probe fails OR
    // returns no PR — either way we expect a pr_retarget_warning on the head.
    const head = out.results[0];
    expect(head.status).toBe("rebased");
    expect(head.pr_retarget_warning).toBeDefined();
  });

  it("appends activity log without a note when activityLog.note is omitted", async () => {
    const repo = setupRepo("act-no-note");
    makeBranch(repo, "Z-1", "main", "a.txt", "A\n");
    makeBranch(repo, "Z-2", "Z-1", "b.txt", "B\n");
    git("checkout main", repo);
    git("merge --squash Z-1", repo);
    git('commit -m "squash"', repo);
    git("push origin main", repo);

    appendActivityLog.mockResolvedValue();

    await cascadeRebase({
      repoRoot: repo,
      originBranch: "Z-1",
      newRoot: "main",
      downstreams: [{ ticket: "Z-2", branch: "Z-2" }],
      activityLog: {},
    });
    expect(appendActivityLog).toHaveBeenCalledWith(
      "Z-2",
      "Branch rebased",
      expect.stringMatching(/Rebased onto `main`\.$/),
    );
  });

  it("includes the push error message when status is pushed-failed", async () => {
    const repo = setupRepo("act-pushfail");
    makeBranch(repo, "P-1", "main", "a.txt", "A\n");
    makeBranch(repo, "P-2", "P-1", "b.txt", "B\n");
    git("checkout main", repo);
    git("merge --squash P-1", repo);
    git('commit -m "squash"', repo);
    git("push origin main", repo);
    // Make push fail by pointing origin at a non-existent remote.
    git("remote set-url origin /tmp/no-such-remote.git", repo);

    appendActivityLog.mockResolvedValue();

    const out = await cascadeRebase({
      repoRoot: repo,
      originBranch: "P-1",
      newRoot: "main",
      downstreams: [{ ticket: "P-2", branch: "P-2" }],
      activityLog: { note: "after merge" },
    });
    expect(out.results[0].status).toBe("pushed-failed");
    expect(appendActivityLog).toHaveBeenCalledWith(
      "P-2",
      "Branch rebased",
      expect.stringContaining("force-push failed"),
    );
  });

  it("captures appendActivityLog errors as activity_log_warning on the result entry", async () => {
    const repo = setupRepo("act-fail");
    makeBranch(repo, "X-1", "main", "a.txt", "A\n");
    makeBranch(repo, "X-2", "X-1", "b.txt", "B\n");
    git("checkout main", repo);
    git("merge --squash X-1", repo);
    git('commit -m "squash"', repo);
    git("push origin main", repo);

    appendActivityLog.mockRejectedValue(new Error("Jira down"));

    const out = await cascadeRebase({
      repoRoot: repo,
      originBranch: "X-1",
      newRoot: "main",
      downstreams: [{ ticket: "X-2", branch: "X-2" }],
      activityLog: { note: "test" },
    });

    expect(out.results[0].activity_log_warning).toBe("Jira down");
  });
});
