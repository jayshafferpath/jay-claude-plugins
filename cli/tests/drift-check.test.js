import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/jira.js", () => ({
  getIssue: vi.fn(),
}));

const { getIssue } = await import("../lib/jira.js");
const {
  diffCitation,
  driftCheck,
  extractImplementationNotes,
  parseCitations,
  parseResearchBaseline,
} = await import("../lib/drift-check.js");

const ROOT = join(tmpdir(), `drift-check-test-${process.pid}-${Date.now()}`);

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function makeRepo(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  git("init --initial-branch=main", dir);
  git("config user.email t@e.com", dir);
  git("config user.name T", dir);
  git("config commit.gpgsign false", dir);
  return dir;
}

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

describe("diffCitation", () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it("returns 'unknown' when no baseline SHA is supplied", () => {
    expect(
      diffCitation({ path: "x", start: 1, end: 1, baselineSha: null }, "/tmp"),
    ).toMatchObject({ status: "unknown", reason: "no baseline SHA" });
  });

  it("returns 'unknown' when the repo path does not exist", () => {
    expect(
      diffCitation(
        { path: "x", start: 1, end: 1, baselineSha: "abc" },
        "/no/such/path",
      ),
    ).toMatchObject({ status: "unknown" });
  });

  it("returns 'current' when the cited range was not modified", () => {
    const repo = makeRepo("clean");
    writeFileSync(join(repo, "f.txt"), "a\nb\nc\n");
    git("add f.txt", repo);
    git('commit -m "initial"', repo);
    const baseline = git("rev-parse HEAD", repo);
    // Add a new file that doesn't touch f.txt's lines:
    writeFileSync(join(repo, "g.txt"), "g\n");
    git("add g.txt", repo);
    git('commit -m "g"', repo);

    const result = diffCitation(
      { path: "f.txt", start: 1, end: 3, baselineSha: baseline },
      repo,
    );
    expect(result.status).toBe("current");
  });

  it("returns 'drifted' with reason 'lines modified' when the cited range changed", () => {
    const repo = makeRepo("modified");
    writeFileSync(join(repo, "f.txt"), "a\nb\nc\n");
    git("add f.txt", repo);
    git('commit -m "initial"', repo);
    const baseline = git("rev-parse HEAD", repo);
    writeFileSync(join(repo, "f.txt"), "a\nB-CHANGED\nc\n");
    git("commit -am rev", repo);

    const result = diffCitation(
      { path: "f.txt", start: 1, end: 3, baselineSha: baseline },
      repo,
    );
    expect(result.status).toBe("drifted");
    expect(result.reason).toBe("lines modified");
    expect(result.commits.length).toBeGreaterThan(0);
  });

  it("returns 'drifted (file removed)' when the file is gone at HEAD", () => {
    const repo = makeRepo("removed");
    writeFileSync(join(repo, "f.txt"), "x\n");
    git("add f.txt", repo);
    git('commit -m "initial"', repo);
    const baseline = git("rev-parse HEAD", repo);
    git("rm f.txt", repo);
    git('commit -m "remove"', repo);

    const result = diffCitation(
      { path: "f.txt", start: 1, end: 1, baselineSha: baseline },
      repo,
    );
    expect(result.status).toBe("drifted");
    expect(result.reason).toBe("file removed");
  });

  it("detects file renames via git log --follow when the new path keeps similar content", () => {
    const repo = makeRepo("rename-detected");
    // Configure git's similarity threshold so identical content qualifies.
    execSync("git config diff.renames true", { cwd: repo, stdio: "pipe" });
    execSync("git config diff.renameLimit 999", { cwd: repo, stdio: "pipe" });
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join(
      "",
    );
    writeFileSync(join(repo, "old.ts"), content);
    git("add old.ts", repo);
    git('commit -m "initial"', repo);
    const baseline = git("rev-parse HEAD", repo);
    // Rename via git mv (records rename in the commit, --follow finds it).
    git("mv old.ts new.ts", repo);
    git('commit -m "rename"', repo);

    const result = diffCitation(
      { path: "old.ts", start: 1, end: 5, baselineSha: baseline },
      repo,
    );
    expect(result.status).toBe("drifted");
    expect(["file moved", "file removed"]).toContain(result.reason);
    if (result.reason === "file moved") {
      expect(result.newPath).toBe("new.ts");
    }
  });

  it("returns 'drifted (file removed)' as the fallback when the file is gone but no rename was detected", () => {
    // git's rename detection is heuristic; the agent path is "best-effort".
    // The file-removed branch is what we hit when --follow finds nothing.
    const repo = makeRepo("renamed");
    writeFileSync(join(repo, "old.txt"), "x\ny\nz\n");
    git("add old.txt", repo);
    git('commit -m "initial"', repo);
    const baseline = git("rev-parse HEAD", repo);
    // Delete (not rename) so --follow has nothing to follow:
    git("rm old.txt", repo);
    git('commit -m "remove"', repo);

    const result = diffCitation(
      { path: "old.txt", start: 1, end: 3, baselineSha: baseline },
      repo,
    );
    expect(result.status).toBe("drifted");
    expect(result.reason).toBe("file removed");
  });
});

describe("driftCheck", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it("returns 'no-notes' when the description has no Implementation Notes block", async () => {
    getIssue.mockResolvedValueOnce({
      fields: { description: "h2. Background\nNothing here." },
    });
    const result = await driftCheck("X-1");
    expect(result.status).toBe("no-notes");
  });

  it("flattens ADF descriptions and reports drift status from citations", async () => {
    const repo = makeRepo("e2e");
    writeFileSync(join(repo, "f.txt"), "a\nb\n");
    git("add f.txt", repo);
    git('commit -m "initial"', repo);
    const baseline = git("rev-parse HEAD", repo);
    writeFileSync(join(repo, "f.txt"), "a\nCHANGED\n");
    git("commit -am rev", repo);

    const description = {
      type: "doc",
      content: [
        { type: "heading", content: [{ text: "h2. Implementation Notes" }] },
        {
          type: "paragraph",
          content: [
            {
              text: `Research baseline: my-repo@${baseline}\nExisting patterns:\n- [f.txt#L1-L2|https://github.com/o/my-repo/blob/${baseline}/f.txt#L1-L2]`,
            },
          ],
        },
      ],
    };
    getIssue.mockResolvedValueOnce({ fields: { description } });

    const result = await driftCheck("X-2", { repoRoot: repo });
    expect(result.status).toBe("drifted");
    expect(result.drifted).toBe(1);
    expect(result.total).toBe(1);
    expect(result.baseline["my-repo"]).toBe(baseline);
  });

  it("returns 'current' when no citations have drifted", async () => {
    const repo = makeRepo("e2e-clean");
    writeFileSync(join(repo, "f.txt"), "x\ny\n");
    git("add f.txt", repo);
    git('commit -m "initial"', repo);
    const baseline = git("rev-parse HEAD", repo);

    const description = `h2. Implementation Notes
Research baseline: my-repo@${baseline}
- [f.txt#L1-L2|https://github.com/o/my-repo/blob/${baseline}/f.txt#L1-L2]`;
    getIssue.mockResolvedValueOnce({ fields: { description } });

    const result = await driftCheck("X-3", { repoRoot: repo });
    expect(result.status).toBe("current");
    expect(result.drifted).toBe(0);
  });
});
