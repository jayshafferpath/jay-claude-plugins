import { execSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

const { verifyMerge } = await import("../lib/verify-merge.js");

describe("verifyMerge", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("throws when required args missing", () => {
    expect(() => verifyMerge({ branch: "x", cwd: "/r" })).toThrow();
    expect(() => verifyMerge({ base: "main", cwd: "/r" })).toThrow();
    expect(() => verifyMerge({ branch: "x", base: "main" })).toThrow();
  });

  it("returns merged=false with no refusalReason when no merged PR (non-strict)", () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr list")) return "[]";
      throw new Error("unexpected");
    });
    const out = verifyMerge({ branch: "feat", base: "main", cwd: "/r" });
    expect(out.merged).toBe(false);
    expect(out.refusalReason).toBeNull();
    expect(out.ancestorOfTarget).toBe(false);
  });

  it("returns merged=false with refusalReason when no merged PR (strict)", () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr list")) return "[]";
      throw new Error("unexpected");
    });
    const out = verifyMerge({
      branch: "feat",
      base: "main",
      cwd: "/r",
      strict: true,
    });
    expect(out.merged).toBe(false);
    expect(out.refusalReason).toMatch(/no merged PR to main/);
  });

  it("returns merged=true ancestor=true when merge commit is reachable", () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr list")) {
        return JSON.stringify([
          {
            number: 7,
            url: "https://gh/x/y/pull/7",
            state: "MERGED",
            mergeCommit: { oid: "abc123" },
          },
        ]);
      }
      if (cmd.includes("git merge-base --is-ancestor")) return "";
      throw new Error("unexpected");
    });
    const out = verifyMerge({
      branch: "feat",
      base: "main",
      cwd: "/r",
      strict: true,
    });
    expect(out).toMatchObject({
      merged: true,
      prNumber: 7,
      mergeSha: "abc123",
      ancestorOfTarget: true,
      refusalReason: null,
    });
  });

  it("returns refusalReason when merge SHA is not an ancestor (strict)", () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr list")) {
        return JSON.stringify([
          {
            number: 9,
            url: "https://gh/x/y/pull/9",
            state: "MERGED",
            mergeCommit: { oid: "deadbeef" },
          },
        ]);
      }
      if (cmd.includes("git merge-base --is-ancestor")) {
        const err = new Error("not ancestor");
        err.status = 1;
        throw err;
      }
      throw new Error("unexpected");
    });
    const out = verifyMerge({
      branch: "feat",
      base: "main",
      cwd: "/r",
      strict: true,
    });
    expect(out.merged).toBe(true);
    expect(out.ancestorOfTarget).toBe(false);
    expect(out.refusalReason).toMatch(/not reachable from origin\/main/);
  });

  it("non-strict ancestor=false produces no refusalReason", () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr list")) {
        return JSON.stringify([
          { number: 1, url: "u", state: "MERGED", mergeCommit: { oid: "s" } },
        ]);
      }
      if (cmd.includes("git merge-base --is-ancestor")) {
        throw new Error("not ancestor");
      }
      throw new Error("unexpected");
    });
    const out = verifyMerge({ branch: "feat", base: "main", cwd: "/r" });
    expect(out.refusalReason).toBeNull();
    expect(out.ancestorOfTarget).toBe(false);
  });

  it("flags missing mergeSha (strict)", () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes("gh pr list")) {
        return JSON.stringify([
          { number: 5, url: "u", state: "MERGED", mergeCommit: null },
        ]);
      }
      throw new Error("unexpected");
    });
    const out = verifyMerge({
      branch: "feat",
      base: "main",
      cwd: "/r",
      strict: true,
    });
    expect(out.merged).toBe(true);
    expect(out.mergeSha).toBeNull();
    expect(out.refusalReason).toMatch(/no merge commit SHA/);
  });
});
