import chalk from "chalk";
import { actionHint, labelState } from "./util.js";

const STATE_COLORS = {
  FAILED: chalk.red,
  "PR open": chalk.green,
  "PR approved": chalk.cyan,
  "stack ready": chalk.yellow,
  "executing...": chalk.blue,
  "plan approved": chalk.cyan,
  "plan ready": chalk.yellow,
  "planning...": chalk.blue,
  ready: chalk.gray,
  unknown: chalk.dim,
};

export function renderTree(stacks) {
  const lines = [];

  for (const stack of stacks) {
    lines.push("");
    lines.push(chalk.bold(`${stack.containerKey}: ${stack.containerSummary}`));

    for (let i = 0; i < stack.tickets.length; i++) {
      const t = stack.tickets[i];
      const isLast = i === stack.tickets.length - 1;
      const prefix = isLast ? "└── " : "├── ";
      const state = labelState(t.labels);
      const colorFn = STATE_COLORS[state.display] || chalk.dim;
      const stateStr = colorFn(`[${state.display}]`);
      const hint = actionHint(state.label);
      const hintStr = hint ? chalk.yellow(` ← ${hint}`) : "";

      if (t.waitingOn) {
        const waitStr = chalk.dim(`[waiting on ${t.waitingOn}]`);
        lines.push(`${prefix}${t.key}: ${t.summary}    ${waitStr}`);
      } else {
        lines.push(`${prefix}${t.key}: ${t.summary}    ${stateStr}${hintStr}`);
      }
    }
  }

  return lines.join("\n");
}

export function renderSummary(stacks) {
  const allTickets = stacks.flatMap((s) => s.tickets);
  const total = allTickets.length;
  const stackCount = stacks.length;
  const planPending = allTickets
    .filter((t) => t.labels.includes("ClaudePlanNeedsApproval"))
    .map((t) => t.key);
  const prPending = allTickets
    .filter((t) => t.labels.includes("ClaudeStackReady"))
    .map((t) => t.key);
  const failed = allTickets
    .filter((t) => t.labels.includes("ClaudeFailed"))
    .map((t) => t.key);

  const lines = [
    "",
    chalk.dim("─".repeat(40)),
    `${total} tickets across ${stackCount} stacks`,
  ];

  if (planPending.length) {
    lines.push(
      chalk.yellow(`Plan approvals pending: ${planPending.join(", ")}`),
    );
  }
  if (prPending.length) {
    lines.push(chalk.yellow(`PR approvals pending: ${prPending.join(", ")}`));
  }
  if (failed.length) {
    lines.push(chalk.red(`Failed: ${failed.join(", ")}`));
  }
  if (!planPending.length && !prPending.length && !failed.length) {
    lines.push(chalk.green("No actions pending."));
  }

  return lines.join("\n");
}

export function renderVerbose(ticket) {
  const lines = [];
  const {
    key,
    summary,
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
    blocks,
    blockedBy,
  } = ticket;

  lines.push("");
  lines.push(chalk.bold(`${key}: ${summary}`));
  lines.push(chalk.dim("━".repeat(40)));
  lines.push(`Stack:      ${stack || "—"}`);
  lines.push(`Base:       ${baseChain || "—"}`);
  lines.push(`Branch:     ${branch || "—"}`);
  lines.push(`Worktree:   ${worktree || "—"}`);

  if (pr) {
    lines.push(`PR:         ${pr.url} (${pr.state})`);
  } else {
    lines.push(`PR:         —`);
  }

  lines.push(
    `Jira:       ${status} | Labels: ${labels.filter((l) => l.startsWith("Claude")).join(", ") || "none"}`,
  );
  lines.push("");

  if (checklist) {
    lines.push("Checklist:");
    const gateSteps = [2, 6, 7];
    let firstUnchecked = null;
    for (const step of checklist.steps) {
      if (!step.done && firstUnchecked === null) firstUnchecked = step.num;
      const check = step.done ? chalk.green("[x]") : chalk.dim("[ ]");
      let extra = "";

      if (step.num === 3 && execPlan) {
        extra = chalk.dim(` (${execPlan.completed}/${execPlan.total} tasks)`);
      }
      if (step.num === 4 && reviewPlan) {
        extra = chalk.dim(` (${reviewPlan.total} issues found)`);
      }
      if (step.num === 5 && reviewPlan) {
        extra = chalk.dim(
          ` (${reviewPlan.resolved} resolved, ${reviewPlan.open} open)`,
        );
      }

      let marker = "";
      if (!step.done && step.num === firstUnchecked) {
        marker = gateSteps.includes(step.num)
          ? chalk.yellow(" ← GATE")
          : chalk.cyan(" ← NEXT");
      }

      lines.push(`  ${check} ${step.num}. ${step.label}${extra}${marker}`);
    }
  } else {
    const state = labelState(labels);
    lines.push(
      "Checklist:  (no checklist file — state inferred from Jira labels)",
    );
    lines.push(`  Current: ${state.display}`);
  }

  lines.push("");
  lines.push(`Blocks:     ${blocks.length ? blocks.join(", ") : "none"}`);
  lines.push(`Blocked by: ${blockedBy.length ? blockedBy.join(", ") : "none"}`);

  return lines.join("\n");
}
