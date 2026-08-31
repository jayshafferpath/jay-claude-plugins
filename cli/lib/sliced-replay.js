// Replay mechanics for /build-sliced: where to rewind to, what survived the
// rewind unchanged, and the crash cursor that makes both recoverable.
//
// The replay is the part of the loop that rewrites history, so every decision it
// makes was previously an LLM reading a markdown table and holding a per-slice
// fingerprint snapshot in context across a `git reset --hard`. Two of those are
// not safe to leave in context at all:
//
//   - The "before" snapshot. It is captured before the rewind and consumed after
//     it, and if the run dies in between it is the only way to classify what
//     happened. It belongs in the cursor file, which is the one piece of durable
//     state outside git.
//   - The replay start. It is the *earliest* slice in commit order carrying an
//     open finding, and "earliest" is not what the review file is grouped by.
//     Group order is depth; rewind order is position. Picking by depth leaves an
//     earlier finding permanently unreachable and re-picks the same start forever.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { classifySlice, computeStability, RUNS_BAR } from "./sliced-ledger.js";

const CURSOR_VERSION = 1;

function gitOrNull(cmd, cwd, { trim = true } = {}) {
  try {
    const out = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return trim ? out.trim() : out;
  } catch {
    return null;
  }
}

// `SLUG` collapses `/` and `_` to `-`, the same convention as
// `pr-review-<branch>.md`. Without it a branch called `feature/foo` names a file
// inside a `.plans/replay-feature/` directory that nothing creates.
export function slugify(branch) {
  return String(branch || "").replace(/[/_]/g, "-");
}

export function cursorPath(plansDir, branch) {
  return `${plansDir}/replay-${slugify(branch)}`;
}

export function reviewPath(plansDir, branch) {
  return `${plansDir}/review-${slugify(branch)}.md`;
}

// Pick the replay start.
//
// Candidates come from three places, and all three must be considered together
// or the rewind lands too late:
//
//   - findings tagged with a slice in the ledger, in scope or out of it. An
//     out-of-scope finding carries a real id and can sit earlier than every
//     in-scope one, in which case it is the start.
//   - Unassigned findings, which resolved to no slice. They are anchored to the
//     earliest id in the previous review's changed set, because that set is the
//     only durable record of what had moved when the finding was written and it
//     cannot be recomputed later: by replay time no patch-id has moved since.
//   - a finding naming an id that is not in the ledger at all, which means the
//     review file is stale. That is a refusal, never a guess.
export function selectReplayStart({ slices, openFindings = [], changed = [] }) {
  const byId = new Map(slices.map((s) => [s.id, s]));
  const violations = [];
  const anchors = [];
  const findingIds = new Set();

  const anchorForUnassigned = changed.find((id) => byId.has(id)) || null;

  for (const finding of openFindings) {
    if (finding.sliceId) {
      const slice = byId.get(finding.sliceId);
      if (!slice) {
        violations.push({
          code: "stale-review",
          message:
            `open finding names ${finding.sliceId}, which is not in the ledger — ` +
            "the review file is stale. Re-run /review-slices rather than guessing a start.",
          sliceId: finding.sliceId,
        });
        continue;
      }
      anchors.push(slice);
      findingIds.add(slice.id);
      continue;
    }

    if (!anchorForUnassigned) {
      violations.push({
        code: "unanchored-unassigned",
        message:
          `Unassigned finding at ${finding.file}:${finding.line} has no anchor — ` +
          "the review file records no changed set that resolves against this ledger. " +
          "Re-run /review-slices.",
        file: finding.file,
        line: finding.line,
      });
      continue;
    }

    const slice = byId.get(anchorForUnassigned);
    anchors.push(slice);
    findingIds.add(slice.id);
  }

  if (violations.length > 0) {
    return { start: null, startIndex: null, findingIds: [], violations };
  }
  if (anchors.length === 0) {
    return { start: null, startIndex: null, findingIds: [], violations };
  }

  const start = anchors.reduce((a, b) => (a.index <= b.index ? a : b));
  return {
    start: start.id,
    startIndex: start.index,
    parentSha: `${start.sha}~1`,
    // Every slice from the start to the tip is re-applied, whether or not it is
    // re-derived, because the rewind is positional.
    replaySpan: slices.slice(start.index).map((s) => s.id),
    findingIds: [...findingIds],
    violations: [],
  };
}

// Everything the replay needs to survive its own `git reset --hard`, written
// before the first commit is rewritten and deleted only after the branch is
// force-pushed. If the file exists on the next run, the previous replay died
// mid-flight; the branch is a rebuildable cache and this file plus the ledger it
// names are the source of truth.
export function buildCursor({
  branch,
  base,
  slices,
  start,
  startIndex,
  parentSha,
  findingIds = [],
  headBefore,
  started = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
}) {
  const before = {};
  for (const slice of slices) {
    if (slice.index < startIndex) continue;
    before[slice.id] = {
      sha: slice.sha,
      patchId: slice.patchId ?? null,
      touched: [...(slice.touched || [])].sort(),
      subject: slice.subject,
    };
  }

  return {
    version: CURSOR_VERSION,
    branch,
    base,
    replayFrom: start,
    startIndex,
    parentSha,
    headBefore,
    started,
    findingIds,
    before,
  };
}

export function writeCursor(path, cursor) {
  writeFileSync(path, `${JSON.stringify(cursor, null, 2)}\n`, "utf-8");
  return path;
}

export function readCursor(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed?.replayFrom ? parsed : null;
  } catch {
    return null;
  }
}

export function clearCursor(path) {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

// Read-only probe of the worktree, for the guard that runs *before* crash
// recovery's own hard reset.
//
// Order matters at the call site and it is not the intuitive one: a conflicted
// cherry-pick leaves paths staged `AA`/`UU`, so a dirty-tree check that runs
// first tells the user to commit or stash — advice that would commit conflict
// markers. `cherryPickInProgress` has to be cleared first, and only what remains
// dirty afterwards is real work at risk.
export function worktreeState(cwd) {
  // Deliberately untrimmed: porcelain status puts the two-column XY code at the
  // start of every line, and an unstaged modification leads with a space. Trimming
  // shifts the first record left and silently truncates its path.
  const status = gitOrNull("git status --porcelain", cwd, { trim: false });
  const cherryPick =
    gitOrNull("git rev-parse --verify -q CHERRY_PICK_HEAD", cwd) !== null;
  const revert =
    gitOrNull("git rev-parse --verify -q REVERT_HEAD", cwd) !== null;

  const entries = (status || "")
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => ({ xy: line.slice(0, 2), path: line.slice(3).trim() }));

  return {
    clean: entries.length === 0,
    cherryPickInProgress: cherryPick,
    revertInProgress: revert,
    conflicted: entries
      .filter((e) => /[U]/.test(e.xy) || e.xy === "AA" || e.xy === "DD")
      .map((e) => e.path),
    dirty: entries.map((e) => e.path),
  };
}

// Classify every slice the replay touched, against the fingerprints the cursor
// captured before the rewind.
//
// `absentMeans: "unchanged"` is the correct reading here and differs from the
// review pass on purpose: the cursor only holds slices at or after the start, and
// the rewind does not reach anything earlier, so an influence-set member that
// predates the start contributes "unchanged" without needing to be measured.
//
// Only `regenerated-identical` skips the bar. A clean cherry-pick is not a green
// light: it preserves the patch, not the tree, and a patch that reads identically
// against a moved foundation is exactly the case that compiled yesterday and
// fails today.
export function classifyReplay({ slices, cursor }) {
  if (!cursor) throw new Error("classifyReplay: cursor is required");

  const before = cursor.before || {};
  const prior = {};
  for (const [id, entry] of Object.entries(before)) {
    prior[id] = { patchId: entry.patchId, touched: entry.touched };
  }

  const findingIds = new Set(cursor.findingIds || []);
  const stability = computeStability({
    slices,
    prior,
    absentMeans: "unchanged",
  });

  const replayed = slices.filter((s) => s.index >= (cursor.startIndex ?? 0));

  return replayed.map((slice) => {
    const entry = stability.get(slice.id);
    const hadFinding = findingIds.has(slice.id);
    const cls = classifySlice({ stability: entry, hadFinding });
    return {
      id: slice.id,
      depth: slice.depth ?? 0,
      kind: slice.kind ?? null,
      class: cls,
      runsBar: RUNS_BAR.has(cls),
      hadFinding,
      movedInfluences: entry.movedInfluences,
      // A finding was routed to this slice and its patch did not move, so the
      // replay produced no change where one was required — the slice was
      // cherry-picked when it should have been re-derived. Nothing else catches
      // this: the classification alone reads as an ordinary skip.
      findingUnaddressed: hadFinding && !entry.ownMoved,
      // A slice present in the ledger but absent from the cursor was added after
      // the replay began, which should not happen — surface it rather than
      // silently classifying it against nothing.
      unmeasured: !before[slice.id],
    };
  });
}
