#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { loadEnv } from "../lib/env.js";

loadEnv();

import { readActivityLog } from "../lib/checklist.js";
import {
  countCommitsBehind,
  getBranchLastCommitAt,
  getOpenPrActivityMap,
} from "../lib/git.js";
import { DEFAULT_THRESHOLDS, detectStagnation } from "../lib/stagnation.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: detect-stagnation --stacks-file <path> [--repo-root <path>]\n" +
      "                        [--in-flight-hours N] [--failed-days N]\n" +
      "                        [--pr-days N] [--behind-commits N]\n" +
      "                        [--now <iso>] [--no-enrich]\n" +
      "\n" +
      "Add the time dimension that classify-actions lacks: find tickets stalled\n" +
      "in the lifecycle. Consumes the same stacks JSON shape as classify-actions\n" +
      "so /triage-tickets can feed one snapshot to both.\n" +
      "\n" +
      "Three rules, all evaluated (a ticket can match more than one):\n" +
      "  abandoned-in-flight  ClaudePlanning/ClaudeExecuting gone quiet past\n" +
      "                       --in-flight-hours (default " +
      DEFAULT_THRESHOLDS.inFlightHours +
      ")\n" +
      "  unattended-failure   ClaudeFailed untouched past --failed-days\n" +
      "                       (default " +
      DEFAULT_THRESHOLDS.failedDays +
      ")\n" +
      "  rotting-pr           open PR untouched past --pr-days (default " +
      DEFAULT_THRESHOLDS.prDays +
      "),\n" +
      "                       or base moved >= --behind-commits (default " +
      DEFAULT_THRESHOLDS.staleBehindCommits +
      ")\n" +
      "\n" +
      "With --repo-root, timestamps missing from the stacks JSON are enriched\n" +
      "from git and gh (branch tip, PR commits/reviews/comments, behind-by) and\n" +
      "from each ticket's [claude-activity-log] Jira comment. --no-enrich skips\n" +
      "all of that and judges only what the input already carries, which is what\n" +
      "the tests use.\n" +
      "\n" +
      "--now <iso> pins the clock for reproducible output.\n" +
      "\n" +
      "Output: { findings: [...], byKind: {...}, counts: {...} }\n" +
      "Exit 0 when nothing is stagnant, 2 when at least one finding is emitted.\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function getNumberFlag(name, fallback) {
  const raw = getFlag(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`${name} must be a non-negative number. Got: ${raw}`);
    process.exit(1);
  }
  return n;
}

const stacksFile = getFlag("--stacks-file");
const repoRoot = getFlag("--repo-root");
const nowRaw = getFlag("--now");
const enrich = !args.includes("--no-enrich");

if (!stacksFile) {
  console.error("Provide --stacks-file <path>.");
  process.exit(1);
}

const thresholds = {
  inFlightHours: getNumberFlag(
    "--in-flight-hours",
    DEFAULT_THRESHOLDS.inFlightHours,
  ),
  failedDays: getNumberFlag("--failed-days", DEFAULT_THRESHOLDS.failedDays),
  prDays: getNumberFlag("--pr-days", DEFAULT_THRESHOLDS.prDays),
  staleBehindCommits: getNumberFlag(
    "--behind-commits",
    DEFAULT_THRESHOLDS.staleBehindCommits,
  ),
};

const now = nowRaw ? Date.parse(nowRaw) : Date.now();
if (Number.isNaN(now)) {
  console.error(`--now is not a parseable timestamp: ${nowRaw}`);
  process.exit(1);
}

let stacks;
try {
  const raw = JSON.parse(readFileSync(stacksFile, "utf-8"));
  stacks = Array.isArray(raw) ? raw : raw.stacks;
} catch (err) {
  console.error(
    `detect-stagnation: failed to read stacks JSON: ${err.message}`,
  );
  process.exit(1);
}

if (!Array.isArray(stacks)) {
  console.error("detect-stagnation: stacks JSON must be an array of stacks.");
  process.exit(1);
}

// Fill in the timestamps the rules need but the caller didn't supply. Every
// probe is best-effort: a null leaves the corresponding rule unable to judge,
// which is the conservative outcome (no finding) rather than a false alarm.
async function enrichTickets() {
  const prMap = repoRoot ? getOpenPrActivityMap(repoRoot) : new Map();
  const behindCache = new Map();

  for (const stack of stacks) {
    for (const ticket of stack?.tickets || []) {
      const branch = ticket.branch || null;

      if (repoRoot && branch && ticket.lastCommitAt === undefined) {
        ticket.lastCommitAt = getBranchLastCommitAt(branch, repoRoot);
      }

      // The activity log is only consulted for tickets the in-flight rule could
      // actually fire on — it is one Jira round-trip per ticket.
      const inFlight =
        Array.isArray(ticket.labels) &&
        (ticket.labels.includes("ClaudeExecuting") ||
          ticket.labels.includes("ClaudePlanning"));
      if (inFlight && ticket.lastActivityAt === undefined) {
        try {
          const log = await readActivityLog(ticket.key);
          const entries = log?.entries || [];
          ticket.lastActivityAt = entries.length
            ? entries[entries.length - 1]?.timestamp || null
            : null;
        } catch {
          ticket.lastActivityAt = null;
        }
      }

      if (ticket.pr === undefined && branch && prMap.has(branch)) {
        const pr = { ...prMap.get(branch) };
        if (repoRoot && pr.baseRefName) {
          const cacheKey = `${branch}..${pr.baseRefName}`;
          if (!behindCache.has(cacheKey)) {
            behindCache.set(
              cacheKey,
              countCommitsBehind(branch, pr.baseRefName, repoRoot),
            );
          }
          pr.behindBy = behindCache.get(cacheKey);
        }
        ticket.pr = pr;
      }
    }
  }
}

try {
  if (enrich) await enrichTickets();
  const out = detectStagnation({ stacks, now, thresholds });
  console.log(JSON.stringify(out, null, 2));
  // Exit 2 signals "found something", so a loop can branch without parsing.
  process.exit(out.counts.total > 0 ? 2 : 0);
} catch (err) {
  console.error(`detect-stagnation: ${err.message}`);
  process.exit(1);
}
