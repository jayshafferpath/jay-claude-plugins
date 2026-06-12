#!/usr/bin/env node

import { ensureFeatureBranch, ensureWorkDir } from "../lib/work-dir.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: ensure-work-dir <TICKET_KEY> --repo-root <path> [--base <branch>]\n" +
      "                                   [--branch <name>] [--serial] [--no-fetch]\n" +
      "       ensure-work-dir --feature-branch <name> --container-base <branch>\n" +
      "                       --repo-root <path> [--unmerged-blockers a,b]\n" +
      "                       [--no-fetch]\n" +
      "\n" +
      "Outputs JSON: { workDir, branch, mode, created, fetched }\n" +
      "or: { action: 'exists' | 'created', base? }\n",
  );
  process.exit(1);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const fetchEnabled = !args.includes("--no-fetch");
const repoRoot = getFlag("--repo-root");

if (!repoRoot) {
  console.error("Error: --repo-root is required");
  process.exit(1);
}

const featureBranch = getFlag("--feature-branch");

try {
  if (featureBranch) {
    const blockersArg = getFlag("--unmerged-blockers");
    const unmergedBlockers = blockersArg
      ? blockersArg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const result = ensureFeatureBranch({
      featureBranch,
      containerBase: getFlag("--container-base"),
      unmergedBlockers,
      repoRoot,
      fetch: fetchEnabled,
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    const ticketKey = args[0];
    if (!ticketKey || ticketKey.startsWith("--")) {
      console.error("Error: TICKET_KEY is required as first positional arg");
      process.exit(1);
    }
    const result = ensureWorkDir({
      ticketKey: ticketKey.toUpperCase(),
      repoRoot,
      branch: getFlag("--branch"),
      baseBranch: getFlag("--base"),
      serial: args.includes("--serial"),
      fetch: fetchEnabled,
    });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
