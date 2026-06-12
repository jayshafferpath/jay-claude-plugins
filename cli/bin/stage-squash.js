#!/usr/bin/env node

import { stageSquash } from "../lib/stage-squash.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: stage-squash <TICKET_KEY> --label <text> [--base <branch>]\n" +
      "                    [--branch <name>] [--cwd <path>] [--no-push]\n" +
      "                    [--stage-start-sha <sha>]\n" +
      "\n" +
      "Squashes every commit between STAGE_START_SHA and HEAD into a single\n" +
      "[{KEY}] {label} commit, then force-with-lease pushes (unless --no-push).\n" +
      "\n" +
      "STAGE_START_SHA is derived automatically from the most recent [{KEY}]\n" +
      "commit in git log, falling back to the merge-base with origin/<base>.\n" +
      "Override with --stage-start-sha when resuming an unusual flow.\n" +
      "\n" +
      "Outputs JSON: { action, label, sha?, pushed, branch? }\n" +
      "  action ∈ 'squashed' | 'noop' | 'push-failed'\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const ticketKey = args[0]?.toUpperCase();
const label = getFlag("--label");
const baseBranch = getFlag("--base");
const branch = getFlag("--branch");
const cwd = getFlag("--cwd") || process.cwd();
const stageStartSha = getFlag("--stage-start-sha");
const noPush = args.includes("--no-push");

if (!ticketKey || !label) {
  console.error("Error: TICKET_KEY and --label are required");
  process.exit(1);
}

try {
  const result = stageSquash({
    ticketKey,
    branch,
    label,
    baseBranch,
    cwd,
    stageStartSha,
    push: !noPush,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.action === "push-failed") process.exit(2);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
