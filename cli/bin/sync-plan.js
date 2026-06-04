#!/usr/bin/env node

import { join } from "node:path";
import { readExecutionPlanRaw, syncPlanToJira } from "../lib/checklist.js";
import { detectWorkDir } from "../lib/util.js";

const ticketKey = process.argv[2]?.toUpperCase();

if (!ticketKey) {
  console.error("Usage: sync-plan <TICKET_KEY> [work_dir]");
  process.exit(1);
}

const workDir = process.argv[3] || process.cwd();
const relPath = join(".claude", "plans", `jira-${ticketKey}.md`);
const resolvedDir = detectWorkDir(workDir, relPath);

if (!resolvedDir) {
  console.error(`No plan found for ${ticketKey} in ${workDir}`);
  process.exit(1);
}

const planContent = readExecutionPlanRaw(resolvedDir, ticketKey);

if (!planContent) {
  console.error(`Plan for ${ticketKey} is empty or unreadable.`);
  process.exit(1);
}

try {
  await syncPlanToJira(ticketKey, planContent);
  const tasks = (planContent.match(/^- \[[ x]\]/gm) || []).length;
  const completed = (planContent.match(/^- \[x\]/gm) || []).length;
  console.log(
    `Synced plan to ${ticketKey}: ${completed}/${tasks} tasks complete.`,
  );
} catch (err) {
  console.error(`Failed to sync plan: ${err.message}`);
  process.exit(1);
}
