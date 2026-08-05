#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { createInterface } from "node:readline";
import chalk from "chalk";
import {
  readChecklistFromJira,
  readExecutionPlanFromJira,
} from "../lib/checklist.js";
import { loadDevRoot } from "../lib/config.js";
import { findBranch, findWorktree, getPrInfo } from "../lib/git.js";
import { getIssue, searchIssues } from "../lib/jira.js";
import { renderSummary, renderTree, renderVerbose } from "../lib/render.js";
import { attachFeatureBranches, buildStacks } from "../lib/stacks.js";
import { resolveRepoRoot } from "../lib/util.js";

const DEV_ROOT = loadDevRoot();
const args = process.argv.slice(2);

async function main() {
  if (args.length && args[0] !== "--help") {
    await verboseMode(args[0].toUpperCase());
  } else if (args[0] === "--help") {
    printHelp();
  } else {
    await treeMode();
  }
}

function printHelp() {
  console.log(`
${chalk.bold("ticket-status")} — View and manage Claude ticket stacks

${chalk.dim("Usage:")}
  ticket-status           Tree overview of all stacks
  ticket-status KEY       Verbose view of a specific ticket
  ticket-status --help    This message

${chalk.dim("Environment:")}
  JIRA_EMAIL              Jira account email
  JIRA_API_TOKEN          Jira API token
  JIRA_DOMAIN             Jira domain (e.g., myorg.atlassian.net)

${chalk.dim("Actions (interactive):")}
  v KEY    Verbose view
  q        Quit
`);
}

async function treeMode() {
  const issues = await searchIssues(
    'labels = "ClaudeWork" AND assignee = currentUser() AND statusCategory != Done',
    ["key", "summary", "status", "labels", "issuelinks", "parent", "issuetype"],
  );

  if (!issues.length) {
    console.log(chalk.dim("No active Claude tickets found."));
    return;
  }

  const stacks = buildStacks(issues);
  await attachFeatureBranches(stacks);
  console.log(renderTree(stacks));
  console.log(renderSummary(stacks));
  await interactiveLoop();
}

async function interactiveLoop() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () =>
    new Promise((resolve) => {
      rl.question(
        chalk.dim("\nActions: (v KEY) verbose, (q) quit\n> "),
        resolve,
      );
    });

  while (true) {
    const input = (await prompt()).trim();
    if (!input || input === "q") {
      rl.close();
      return;
    }

    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const keyArg = parts[1]?.toUpperCase();

    if (cmd === "v" && keyArg) {
      await verboseMode(keyArg);
    } else {
      console.log(chalk.dim("Unknown action. Try: v KEY, q"));
    }
  }
}

async function verboseMode(ticketKey) {
  const issue = await getIssue(ticketKey);
  const fields = issue.fields;
  const labels = fields.labels || [];
  const status = fields.status?.name || "Unknown";

  const parent = fields.parent;
  const isSubtask = ["Sub-task", "Subtask"].includes(
    fields.issuetype?.name || "",
  );
  let stack = null;
  if (isSubtask && parent) {
    stack = `${parent.key} (${parent.fields?.summary || ""})`;
  }

  const inwardLinks = (fields.issuelinks || [])
    .filter((l) => l.type?.inward === "is blocked by" && l.inwardIssue)
    .map((l) => l.inwardIssue.key);

  const outwardLinks = (fields.issuelinks || [])
    .filter((l) => l.type?.outward === "blocks" && l.outwardIssue)
    .map((l) => l.outwardIssue.key);

  let baseChain = "main";
  if (inwardLinks.length) {
    baseChain = `main → ${inwardLinks[0]} → ${ticketKey}`;
  }

  const repoRoot = resolveRepoRoot(labels, DEV_ROOT);

  const branch = findBranch(ticketKey, repoRoot);
  const worktree = findWorktree(ticketKey, repoRoot);
  const pr = getPrInfo(branch, repoRoot || worktree);
  const checklist = await readChecklistFromJira(ticketKey);
  const execPlan = await readExecutionPlanFromJira(ticketKey);
  const reviewPlan = null;

  console.log(
    renderVerbose({
      key: ticketKey,
      summary: fields.summary,
      stack,
      baseChain,
      branch,
      worktree,
      pr,
      status,
      labels,
      checklist,
      reviewPlan,
      execPlan,
      blocks: outwardLinks,
      blockedBy: inwardLinks,
    }),
  );
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
