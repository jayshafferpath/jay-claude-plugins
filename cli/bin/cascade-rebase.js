#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { cascadeRebase } from "../lib/cascade-rebase.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: cascade-rebase --repo-root <path> --origin <originBranch> --new-root <newRoot> --downstreams <ticket:branch,ticket:branch,...> [--no-push]\n" +
      "                     [--activity-note <text>] [--retarget-first-pr <newBase>]\n" +
      "\n" +
      "Cascade-rebase a chain of stacked branches after their original base has merged or moved.\n" +
      "\n" +
      "Side effects (opt-in):\n" +
      "  --activity-note <text>          For every rebased / pushed-failed entry, append\n" +
      "                                  a 'Branch rebased' activity-log entry to its Jira\n" +
      "                                  ticket. <text> is appended to the standard body so\n" +
      "                                  callers can identify the trigger (e.g. 'cleanup\n" +
      "                                  cascade after FOO-123 merged to main').\n" +
      "  --retarget-first-pr <newBase>   Retarget the head-of-chain ticket's open PR base\n" +
      "                                  to <newBase> via `gh pr edit`. Skipped when no PR\n" +
      "                                  is open. Failures fold into the result entry as\n" +
      "                                  pr_retarget_warning rather than failing the run.\n" +
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
const activityNote = getFlag("--activity-note");
const retargetFirstPrBase = getFlag("--retarget-first-pr");

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
  const out = await cascadeRebase({
    repoRoot,
    originBranch,
    newRoot,
    downstreams,
    pushAfterRebase: !noPush,
    activityLog: activityNote ? { note: activityNote } : null,
    retargetFirstPr: retargetFirstPrBase
      ? { newBase: retargetFirstPrBase }
      : null,
  });
  console.log(JSON.stringify(out));
  const hadConflict = out.results.some((r) => r.status === "conflict");
  process.exit(hadConflict ? 2 : 0);
} catch (err) {
  console.error(`cascade-rebase: ${err.message}`);
  process.exit(1);
}
