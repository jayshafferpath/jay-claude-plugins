#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import {
  readChecklistFromJira,
  readExecutionPlanFromJira,
} from "../lib/checklist.js";
import { loadDevRoot } from "../lib/config.js";
import { findBranch, findWorktree, getPrInfo } from "../lib/git.js";
import { getIssue, searchIssues, swapLabel } from "../lib/jira.js";
import { renderSummary, renderTree, renderVerbose } from "../lib/render.js";
import { topologicalSort } from "../lib/util.js";

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
  p KEY    Approve plan
  r KEY    Approve PR
  ap       Approve all pending plans
  ar       Approve all pending PRs
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

  const stacks = await buildStacks(issues);
  console.log(renderTree(stacks));
  console.log(renderSummary(stacks));
  await interactiveLoop(stacks);
}

async function buildStacks(issues) {
  const containerCache = new Map();
  const grouped = new Map();
  const blockingLinks = [];

  for (const issue of issues) {
    const key = issue.key;
    const fields = issue.fields;
    const labels = fields.labels || [];
    const parent = fields.parent;
    const issuetype = fields.issuetype?.name || "";

    let containerKey = null;
    if (parent && ["Sub-task", "Subtask"].includes(issuetype)) {
      containerKey = parent.key;
      if (!containerCache.has(containerKey)) {
        containerCache.set(containerKey, parent.fields?.summary || "");
      }
    } else {
      const epicLink = fields.issuelinks?.find(
        (l) =>
          l.type?.name === "Epic" ||
          l.outwardIssue?.fields?.issuetype?.name === "Epic",
      );
      if (epicLink?.outwardIssue) {
        containerKey = epicLink.outwardIssue.key;
        containerCache.set(
          containerKey,
          epicLink.outwardIssue.fields?.summary || "",
        );
      }
    }

    if (!containerKey) containerKey = "Standalone";
    if (!containerCache.has(containerKey)) {
      containerCache.set(containerKey, "");
    }

    if (!grouped.has(containerKey)) grouped.set(containerKey, []);

    const blockers = (fields.issuelinks || [])
      .filter((l) => l.type?.inward === "is blocked by" && l.inwardIssue)
      .map((l) => l.inwardIssue.key);

    const blocks = (fields.issuelinks || [])
      .filter((l) => l.type?.outward === "blocks" && l.outwardIssue)
      .map((l) => l.outwardIssue.key);

    for (const blocker of blockers) {
      blockingLinks.push({ from: blocker, to: key });
    }

    const isFinished = (k) =>
      issues.some(
        (i) =>
          i.key === k &&
          (i.fields.status?.statusCategory?.key === "done" ||
            i.fields.labels?.includes("ClaudeStackReady") ||
            i.fields.labels?.includes("ClaudeNeedsReview")),
      );

    const unfinishedBlockers = blockers.filter(
      (b) => issues.some((i) => i.key === b) && !isFinished(b),
    );

    grouped.get(containerKey).push({
      key,
      summary: fields.summary,
      labels,
      blockers,
      blocks,
      waitingOn: unfinishedBlockers.length ? unfinishedBlockers[0] : null,
    });
  }

  const stacks = [];
  for (const [containerKey, tickets] of grouped) {
    const sorted = topologicalSort(tickets, blockingLinks);
    const orderedTickets = sorted
      .map((k) => tickets.find((t) => t.key === k))
      .filter(Boolean);
    const remaining = tickets.filter((t) => !sorted.includes(t.key));

    stacks.push({
      containerKey,
      containerSummary: containerCache.get(containerKey) || "",
      tickets: [...orderedTickets, ...remaining],
    });
  }

  stacks.sort((a, b) => a.containerKey.localeCompare(b.containerKey));
  return stacks;
}

async function interactiveLoop(stacks) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () =>
    new Promise((resolve) => {
      rl.question(
        chalk.dim(
          "\nActions: (p KEY) plan, (r KEY) PR, (ap) all plans, (ar) all PRs, (v KEY) verbose, (q) quit\n> ",
        ),
        resolve,
      );
    });

  while (true) {
    const input = (await prompt()).trim();
    if (!input || input === "q") {
      rl.close();
      return;
    }

    const allTickets = stacks.flatMap((s) => s.tickets);
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const keyArg = parts[1]?.toUpperCase();

    if (cmd === "p" && keyArg) {
      const ticket = allTickets.find(
        (t) => t.key === keyArg || t.key.endsWith(`-${keyArg}`),
      );
      if (!ticket) {
        console.log(
          chalk.red(`Ticket ${keyArg} not found in current results.`),
        );
        continue;
      }
      if (!ticket.labels.includes("ClaudePlanNeedsApproval")) {
        console.log(chalk.red(`${ticket.key} is not awaiting plan approval.`));
        continue;
      }
      await swapLabel(
        ticket.key,
        "ClaudePlanNeedsApproval",
        "ClaudePlanApproved",
      );
      ticket.labels = ticket.labels.filter(
        (l) => l !== "ClaudePlanNeedsApproval",
      );
      ticket.labels.push("ClaudePlanApproved");
      console.log(chalk.green(`Approved plan for ${ticket.key}`));
      console.log(renderTree(stacks));
      console.log(renderSummary(stacks));
    } else if (cmd === "r" && keyArg) {
      const ticket = allTickets.find(
        (t) => t.key === keyArg || t.key.endsWith(`-${keyArg}`),
      );
      if (!ticket) {
        console.log(
          chalk.red(`Ticket ${keyArg} not found in current results.`),
        );
        continue;
      }
      if (!ticket.labels.includes("ClaudeStackReady")) {
        console.log(chalk.red(`${ticket.key} is not awaiting PR approval.`));
        continue;
      }
      await swapLabel(ticket.key, "ClaudeStackReady", "ClaudePRApproved");
      ticket.labels = ticket.labels.filter((l) => l !== "ClaudeStackReady");
      ticket.labels.push("ClaudePRApproved");
      console.log(chalk.green(`Approved PR for ${ticket.key}`));
      console.log(renderTree(stacks));
      console.log(renderSummary(stacks));
    } else if (cmd === "ap") {
      const pending = allTickets.filter((t) =>
        t.labels.includes("ClaudePlanNeedsApproval"),
      );
      if (!pending.length) {
        console.log(chalk.dim("No plans pending approval."));
        continue;
      }
      for (const t of pending) {
        await swapLabel(t.key, "ClaudePlanNeedsApproval", "ClaudePlanApproved");
        t.labels = t.labels.filter((l) => l !== "ClaudePlanNeedsApproval");
        t.labels.push("ClaudePlanApproved");
      }
      console.log(
        chalk.green(
          `Approved plans for: ${pending.map((t) => t.key).join(", ")}`,
        ),
      );
      console.log(renderTree(stacks));
      console.log(renderSummary(stacks));
    } else if (cmd === "ar") {
      const pending = allTickets.filter((t) =>
        t.labels.includes("ClaudeStackReady"),
      );
      if (!pending.length) {
        console.log(chalk.dim("No PRs pending approval."));
        continue;
      }
      for (const t of pending) {
        await swapLabel(t.key, "ClaudeStackReady", "ClaudePRApproved");
        t.labels = t.labels.filter((l) => l !== "ClaudeStackReady");
        t.labels.push("ClaudePRApproved");
      }
      console.log(
        chalk.green(
          `Approved PRs for: ${pending.map((t) => t.key).join(", ")}`,
        ),
      );
      console.log(renderTree(stacks));
      console.log(renderSummary(stacks));
    } else if (cmd === "v" && keyArg) {
      await verboseMode(keyArg);
    } else {
      console.log(
        chalk.dim("Unknown action. Try: p KEY, r KEY, ap, ar, v KEY, q"),
      );
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

  let repoRoot = null;
  const repoLabel = labels.find((l) => l.startsWith("repo:"));
  if (repoLabel && DEV_ROOT) {
    const repoName = repoLabel.slice(5);
    const candidate = join(DEV_ROOT, repoName);
    if (existsSync(candidate)) repoRoot = candidate;
  }

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

  if (!args.length || args[0].toUpperCase() !== ticketKey) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () =>
    new Promise((resolve) => {
      const actions = [];
      if (labels.includes("ClaudePlanNeedsApproval"))
        actions.push("(p) approve plan");
      if (labels.includes("ClaudeStackReady")) actions.push("(r) approve PR");
      actions.push("(q) quit");
      rl.question(chalk.dim(`\nActions: ${actions.join(", ")}\n> `), resolve);
    });

  while (true) {
    const input = (await prompt()).trim().toLowerCase();
    if (!input || input === "q") {
      rl.close();
      return;
    }

    if (input === "p") {
      if (!labels.includes("ClaudePlanNeedsApproval")) {
        console.log(chalk.red("Not awaiting plan approval."));
        continue;
      }
      await swapLabel(
        ticketKey,
        "ClaudePlanNeedsApproval",
        "ClaudePlanApproved",
      );
      console.log(chalk.green(`Approved plan for ${ticketKey}`));
      rl.close();
      return;
    } else if (input === "r") {
      if (!labels.includes("ClaudeStackReady")) {
        console.log(chalk.red("Not awaiting PR approval."));
        continue;
      }
      await swapLabel(ticketKey, "ClaudeStackReady", "ClaudePRApproved");
      console.log(chalk.green(`Approved PR for ${ticketKey}`));
      rl.close();
      return;
    } else {
      console.log(chalk.dim("Unknown action."));
    }
  }
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
