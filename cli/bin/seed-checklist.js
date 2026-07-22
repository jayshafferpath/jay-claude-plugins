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
import { COMPLEXITY_TRIVIAL, getComplexity } from "../lib/labels.js";
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
  "PR review plan generated with /jay-pr-review",
  "Stack ready (unblocks downstream) — TERMINAL STATE",
  "PR approved",
  "PR description and title generated with /jay-pr-description",
  "PR pushed as draft",
  "PR review summary posted",
];

// 1-indexed step numbers that are skipped on the trivial complexity tier.
// Step numbering stays stable across tiers — these steps are pre-marked
// done with a `(skipped: trivial)` suffix at seed time so render.js, gate
// logic, and the S4 loop in commands/ticket-work.md keep working unchanged.
//   1 → /jira-start (no plan needed for trivial)
//   4 → @refactor agent (small surface, low ROI)
//   5 → /jay-pr-review plan
const TRIVIAL_SKIPPED_STEPS = new Set([1, 4, 5]);
const TRIVIAL_SKIP_SUFFIX = " (skipped: trivial)";

async function seedSteps() {
  const steps = Array(STEP_LABELS.length).fill(false);

  const issue = await getIssue(ticketKey);
  const labels = issue.fields.labels || [];
  const complexity = getComplexity(labels);

  const planPath = join(plansDir, `jira-${ticketKey}.md`);
  const planExists = existsSync(planPath);

  const prInfo = getPrInfo(branchName, workDir);
  const prExists = prInfo !== null && prInfo.state === "OPEN";

  const hasLabel = (l) => labels.includes(l);
  const hasAny = (...ls) => ls.some(hasLabel);

  if (prExists) {
    for (let i = 0; i < 9; i++) steps[i] = true;
  } else if (hasAny("ClaudePRApproved", "ClaudeNeedsReview")) {
    for (let i = 0; i < 7; i++) steps[i] = true;
  } else if (hasLabel("ClaudeStackReady")) {
    for (let i = 0; i < 6; i++) steps[i] = true;
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
    { step: 4, prefix: "review" },
  ];

  for (const { step, prefix } of stageMap) {
    if (hasStageCommit(ticketKey, prefix, workDir, baseBranch)) {
      for (let i = 0; i <= step; i++) steps[i] = true;
    }
  }

  // Pre-mark trivial-skipped steps as done so the S4 loop never opens them.
  // This runs after every other signal so a triggered step (e.g. existing
  // /jira-start plan) doesn't lose its done state — it can only flip false→true.
  if (complexity === COMPLEXITY_TRIVIAL) {
    for (const num of TRIVIAL_SKIPPED_STEPS) {
      steps[num - 1] = true;
    }
  }

  return { steps, complexity };
}

function labelFor(num, complexity) {
  if (complexity === COMPLEXITY_TRIVIAL && TRIVIAL_SKIPPED_STEPS.has(num)) {
    return STEP_LABELS[num - 1] + TRIVIAL_SKIP_SUFFIX;
  }
  return STEP_LABELS[num - 1];
}

try {
  if (jiraSource) {
    const existing = await readChecklistFromJira(ticketKey);
    if (existing?.steps?.length) {
      console.log(JSON.stringify({ steps: existing.steps, source: "jira" }));
    } else {
      const { steps: stepsDone, complexity } = await seedSteps();
      const stepsOutput = stepsDone.map((done, i) => ({
        num: i + 1,
        label: labelFor(i + 1, complexity),
        done,
      }));
      await syncChecklistToJira(ticketKey, stepsOutput);
      console.log(
        JSON.stringify({ steps: stepsOutput, source: "seeded", complexity }),
      );
    }
  } else {
    const { steps, complexity } = await seedSteps();
    const timestamp = new Date().toISOString();

    const stepLines = steps.map(
      (done, i) =>
        `- [${done ? "x" : " "}] ${i + 1}. ${labelFor(i + 1, complexity)}`,
    );

    const frontmatter = `---\nticket: ${ticketKey}\nbranch: ${branchName}\nsummary: ${summary}\nbase_branch: ${baseBranch}\npr_target: ${prTarget}\nwork_dir: ${workDir}\nserial: ${serial}\ncomplexity: ${complexity}\ncreated: ${timestamp}\n---`;

    const markdown = `${frontmatter}\n\n# ${ticketKey} - Work Checklist\n\n${stepLines.join("\n")}\n`;

    const stepsOutput = steps.map((done, i) => ({
      num: i + 1,
      label: labelFor(i + 1, complexity),
      done,
    }));

    console.log(
      JSON.stringify({ steps: stepsOutput, markdown, complexity }, null, 2),
    );
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
