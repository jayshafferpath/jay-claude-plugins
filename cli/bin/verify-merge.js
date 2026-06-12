#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { verifyMerge } from "../lib/verify-merge.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: verify-merge <branch> --base <target> [--cwd <path>] [--strict]\n" +
      "\n" +
      "Probe whether <branch> was merged via PR into <target> AND whether the\n" +
      "merge commit is reachable from origin/<target>. Replaces the\n" +
      "pr-state --state merged + git merge-base --is-ancestor pair that\n" +
      "/cleanup and /promote-to-main re-implement in prose.\n" +
      "\n" +
      "With --strict, populates `refusalReason` whenever the merge cannot be\n" +
      "fully verified (no merged PR, missing merge SHA, or SHA not an\n" +
      "ancestor of origin/<target>). Callers can `if (out.refusalReason)`\n" +
      "instead of re-deriving the conditions.\n" +
      "\n" +
      "Output: { merged, prNumber, prUrl, prState, mergeSha, ancestorOfTarget, refusalReason }\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const branch = args[0];
const base = getFlag("--base");
const cwd = getFlag("--cwd") || process.cwd();
const strict = args.includes("--strict");

if (!base) {
  console.error("Missing required flag --base. Run with --help for usage.");
  process.exit(1);
}

try {
  const result = verifyMerge({ branch, base, cwd, strict });
  console.log(JSON.stringify(result, null, 2));
  process.exit(strict && result.refusalReason ? 2 : 0);
} catch (err) {
  console.error(`verify-merge: ${err.message}`);
  process.exit(1);
}
