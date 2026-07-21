#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import {
  parseDownstreams,
  refreshFeatureBranch,
} from "../lib/feature-refresh.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: cleanup-feature-refresh \\\n" +
      "         --repo-root <path> \\\n" +
      "         --feature-branch <name> \\\n" +
      "         --merge-target <name> \\\n" +
      "         --downstreams <ticket:branch:status[:summary[:mergeSha]],...> \\\n" +
      "         [--cascade-status <status>] [--no-skip-on-cascade-conflict]\n" +
      "\n" +
      "Refresh a long-lived feature branch after a downstream cascade-rebase.\n" +
      "Implements /cleanup Step 8 (orphan check, dirty-worktree check, reset to\n" +
      "origin/{mergeTarget}, replay --no-ff merges or cherry-picks, force-push).\n" +
      "\n" +
      "--downstreams entries are colon-separated tuples:\n" +
      "  ticket:branch:status\n" +
      "  ticket:branch:status:summary\n" +
      "  ticket:branch:status:summary:mergeSha\n" +
      "\n" +
      "Use an empty branch field (e.g. 'NEV-1010::rebased::bfc799d2') when the\n" +
      "branch was deleted by a prior terminal cleanup but the squash mergeSha is\n" +
      "still available for cherry-pick replay. status ∈ rebased|pushed-failed|\n" +
      "conflict|skipped|not-attempted. Only 'rebased' and 'pushed-failed' get\n" +
      "replayed.\n" +
      "\n" +
      "--cascade-status <status>: pass the prior cascade-rebase verdict so the\n" +
      "refresh can refuse to run on top of a partial cascade. Values:\n" +
      "  conflict — skip refresh entirely (default behavior unless\n" +
      "             --no-skip-on-cascade-conflict).\n" +
      "  rebased / pushed-failed / completed / etc. — proceed.\n" +
      "\n" +
      "Output: JSON { outcome, oldSha, remerged, orphans?, missingRefs?,\n" +
      "               orphanCheckError?, unresolvable?, unrecoverableCommits?,\n" +
      "               dirtyWorktrees?, conflictBranch?, conflictTicket?,\n" +
      "               conflictFiles?, conflictVia?, pushError? }.\n" +
      "Exit code 0 on outcome=refreshed; 2 on any skipped-* or\n" +
      "partial-merge-conflict / pushed-failed.\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const repoRoot = getFlag("--repo-root");
const featureBranch = getFlag("--feature-branch");
const mergeTarget = getFlag("--merge-target");
const downstreamsArg = getFlag("--downstreams");
const cascadeStatus = getFlag("--cascade-status") || null;
const skipOnConflict = !args.includes("--no-skip-on-cascade-conflict");

if (!repoRoot || !featureBranch || !mergeTarget) {
  console.error("Missing required flag. Run with --help for usage.");
  process.exit(1);
}

const downstreams = parseDownstreams(downstreamsArg);

try {
  const out = refreshFeatureBranch({
    repoRoot,
    featureBranch,
    mergeTarget,
    downstreams,
    skipOnConflict,
    cascadeStatus,
  });
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.outcome === "refreshed" ? 0 : 2);
} catch (err) {
  console.error(`cleanup-feature-refresh: ${err.message}`);
  process.exit(1);
}
