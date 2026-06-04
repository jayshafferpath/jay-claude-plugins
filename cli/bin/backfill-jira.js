#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readChecklist,
  readExecutionPlanRaw,
  syncChecklistToJira,
  syncPlanToJira,
} from "../lib/checklist.js";

const TICKETS = [
  ["NEV-426", "/Users/jayshaffer/dev/employer-backend-root/NEV-426"],
  ["NEV-433", "/Users/jayshaffer/dev/employer-backend-root/NEV-433"],
  ["NEV-438", "/Users/jayshaffer/dev/employer-backend-root/NEV-438"],
  ["NEV-509", "/Users/jayshaffer/dev/employer-backend-root/NEV-509"],
  ["NEV-517", "/Users/jayshaffer/dev/employer-backend-root/NEV-517"],
  ["NEV-518", "/Users/jayshaffer/dev/employer-backend-root/NEV-518"],
  ["NEV-522", "/Users/jayshaffer/dev/employer-backend-root/NEV-522"],
  ["NEV-523", "/Users/jayshaffer/dev/employer-backend-root/NEV-523"],
  ["NEV-526", "/Users/jayshaffer/dev/employer-backend-root/NEV-526"],
  ["NEV-527", "/Users/jayshaffer/dev/employer-backend-root/NEV-527"],
  ["NEV-529", "/Users/jayshaffer/dev/employer-backend-root/NEV-529"],
  ["NEV-530", "/Users/jayshaffer/dev/employer-backend-root/NEV-530"],
  ["NEV-566", "/Users/jayshaffer/dev/employer-backend-root/NEV-566"],
  ["NEV-618", "/Users/jayshaffer/dev/employer-backend-root/NEV-618"],
  ["NEV-619", "/Users/jayshaffer/dev/employer-backend-root/NEV-619"],
  ["NEV-620", "/Users/jayshaffer/dev/employer-backend-root/NEV-620"],
  ["NEV-621", "/Users/jayshaffer/dev/employer-backend-root/NEV-621"],
  ["NEV-622", "/Users/jayshaffer/dev/employer-backend-root/NEV-622"],
  ["NEV-661", "/Users/jayshaffer/dev/NEV-661"],
  ["NEV-688", "/Users/jayshaffer/dev/employer-backend-root/NEV-688"],
  ["NEV-690", "/Users/jayshaffer/dev/employer-backend-root/NEV-690"],
  ["NEV-691", "/Users/jayshaffer/dev/employer-backend-root/NEV-691"],
  ["NEV-692", "/Users/jayshaffer/dev/employer-backend-root/NEV-692"],
  ["NEV-708", "/Users/jayshaffer/dev/employer-backend-root/NEV-708"],
  ["NEV-804", "/Users/jayshaffer/dev/employer-backend-root/NEV-804"],
  ["NEV-872", "/Users/jayshaffer/dev/employer-backend-root/NEV-872"],
  ["NEV-874", "/Users/jayshaffer/dev/employer-backend-root/NEV-874"],
  ["NEV-876", "/Users/jayshaffer/dev/employer-backend-root/NEV-876"],
  ["NEV-877", "/Users/jayshaffer/dev/employer-backend-root/NEV-877"],
  ["NEV-879", "/Users/jayshaffer/dev/employer-backend-root/NEV-879"],
  ["NEV-881", "/Users/jayshaffer/dev/employer-backend-root/NEV-881"],
  ["NEV-898", "/Users/jayshaffer/dev/NEV-898"],
  ["NEV-902", "/Users/jayshaffer/dev/employer-backend-root/NEV-902"],
  ["NEV-904", "/Users/jayshaffer/dev/employer-backend-root/NEV-904"],
  ["NEV-934", "/Users/jayshaffer/dev/employer-backend-root/NEV-934"],
  ["NEV-935", "/Users/jayshaffer/dev/employer-backend-root/NEV-935"],
  ["NEV-937", "/Users/jayshaffer/dev/employer-backend-root/NEV-937"],
  ["NEV-938", "/Users/jayshaffer/dev/employer-backend-root/NEV-938"],
  ["NEV-939", "/Users/jayshaffer/dev/employer-backend-root/NEV-939"],
  ["NEV-940", "/Users/jayshaffer/dev/employer-backend-root/NEV-940"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let synced = 0;
let skipped = 0;
let failed = 0;

for (const [key, dir] of TICKETS) {
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
