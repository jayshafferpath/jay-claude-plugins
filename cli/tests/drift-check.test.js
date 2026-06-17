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
  parseConstraints,
  parseFilesLikelyToChange,
  parsePatterns,
  parseResearchBaseline,
  parseTddRef,
  parseTestsLikelyToExtend,
  verifyCitationWellFormed,
  verifyPathExists,
  verifySidecars,
  verifySymbolPresent,
  verifyTddRef,
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

describe("parsePatterns", () => {
  it("extracts name, symbol, and citation from a planner-shaped bullet", () => {
    const block = `*Existing patterns to extend:*
* *Auth middleware* — \`requireSession\` in [src/auth.ts#L10-L40|https://github.com/o/r/blob/abc123/src/auth.ts#L10-L40] — follows existing pattern
* *Token validator* — \`validateJWT\` in [src/jwt.ts#L1-L20|https://github.com/o/r/blob/abc123/src/jwt.ts#L1-L20] — reuse this

*Files likely to change:*
* \`src/foo.ts\``;
    const patterns = parsePatterns(block);
    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toMatchObject({
      name: "Auth middleware",
      symbol: "requireSession",
    });
    expect(patterns[0].citation).toMatchObject({
      path: "src/auth.ts",
      start: 10,
      end: 40,
    });
    expect(patterns[1].symbol).toBe("validateJWT");
  });

  it("returns an empty list when the section is absent", () => {
    expect(parsePatterns("Research baseline: r@abc")).toEqual([]);
  });
});

describe("parseFilesLikelyToChange", () => {
  it("extracts paths from backtick-quoted bullets", () => {
    const block = `*Files likely to change:*
* \`src/foo.ts\` — adds the new endpoint
* \`src/bar.ts\` — wires it up

*Tests likely to extend:*
* \`tests/foo.test.ts\``;
    const files = parseFilesLikelyToChange(block);
    expect(files.map((f) => f.path)).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("falls back to citation path when no backticks are present", () => {
    const block = `*Files likely to change:*
* [src/baz.ts#L1-L1|https://github.com/o/r/blob/abc/src/baz.ts#L1-L1]`;
    const files = parseFilesLikelyToChange(block);
    expect(files[0].path).toBe("src/baz.ts");
  });
});

describe("parseTestsLikelyToExtend", () => {
  it("captures both path and citation", () => {
    const block = `*Tests likely to extend:*
* \`tests/auth.test.ts\` — extend the [tests/auth.test.ts#L50-L80|https://github.com/o/r/blob/abc/tests/auth.test.ts#L50-L80] suite`;
    const tests = parseTestsLikelyToExtend(block);
    expect(tests[0].path).toBe("tests/auth.test.ts");
    expect(tests[0].citation).toMatchObject({ start: 50, end: 80 });
  });
});

describe("parseConstraints", () => {
  it("returns the trimmed body of the constraints subsection", () => {
    const block = `*Files likely to change:*
* \`x\`

*Constraints:*
* in-flight migration to async handlers
* avoid sync DB calls`;
    const c = parseConstraints(block);
    expect(c).toContain("in-flight migration");
    expect(c).toContain("avoid sync DB calls");
    expect(c).not.toContain("Files likely to change");
  });

  it("returns null when constraints subsection is missing", () => {
    expect(parseConstraints("Research baseline: r@abc")).toBeNull();
  });
});

describe("parseTddRef", () => {
  it("extracts title, repo, path, and anchor from the TDD Reference block", () => {
    const text = `h2. TDD Reference
[Auth TDD - Session Management|https://github.com/o/platform/blob/abc1234/docs/tdds/auth.md#session-management]
Repo path: docs/tdds/auth.md#session-management

h2. Acceptance Criteria
- something`;
    const ref = parseTddRef(text);
    expect(ref).toMatchObject({
      title: "Auth TDD - Session Management",
      repo: "platform",
      path: "docs/tdds/auth.md",
      anchor: "session-management",
    });
  });

  it("returns null when no TDD Reference block exists", () => {
    expect(parseTddRef("h2. Background\nsomething")).toBeNull();
  });

  it("falls back to Repo path when the link URL is malformed", () => {
    const text = `h2. TDD Reference
Repo path: docs/tdds/auth.md#session-management`;
    const ref = parseTddRef(text);
    expect(ref).toMatchObject({
      path: "docs/tdds/auth.md",
      anchor: "session-management",
    });
  });
});

describe("verifyCitationWellFormed", () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it("flags invalid line ranges", () => {
    expect(
      verifyCitationWellFormed(
        { path: "x", start: 5, end: 2, baselineSha: "abc" },
        "/tmp",
      ),
    ).toMatchObject({ status: "drifted", reason: "invalid line range" });
  });

  it("flags an unreachable baseline SHA", () => {
    const repo = makeRepo("unreachable-sha");
    writeFileSync(join(repo, "f.txt"), "a\n");
    git("add f.txt", repo);
    git('commit -m "initial"', repo);
    const result = verifyCitationWellFormed(
      { path: "f.txt", start: 1, end: 1, baselineSha: "deadbeefdead" },
      repo,
    );
    expect(result.status).toBe("drifted");
    expect(result.reason).toMatch(/unreachable/);
  });

  it("flags an end line past the baseline file length", () => {
    const repo = makeRepo("oob-line");
    writeFileSync(join(repo, "f.txt"), "a\nb\n");
    git("add f.txt", repo);
    git('commit -m "initial"', repo);
    const baseline = git("rev-parse HEAD", repo);
    const result = verifyCitationWellFormed(
      { path: "f.txt", start: 1, end: 99, baselineSha: baseline },
      repo,
    );
    expect(result.status).toBe("drifted");
    expect(result.reason).toMatch(/exceeds baseline/);
  });

  it("returns 'current' when the citation is well-formed and reachable", () => {
    const repo = makeRepo("well-formed");
    writeFileSync(join(repo, "f.txt"), "a\nb\nc\n");
    git("add f.txt", repo);
    git('commit -m "initial"', repo);
    const baseline = git("rev-parse HEAD", repo);
    const result = verifyCitationWellFormed(
      { path: "f.txt", start: 1, end: 3, baselineSha: baseline },
      repo,
    );
    expect(result.status).toBe("current");
  });
});

describe("verifySymbolPresent", () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it("returns 'current' when the symbol is still at the cited path", () => {
    const repo = makeRepo("symbol-here");
    writeFileSync(
      join(repo, "auth.ts"),
      "export function requireSession() {}\n",
    );
    git("add auth.ts", repo);
    git('commit -m "initial"', repo);
    const result = verifySymbolPresent(
      {
        symbol: "requireSession",
        citation: { path: "auth.ts", start: 1, end: 1 },
      },
      repo,
    );
    expect(result.status).toBe("current");
  });

  it("returns 'drifted (symbol moved)' with newPaths when symbol grep finds it elsewhere", () => {
    const repo = makeRepo("symbol-moved");
    writeFileSync(join(repo, "old.ts"), "filler\n");
    writeFileSync(join(repo, "new.ts"), "export function moved() {}\n");
    git("add .", repo);
    git('commit -m "initial"', repo);
    const result = verifySymbolPresent(
      {
        symbol: "moved",
        citation: { path: "old.ts", start: 1, end: 1 },
      },
      repo,
    );
    expect(result.status).toBe("drifted");
    expect(result.reason).toBe("symbol moved");
    expect(result.newPaths).toContain("new.ts");
  });

  it("returns 'drifted (symbol removed)' when the symbol is gone repo-wide", () => {
    const repo = makeRepo("symbol-removed");
    writeFileSync(join(repo, "auth.ts"), "// no symbol here\n");
    git("add .", repo);
    git('commit -m "initial"', repo);
    const result = verifySymbolPresent(
      {
        symbol: "totallyGoneSymbol",
        citation: { path: "auth.ts", start: 1, end: 1 },
      },
      repo,
    );
    expect(result.status).toBe("drifted");
    expect(result.reason).toBe("symbol removed");
  });

  it("skips the check when no symbol is captured", () => {
    expect(verifySymbolPresent({ symbol: null }, "/tmp")).toMatchObject({
      status: "current",
    });
  });
});

describe("verifyPathExists", () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it("returns 'current' when the path is at HEAD", () => {
    const repo = makeRepo("path-here");
    writeFileSync(join(repo, "src.ts"), "x\n");
    git("add .", repo);
    git('commit -m "init"', repo);
    expect(verifyPathExists({ path: "src.ts" }, repo)).toMatchObject({
      status: "current",
    });
  });

  it("returns 'drifted (file removed)' when the path is gone with no rename", () => {
    const repo = makeRepo("path-removed");
    writeFileSync(join(repo, "src.ts"), "x\n");
    git("add .", repo);
    git('commit -m "init"', repo);
    git("rm src.ts", repo);
    git('commit -m "rm"', repo);
    expect(verifyPathExists({ path: "src.ts" }, repo)).toMatchObject({
      status: "drifted",
      reason: "file removed",
    });
  });
});

describe("verifyTddRef", () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it("returns 'current' when path and anchor still resolve at HEAD", () => {
    const repo = makeRepo("tdd-ok");
    mkdirSync(join(repo, "docs/tdds"), { recursive: true });
    writeFileSync(
      join(repo, "docs/tdds/auth.md"),
      "# Auth TDD\n\n## Session Management\n\nDetails.\n",
    );
    git("add .", repo);
    git('commit -m "init"', repo);
    const result = verifyTddRef(
      { path: "docs/tdds/auth.md", anchor: "session-management" },
      repo,
    );
    expect(result.status).toBe("current");
  });

  it("returns 'drifted' when the anchor no longer matches a heading", () => {
    const repo = makeRepo("tdd-anchor-gone");
    mkdirSync(join(repo, "docs/tdds"), { recursive: true });
    writeFileSync(
      join(repo, "docs/tdds/auth.md"),
      "# Auth TDD\n\n## Sessions\n\nDetails.\n",
    );
    git("add .", repo);
    git('commit -m "init"', repo);
    const result = verifyTddRef(
      { path: "docs/tdds/auth.md", anchor: "session-management" },
      repo,
    );
    expect(result.status).toBe("drifted");
    expect(result.reason).toMatch(/anchor/);
  });

  it("returns 'unknown' when the TDD path lives outside this repo", () => {
    const repo = makeRepo("tdd-elsewhere");
    writeFileSync(join(repo, "x"), "x");
    git("add .", repo);
    git('commit -m "init"', repo);
    const result = verifyTddRef(
      { path: "docs/tdds/auth.md", anchor: "x" },
      repo,
    );
    expect(result.status).toBe("unknown");
  });
});

describe("verifySidecars", () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it("reports each per-repo sidecar's presence at HEAD", () => {
    const repo = makeRepo("sidecars");
    mkdirSync(join(repo, "docs/tdds/auth"), { recursive: true });
    writeFileSync(join(repo, "docs/tdds/auth.md"), "# Auth\n");
    writeFileSync(
      join(repo, "docs/tdds/auth/platform.research.md"),
      "# platform\n",
    );
    git("add .", repo);
    git('commit -m "init"', repo);
    const sidecars = verifySidecars(
      { path: "docs/tdds/auth.md" },
      { platform: "abc1234", "missing-repo": "def5678" },
      repo,
    );
    const platform = sidecars.find((s) => s.repo === "platform");
    const missing = sidecars.find((s) => s.repo === "missing-repo");
    expect(platform.status).toBe("current");
    expect(missing.status).toBe("unknown");
  });
});

describe("driftCheck (full mode)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it("emits expanded report with patterns/files/tests/tddRef/sidecars", async () => {
    const repo = makeRepo("full-mode");
    mkdirSync(join(repo, "docs/tdds/auth"), { recursive: true });
    writeFileSync(
      join(repo, "docs/tdds/auth.md"),
      "# Auth TDD\n\n## Session Management\n\nDetails.\n",
    );
    writeFileSync(
      join(repo, "docs/tdds/auth/my-repo.research.md"),
      "# my-repo\n",
    );
    writeFileSync(
      join(repo, "auth.ts"),
      "export function requireSession() {}\nexport function helper() {}\n",
    );
    writeFileSync(join(repo, "src.ts"), "x\n");
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "tests/auth.test.ts"), "test()\n");
    git("add .", repo);
    git('commit -m "init"', repo);
    const baseline = git("rev-parse HEAD", repo);

    const description = `h2. TDD Reference
[Auth TDD|https://github.com/o/my-repo/blob/${baseline}/docs/tdds/auth.md#session-management]
Repo path: docs/tdds/auth.md#session-management

h2. Implementation Notes
Research baseline: my-repo@${baseline}

*Existing patterns to extend:*
* *Auth middleware* — \`requireSession\` in [auth.ts#L1-L1|https://github.com/o/my-repo/blob/${baseline}/auth.ts#L1-L1]

*Files likely to change:*
* \`src.ts\`

*Tests likely to extend:*
* \`tests/auth.test.ts\`

*Constraints:*
* none surfaced`;
    getIssue.mockResolvedValueOnce({ fields: { description } });

    const result = await driftCheck("X-FULL", { repoRoot: repo });
    expect(result.mode).toBe("full");
    expect(result.status).toBe("current");
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].symbolStatus).toBe("current");
    expect(result.filesLikelyToChange[0].pathStatus).toBe("current");
    expect(result.testsLikelyToExtend[0].pathStatus).toBe("current");
    expect(result.tddRef.status).toBe("current");
    expect(result.sidecars[0].status).toBe("current");
    expect(result.constraintsRaw).toContain("none surfaced");
  });

  it("flags drift when a pattern's symbol has been removed", async () => {
    const repo = makeRepo("symbol-drift");
    writeFileSync(join(repo, "auth.ts"), "// empty\n");
    git("add .", repo);
    git('commit -m "init"', repo);
    const baseline = git("rev-parse HEAD", repo);

    const description = `h2. Implementation Notes
Research baseline: my-repo@${baseline}

*Existing patterns to extend:*
* *Auth* — \`gone\` in [auth.ts#L1-L1|https://github.com/o/my-repo/blob/${baseline}/auth.ts#L1-L1]`;
    getIssue.mockResolvedValueOnce({ fields: { description } });

    const result = await driftCheck("X-SYM", { repoRoot: repo });
    expect(result.status).toBe("drifted");
    expect(result.patterns[0].symbolStatus).toBe("drifted");
    expect(result.patterns[0].symbolReason).toBe("symbol removed");
  });

  it("--lite mode preserves the legacy report shape", async () => {
    const repo = makeRepo("lite-mode");
    writeFileSync(join(repo, "f.txt"), "a\nb\n");
    git("add .", repo);
    git('commit -m "init"', repo);
    const baseline = git("rev-parse HEAD", repo);

    const description = `h2. Implementation Notes
Research baseline: my-repo@${baseline}
- [f.txt#L1-L2|https://github.com/o/my-repo/blob/${baseline}/f.txt#L1-L2]`;
    getIssue.mockResolvedValueOnce({ fields: { description } });

    const result = await driftCheck("X-LITE", { repoRoot: repo, lite: true });
    expect(result.mode).toBe("lite");
    expect(result.patterns).toBeUndefined();
    expect(result.filesLikelyToChange).toBeUndefined();
  });
});
