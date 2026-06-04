#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readExecutionPlanRaw, syncPlanToJira } from "../lib/checklist.js";

const ticketKey = process.argv[2]?.toUpperCase();

if (!ticketKey) {
  console.error("Usage: sync-plan <TICKET_KEY> [work_dir]");
  process.exit(1);
}

const workDir = process.argv[3] || process.cwd();

function detectWorkDir() {
  const explicit = join(workDir, ".claude", "plans", `jira-${ticketKey}.md`);
  if (existsSync(explicit)) return workDir;

  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", {
      cwd: workDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const inRepo = join(repoRoot, ".claude", "plans", `jira-${ticketKey}.md`);
    if (existsSync(inRepo)) return repoRoot;
  } catch {}

  return null;
}

const resolvedDir = detectWorkDir();

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
