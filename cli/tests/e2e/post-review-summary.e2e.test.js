import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "../../bin/post-review-summary.js");
const TMP = join(tmpdir(), `post-review-summary-e2e-${Date.now()}`);
const SHIM_DIR = join(TMP, "shims");
const WORK_DIR = join(TMP, "repo");
const PLANS_DIR = join(WORK_DIR, ".claude", "plans");

function createShims() {
  mkdirSync(SHIM_DIR, { recursive: true });

  const ghShim = `#!/bin/bash
case "$*" in
  *"pr comment"*)
    echo "https://github.com/org/repo/pull/1#issuecomment-123"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
  writeFileSync(join(SHIM_DIR, "gh"), ghShim, { mode: 0o755 });
}

beforeAll(() => {
  mkdirSync(PLANS_DIR, { recursive: true });
  createShims();
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function run(args) {
  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}:${process.env.PATH}`,
  };
  try {
    const result = execSync(`node ${BIN} ${args}`, {
      encoding: "utf-8",
      cwd: WORK_DIR,
      env,
      timeout: 10000,
    });
    return { exitCode: 0, output: JSON.parse(result) };
  } catch (err) {
    const stdout = err.stdout || "";
    try {
      return { exitCode: err.status, output: JSON.parse(stdout) };
    } catch {
      return { exitCode: err.status, output: null, stderr: err.stderr };
    }
  }
}

describe("post-review-summary e2e", () => {
  it("posts summary when review plan file exists with issues", () => {
    const planContent = `# PR Review Plan

- [x] **Missing null check**: handler crashes on empty input
  - Added guard clause
- [ ] **Unused import**: lodash imported but not used
  - Remove the import
`;
    writeFileSync(join(PLANS_DIR, "pr-review-2024-01.md"), planContent);

    const { exitCode, output } = run("feat-1 --plans-dir .claude/plans");

    expect(exitCode).toBe(0);
    expect(output.posted).toBe(true);
    expect(output.issuesFound).toBe(2);
    expect(output.issuesResolved).toBe(1);
  });

  it("finds plan file by ticket key pattern", () => {
    const planContent = `# Review
- [x] **Fix A**: done
`;
    writeFileSync(join(PLANS_DIR, "pr-T-123-review.md"), planContent);

    const { exitCode, output } = run(
      "feat-2 --plans-dir .claude/plans --ticket-key T-123",
    );

    expect(exitCode).toBe(0);
    expect(output.posted).toBe(true);
    expect(output.issuesFound).toBe(1);
    expect(output.issuesResolved).toBe(1);
  });

  it("resolves an absolute --plans-dir against the file it contains", () => {
    const absPlans = join(TMP, "abs-plans");
    mkdirSync(absPlans, { recursive: true });
    writeFileSync(
      join(absPlans, "pr-ABS-1-review.md"),
      "# Review\n- [x] **Fix**: ok\n",
    );

    const { exitCode, output } = run(
      `feat-abs --plans-dir ${absPlans} --ticket-key ABS-1`,
    );

    expect(exitCode).toBe(0);
    expect(output.posted).toBe(true);
    expect(output.issuesFound).toBe(1);
  });

  it("exits with code 1 when no plan file found", () => {
    const emptyPlans = join(TMP, "empty-plans");
    mkdirSync(emptyPlans, { recursive: true });

    const { exitCode, output } = run(
      `feat-3 --plans-dir ${emptyPlans} --ticket-key NOPE-1`,
    );

    expect(exitCode).not.toBe(0);
    expect(output.posted).toBe(false);
    expect(output.reason).toBe("no_plan_file");
  });

  it("exits with error when no arguments", () => {
    const { exitCode } = run("");
    expect(exitCode).not.toBe(0);
  });
});
