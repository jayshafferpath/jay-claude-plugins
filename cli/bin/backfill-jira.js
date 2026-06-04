#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readChecklist,
  readExecutionPlanRaw,
  syncChecklistToJira,
  syncPlanToJira,
} from "../lib/checklist.js";
import { loadDevRoot } from "../lib/config.js";
import { findWorktree } from "../lib/git.js";
import { searchIssues } from "../lib/jira.js";

const DEV_ROOT = loadDevRoot();

if (!DEV_ROOT) {
  console.error("DEV_ROOT not set. Cannot discover ticket worktrees.");
  process.exit(1);
}

const issues = await searchIssues(
  'labels = "ClaudeWork" AND assignee = currentUser() AND statusCategory != Done',
  ["key", "labels"],
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let synced = 0;
let skipped = 0;
let failed = 0;

for (const issue of issues) {
  const key = issue.key;
  const labels = issue.fields.labels || [];
  const repoLabel = labels.find((l) => l.startsWith("repo:"));
  const repoName = repoLabel ? repoLabel.slice(5) : null;
  const repoRoot = repoName ? join(DEV_ROOT, repoName) : null;

  const worktree =
    repoRoot && existsSync(repoRoot) ? findWorktree(key, repoRoot) : null;

  const dir = worktree || repoRoot;
  if (!dir || !existsSync(dir)) {
    skipped++;
    continue;
  }

  const checklistPath = join(dir, ".claude", "plans", `ticket-work-${key}.md`);
  const planPath = join(dir, ".claude", "plans", `jira-${key}.md`);

  const hasChecklist = existsSync(checklistPath);
  const hasPlan = existsSync(planPath);

  if (!hasChecklist && !hasPlan) {
    skipped++;
    continue;
  }

  try {
    if (hasChecklist) {
      const checklist = readChecklist(dir, key);
      if (checklist?.steps.length) {
        await syncChecklistToJira(key, checklist.steps);
        const done = checklist.steps.filter((s) => s.done).length;
        console.log(`✓ ${key} checklist: ${done}/${checklist.steps.length}`);
      }
      await sleep(200);
    }

    if (hasPlan) {
      const planContent = readExecutionPlanRaw(dir, key);
      if (planContent) {
        await syncPlanToJira(key, planContent);
        const tasks = (planContent.match(/^- \[[ x]\]/gm) || []).length;
        const completed = (planContent.match(/^- \[x\]/gm) || []).length;
        console.log(`✓ ${key} plan: ${completed}/${tasks}`);
      }
      await sleep(200);
    }

    synced++;
  } catch (err) {
    console.error(`✗ ${key}: ${err.message}`);
    failed++;
    await sleep(500);
  }
}

console.log(
  `\nDone. Synced: ${synced}, Skipped: ${skipped}, Failed: ${failed}`,
);
