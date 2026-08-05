import { describe, expect, it } from "vitest";
import { serializeJob, __test__ } from "../api/run-command.js";

const { truncate, MAX_LOG_CHARS } = __test__;

describe("truncate", () => {
  it("leaves a short log untouched", () => {
    expect(truncate("hello")).toBe("hello");
  });

  it("keeps the tail, not the head, once the cap is passed", () => {
    // The end of a command's output is where the failure and result are; the
    // beginning is setup noise.
    const log = `START${"x".repeat(MAX_LOG_CHARS)}END`;
    const result = truncate(log);
    expect(result).toContain("END");
    expect(result).not.toContain("START");
    expect(result).toContain("earlier output truncated");
  });

  it("keeps the result bounded", () => {
    const log = "y".repeat(MAX_LOG_CHARS * 3);
    // Bounded by the cap plus the notice line, not by the input size.
    expect(truncate(log).length).toBeLessThan(MAX_LOG_CHARS + 100);
  });

  it("does not truncate a log exactly at the cap", () => {
    const log = "z".repeat(MAX_LOG_CHARS);
    expect(truncate(log)).toBe(log);
  });
});

describe("serializeJob", () => {
  const job = {
    id: "abc",
    ticketKey: "PROJ-1",
    prompt: "/cleanup-main PROJ-1 --yes",
    status: "running",
    log: "lots of output",
  };

  it("omits the log by default so the job list stays small", () => {
    const result = serializeJob(job);
    expect(result).not.toHaveProperty("log");
    expect(result).toMatchObject({ id: "abc", ticketKey: "PROJ-1" });
  });

  it("includes the log on request", () => {
    expect(serializeJob(job, { includeLog: true }).log).toBe("lots of output");
  });

  it("returns null for a missing job", () => {
    expect(serializeJob(null)).toBeNull();
    expect(serializeJob(undefined)).toBeNull();
  });

  it("does not mutate the job it serializes", () => {
    serializeJob(job);
    expect(job.log).toBe("lots of output");
  });
});
