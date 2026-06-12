#!/usr/bin/env node

import { prState } from "../lib/pr.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: pr-state <branch> [--base <target>] [--state open|closed|merged|all]\n" +
      "                 [--cwd <path>]\n" +
      "\n" +
      "Probe `gh pr list` for the most recent PR matching the filters and emit\n" +
      "a normalized JSON object. Default state is 'all'.\n" +
      "\n" +
      "Output: { number, url, state, title, headRefName, baseRefName, mergeCommit, mergedAt }\n" +
      "        or 'null' (literal) when no PR matches.\n",
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
const state = getFlag("--state") || "all";
const cwd = getFlag("--cwd") || process.cwd();

const result = prState(branch, { base, state, cwd });
console.log(JSON.stringify(result, null, 2));
