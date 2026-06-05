#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { join } from "node:path";
import {
  clearChecklistFromJira,
  readChecklist,
  syncChecklistToJira,
} from "../lib/checklist.js";
import { detectWorkDir } from "../lib/util.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: sync-checklist <TICKET_KEY> [work_dir]\n" +
      "       sync-checklist <TICKET_KEY> --steps '<json>'\n" +
      "       sync-checklist <TICKET_KEY> --clear",
  );
  process.exit(1);
}

const ticketKey = args[0]?.toUpperCase();

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const stepsJson = getFlag("--steps");
const clearMode = args.includes("--clear");

try {
  if (clearMode) {
    const deleted = await clearChecklistFromJira(ticketKey);
    if (deleted) {
      console.log(`Cleared checklist for ${ticketKey}.`);
    } else {
      console.log(`No checklist found for ${ticketKey} — nothing to clear.`);
    }
  } else if (stepsJson) {
    const steps = JSON.parse(stepsJson);
    if (!Array.isArray(steps) || !steps.length) {
      console.error("--steps must be a non-empty JSON array");
      process.exit(1);
    }
    await syncChecklistToJira(ticketKey, steps);
    const done = steps.filter((s) => s.done).length;
    console.log(
      `Synced checklist to ${ticketKey}: ${done}/${steps.length} steps complete.`,
    );
  } else {
    const workDir = args[1] || process.cwd();
    const relPath = join(".claude", "plans", `ticket-work-${ticketKey}.md`);
    const resolvedDir = detectWorkDir(workDir, relPath);

    if (!resolvedDir) {
      console.error(`No checklist found for ${ticketKey} in ${workDir}`);
      process.exit(1);
    }

    const checklist = readChecklist(resolvedDir, ticketKey);

    if (!checklist?.steps.length) {
      console.error(`Checklist for ${ticketKey} is empty or unreadable.`);
      process.exit(1);
    }

    await syncChecklistToJira(ticketKey, checklist.steps);
    const done = checklist.steps.filter((s) => s.done).length;
    const total = checklist.steps.length;
    console.log(
      `Synced checklist to ${ticketKey}: ${done}/${total} steps complete.`,
    );
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
