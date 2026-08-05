import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "../../bin/seed-checklist.js");
const TMP = join(tmpdir(), `seed-checklist-e2e-${Date.now()}`);
const SHIM_DIR = join(TMP, "shims");
const WORK_DIR = join(TMP, "repo");
const PLANS_DIR = join(WORK_DIR, ".claude", "plans");

let server;
let port;

function createIssueResponse(key, labels = []) {
  return {
    key,
    fields: {
      summary: `Summary for ${key}`,
      labels,
      parent: null,
      issuetype: { name: "Task" },
      status: { statusCategory: { key: "indeterminate" } },
      assignee: null,
      issuelinks: [],
    },
  };
}

function createShims(prExists = false, prState = "OPEN") {
  mkdirSync(SHIM_DIR, { recursive: true });

  let ghPrView;
  if (prExists) {
    ghPrView = `echo '{"number":5,"url":"http://pr/5","state":"${prState}"}'`;
  } else {
    ghPrView = "exit 1";
  }

  const ghShim = `#!/bin/bash
case "$*" in
  *"pr view"*)
    ${ghPrView}
    ;;
  *)
    exit 1
    ;;
esac
`;
  writeFileSync(join(SHIM_DIR, "gh"), ghShim, { mode: 0o755 });

  const gitShim = `#!/bin/bash
exit 1
`;
  writeFileSync(join(SHIM_DIR, "git"), gitShim, { mode: 0o755 });
}

function runAsync(args, opts = {}) {
  createShims(opts.prExists || false, opts.prState || "OPEN");
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      JIRA_EMAIL: "test@example.com",
      JIRA_API_TOKEN: "fake-token",
      JIRA_DOMAIN: `127.0.0.1:${port}`,
      JIRA_PROTOCOL: "http",
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
    };
    const child = spawn("node", [BIN, ...args.split(" ")], {
      env,
      cwd: WORK_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`Invalid JSON: ${stdout}\nstderr: ${stderr}`));
        }
      } else {
        reject(new Error(`Exit ${code}: ${stderr}\nstdout: ${stdout}`));
      }
    });
    setTimeout(() => {
      child.kill();
      reject(new Error("Timeout"));
    }, 10000);
  });
}

beforeAll(async () => {
  mkdirSync(PLANS_DIR, { recursive: true });

  server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const url = req.url;
      const issueMatch = url.match(/\/issue\/([A-Z]+-\d+)/);
      if (issueMatch) {
        const key = issueMatch[1];
        let labels = [];
        if (key === "PLAN-1") labels = ["ClaudeExecuting"];
        if (key === "EXEC-1") labels = ["ClaudeStackReady"];
        if (key === "TRIV-1") labels = ["complexity:trivial"];
        if (key === "TRIV-2")
          labels = ["complexity:trivial", "ClaudeExecuting"];

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(createIssueResponse(key, labels)));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("seed-checklist e2e", () => {
  it("seeds fresh checklist with no steps done for new ticket", async () => {
    const result = await runAsync(
      `FRESH-1 --work-dir ${WORK_DIR} --branch FRESH-1 --base-branch main --pr-target main --summary New`,
    );

    expect(result.steps).toHaveLength(10);
    expect(result.steps[0].done).toBe(false);
    expect(result.steps[9].done).toBe(false);
    expect(result.markdown).toContain("# FRESH-1 - Work Checklist");
    expect(result.markdown).toContain("- [ ] 1. Plan generated");
  });

  it("seeds with step 1 done when ClaudeExecuting label present", async () => {
    const result = await runAsync(
      `PLAN-1 --work-dir ${WORK_DIR} --branch PLAN-1 --base-branch main --pr-target main --summary Executing`,
    );

    expect(result.steps[0].done).toBe(true);
    expect(result.steps[1].done).toBe(false);
  });

  it("seeds with steps 1-6 done when ClaudeStackReady label present", async () => {
    const result = await runAsync(
      `EXEC-1 --work-dir ${WORK_DIR} --branch EXEC-1 --base-branch main --pr-target main --summary Done`,
    );

    for (let i = 0; i < 6; i++) {
      expect(result.steps[i].done).toBe(true);
    }
    // Slot 7 is the retired PR-approval gate — always pre-marked done.
    expect(result.steps[6].done).toBe(true);
    expect(result.steps[7].done).toBe(false);
  });

  it("seeds with steps 1-9 done when PR exists", async () => {
    const result = await runAsync(
      `FRESH-1 --work-dir ${WORK_DIR} --branch FRESH-1 --base-branch main --pr-target main --summary HasPR`,
      { prExists: true },
    );

    for (let i = 0; i < 9; i++) {
      expect(result.steps[i].done).toBe(true);
    }
    expect(result.steps[9].done).toBe(false);
  });

  it("ignores a MERGED PR from a prior life on a rework'd branch", async () => {
    const result = await runAsync(
      `FRESH-1 --work-dir ${WORK_DIR} --branch FRESH-1 --base-branch main --pr-target main --summary ReworkedFresh`,
      { prExists: true, prState: "MERGED" },
    );

    // Slot 7 (retired gate) is always done; nothing else is.
    expect(result.steps.filter((s) => s.done)).toHaveLength(1);
    expect(result.steps[6].done).toBe(true);
  });

  it("ignores a CLOSED PR from a prior life on a rework'd branch", async () => {
    const result = await runAsync(
      `FRESH-1 --work-dir ${WORK_DIR} --branch FRESH-1 --base-branch main --pr-target main --summary ReworkedFresh`,
      { prExists: true, prState: "CLOSED" },
    );

    // Slot 7 (retired gate) is always done; nothing else is.
    expect(result.steps.filter((s) => s.done)).toHaveLength(1);
    expect(result.steps[6].done).toBe(true);
  });

  it("uses base_branch and pr_target frontmatter for stacked tickets", async () => {
    const result = await runAsync(
      `FRESH-1 --work-dir ${WORK_DIR} --branch FRESH-1 --base-branch STORY-1 --pr-target STORY-1 --summary FB`,
    );

    expect(result.markdown).toContain("base_branch: STORY-1");
    expect(result.markdown).toContain("pr_target: STORY-1");
    expect(result.markdown).not.toContain("feature_branch:");
  });

  it("pre-marks trivial-skipped steps (1, 4, 5) as done with skip suffix", async () => {
    const result = await runAsync(
      `TRIV-1 --work-dir ${WORK_DIR} --branch TRIV-1 --base-branch main --pr-target main --summary Trivial`,
    );

    expect(result.complexity).toBe("trivial");
    // Skipped steps are pre-checked and labeled.
    for (const num of [1, 4, 5]) {
      const step = result.steps[num - 1];
      expect(step.done).toBe(true);
      expect(step.label).toContain("(skipped: trivial)");
    }
    // Non-skipped steps remain unchecked + unlabeled.
    expect(result.steps[1].done).toBe(false); // step 2: execute
    expect(result.steps[2].done).toBe(false); // step 3: AC verify
    expect(result.steps[5].done).toBe(false); // step 6: stack ready
    expect(result.steps[1].label).not.toContain("(skipped");
    expect(result.markdown).toContain("complexity: trivial");
    expect(result.markdown).toContain(
      "- [x] 1. Plan generated with /jira-start (skipped: trivial)",
    );
    expect(result.markdown).toContain(
      "- [x] 4. Combined review pass (review + refactor + plan) (skipped: trivial)",
    );
  });

  it("standard tier (no complexity label) keeps the original step labels", async () => {
    const result = await runAsync(
      `FRESH-1 --work-dir ${WORK_DIR} --branch FRESH-1 --base-branch main --pr-target main --summary Std`,
    );

    expect(result.complexity).toBe("standard");
    for (const step of result.steps) {
      expect(step.label).not.toContain("(skipped: trivial)");
    }
    expect(result.markdown).toContain("complexity: standard");
  });

  it("trivial tier preserves stage progress signals (does not flip done→false)", async () => {
    // TRIV-2 has both complexity:trivial and ClaudeExecuting.
    // ClaudeExecuting normally implies step 1 done; trivial pre-marks 1,4,5.
    // Result: 1, 4, 5 all done; everything else still false.
    const result = await runAsync(
      `TRIV-2 --work-dir ${WORK_DIR} --branch TRIV-2 --base-branch main --pr-target main --summary Mixed`,
    );

    expect(result.complexity).toBe("trivial");
    expect(result.steps[0].done).toBe(true); // step 1 (skipped + ClaudeExecuting both want it true)
    expect(result.steps[3].done).toBe(true); // step 4 skipped
    expect(result.steps[4].done).toBe(true); // step 5 skipped
    expect(result.steps[1].done).toBe(false); // step 2 execute, not skipped
  });

  it("includes serial flag in frontmatter when specified", async () => {
    const result = await runAsync(
      `FRESH-1 --work-dir ${WORK_DIR} --branch FRESH-1 --base-branch main --pr-target main --summary Serial --serial`,
    );

    expect(result.markdown).toContain("serial: true");
  });
});
