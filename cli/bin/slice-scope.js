#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

import { loadEnv } from "../lib/env.js";

loadEnv();

import { computeScope, readLedger, snapshot } from "../lib/sliced-ledger.js";
import { parseReviewFile } from "../lib/sliced-review.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: slice-scope --base <branch> [--head <ref>] [--review <file>]\n" +
      "                   [--cwd <path>]\n" +
      "\n" +
      "Compute /review-slices' scope: every slice that is not `stable` — its own\n" +
      "patch-id moved, or a patch-id in its influence set did. The influence set\n" +
      "is the transitive Depends-On closure plus any earlier slice sharing a\n" +
      "touched file, where 'sharing' is measured over the union of each slice's\n" +
      "before and after file lists (a slice that stops touching a file is as\n" +
      "dangerous as one that starts).\n" +
      "\n" +
      "--review supplies the previous run's record. Absent or unparseable, every\n" +
      "slice is changed, which is the correct reading of a first review.\n" +
      "\n" +
      "Output: { ok, changed[], stable[], earliest, range, contiguous, files[],\n" +
      "          slicemap, detail[], violations[] }\n" +
      "`changed` is in commit order — the build loop needs its first element as a\n" +
      "replay anchor, so the order is part of the contract.\n" +
      "\n" +
      "Exit 0 clean, 2 when the ledger is unreadable, 1 on usage or git error.\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const base = getFlag("--base");
const head = getFlag("--head") || "HEAD";
const cwd = getFlag("--cwd") || process.cwd();
const reviewFile = getFlag("--review");

if (!base) {
  console.error("Missing required flag --base. Run with --help for usage.");
  process.exit(1);
}

try {
  const ledger = readLedger({ base, head, cwd, fingerprints: true });
  if (!ledger.ok) {
    console.log(
      JSON.stringify(
        { ok: false, violations: ledger.violations, changed: [], stable: [] },
        null,
        2,
      ),
    );
    process.exit(2);
  }

  let prior = {};
  let priorFound = false;
  if (reviewFile && existsSync(reviewFile)) {
    const parsed = parseReviewFile(readFileSync(reviewFile, "utf-8"));
    if (parsed.state?.slicemap) {
      prior = parsed.state.slicemap;
      priorFound = true;
    }
  }

  const scope = computeScope({ slices: ledger.slices, prior });

  console.log(
    JSON.stringify(
      {
        ok: true,
        base,
        head,
        priorFound,
        firstReview: !priorFound,
        ...scope,
        slicemap: snapshot(ledger.slices),
        violations: ledger.violations,
      },
      null,
      2,
    ),
  );
  process.exit(0);
} catch (err) {
  console.error(`slice-scope: ${err.message}`);
  process.exit(1);
}
