import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
}));

const envKeys = ["SLACK_WEBHOOK_URL", "DEV_ROOT"];
const saved = {};

beforeEach(() => {
  vi.resetAllMocks();
  for (const k of envKeys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadEnv", () => {
  it("loads vars from .env file", async () => {
    readFileSync.mockImplementation((path) => {
      if (path.toString().endsWith(".env")) {
        return 'SLACK_WEBHOOK_URL="http://hook"\nDEV_ROOT=/dev\n';
      }
      throw new Error("not found");
    });

    const { loadEnv } = await import("../lib/env.js");
    loadEnv();
    expect(process.env.SLACK_WEBHOOK_URL).toBe("http://hook");
    expect(process.env.DEV_ROOT).toBe("/dev");
  });

  it("does not override existing env vars", async () => {
    process.env.SLACK_WEBHOOK_URL = "existing";
    readFileSync.mockImplementation((path) => {
      if (path.toString().endsWith(".env")) {
        return 'SLACK_WEBHOOK_URL="http://new"\n';
      }
      throw new Error("not found");
    });

    const { loadEnv } = await import("../lib/env.js");
    loadEnv();
    expect(process.env.SLACK_WEBHOOK_URL).toBe("existing");
  });

  it("skips comments and blank lines in .env", async () => {
    readFileSync.mockImplementation((path) => {
      if (path.toString().endsWith(".env")) {
        return "# comment\n\nDEV_ROOT=/x\n";
      }
      throw new Error("not found");
    });

    const { loadEnv } = await import("../lib/env.js");
    loadEnv();
    expect(process.env.DEV_ROOT).toBe("/x");
  });

  it("loads slackWebhookUrl from dev-root.json", async () => {
    readFileSync.mockImplementation((path) => {
      if (path.toString().endsWith(".env")) throw new Error("no .env");
      if (path.toString().endsWith("dev-root.json")) {
        return JSON.stringify({
          slackWebhookUrl: "http://slack",
          root: "/dev",
        });
      }
      throw new Error("not found");
    });

    const { loadEnv } = await import("../lib/env.js");
    loadEnv();
    expect(process.env.SLACK_WEBHOOK_URL).toBe("http://slack");
    expect(process.env.DEV_ROOT).toBe("/dev");
  });

  it("handles tilde in dev-root.json root path", async () => {
    readFileSync.mockImplementation((path) => {
      if (path.toString().endsWith(".env")) throw new Error("no .env");
      if (path.toString().endsWith("dev-root.json")) {
        return JSON.stringify({ root: "~/projects" });
      }
      throw new Error("not found");
    });

    const { loadEnv } = await import("../lib/env.js");
    loadEnv();
    expect(process.env.DEV_ROOT).toContain("projects");
    expect(process.env.DEV_ROOT).not.toContain("~");
  });

  it("survives missing .env and dev-root.json", async () => {
    readFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const { loadEnv } = await import("../lib/env.js");
    expect(() => loadEnv()).not.toThrow();
  });
});
