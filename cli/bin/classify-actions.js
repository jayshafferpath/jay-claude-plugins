#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { loadEnv } from "../lib/env.js";

loadEnv();

import { classifyActions, extractFailedStep } from "../lib/classify-actions.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: classify-actions --stacks-file <path> [--pr-state-file <path>]\n" +
      "       classify-actions --stacks-stdin   [--pr-state-file <path>]\n" +
      "       classify-actions --extract-failed-step --activity-log-file <path>\n" +
      "\n" +
      "Apply the /orchestrate Step 3 decision table to a stacks snapshot. The\n" +
      "stacks JSON shape is the orchestrator's STACKS array — each entry has\n" +
      "{ container: { key, featureBranch, parentFeatureBranch, unmergedBlockers },\n" +
      "  tickets: [{ key, branch, labels[], mergedIntoMain, mergedIntoFeature,\n" +
      "              eligible, blockers[], ... }] }.\n" +
      "\n" +
      "--pr-state-file is an optional JSON map { branchName: { mergedToParentFeatureBranch: bool } }\n" +
      "for rule 1a. If a rule-1a candidate's branch is missing from the map,\n" +
      "classify-actions emits it under `pendingProbes` so the caller can fetch\n" +
      "the PR state and re-run.\n" +
      "\n" +
      "--extract-failed-step is a separate one-shot mode: scan an activity-log\n" +
      "file body for the latest reference to a ticket-work step (S4.2/S4.3/S4.7)\n" +
      "and emit the matching recommendation (rework/fix-drift/manual).\n" +
      "\n" +
      "Output: { stacks: [...], queues: { autoSafe, asks, manual, blocked, inFlight, idle }, pendingProbes }\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const stacksFile = getFlag("--stacks-file");
const prStateFile = getFlag("--pr-state-file");
const fromStdin = args.includes("--stacks-stdin");
const extractMode = args.includes("--extract-failed-step");
const activityLogFile = getFlag("--activity-log-file");

if (extractMode) {
  if (!activityLogFile) {
    console.error("--extract-failed-step requires --activity-log-file <path>");
    process.exit(1);
  }
  const body = readFileSync(activityLogFile, "utf-8");
  console.log(JSON.stringify(extractFailedStep(body), null, 2));
  process.exit(0);
}

if (!stacksFile && !fromStdin) {
  console.error("Provide --stacks-file <path> or --stacks-stdin.");
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

let stacksRaw;
if (fromStdin) {
  stacksRaw = await readStdin();
} else {
  stacksRaw = readFileSync(stacksFile, "utf-8");
}

let stacks;
try {
  stacks = JSON.parse(stacksRaw);
} catch (err) {
  console.error(
    `classify-actions: failed to parse stacks JSON: ${err.message}`,
  );
  process.exit(1);
}

let prStateMap = {};
if (prStateFile) {
  try {
    prStateMap = JSON.parse(readFileSync(prStateFile, "utf-8"));
  } catch (err) {
    console.error(
      `classify-actions: failed to read --pr-state-file: ${err.message}`,
    );
    process.exit(1);
  }
}

const mergedToParentFeatureBranch = {};
for (const [branch, value] of Object.entries(prStateMap)) {
  if (value && typeof value === "object") {
    mergedToParentFeatureBranch[branch] =
      value.mergedToParentFeatureBranch === true;
  }
}

try {
  const out = classifyActions({
    stacks: Array.isArray(stacks) ? stacks : stacks.stacks,
    mergedToParentFeatureBranch,
  });
  console.log(JSON.stringify(out, null, 2));
  // Exit 3 when probes are still needed, so callers can branch.
  process.exit(out.pendingProbes.length > 0 ? 3 : 0);
} catch (err) {
  console.error(`classify-actions: ${err.message}`);
  process.exit(1);
}
