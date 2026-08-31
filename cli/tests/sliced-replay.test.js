import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildCursor,
  classifyReplay,
  clearCursor,
  cursorPath,
  readCursor,
  reviewPath,
  selectReplayStart,
  slugify,
  worktreeState,
  writeCursor,
} from "../lib/sliced-replay.js";

const ROOT = join(tmpdir(), `sliced-replay-test-${process.pid}-${Date.now()}`);

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
  git("config core.hooksPath /dev/null", dir);
  writeFileSync(join(dir, "base.txt"), "0\n");
  git("add base.txt", dir);
  git('commit -m "base"', dir);
  return dir;
}

const SLICES = [
  {
    id: "s01",
    index: 0,
    sha: "aaaaaaa",
    dependsOn: [],
    touched: ["a.ts"],
    patchId: "p1",
    depth: 0,
    subject: "add T",
    kind: "foundation",
  },
  {
    id: "s02",
    index: 1,
    sha: "bbbbbbb",
    dependsOn: ["s01"],
    touched: ["b.ts"],
    patchId: "p2",
    depth: 1,
    subject: "consume T",
    kind: "leaf",
  },
  {
    id: "s03",
    index: 2,
    sha: "ccccccc",
    dependsOn: [],
    touched: ["c.ts"],
    patchId: "p3",
    depth: 0,
    subject: "leaf",
    kind: "leaf",
  },
];

beforeAll(() => mkdirSync(ROOT, { recursive: true }));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("slugify and paths", () => {
  it("collapses slashes and underscores so no path implies a missing directory", () => {
    // `.plans/replay-feature/foo` would name a directory nothing creates.
    expect(slugify("feature/foo_bar")).toBe("feature-foo-bar");
    expect(cursorPath(".plans", "feature/foo")).toBe(
      ".plans/replay-feature-foo",
    );
    expect(reviewPath(".plans", "feature/foo")).toBe(
      ".plans/review-feature-foo.md",
    );
  });

  it("tolerates an empty branch name", () => {
    expect(slugify(null)).toBe("");
  });
});

describe("selectReplayStart", () => {
  const open = (sliceId, extra = {}) => ({
    sliceId,
    file: "x.ts",
    line: 1,
    ...extra,
  });

  it("picks the earliest slice in COMMIT order, not the shallowest", () => {
    // s03 is depth 0 and s02 is depth 1, but s02 is the earlier commit. A rewind
    // is positional, so starting at the shallowest would leave s02's finding
    // permanently unreachable and re-pick the same start forever.
    const out = selectReplayStart({
      slices: SLICES,
      openFindings: [open("s03"), open("s02")],
      changed: [],
    });
    expect(out.start).toBe("s02");
    expect(out.startIndex).toBe(1);
    expect(out.parentSha).toBe("bbbbbbb~1");
  });

  it("includes out-of-scope findings — a real id can sit earlier than every in-scope one", () => {
    const out = selectReplayStart({
      slices: SLICES,
      openFindings: [open("s03"), open("s01")],
      changed: ["s03"],
    });
    expect(out.start).toBe("s01");
    expect(out.findingIds.sort()).toEqual(["s01", "s03"]);
  });

  it("spans every slice from the start to the tip, re-derived or not", () => {
    const out = selectReplayStart({
      slices: SLICES,
      openFindings: [open("s02")],
      changed: [],
    });
    expect(out.replaySpan).toEqual(["s02", "s03"]);
  });

  it("anchors an Unassigned finding to the earliest changed id", () => {
    const out = selectReplayStart({
      slices: SLICES,
      openFindings: [{ sliceId: null, file: "seam.ts", line: 3 }],
      changed: ["s02", "s03"],
    });
    expect(out.start).toBe("s02");
    expect(out.findingIds).toEqual(["s02"]);
  });

  it("skips changed ids that no longer resolve when anchoring", () => {
    const out = selectReplayStart({
      slices: SLICES,
      openFindings: [{ sliceId: null, file: "seam.ts", line: 3 }],
      changed: ["s99", "s03"],
    });
    expect(out.start).toBe("s03");
  });

  it("refuses when an Unassigned finding has no anchor at all", () => {
    const out = selectReplayStart({
      slices: SLICES,
      openFindings: [{ sliceId: null, file: "seam.ts", line: 3 }],
      changed: [],
    });
    expect(out.start).toBeNull();
    expect(out.violations[0].code).toBe("unanchored-unassigned");
  });

  it("refuses on a finding naming an id absent from the ledger rather than guessing", () => {
    const out = selectReplayStart({
      slices: SLICES,
      openFindings: [open("s99")],
      changed: [],
    });
    expect(out.start).toBeNull();
    expect(out.violations[0].code).toBe("stale-review");
    expect(out.violations[0].message).toMatch(/stale/);
  });

  it("refuses on a stale id even when another finding would have resolved", () => {
    const out = selectReplayStart({
      slices: SLICES,
      openFindings: [open("s01"), open("s99")],
      changed: [],
    });
    expect(out.start).toBeNull();
    expect(out.violations).toHaveLength(1);
  });

  it("returns no start when there are no open findings", () => {
    const out = selectReplayStart({
      slices: SLICES,
      openFindings: [],
      changed: [],
    });
    expect(out.start).toBeNull();
    expect(out.violations).toEqual([]);
  });
});

describe("buildCursor", () => {
  it("captures fingerprints only from the start onward", () => {
    // Slices before the start are unreachable by the rewind, so their patch-ids
    // are unchanged by construction and need no measurement.
    const cursor = buildCursor({
      branch: "feat",
      base: "main",
      slices: SLICES,
      start: "s02",
      startIndex: 1,
      parentSha: "bbbbbbb~1",
      findingIds: ["s02"],
      headBefore: "deadbeef",
    });

    expect(Object.keys(cursor.before)).toEqual(["s02", "s03"]);
    expect(cursor.before.s02).toMatchObject({
      sha: "bbbbbbb",
      patchId: "p2",
      touched: ["b.ts"],
    });
    expect(cursor).toMatchObject({
      version: 1,
      replayFrom: "s02",
      startIndex: 1,
      headBefore: "deadbeef",
      findingIds: ["s02"],
    });
    expect(cursor.started).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("records a null patch-id rather than omitting an unfingerprintable slice", () => {
    const cursor = buildCursor({
      branch: "f",
      base: "main",
      slices: [{ ...SLICES[0], patchId: null, touched: undefined }],
      start: "s01",
      startIndex: 0,
      parentSha: "aaaaaaa~1",
      headBefore: "x",
    });
    expect(cursor.before.s01).toMatchObject({ patchId: null, touched: [] });
  });
});

describe("cursor file I/O", () => {
  it("round-trips, and reports absence rather than throwing", () => {
    const dir = makeRepo("cursor-io");
    const path = join(dir, "replay-feat");

    expect(readCursor(path)).toBeNull();
    expect(clearCursor(path)).toBe(false);

    const cursor = buildCursor({
      branch: "feat",
      base: "main",
      slices: SLICES,
      start: "s01",
      startIndex: 0,
      parentSha: "aaaaaaa~1",
      headBefore: "deadbeef",
    });
    writeCursor(path, cursor);

    expect(readCursor(path)).toMatchObject({
      replayFrom: "s01",
      headBefore: "deadbeef",
    });
    expect(clearCursor(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("treats a corrupt or incomplete cursor as absent", () => {
    const dir = makeRepo("cursor-corrupt");
    const path = join(dir, "replay-bad");

    writeFileSync(path, "not json at all");
    expect(readCursor(path)).toBeNull();

    // A cursor with no replayFrom names no start, so it cannot drive a recovery.
    writeFileSync(path, JSON.stringify({ version: 1, headBefore: "x" }));
    expect(readCursor(path)).toBeNull();
  });
});

describe("worktreeState", () => {
  it("reports a clean tree", () => {
    const dir = makeRepo("wt-clean");
    expect(worktreeState(dir)).toMatchObject({
      clean: true,
      cherryPickInProgress: false,
      dirty: [],
      conflicted: [],
    });
  });

  it("reports uncommitted work, which the guard must never hard-reset over", () => {
    const dir = makeRepo("wt-dirty");
    writeFileSync(join(dir, "base.txt"), "changed\n");
    const state = worktreeState(dir);
    expect(state.clean).toBe(false);
    expect(state.dirty).toEqual(["base.txt"]);
  });

  it("separates a conflicted cherry-pick from ordinary dirt", () => {
    // The distinction is load-bearing: a conflicted cherry-pick reads as a dirty
    // tree, and telling the user to "commit or stash" would commit conflict
    // markers. The abort has to come first.
    const dir = makeRepo("wt-conflict");
    writeFileSync(join(dir, "f.txt"), "main\n");
    git("add f.txt", dir);
    git('commit -m "main writes f"', dir);

    git("switch -c side HEAD~1", dir);
    writeFileSync(join(dir, "f.txt"), "side\n");
    git("add f.txt", dir);
    git('commit -m "side writes f"', dir);
    const sideSha = git("rev-parse HEAD", dir);

    git("switch main", dir);
    try {
      git(`cherry-pick ${sideSha}`, dir);
    } catch {
      // expected: conflicting write to the same file
    }

    const state = worktreeState(dir);
    expect(state.cherryPickInProgress).toBe(true);
    expect(state.clean).toBe(false);
    expect(state.conflicted).toContain("f.txt");
  });
});

describe("classifyReplay", () => {
  const cursor = buildCursor({
    branch: "feat",
    base: "main",
    slices: SLICES,
    start: "s01",
    startIndex: 0,
    parentSha: "aaaaaaa~1",
    findingIds: ["s01"],
    headBefore: "deadbeef",
  });

  it("classifies a fixed foundation, an untouched-patch dependent, and an unrelated leaf", () => {
    // The middle row is the whole reason the influence set exists: s02's patch is
    // byte-identical after the replay, yet it was rebuilt on a changed foundation
    // and its verdict was never re-earned.
    const after = [
      { ...SLICES[0], patchId: "p1-NEW" },
      { ...SLICES[1] },
      { ...SLICES[2] },
    ];
    const classes = classifyReplay({ slices: after, cursor });

    expect(classes.map((c) => [c.id, c.class, c.runsBar])).toEqual([
      ["s01", "changed", true],
      ["s02", "context-changed", true],
      ["s03", "regenerated-identical", false],
    ]);
  });

  it("calls a slice shape-changed when its patch moved with no finding on it", () => {
    const after = [
      { ...SLICES[0] },
      { ...SLICES[1], patchId: "p2-NEW" },
      { ...SLICES[2] },
    ];
    const classes = classifyReplay({ slices: after, cursor });
    const s02 = classes.find((c) => c.id === "s02");
    expect(s02).toMatchObject({
      class: "shape-changed",
      hadFinding: false,
      runsBar: true,
    });
  });

  it("skips the bar only when the slice and its influence set are both unmoved", () => {
    const classes = classifyReplay({ slices: SLICES, cursor });
    expect(classes.filter((c) => !c.runsBar).map((c) => c.id)).toEqual([
      "s01",
      "s02",
      "s03",
    ]);
  });

  it("only classifies slices at or after the replay start", () => {
    const late = buildCursor({
      branch: "feat",
      base: "main",
      slices: SLICES,
      start: "s03",
      startIndex: 2,
      parentSha: "ccccccc~1",
      headBefore: "x",
    });
    expect(
      classifyReplay({ slices: SLICES, cursor: late }).map((c) => c.id),
    ).toEqual(["s03"]);
  });

  it("flags a slice the cursor never measured instead of classifying it against nothing", () => {
    const withExtra = [
      ...SLICES,
      {
        id: "s04",
        index: 3,
        sha: "ddd",
        dependsOn: [],
        touched: ["d.ts"],
        patchId: "p4",
        depth: 0,
      },
    ];
    const s04 = classifyReplay({ slices: withExtra, cursor }).find(
      (c) => c.id === "s04",
    );
    expect(s04.unmeasured).toBe(true);
  });

  it("flags a slice whose finding produced no change — it was cherry-picked, not re-derived", () => {
    // Nothing else catches this. A finding was routed to s01, yet its patch is
    // byte-identical, so the replay did not do the work it was invoked for. The
    // classification alone reads as an ordinary skip.
    const untouched = classifyReplay({ slices: SLICES, cursor });
    const s01 = untouched.find((c) => c.id === "s01");
    expect(s01).toMatchObject({
      hadFinding: true,
      class: "regenerated-identical",
      findingUnaddressed: true,
    });
  });

  it("does not flag a slice whose finding did produce a change", () => {
    const after = [{ ...SLICES[0], patchId: "p1-NEW" }, SLICES[1], SLICES[2]];
    const s01 = classifyReplay({ slices: after, cursor }).find(
      (c) => c.id === "s01",
    );
    expect(s01).toMatchObject({ class: "changed", findingUnaddressed: false });
  });

  it("does not flag a slice that never had a finding", () => {
    const classes = classifyReplay({ slices: SLICES, cursor });
    expect(classes.find((c) => c.id === "s02").findingUnaddressed).toBe(false);
  });

  it("requires a cursor", () => {
    expect(() => classifyReplay({ slices: SLICES, cursor: null })).toThrow(
      /cursor is required/,
    );
  });
});
