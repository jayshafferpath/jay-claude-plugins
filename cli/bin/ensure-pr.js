#!/usr/bin/env node

import { join } from "node:path";
import { ensurePr } from "../lib/pr.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: ensure-pr <branch> --base <target> [--title <title>] [--body-file <path>] [--draft] [--force-push]",
  );
  process.exit(1);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const branch = args[0];
const base = getFlag("--base");
const title = getFlag("--title");
const bodyFileArg = getFlag("--body-file");
const draft = args.includes("--draft");
const forcePush = args.includes("--force-push");
const cwd = process.cwd();

if (!base) {
  console.error("Error: --base <target> is required");
  process.exit(1);
}

const bodyFile = bodyFileArg ? join(cwd, bodyFileArg) : undefined;

const result = ensurePr({
  branch,
  base,
  title,
  bodyFile,
  draft,
  forcePush,
  cwd,
});
console.log(JSON.stringify(result, null, 2));

if (result.action === "push_failed" || result.action === "create_failed") {
  process.exit(1);
}
