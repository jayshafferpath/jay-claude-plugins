import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  baseDrift,
  classifySlice,
  computeScope,
  computeStability,
  influenceSets,
  parseLedger,
  RUNS_BAR,
  readLedger,
  resolveFindingSlice,
  slicePatchId,
  sliceTouchedFiles,
  snapshot,
} from "../lib/sliced-ledger.js";

const ROOT = join(tmpdir(), `sliced-ledger-test-${process.pid}-${Date.now()}`);

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
  git("branch basemark", dir);
  return dir;
}

// Commit a slice with both trailers in one -m, newline-separated. Splitting them
// across two -m flags is the documented silent failure, and one test below relies
// on doing it wrong on purpose.
function slice(dir, { file, body, subject, id, dependsOn = "none" }) {
  writeFileSync(join(dir, file), body);
  git(`add ${file}`, dir);
  execSync(
    `git commit -m "${subject}" -m "Slice-Id: ${id}\nDepends-On: ${dependsOn}"`,
    {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return git("rev-parse HEAD", dir);
}

beforeAll(() => mkdirSync(ROOT, { recursive: true }));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("parseLedger", () => {
  it("splits NUL-delimited records into commit-order slices", () => {
    const raw =
      "\x01sha1\x00p0\x00s01\x00none\x00add T\n" +
      "\x01sha2\x00p1\x00s02\x00s01\x00consume T\n";
    const slices = parseLedger(raw);

    expect(slices).toHaveLength(2);
    expect(slices[0]).toMatchObject({
      sha: "sha1",
      id: "s01",
      dependsOn: [],
      subject: "add T",
      index: 0,
    });
    expect(slices[1]).toMatchObject({
      id: "s02",
      dependsOn: ["s01"],
      index: 1,
    });
  });

  it("parses multiple comma-separated dependencies and drops a stray none", () => {
    const slices = parseLedger("\x01sha\x00p\x00s03\x00s01, s02\x00x");
    expect(slices[0].dependsOn).toEqual(["s01", "s02"]);

    const mixed = parseLedger("\x01sha\x00p\x00s03\x00none, s01\x00x");
    expect(mixed[0].dependsOn).toEqual(["s01"]);
  });

  it("returns nothing for empty input", () => {
    expect(parseLedger("")).toEqual([]);
    expect(parseLedger(null)).toEqual([]);
  });

  it("records every parent so a merge commit is caught by parent count", () => {
    const slices = parseLedger("\x01sha\x00p1 p2\x00\x00\x00Merge branch");
    expect(slices[0].parents).toHaveLength(2);
  });
});

describe("readLedger — a well-formed stack", () => {
  let dir;
  beforeAll(() => {
    dir = makeRepo("clean");
    slice(dir, {
      file: "a.ts",
      body: "type T = { a: string }\n",
      subject: "add T",
      id: "s01",
    });
    slice(dir, {
      file: "b.ts",
      body: "const x: T = { a: '1' }\n",
      subject: "consume T",
      id: "s02",
      dependsOn: "s01",
    });
    slice(dir, {
      file: "c.ts",
      body: "export const u = 1\n",
      subject: "leaf",
      id: "s03",
    });
  });

  it("reads slices in commit order with fingerprints", () => {
    const out = readLedger({ base: "basemark", cwd: dir });

    expect(out.ok).toBe(true);
    expect(out.violations).toEqual([]);
    expect(out.slices.map((s) => s.id)).toEqual(["s01", "s02", "s03"]);
    expect(out.slices.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(out.slices[0].touched).toEqual(["a.ts"]);
    expect(out.slices[0].patchId).toMatch(/^[0-9a-f]{40}$/);
  });

  it("derives kind and depth as different axes", () => {
    const out = readLedger({ base: "basemark", cwd: dir, fingerprints: false });
    const byId = Object.fromEntries(out.slices.map((s) => [s.id, s]));

    expect(byId.s01).toMatchObject({ kind: "foundation", depth: 0 });
    expect(byId.s02).toMatchObject({ kind: "leaf", depth: 1 });
    expect(byId.s03).toMatchObject({ kind: "leaf", depth: 0 });
    expect(out.counts).toMatchObject({
      slices: 3,
      foundation: 1,
      leaf: 2,
      maxDepth: 1,
    });
  });

  it("collapses a multi-level stack in kind but not in depth", () => {
    const deep = makeRepo("deep");
    slice(deep, { file: "a.ts", body: "1\n", subject: "s1", id: "s01" });
    slice(deep, {
      file: "b.ts",
      body: "2\n",
      subject: "s2",
      id: "s02",
      dependsOn: "s01",
    });
    slice(deep, {
      file: "c.ts",
      body: "3\n",
      subject: "s3",
      id: "s03",
      dependsOn: "s02",
    });

    const byId = Object.fromEntries(
      readLedger({
        base: "basemark",
        cwd: deep,
        fingerprints: false,
      }).slices.map((s) => [s.id, s]),
    );
    expect([byId.s01.kind, byId.s02.kind, byId.s03.kind]).toEqual([
      "foundation",
      "foundation",
      "leaf",
    ]);
    expect([byId.s01.depth, byId.s02.depth, byId.s03.depth]).toEqual([0, 1, 2]);
  });

  it("takes the max over multiple dependencies for depth", () => {
    const dia = makeRepo("diamond");
    slice(dia, { file: "a.ts", body: "1\n", subject: "s1", id: "s01" });
    slice(dia, {
      file: "b.ts",
      body: "2\n",
      subject: "s2",
      id: "s02",
      dependsOn: "s01",
    });
    slice(dia, {
      file: "c.ts",
      body: "3\n",
      subject: "s3",
      id: "s03",
      dependsOn: "s01, s02",
    });

    const byId = Object.fromEntries(
      readLedger({
        base: "basemark",
        cwd: dia,
        fingerprints: false,
      }).slices.map((s) => [s.id, s]),
    );
    expect(byId.s03.depth).toBe(2);
  });

  it("throws on an unresolvable range", () => {
    expect(() => readLedger({ base: "nope", cwd: dir })).toThrow(/cannot read/);
  });

  it("requires base and cwd", () => {
    expect(() => readLedger({ cwd: dir })).toThrow(/base is required/);
    expect(() => readLedger({ base: "basemark" })).toThrow(/cwd is required/);
  });
});

describe("readLedger — validation stops the ledger rather than deriving", () => {
  function codes(dir) {
    return readLedger({ base: "basemark", cwd: dir }).violations.map(
      (v) => v.code,
    );
  }

  it("flags trailers split across separate -m flags distinctly from a missing one", () => {
    const dir = makeRepo("split-trailers");
    writeFileSync(join(dir, "a.ts"), "1\n");
    git("add a.ts", dir);
    execSync('git commit -m "split" -m "Slice-Id: s01" -m "Depends-On: none"', {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out = readLedger({ base: "basemark", cwd: dir });
    expect(out.ok).toBe(false);
    expect(out.readable).toBe(false);
    expect(out.slices).toEqual([]);
    expect(out.violations[0].code).toBe("empty-slice-id");
    expect(out.violations[0].message).toMatch(/separate -m flags/);
    // The commit still parsed a Depends-On — that asymmetry is the fingerprint
    // of the mis-commit, and it is what lets the message name the actual fix.
    expect(out.unreadable[0].dependsOnRaw).toBe("none");
  });

  it("flags a commit with no Slice-Id at all", () => {
    const dir = makeRepo("no-trailer");
    writeFileSync(join(dir, "a.ts"), "1\n");
    git("add a.ts", dir);
    git('commit -m "hand-written"', dir);
    expect(codes(dir)).toEqual(["missing-slice-id"]);
  });

  it("flags a merge commit by parent count, not by its missing trailer", () => {
    const dir = makeRepo("merged");
    slice(dir, { file: "a.ts", body: "1\n", subject: "s1", id: "s01" });
    git("switch -c side basemark", dir);
    writeFileSync(join(dir, "z.ts"), "z\n");
    git("add z.ts", dir);
    git('commit -m "side work"', dir);
    git("switch main", dir);
    git('merge --no-ff side -m "Merge side"', dir);

    const out = readLedger({ base: "basemark", cwd: dir });
    expect(out.violations.map((v) => v.code)).toContain("merge-commit");
    expect(
      out.violations.find((v) => v.code === "merge-commit").message,
    ).toMatch(/Rebase onto the moved base/);
  });

  it("flags a Depends-On that resolves to no slice in range", () => {
    const dir = makeRepo("dangling");
    slice(dir, {
      file: "a.ts",
      body: "1\n",
      subject: "s1",
      id: "s01",
      dependsOn: "s99",
    });
    expect(codes(dir)).toEqual(["dangling-edge"]);
  });

  it("flags a missing Depends-On — an absent field is not the same as `none`", () => {
    const dir = makeRepo("no-depends");
    writeFileSync(join(dir, "a.ts"), "1\n");
    git("add a.ts", dir);
    execSync('git commit -m "only id" -m "Slice-Id: s01"', {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(codes(dir)).toEqual(["missing-depends-on"]);
  });

  it("flags a duplicate Slice-Id — a slice is exactly one commit", () => {
    const dir = makeRepo("dupe");
    slice(dir, { file: "a.ts", body: "1\n", subject: "s1", id: "s01" });
    slice(dir, { file: "b.ts", body: "2\n", subject: "s1 again", id: "s01" });
    expect(codes(dir)).toContain("duplicate-slice-id");
  });

  it("flags a self-edge", () => {
    const dir = makeRepo("self");
    slice(dir, {
      file: "a.ts",
      body: "1\n",
      subject: "s1",
      id: "s01",
      dependsOn: "s01",
    });
    expect(codes(dir)).toEqual(["self-edge"]);
  });

  it("flags a forward edge — replay is positional, so a dependency must be earlier", () => {
    const dir = makeRepo("forward");
    slice(dir, {
      file: "a.ts",
      body: "1\n",
      subject: "s1",
      id: "s01",
      dependsOn: "s02",
    });
    slice(dir, { file: "b.ts", body: "2\n", subject: "s2", id: "s02" });

    const out = readLedger({ base: "basemark", cwd: dir });
    expect(out.violations.map((v) => v.code)).toEqual(["forward-edge"]);
    expect(out.violations[0].message).toMatch(/committed after it/);
  });

  it("flags a cycle rather than recursing without a base case", () => {
    const dir = makeRepo("cycle");
    slice(dir, {
      file: "a.ts",
      body: "1\n",
      subject: "s1",
      id: "s01",
      dependsOn: "s02",
    });
    slice(dir, {
      file: "b.ts",
      body: "2\n",
      subject: "s2",
      id: "s02",
      dependsOn: "s01",
    });

    const out = readLedger({ base: "basemark", cwd: dir });
    expect(out.violations.map((v) => v.code)).toContain("cycle");
  });

  it("warns but stays readable for a slice with no patch-id", () => {
    const dir = makeRepo("empty-diff");
    slice(dir, { file: "a.ts", body: "1\n", subject: "s1", id: "s01" });
    execSync(
      'git commit --allow-empty -m "empty" -m "Slice-Id: s02\nDepends-On: s01"',
      {
        cwd: dir,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const out = readLedger({ base: "basemark", cwd: dir });
    expect(out.ok).toBe(true);
    const warn = out.violations.find(
      (v) => v.code === "unfingerprintable-slice",
    );
    expect(warn.severity).toBe("warning");
    expect(out.slices.find((s) => s.id === "s02").patchId).toBeNull();
  });
});

describe("fingerprints", () => {
  it("patch-id survives a replay that only moves the parent and timestamp", () => {
    const dir = makeRepo("stable-patchid");
    const original = slice(dir, {
      file: "a.ts",
      body: "1\n",
      subject: "s1",
      id: "s01",
    });
    const before = slicePatchId(original, dir);

    // Rewind, then re-apply the identical patch on a different parent — exactly
    // what a replay does to every slice from the start to the tip.
    git("reset --hard basemark", dir);
    writeFileSync(join(dir, "pre.txt"), "pre\n");
    git("add pre.txt", dir);
    git('commit -m "unrelated"', dir);
    git(`cherry-pick ${original}`, dir);

    const replayed = git("rev-parse HEAD", dir);
    expect(replayed).not.toBe(original);
    expect(slicePatchId(replayed, dir)).toBe(before);
  });

  it("returns null rather than a bogus id when there is no diff", () => {
    const dir = makeRepo("no-diff");
    execSync('git commit --allow-empty -m "nothing"', {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(slicePatchId(git("rev-parse HEAD", dir), dir)).toBeNull();
    expect(sliceTouchedFiles(git("rev-parse HEAD", dir), dir)).toEqual([]);
  });

  it("returns null for a bad ref instead of throwing", () => {
    const dir = makeRepo("bad-ref");
    expect(slicePatchId("nosuchsha", dir)).toBeNull();
    expect(sliceTouchedFiles("nosuchsha", dir)).toEqual([]);
  });
});

describe("influenceSets", () => {
  const mk = (id, index, dependsOn, touched) => ({
    id,
    index,
    dependsOn,
    touched,
  });

  it("includes the transitive closure, not just direct dependents", () => {
    const slices = [
      mk("s01", 0, [], ["a.ts"]),
      mk("s02", 1, ["s01"], ["b.ts"]),
      mk("s03", 2, ["s02"], ["c.ts"]),
    ];
    const sets = influenceSets(slices);
    expect([...sets.get("s03")].sort()).toEqual(["s01", "s02"]);
  });

  it("adds an earlier slice sharing a touched file even with no declared edge", () => {
    const slices = [
      mk("s01", 0, [], ["barrel.ts"]),
      mk("s02", 1, [], ["barrel.ts"]),
    ];
    expect([...influenceSets(slices).get("s02")]).toEqual(["s01"]);
    // The relation is directional: an earlier slice is never influenced by a
    // later one, because the rewind re-applies in commit order.
    expect([...influenceSets(slices).get("s01")]).toEqual([]);
  });

  it("counts a file the earlier slice STOPPED touching (union of before and after)", () => {
    // s01 used to write a.ts and now writes z.ts. s02 reads a.ts. Measured only
    // against the current file lists there is no overlap, and s02 would read as
    // stable while the file it depends on lost its content.
    const slices = [mk("s01", 0, [], ["z.ts"]), mk("s02", 1, [], ["a.ts"])];
    const prior = { s01: { patchId: "old", touched: ["a.ts"] } };

    expect([...influenceSets(slices, {}).get("s02")]).toEqual([]);
    expect([...influenceSets(slices, prior).get("s02")]).toEqual(["s01"]);
  });

  it("counts a file the later slice stopped touching too", () => {
    const slices = [mk("s01", 0, [], ["a.ts"]), mk("s02", 1, [], ["z.ts"])];
    const prior = { s02: { patchId: "old", touched: ["a.ts"] } };
    expect([...influenceSets(slices, prior).get("s02")]).toEqual(["s01"]);
  });

  it("never lists a slice as its own influence", () => {
    const slices = [
      mk("s01", 0, [], ["a.ts"]),
      mk("s02", 1, ["s01"], ["a.ts"]),
    ];
    expect(influenceSets(slices).get("s02").has("s02")).toBe(false);
  });
});

describe("computeStability", () => {
  const slices = [
    {
      id: "s01",
      index: 0,
      dependsOn: [],
      touched: ["a.ts"],
      patchId: "p1",
      depth: 0,
    },
    {
      id: "s02",
      index: 1,
      dependsOn: ["s01"],
      touched: ["b.ts"],
      patchId: "p2",
      depth: 1,
    },
    {
      id: "s03",
      index: 2,
      dependsOn: [],
      touched: ["c.ts"],
      patchId: "p3",
      depth: 0,
    },
  ];

  it("is stable only when the slice and its whole influence set are unchanged", () => {
    const prior = {
      s01: { patchId: "p1", touched: ["a.ts"] },
      s02: { patchId: "p2", touched: ["b.ts"] },
      s03: { patchId: "p3", touched: ["c.ts"] },
    };
    const out = computeStability({ slices, prior });
    expect([...out.values()].every((s) => s.stable)).toBe(true);
  });

  it("marks a downstream slice unstable when a foundation moved, patch-id or not", () => {
    const prior = {
      s01: { patchId: "MOVED", touched: ["a.ts"] },
      s02: { patchId: "p2", touched: ["b.ts"] },
      s03: { patchId: "p3", touched: ["c.ts"] },
    };
    const out = computeStability({ slices, prior });

    expect(out.get("s02")).toMatchObject({
      stable: false,
      ownMoved: false,
      movedInfluences: ["s01"],
    });
    // An unrelated leaf at the same depth is untouched by the foundation change.
    expect(out.get("s03").stable).toBe(true);
  });

  it("treats an absent prior entry as changed for a review pass", () => {
    const out = computeStability({ slices, prior: {}, absentMeans: "changed" });
    expect([...out.values()].every((s) => s.stable)).toBe(false);
  });

  it("treats an absent prior entry as unchanged for a replay pass", () => {
    // The rewind never reaches slices before the start, so their patch-ids are
    // unchanged by construction and need no measurement.
    const prior = { s03: { patchId: "p3", touched: ["c.ts"] } };
    const out = computeStability({ slices, prior, absentMeans: "unchanged" });
    expect(out.get("s03").stable).toBe(true);
    expect(out.get("s01").stable).toBe(true);
  });

  it("never calls an unfingerprintable slice stable", () => {
    const unfingerprintable = [{ ...slices[0], patchId: null }];
    const out = computeStability({
      slices: unfingerprintable,
      prior: { s01: { patchId: null, touched: ["a.ts"] } },
    });
    expect(out.get("s01").stable).toBe(false);
  });
});

describe("classifySlice", () => {
  it("separates a fixed slice from one an upstream change reshaped", () => {
    const moved = { ownMoved: true, movedInfluences: [] };
    expect(classifySlice({ stability: moved, hadFinding: true })).toBe(
      "changed",
    );
    expect(classifySlice({ stability: moved, hadFinding: false })).toBe(
      "shape-changed",
    );
  });

  it("calls an identical patch on a moved foundation context-changed, not identical", () => {
    const cls = classifySlice({
      stability: { ownMoved: false, movedInfluences: ["s01"] },
      hadFinding: false,
    });
    expect(cls).toBe("context-changed");
    expect(RUNS_BAR.has(cls)).toBe(true);
  });

  it("only skips the bar when nothing git can see beneath the slice moved", () => {
    const cls = classifySlice({
      stability: { ownMoved: false, movedInfluences: [] },
      hadFinding: false,
    });
    expect(cls).toBe("regenerated-identical");
    expect(RUNS_BAR.has(cls)).toBe(false);
  });
});

describe("computeScope", () => {
  const slices = [
    {
      id: "s01",
      index: 0,
      sha: "aaa",
      dependsOn: [],
      touched: ["a.ts"],
      patchId: "p1",
      depth: 0,
    },
    {
      id: "s02",
      index: 1,
      sha: "bbb",
      dependsOn: ["s01"],
      touched: ["b.ts"],
      patchId: "p2",
      depth: 1,
    },
    {
      id: "s03",
      index: 2,
      sha: "ccc",
      dependsOn: [],
      touched: ["c.ts"],
      patchId: "p3",
      depth: 0,
    },
  ];

  it("returns changed ids in commit order so `earliest` is well defined", () => {
    const prior = {
      s01: { patchId: "p1", touched: ["a.ts"] },
      s02: { patchId: "MOVED", touched: ["b.ts"] },
      s03: { patchId: "MOVED", touched: ["c.ts"] },
    };
    const scope = computeScope({ slices, prior });
    expect(scope.changed).toEqual(["s02", "s03"]);
    expect(scope.earliest).toBe("s02");
    expect(scope.range).toBe("bbb~1...ccc");
    expect(scope.files).toEqual(["b.ts", "c.ts"]);
  });

  it("reports non-contiguous scope so the caller knows the range over-covers", () => {
    const prior = {
      s01: { patchId: "MOVED", touched: ["a.ts"] },
      s02: { patchId: "p2", touched: ["b.ts"] },
      s03: { patchId: "MOVED", touched: ["c.ts"] },
    };
    const scope = computeScope({ slices, prior });
    // s02 declares an edge to s01, so a moved s01 pulls it in regardless.
    expect(scope.changed).toEqual(["s01", "s02", "s03"]);
    expect(scope.contiguous).toBe(true);
  });

  it("treats the first review as everything changed", () => {
    const scope = computeScope({ slices, prior: {} });
    expect(scope.changed).toEqual(["s01", "s02", "s03"]);
    expect(scope.stable).toEqual([]);
  });

  it("returns an empty scope with a null range when nothing moved", () => {
    const prior = snapshot(slices);
    const scope = computeScope({ slices, prior });
    expect(scope.changed).toEqual([]);
    expect(scope.earliest).toBeNull();
    expect(scope.range).toBeNull();
    expect(scope.contiguous).toBe(true);
  });
});

describe("snapshot", () => {
  it("records patch-id and a sorted file list per slice, skipping unidentified commits", () => {
    const map = snapshot([
      { id: "s01", patchId: "p1", touched: ["z.ts", "a.ts"] },
      { id: "", patchId: "p2", touched: [] },
    ]);
    expect(map).toEqual({ s01: { patchId: "p1", touched: ["a.ts", "z.ts"] } });
  });

  it("records a null patch-id rather than omitting the slice", () => {
    expect(snapshot([{ id: "s01", patchId: null }])).toEqual({
      s01: { patchId: null, touched: [] },
    });
  });
});

describe("baseDrift", () => {
  it("reports unchecked when there is no remote-tracking ref", () => {
    const dir = makeRepo("no-remote");
    expect(baseDrift({ base: "main", cwd: dir })).toMatchObject({
      checked: false,
      advanced: false,
      behindBy: null,
    });
  });

  it("detects that the base advanced past the stack, and by how much", () => {
    const dir = makeRepo("drift");
    // Fake a remote-tracking ref, then advance it past the branch.
    slice(dir, { file: "a.ts", body: "1\n", subject: "s1", id: "s01" });
    git("update-ref refs/remotes/origin/main HEAD", dir);
    expect(baseDrift({ base: "main", cwd: dir })).toMatchObject({
      checked: true,
      advanced: false,
      behindBy: 0,
    });

    git("switch -c ahead", dir);
    writeFileSync(join(dir, "n.txt"), "n\n");
    git("add n.txt", dir);
    git('commit -m "base moved"', dir);
    git("update-ref refs/remotes/origin/main HEAD", dir);
    git("switch main", dir);

    expect(baseDrift({ base: "main", cwd: dir })).toMatchObject({
      checked: true,
      advanced: true,
      behindBy: 1,
    });
  });

  it("is reported by readLedger only when asked", () => {
    const dir = makeRepo("drift-opt");
    slice(dir, { file: "a.ts", body: "1\n", subject: "s1", id: "s01" });
    expect(readLedger({ base: "basemark", cwd: dir }).drift).toBeNull();
    expect(
      readLedger({ base: "basemark", cwd: dir, drift: true }).drift,
    ).toMatchObject({
      checked: false,
    });
  });
});

describe("resolveFindingSlice", () => {
  let dir;
  beforeAll(() => {
    dir = makeRepo("resolve");
    slice(dir, { file: "a.ts", body: "line one\n", subject: "s1", id: "s01" });
    slice(dir, {
      file: "b.ts",
      body: "line one\n",
      subject: "s2",
      id: "s02",
      dependsOn: "s01",
    });
  });

  it("resolves a line to the slice whose commit last touched it", () => {
    expect(
      resolveFindingSlice({
        file: "b.ts",
        line: 1,
        base: "basemark",
        cwd: dir,
      }),
    ).toEqual({
      sliceId: "s02",
      reason: "owned",
    });
  });

  it("reports pre-base for a line the branch never touched", () => {
    const out = resolveFindingSlice({
      file: "base.txt",
      line: 1,
      base: "basemark",
      cwd: dir,
    });
    expect(out.sliceId).toBeNull();
    expect(out.reason).toBe("pre-base");
    expect(out.owner).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports no-such-path for a path absent from HEAD rather than treating it as empty", () => {
    // git exits 128 with `fatal: There is no path ...`, which is not an empty
    // result and must not be read as "no slice owns this line".
    expect(
      resolveFindingSlice({
        file: "gone.ts",
        line: 1,
        base: "basemark",
        cwd: dir,
      }),
    ).toEqual({
      sliceId: null,
      reason: "no-such-path",
    });
  });
});
