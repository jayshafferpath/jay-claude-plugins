#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readChecklistFromJira,
  syncChecklistToJira,
} from "../lib/checklist.js";
import { getPrInfo, hasStageCommit } from "../lib/git.js";
import { getIssue } from "../lib/jira.js";
import { readExecutionPlan, readReviewPlan } from "../lib/plan-reader.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: seed-checklist <TICKET_KEY> --work-dir <path> --branch <name> --base-branch <base> --pr-target <target> --summary <text> [--serial] [--jira-source]",
  );
  process.exit(1);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const ticketKey = args[0]?.toUpperCase();
const workDir = getFlag("--work-dir") || process.cwd();
const branchName = getFlag("--branch") || ticketKey;
const baseBranch = getFlag("--base-branch") || "main";
const prTarget = getFlag("--pr-target") || baseBranch;
const summary = getFlag("--summary") || "";
const serial = args.includes("--serial");
const jiraSource = args.includes("--jira-source");

const plansDir = join(workDir, ".claude", "plans");

const STEP_LABELS = [
  "Plan generated with /jira-start",
  "Plan executed with /plan-execute",
  "Acceptance criteria verified against Gherkin",
  "Refactoring pass with @refactor agent",
  "PR review plan generated with /pr-review",
  "PR review plan executed with /pr-execute-plan",
  "Stack ready (unblocks downstream) — TERMINAL STATE",
  "PR approved",
  "PR description and title generated with /jay-pr-description",
  "PR pushed as draft",
  "Copilot review comments resolved",
  "PR review summary posted",
];

async function seedSteps() {
  const steps = Array(STEP_LABELS.length).fill(false);

  const issue = await getIssue(ticketKey);
  const labels = issue.fields.labels || [];

  const planPath = join(plansDir, `jira-${ticketKey}.md`);
  const planExists = existsSync(planPath);

  const prInfo = getPrInfo(branchName, workDir);
  const prExists = prInfo !== null;

  const hasLabel = (l) => labels.includes(l);
  const hasAny = (...ls) => ls.some(hasLabel);

  if (prExists) {
    for (let i = 0; i < 10; i++) steps[i] = true;
  } else if (hasAny("ClaudePRApproved", "ClaudeNeedsReview")) {
    for (let i = 0; i < 8; i++) steps[i] = true;
  } else if (hasLabel("ClaudeStackReady")) {
    for (let i = 0; i < 7; i++) steps[i] = true;
  } else {
    const reviewPlan = readReviewPlan(workDir, ticketKey);
    if (reviewPlan) {
      for (let i = 0; i < 5; i++) steps[i] = true;
    } else {
      const execPlan = readExecutionPlan(workDir, ticketKey);
      const executingDone =
        hasLabel("ClaudeExecuting") &&
        execPlan &&
        execPlan.completed === execPlan.total &&
        execPlan.total > 0;

      if (executingDone) {
        for (let i = 0; i < 4; i++) steps[i] = true;
      } else if (hasLabel("ClaudeExecuting")) {
        steps[0] = true;
      } else if (planExists) {
        steps[0] = true;
      }
    }
  }

  // Secondary signal: git stage commits
  const stageMap = [
    { step: 0, prefix: "plan" },
    { step: 1, prefix: "execute" },
    { step: 2, prefix: "verify" },
    { step: 3, prefix: "refactor" },
    { step: 5, prefix: "review" },
  ];

  for (const { step, prefix } of stageMap) {
    if (hasStageCommit(ticketKey, prefix, workDir)) {
      for (let i = 0; i <= step; i++) steps[i] = true;
    }
  }

  return steps;
}

try {
  if (jiraSource) {
    const existing = await readChecklistFromJira(ticketKey);
    if (existing?.steps?.length) {
      console.log(JSON.stringify({ steps: existing.steps, source: "jira" }));
    } else {
      const stepsDone = await seedSteps();
      const stepsOutput = stepsDone.map((done, i) => ({
        num: i + 1,
        label: STEP_LABELS[i],
        done,
      }));
      await syncChecklistToJira(ticketKey, stepsOutput);
      console.log(JSON.stringify({ steps: stepsOutput, source: "seeded" }));
    }
  } else {
    const steps = await seedSteps();
    const timestamp = new Date().toISOString();

    const stepLines = steps.map(
      (done, i) => `- [${done ? "x" : " "}] ${i + 1}. ${STEP_LABELS[i]}`,
    );

    const frontmatter = `---\nticket: ${ticketKey}\nbranch: ${branchName}\nsummary: ${summary}\nbase_branch: ${baseBranch}\npr_target: ${prTarget}\nwork_dir: ${workDir}\nserial: ${serial}\ncreated: ${timestamp}\n---`;

    const markdown = `${frontmatter}\n\n# ${ticketKey} - Work Checklist\n\n${stepLines.join("\n")}\n`;

    const stepsOutput = steps.map((done, i) => ({
      num: i + 1,
      label: STEP_LABELS[i],
      done,
    }));

    console.log(JSON.stringify({ steps: stepsOutput, markdown }, null, 2));
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
