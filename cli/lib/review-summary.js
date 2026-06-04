import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function run(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export function findReviewPlanFile(plansDir, ticketKey) {
  if (!existsSync(plansDir)) return null;

  const files = readdirSync(plansDir);
  const match = files.find(
    (f) =>
      f.match(/^pr-review-.*\.md$/) ||
      (ticketKey && f.match(new RegExp(`^pr-${ticketKey}.*\\.md$`, "i"))),
  );
  return match ? join(plansDir, match) : null;
}

export function formatSummary(planContent) {
  const issues = [];
  const lines = planContent.split("\n");

  let currentIssue = null;
  for (const line of lines) {
    const itemMatch = line.match(/^- \[([ x])\]\s*\*?\*?(.+?)\*?\*?\s*$/);
    if (itemMatch) {
      currentIssue = {
        title: itemMatch[2].replace(/\*\*/g, "").trim(),
        resolved: itemMatch[1] === "x",
        description: "",
      };
      issues.push(currentIssue);
      continue;
    }

    const subItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (subItemMatch && currentIssue) {
      if (!currentIssue.description) {
        currentIssue.description = subItemMatch[1];
      }
    }
  }

  if (issues.length === 0) {
    return { markdown: null, issuesFound: 0, issuesResolved: 0 };
  }

  const resolved = issues.filter((i) => i.resolved).length;

  let md = "## Claude Code Review Summary\n\n### Issues Found\n";
  for (const issue of issues) {
    const status = issue.resolved ? "resolved" : "open";
    const desc = issue.description ? `: ${issue.description}` : "";
    md += `- **${issue.title}**${desc} — **${status}**\n`;
  }

  md += "\n### Resolutions\n";
  for (const issue of issues.filter((i) => i.resolved)) {
    md += `- ${issue.title}: resolved\n`;
  }

  md += `\n${issues.length} issues found, ${resolved} resolved.\n`;

  return { markdown: md, issuesFound: issues.length, issuesResolved: resolved };
}

export function postSummary(branch, plansDir, ticketKey, cwd) {
  const planFile = findReviewPlanFile(plansDir, ticketKey);
  if (!planFile) {
    return { posted: false, reason: "no_plan_file" };
  }

  const content = readFileSync(planFile, "utf-8");
  const { markdown, issuesFound, issuesResolved } = formatSummary(content);

  if (!markdown) {
    return { posted: false, reason: "no_issues_found" };
  }

  const escaped = markdown.replace(/'/g, "'\\''");
  const result = run(`gh pr comment ${branch} --body '${escaped}'`, cwd);

  if (result === null) {
    return { posted: false, reason: "gh_comment_failed" };
  }

  return { posted: true, issuesFound, issuesResolved };
}
