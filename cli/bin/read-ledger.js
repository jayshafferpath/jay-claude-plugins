#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { readLedger } from "../lib/sliced-ledger.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: read-ledger --base <branch> [--head <ref>] [--cwd <path>]\n" +
      "                   [--no-fingerprints] [--drift]\n" +
      "\n" +
      "Read the Slice-Id / Depends-On commit trailers in <base>..<head>,\n" +
      "validate the ledger, and derive everything keyed on it. Replaces the\n" +
      "`git log --format=%(trailers:...)` incantation that /build-sliced and\n" +
      "/review-slices each carried in prose, along with the kind, depth,\n" +
      "closure and patch-id derivations layered on top.\n" +
      "\n" +
      "Validation is fatal by design — each of these makes every downstream\n" +
      "decision plausible-looking and wrong rather than failing:\n" +
      "  merge-commit, empty-slice-id, missing-slice-id, duplicate-slice-id,\n" +
      "  missing-depends-on, self-edge, dangling-edge, forward-edge, cycle\n" +
      "\n" +
      "With --drift, also reports how far origin/<base> has advanced past the\n" +
      "stack. Reads existing refs only; fetch first if you want it fresh.\n" +
      "\n" +
      "Output: { ok, readable, base, head, counts, slices[], violations[], drift }\n" +
      "Each slice: { id, sha, index, subject, dependsOn[], kind, depth,\n" +
      "              patchId, touched[] }\n" +
      "\n" +
      "Exit 0 clean, 2 when the ledger is unreadable, 1 on usage or git error.\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const base = getFlag("--base");
const head = getFlag("--head") || "HEAD";
const cwd = getFlag("--cwd") || process.cwd();

if (!base) {
  console.error("Missing required flag --base. Run with --help for usage.");
  process.exit(1);
}

try {
  const result = readLedger({
    base,
    head,
    cwd,
    fingerprints: !args.includes("--no-fingerprints"),
    drift: args.includes("--drift"),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
} catch (err) {
  console.error(`read-ledger: ${err.message}`);
  process.exit(1);
}
