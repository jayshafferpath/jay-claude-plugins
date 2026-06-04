import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "../../bin/ensure-pr.js");
const TMP = join(tmpdir(), `ensure-pr-e2e-${Date.now()}`);
const SHIM_DIR = join(TMP, "shims");
const WORK_DIR = join(TMP, "repo");

function createShims(scenario = "no-pr") {
  mkdirSync(SHIM_DIR, { recursive: true });

  let ghBehavior;
  if (scenario === "no-pr") {
    ghBehavior = `
case "$*" in
  *"pr list"*)
    echo "[]"
    ;;
  *"pr create"*)
    echo "https://github.com/org/repo/pull/42"
    ;;
  *"pr view"*)
    echo '{"number":42,"url":"https://github.com/org/repo/pull/42","state":"OPEN"}'
    ;;
  *)
    echo "{}"
    ;;
esac
`;
  } else if (scenario === "pr-exists") {
    ghBehavior = `
case "$*" in
  *"pr list"*)
    echo '[{"number":10,"url":"https://github.com/org/repo/pull/10","state":"OPEN"}]'
    ;;
  *)
    echo "{}"
    ;;
esac
`;
  }

  const ghShim = `#!/bin/bash\n${ghBehavior}`;
  writeFileSync(join(SHIM_DIR, "gh"), ghShim, { mode: 0o755 });

  const gitShim = `#!/bin/bash
case "$*" in
  *"push"*)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
  writeFileSync(join(SHIM_DIR, "git"), gitShim, { mode: 0o755 });
}

beforeAll(() => {
  mkdirSync(WORK_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function run(args, scenario = "no-pr") {
  createShims(scenario);
  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}:${process.env.PATH}`,
  };
  const result = execSync(`node ${BIN} ${args}`, {
    encoding: "utf-8",
    cwd: WORK_DIR,
    env,
    timeout: 10000,
  });
  return JSON.parse(result);
}

describe("ensure-pr e2e", () => {
  it("creates a new draft PR when none exists", () => {
    writeFileSync(join(WORK_DIR, "pr.md"), "# My PR Title\n\nBody here.");
    const result = run("feat-1 --base main --body-file pr.md --draft");

    expect(result.action).toBe("created");
    expect(result.pr.number).toBe(42);
    expect(result.pr.url).toBe("https://github.com/org/repo/pull/42");
    expect(result.pushed).toBe(true);
  });

  it("returns exists when PR is already open", () => {
    const result = run("feat-1 --base main", "pr-exists");

    expect(result.action).toBe("exists");
    expect(result.pr.number).toBe(10);
    expect(result.pushed).toBe(true);
  });

  it("exits with error when --base is missing", () => {
    expect(() => {
      execSync(`node ${BIN} feat-1`, {
        encoding: "utf-8",
        cwd: WORK_DIR,
        env: { ...process.env, PATH: `${SHIM_DIR}:${process.env.PATH}` },
        stdio: "pipe",
        timeout: 10000,
      });
    }).toThrow();
  });

  it("exits with error when no arguments provided", () => {
    expect(() => {
      execSync(`node ${BIN}`, {
        encoding: "utf-8",
        cwd: WORK_DIR,
        stdio: "pipe",
        timeout: 10000,
      });
    }).toThrow();
  });
});
