import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { glob } from "./util.js";

export function readChecklist(worktreeDir, ticketKey) {
  if (!worktreeDir) return null;
  const path = join(worktreeDir, ".claude", "plans", `ticket-work-${ticketKey}.md`);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf-8");
  const steps = [];
  const stepRegex = /^- \[([ x])\] (\d+)\. (.+)$/gm;
  let match;
  while ((match = stepRegex.exec(content)) !== null) {
    steps.push({
      num: parseInt(match[2], 10),
      done: match[1] === "x",
      label: match[3],
    });
  }

  const frontmatter = {};
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const [key, ...rest] = line.split(":");
      if (key && rest.length) {
        frontmatter[key.trim()] = rest.join(":").trim();
      }
    }
  }

  return { steps, frontmatter };
}

export function readReviewPlan(worktreeDir, ticketKey) {
  if (!worktreeDir) return null;
  const plansDir = join(worktreeDir, ".claude", "plans");
  if (!existsSync(plansDir)) return null;

  const files = glob(plansDir, /^(pr-review-|pr-.*).md$/);
  if (!files.length) return null;

  const content = readFileSync(join(plansDir, files[0]), "utf-8");
  const issues = (content.match(/^- \[[ x]\]/gm) || []).length;
  const resolved = (content.match(/^- \[x\]/gm) || []).length;
  return { total: issues, resolved, open: issues - resolved };
}

export function readExecutionPlan(worktreeDir, ticketKey) {
  if (!worktreeDir) return null;
  const path = join(worktreeDir, ".claude", "plans", `jira-${ticketKey}.md`);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf-8");
  const tasks = (content.match(/^- \[[ x]\]/gm) || []).length;
  const completed = (content.match(/^- \[x\]/gm) || []).length;
  return { total: tasks, completed };
}
