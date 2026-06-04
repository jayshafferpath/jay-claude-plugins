#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  markPlanTaskDone,
  readPlanSectionsFromJira,
  syncPlanToJira,
} from "../lib/checklist.js";
import { readExecutionPlanRaw } from "../lib/plan-reader.js";
import { detectWorkDir } from "../lib/util.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: sync-plan <TICKET_KEY> [work_dir]\n" +
      "       sync-plan <TICKET_KEY> --file <path>\n" +
      "       sync-plan <TICKET_KEY> --read\n" +
      '       sync-plan <TICKET_KEY> --mark-done "<task_label>"',
  );
  process.exit(1);
}

const ticketKey = args[0]?.toUpperCase();

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const filePath = getFlag("--file");
const readMode = args.includes("--read");
const markDoneLabel = getFlag("--mark-done");

try {
  if (readMode) {
    const result = await readPlanSectionsFromJira(ticketKey);
    if (!result) {
      console.error(`No plan found in Jira for ${ticketKey}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
  } else if (markDoneLabel) {
    const result = await markPlanTaskDone(ticketKey, markDoneLabel);
    console.log(
      `Marked done: "${markDoneLabel}" (${result.completed}/${result.total} complete)`,
    );
  } else if (filePath) {
    const planContent = readFileSync(filePath, "utf-8");
    if (!planContent) {
      console.error(`Plan file is empty: ${filePath}`);
      process.exit(1);
    }
    await syncPlanToJira(ticketKey, planContent);
    const tasks = (planContent.match(/^- \[[ x]\]/gm) || []).length;
    const completed = (planContent.match(/^- \[x\]/gm) || []).length;
    console.log(
      `Synced plan to ${ticketKey}: ${completed}/${tasks} tasks complete.`,
    );
  } else {
    const workDir = args[1] || process.cwd();
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

    await syncPlanToJira(ticketKey, planContent);
    const tasks = (planContent.match(/^- \[[ x]\]/gm) || []).length;
    const completed = (planContent.match(/^- \[x\]/gm) || []).length;
    console.log(
      `Synced plan to ${ticketKey}: ${completed}/${tasks} tasks complete.`,
    );
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
