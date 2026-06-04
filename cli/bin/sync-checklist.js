#!/usr/bin/env node

import { join } from "node:path";
import { readChecklist, syncChecklistToJira } from "../lib/checklist.js";
import { detectWorkDir } from "../lib/util.js";

const ticketKey = process.argv[2]?.toUpperCase();

if (!ticketKey) {
  console.error("Usage: sync-checklist <TICKET_KEY> [work_dir]");
  process.exit(1);
}

const workDir = process.argv[3] || process.cwd();
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

try {
  await syncChecklistToJira(ticketKey, checklist.steps);
  const done = checklist.steps.filter((s) => s.done).length;
  const total = checklist.steps.length;
  console.log(
    `Synced checklist to ${ticketKey}: ${done}/${total} steps complete.`,
  );
} catch (err) {
  console.error(`Failed to sync checklist: ${err.message}`);
  process.exit(1);
}
