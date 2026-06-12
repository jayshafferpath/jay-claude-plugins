import { describe, expect, it } from "vitest";

import {
  extractImplementationNotes,
  parseCitations,
  parseResearchBaseline,
} from "../lib/drift-check.js";

describe("extractImplementationNotes", () => {
  it("returns the block between Implementation Notes and the next h2.", () => {
    const text = [
      "h2. Background",
      "Some context.",
      "",
      "h2. Implementation Notes",
      "Research baseline: my-repo@deadbeef",
      "Existing patterns:",
      "- [src/foo.ts#L10-L20|https://github.com/o/my-repo/blob/deadbeef/src/foo.ts#L10-L20]",
      "",
      "h2. Acceptance Criteria",
      "- something",
    ].join("\n");

    const notes = extractImplementationNotes(text);
    expect(notes).toContain("Research baseline: my-repo@deadbeef");
    expect(notes).not.toContain("Acceptance Criteria");
  });

  it("returns null when no Implementation Notes block exists", () => {
    const text = "h2. Background\nText here.\n\nh2. Acceptance\n- x";
    expect(extractImplementationNotes(text)).toBeNull();
  });

  it("returns the trailing block when Implementation Notes is the final h2.", () => {
    const text = "h2. Implementation Notes\nResearch baseline: r@abc123\n";
    const notes = extractImplementationNotes(text);
    expect(notes).toContain("r@abc123");
  });
});

describe("parseResearchBaseline", () => {
  it("parses a single repo@sha", () => {
    expect(parseResearchBaseline("Research baseline: r1@abc123")).toEqual({
      r1: "abc123",
    });
  });

  it("parses multiple repos separated by commas", () => {
    expect(
      parseResearchBaseline("Research baseline: r1@abc, r2@def, r3@ghi"),
    ).toEqual({ r1: "abc", r2: "def", r3: "ghi" });
  });

  it("returns empty object when no baseline line is present", () => {
    expect(parseResearchBaseline("just some prose")).toEqual({});
  });
});

describe("parseCitations", () => {
  it("extracts path/start/end from a permalink citation", () => {
    const block =
      "- [src/foo.ts#L10-L20|https://github.com/owner/my-repo/blob/abc1234/src/foo.ts#L10-L20]";
    const citations = parseCitations(block);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      path: "src/foo.ts",
      start: 10,
      end: 20,
      repo: "my-repo",
      baselineSha: "abc1234",
    });
  });

  it("falls back to start as end when only one line number is given", () => {
    const block = "[a/b.ts#L42|https://github.com/o/r/blob/sha/a/b.ts#L42]";
    const citations = parseCitations(block);
    expect(citations[0]).toMatchObject({ start: 42, end: 42 });
  });

  it("captures path even when no permalink is attached", () => {
    const block = "[src/x.ts#L1-L3]";
    const citations = parseCitations(block);
    expect(citations[0]).toMatchObject({
      path: "src/x.ts",
      start: 1,
      end: 3,
      repo: null,
      baselineSha: null,
    });
  });

  it("returns an empty list when no citations are present", () => {
    expect(parseCitations("just a paragraph")).toEqual([]);
  });
});
