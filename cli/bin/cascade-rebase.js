#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { cascadeRebase } from "../lib/cascade-rebase.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: cascade-rebase --repo-root <path> --origin <originBranch> --new-root <newRoot> --downstreams <ticket:branch,ticket:branch,...> [--no-push]\n" +
      "\n" +
      "Cascade-rebase a chain of stacked branches after their original base has merged or moved.\n" +
      "\n" +
      "Outputs JSON: { results: [{ ticket, branch, status, ... }] } where status ∈\n" +
      '  "rebased" | "pushed-failed" | "conflict" | "not-attempted" | "skipped".\n' +
      "Exit code is non-zero only if a conflict occurred (so callers can branch on it).",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const repoRoot = getFlag("--repo-root");
const originBranch = getFlag("--origin");
const newRoot = getFlag("--new-root");
const downstreamsArg = getFlag("--downstreams");
const noPush = args.includes("--no-push");

if (!repoRoot || !originBranch || !newRoot || !downstreamsArg) {
  console.error("Missing required flag. Run with --help for usage.");
  process.exit(1);
}

const downstreams = downstreamsArg
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [ticket, branch] = entry.split(":");
    return { ticket, branch: branch || null };
  });

if (downstreams.length === 0) {
  console.log(JSON.stringify({ results: [] }));
  process.exit(0);
}

try {
  const out = cascadeRebase({
    repoRoot,
    originBranch,
    newRoot,
    downstreams,
    pushAfterRebase: !noPush,
  });
  console.log(JSON.stringify(out));
  const hadConflict = out.results.some((r) => r.status === "conflict");
  process.exit(hadConflict ? 2 : 0);
} catch (err) {
  console.error(`cascade-rebase: ${err.message}`);
  process.exit(1);
}
