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

function createShims(prExists = false) {
  mkdirSync(SHIM_DIR, { recursive: true });

  let ghPrView;
  if (prExists) {
    ghPrView = `echo '{"number":5,"url":"http://pr/5","state":"OPEN"}'`;
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
  createShims(opts.prExists || false);
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
        if (key === "PLAN-1") labels = ["ClaudePlanApproved"];
        if (key === "EXEC-1") labels = ["ClaudeStackReady"];

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

    expect(result.steps).toHaveLength(13);
    expect(result.steps[0].done).toBe(false);
    expect(result.steps[12].done).toBe(false);
    expect(result.markdown).toContain("# FRESH-1 - Work Checklist");
    expect(result.markdown).toContain("- [ ] 1. Plan generated");
  });

  it("seeds with steps 1-2 done when ClaudePlanApproved label present", async () => {
    const result = await runAsync(
      `PLAN-1 --work-dir ${WORK_DIR} --branch PLAN-1 --base-branch main --pr-target main --summary Approved`,
    );

    expect(result.steps[0].done).toBe(true);
    expect(result.steps[1].done).toBe(true);
    expect(result.steps[2].done).toBe(false);
  });

  it("seeds with steps 1-8 done when ClaudeStackReady label present", async () => {
    const result = await runAsync(
      `EXEC-1 --work-dir ${WORK_DIR} --branch EXEC-1 --base-branch main --pr-target main --summary Done`,
    );

    for (let i = 0; i < 8; i++) {
      expect(result.steps[i].done).toBe(true);
    }
    expect(result.steps[8].done).toBe(false);
  });

  it("seeds with steps 1-11 done when PR exists", async () => {
    const result = await runAsync(
      `FRESH-1 --work-dir ${WORK_DIR} --branch FRESH-1 --base-branch main --pr-target main --summary HasPR`,
      { prExists: true },
    );

    for (let i = 0; i < 11; i++) {
      expect(result.steps[i].done).toBe(true);
    }
    expect(result.steps[11].done).toBe(false);
    expect(result.steps[12].done).toBe(false);
  });

  it("includes feature branch in frontmatter when specified", async () => {
    const result = await runAsync(
      `FRESH-1 --work-dir ${WORK_DIR} --branch FRESH-1 --base-branch feature-x --feature-branch feature-x --pr-target feature-x --summary FB`,
    );

    expect(result.markdown).toContain("feature_branch: feature-x");
    expect(result.markdown).toContain("pr_target: feature-x");
  });

  it("includes serial flag in frontmatter when specified", async () => {
    const result = await runAsync(
      `FRESH-1 --work-dir ${WORK_DIR} --branch FRESH-1 --base-branch main --pr-target main --summary Serial --serial`,
    );

    expect(result.markdown).toContain("serial: true");
  });
});
