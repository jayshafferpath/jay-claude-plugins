#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { syncChecklistToJira, readChecklist } from "../lib/checklist.js";

const ticketKey = process.argv[2]?.toUpperCase();

if (!ticketKey) {
  console.error("Usage: sync-checklist <TICKET_KEY> [work_dir]");
  process.exit(1);
}

const workDir = process.argv[3] || process.cwd();

function detectWorkDir() {
  const explicit = join(workDir, ".claude", "plans", `ticket-work-${ticketKey}.md`);
  if (existsSync(explicit)) return workDir;

  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", {
      cwd: workDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const inRepo = join(repoRoot, ".claude", "plans", `ticket-work-${ticketKey}.md`);
    if (existsSync(inRepo)) return repoRoot;
  } catch {}

  return null;
}

const resolvedDir = detectWorkDir();

if (!resolvedDir) {
  console.error(`No checklist found for ${ticketKey} in ${workDir}`);
  process.exit(1);
}

const checklist = readChecklist(resolvedDir, ticketKey);

if (!checklist || !checklist.steps.length) {
  console.error(`Checklist for ${ticketKey} is empty or unreadable.`);
  process.exit(1);
}

try {
  await syncChecklistToJira(ticketKey, checklist.steps);
  const done = checklist.steps.filter((s) => s.done).length;
  const total = checklist.steps.length;
  console.log(`Synced checklist to ${ticketKey}: ${done}/${total} steps complete.`);
} catch (err) {
  console.error(`Failed to sync checklist: ${err.message}`);
  process.exit(1);
}
