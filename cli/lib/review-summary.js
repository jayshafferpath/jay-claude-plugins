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

// `/jay-pr-review`'s exact filename convention (commands/jay-pr-review.md Step 1):
// `.plans/pr-review-<BRANCH with / and _ -> ->.md`. Exposed so callers that
// already know the branch (every real caller does — it's a required arg)
// can match on it instead of guessing.
export function reviewPlanFilename(branch) {
  return `pr-review-${branch.replace(/[/_]/g, "-")}.md`;
}

export function findReviewPlanFile(plansDir, ticketKey, branch) {
  if (!existsSync(plansDir)) return null;

  const files = readdirSync(plansDir);

  // Branch match is checked first, and is authoritative when it hits: the
  // filename convention already encodes the branch, so this is an exact,
  // unambiguous match rather than a scoped guess. This is what makes the
  // function safe to call with no ticket key at all — a Jira-less stack (a
  // plain GitHub PR chain) still has one `pr-review-*.md` file per branch
  // sitting in the same shared `.plans/` dir, and without this check the
  // ticket-key-less fallback below would grab an arbitrary one of them.
  if (branch) {
    const target = reviewPlanFilename(branch);
    if (files.includes(target)) return join(plansDir, target);
  }

  // When a ticket key is supplied, require the filename to reference it.
  // Without this scoping, a leftover `pr-review-*.md` from a prior ticket
  // (e.g. sibling in the same stack, or an aborted run) wins the match and
  // we end up posting a stale summary against the wrong PR.
  if (ticketKey) {
    const escapedKey = ticketKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const scoped = new RegExp(
      `^(pr-review-|pr-)${escapedKey}([._-].*)?\\.md$`,
      "i",
    );
    const match = files.find((f) => scoped.test(f));
    return match ? join(plansDir, match) : null;
  }

  const match = files.find((f) => f.match(/^pr-review-.*\.md$/));
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
  const planFile = findReviewPlanFile(plansDir, ticketKey, branch);
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
