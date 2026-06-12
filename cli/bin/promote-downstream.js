#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { promoteDownstream } from "../lib/queue.js";

const args = process.argv.slice(2);

if (args.includes("--help")) {
  console.error(
    "Usage: promote-downstream [--repo-root <path>]\n" +
      "\n" +
      "Finds tickets that are now Done (assigned to current user, ClaudeWork) and\n" +
      "adds ClaudeReady to their unblocked downstream dependents. Detects stack\n" +
      "completion and reports containers ready for ClaudeStackComplete.\n" +
      "\n" +
      "Outputs JSON: { promoted, skipped, stackComplete }\n",
  );
  process.exit(0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

try {
  const result = await promoteDownstream({ repoRoot: getFlag("--repo-root") });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
