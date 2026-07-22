#!/usr/bin/env node

import { resolve } from "node:path";
import { postSummary } from "../lib/review-summary.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: post-review-summary <branch> [--plans-dir <path>] [--ticket-key <key>]",
  );
  process.exit(1);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const branch = args[0];
const plansDirArg = getFlag("--plans-dir") || ".claude/plans";
const ticketKey = getFlag("--ticket-key")?.toUpperCase();
const cwd = process.cwd();
const plansDir = resolve(cwd, plansDirArg);

const result = postSummary(branch, plansDir, ticketKey, cwd);
console.log(JSON.stringify(result, null, 2));

if (!result.posted) {
  process.exit(1);
}
