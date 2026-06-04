import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "../../bin/resolve-stack.js");
const TMP = join(tmpdir(), `resolve-stack-e2e-${Date.now()}`);
const SHIM_DIR = join(TMP, "shims");

let server;
let port;

const ISSUES = {
  "SUB-1": {
    key: "SUB-1",
    fields: {
      summary: "First subtask",
      labels: ["ClaudeWork", "ClaudeNeedsReview", "repo:my-backend"],
      parent: { key: "STORY-1", fields: { summary: "Parent Story" } },
      issuetype: { name: "Sub-task" },
      status: { statusCategory: { key: "done" } },
      assignee: { accountId: "user1" },
      issuelinks: [
        { type: { outward: "blocks" }, outwardIssue: { key: "SUB-2" } },
      ],
    },
  },
  "SUB-2": {
    key: "SUB-2",
    fields: {
      summary: "Second subtask",
      labels: ["ClaudeWork", "ClaudeReady", "repo:my-backend"],
      parent: { key: "STORY-1", fields: { summary: "Parent Story" } },
      issuetype: { name: "Sub-task" },
      status: { statusCategory: { key: "indeterminate" } },
      assignee: { accountId: "user1" },
      issuelinks: [
        {
          type: { inward: "is blocked by" },
          inwardIssue: { key: "SUB-1" },
        },
      ],
    },
  },
  "STORY-1": {
    key: "STORY-1",
    fields: {
      summary: "Parent Story",
      labels: ["branch:feature-auth", "repo:my-backend"],
      parent: null,
      issuetype: { name: "Story" },
      status: { statusCategory: { key: "indeterminate" } },
      assignee: null,
      issuelinks: [],
    },
  },
};

function createShims() {
  mkdirSync(SHIM_DIR, { recursive: true });

  const gitShim = `#!/bin/bash
case "$*" in
  *"branch --list"*SUB-1*)
    echo "  SUB-1"
    ;;
  *"branch --list"*SUB-2*)
    echo "  SUB-2"
    ;;
  *"merge-base --is-ancestor"*)
    exit 0
    ;;
  *"branch -r --merged"*)
    echo "  origin/SUB-1"
    ;;
  *"fetch"*)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
  writeFileSync(join(SHIM_DIR, "git"), gitShim, { mode: 0o755 });
}

function runAsync(args) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      JIRA_EMAIL: "test@example.com",
      JIRA_API_TOKEN: "fake-token",
      JIRA_DOMAIN: `127.0.0.1:${port}`,
      JIRA_PROTOCOL: "http",
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      DEV_ROOT: TMP,
    };
    const child = spawn("node", [BIN, ...args.split(" ")], {
      env,
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
          reject(new Error(`Invalid JSON: ${stdout}`));
        }
      } else {
        reject(new Error(`Exit ${code}: ${stderr}`));
      }
    });
    setTimeout(() => {
      child.kill();
      reject(new Error("Timeout"));
    }, 10000);
  });
}

beforeAll(async () => {
  mkdirSync(join(TMP, "my-backend"), { recursive: true });
  createShims();

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const url = req.url;

      if (url.includes("/search/jql")) {
        const payload = JSON.parse(body);
        const jql = payload.jql;
        let issues = [];
        if (jql.includes("STORY-1")) {
          issues = [ISSUES["SUB-1"], ISSUES["SUB-2"]];
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ issues }));
        return;
      }

      const issueMatch = url.match(/\/issue\/([A-Z]+-\d+)/);
      if (issueMatch) {
        const key = issueMatch[1];
        if (ISSUES[key]) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(ISSUES[key]));
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Unknown endpoint");
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

describe("resolve-stack e2e", () => {
  it("resolves a two-ticket stack from SUB-1", async () => {
    const result = await runAsync("SUB-1");

    expect(result.container).not.toBeNull();
    expect(result.container.key).toBe("STORY-1");
    expect(result.container.type).toBe("Story");
    expect(result.container.featureBranch).toBe("feature-auth");
    expect(result.inputTicket).toBe("SUB-1");
    expect(result.stack).toHaveLength(2);

    const sub1 = result.stack.find((t) => t.key === "SUB-1");
    expect(sub1.status).toBe("finished");
    expect(sub1.branch).toBe("SUB-1");
    expect(sub1.mergedIntoMain).toBe(true);

    const sub2 = result.stack.find((t) => t.key === "SUB-2");
    expect(sub2.eligible).toBe(true);
    expect(sub2.baseBranch).toBe("feature-auth");
    expect(sub2.prTarget).toBe("feature-auth");
  });

  it("resolves from SUB-2 with correct ticketIndex", async () => {
    const result = await runAsync("SUB-2");

    expect(result.inputTicket).toBe("SUB-2");
    expect(result.ticketIndex).toBeGreaterThanOrEqual(0);
    const sub2 = result.stack[result.ticketIndex];
    expect(sub2.key).toBe("SUB-2");
  });

  it("exits with error for nonexistent ticket", async () => {
    await expect(runAsync("NOPE-999")).rejects.toThrow();
  });
});
