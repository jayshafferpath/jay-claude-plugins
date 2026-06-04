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

  it("loads from ~/.claude/.env as fallback", async () => {
    readFileSync.mockImplementation((path) => {
      if (path.toString().includes(".claude/.env")) {
        return "DEV_ROOT=/home/dev\n";
      }
      throw new Error("not found");
    });

    const { loadEnv } = await import("../lib/env.js");
    loadEnv();
    expect(process.env.DEV_ROOT).toBe("/home/dev");
  });

  it("survives missing .env files", async () => {
    readFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const { loadEnv } = await import("../lib/env.js");
    expect(() => loadEnv()).not.toThrow();
  });
});
