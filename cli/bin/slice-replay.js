#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { loadEnv } from "../lib/env.js";

loadEnv();

import { readLedger } from "../lib/sliced-ledger.js";
import {
  buildCursor,
  classifyReplay,
  clearCursor,
  cursorPath,
  readCursor,
  reviewPath,
  selectReplayStart,
  worktreeState,
  writeCursor,
} from "../lib/sliced-replay.js";
import { openFindings, parseReviewFile } from "../lib/sliced-review.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: slice-replay <plan|classify|recover|clear> --base <branch>\n" +
      "                    [--branch <name>] [--plans-dir <path>] [--review <file>]\n" +
      "                    [--cwd <path>]\n" +
      "\n" +
      "  plan      Pick the replay start from the review file's open findings and\n" +
      "            write the crash cursor. The start is the earliest slice in\n" +
      "            COMMIT order, not depth order: the rewind is positional, so a\n" +
      "            later start leaves earlier findings permanently unreachable and\n" +
      "            re-picks the same start on every future run. Out-of-scope\n" +
      "            findings carry real ids and are included; Unassigned findings\n" +
      "            anchor to the earliest id in the review's changed set.\n" +
      "            Run this BEFORE the rewind — the cursor holds the pre-rewind\n" +
      "            fingerprints that nothing else can reconstruct afterwards.\n" +
      "\n" +
      "  classify  After the replay, classify every slice from the start to the tip\n" +
      "            against the cursor's fingerprints: changed, shape-changed,\n" +
      "            context-changed, regenerated-identical. Only the last skips the\n" +
      "            bar.\n" +
      "\n" +
      "  recover   Report a surviving cursor plus the worktree state its guard\n" +
      "            needs, without touching anything. Clear cherryPickInProgress\n" +
      "            before judging `clean` — a conflicted cherry-pick reads as a\n" +
      "            dirty tree, and 'commit or stash' would commit the markers.\n" +
      "\n" +
      "  clear     Delete the cursor. Only after the replay has force-pushed.\n" +
      "\n" +
      "Exit 0 clean, 2 on an unreadable ledger / stale review / no cursor,\n" +
      "1 on usage or git error.\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const mode = args[0];
const base = getFlag("--base");
const cwd = getFlag("--cwd") || process.cwd();
const plansDir = getFlag("--plans-dir") || ".plans";

if (!["plan", "classify", "recover", "clear"].includes(mode)) {
  console.error(`Unknown mode "${mode}". Run with --help for usage.`);
  process.exit(1);
}

function git(cmd) {
  return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
}

function resolveBranch() {
  const explicit = getFlag("--branch");
  if (explicit) return explicit;
  try {
    return git("git branch --show-current") || null;
  } catch {
    return null;
  }
}

function emit(payload, code = 0) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(code);
}

const branch = resolveBranch();
if (!branch) {
  console.error("Could not resolve a branch. Pass --branch.");
  process.exit(1);
}

const cursorFile = cursorPath(plansDir, branch);

try {
  if (mode === "clear") {
    emit({ ok: true, cursor: cursorFile, cleared: clearCursor(cursorFile) });
  } else if (mode === "recover") {
    const cursor = readCursor(cursorFile);
    emit(
      {
        ok: Boolean(cursor),
        cursor: cursorFile,
        found: Boolean(cursor),
        replayFrom: cursor?.replayFrom ?? null,
        headBefore: cursor?.headBefore ?? null,
        startIndex: cursor?.startIndex ?? null,
        started: cursor?.started ?? null,
        worktree: worktreeState(cwd),
      },
      cursor ? 0 : 2,
    );
  }

  if (!base) {
    console.error("Missing required flag --base. Run with --help for usage.");
    process.exit(1);
  }

  const ledger = readLedger({ base, head: branch, cwd, fingerprints: true });
  if (!ledger.ok) {
    emit(
      { ok: false, reason: "unreadable-ledger", violations: ledger.violations },
      2,
    );
  }

  if (mode === "classify") {
    const cursor = readCursor(cursorFile);
    if (!cursor)
      emit({ ok: false, reason: "no-cursor", cursor: cursorFile }, 2);

    const classes = classifyReplay({ slices: ledger.slices, cursor });
    emit({
      ok: true,
      replayFrom: cursor.replayFrom,
      slices: classes,
      barSkipped: classes.filter((c) => !c.runsBar).map((c) => c.id),
      // A replay that produced no change on a slice a finding was routed to did
      // not do the work it was invoked for. Report it rather than letting the
      // classification read as an ordinary skip.
      findingsUnaddressed: classes
        .filter((c) => c.findingUnaddressed)
        .map((c) => c.id),
      unmeasured: classes.filter((c) => c.unmeasured).map((c) => c.id),
      counts: classes.reduce((acc, c) => {
        acc[c.class] = (acc[c.class] || 0) + 1;
        return acc;
      }, {}),
    });
  }

  const reviewFile = getFlag("--review") || reviewPath(plansDir, branch);
  if (!existsSync(reviewFile)) {
    emit({ ok: false, reason: "no-review-file", reviewFile }, 2);
  }

  const parsed = parseReviewFile(readFileSync(reviewFile, "utf-8"));
  const open = openFindings(parsed.findings);
  if (open.length === 0) {
    emit({ ok: true, settled: true, start: null, reviewFile, open: 0 });
  }

  const selection = selectReplayStart({
    slices: ledger.slices,
    openFindings: open,
    changed: parsed.state?.changed || [],
  });

  if (selection.violations.length > 0) {
    emit(
      {
        ok: false,
        reason: "stale-review",
        violations: selection.violations,
        reviewFile,
      },
      2,
    );
  }

  const cursor = buildCursor({
    branch,
    base,
    slices: ledger.slices,
    start: selection.start,
    startIndex: selection.startIndex,
    parentSha: selection.parentSha,
    findingIds: selection.findingIds,
    headBefore: git("git rev-parse HEAD"),
  });
  writeCursor(cursorFile, cursor);

  emit({
    ok: true,
    settled: false,
    reviewFile,
    cursor: cursorFile,
    start: cursor.replayFrom,
    startIndex: cursor.startIndex,
    parentSha: cursor.parentSha,
    headBefore: cursor.headBefore,
    replaySpan: selection.replaySpan,
    findingIds: selection.findingIds,
    open: open.length,
  });
} catch (err) {
  console.error(`slice-replay: ${err.message}`);
  process.exit(1);
}
