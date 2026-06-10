import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { glob } from "./util.js";

function gitShow(branch, filePath, cwd) {
  try {
    return execSync(`git show ${branch}:${filePath}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function parseChecklist(content) {
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

function parseExecContent(content) {
  const tasks = (content.match(/^- \[[ x]\]/gm) || []).length;
  const completed = (content.match(/^- \[x\]/gm) || []).length;
  return { total: tasks, completed };
}

function parseReviewContent(content) {
  const issues = (content.match(/^- \[[ x]\]/gm) || []).length;
  const resolved = (content.match(/^- \[x\]/gm) || []).length;
  return { total: issues, resolved, open: issues - resolved };
}

export function parsePlanSections(content) {
  const sections = [];
  let currentSection = null;

  for (const line of content.split("\n")) {
    const headingMatch = line.match(/^#{2,4}\s+(.+)/);
    if (headingMatch) {
      currentSection = { title: headingMatch[1], tasks: [] };
      sections.push(currentSection);
      continue;
    }

    const taskMatch = line.match(/^- \[([ x])\] (.+)$/);
    if (taskMatch && currentSection) {
      currentSection.tasks.push({
        done: taskMatch[1] === "x",
        label: taskMatch[2],
      });
    }
  }

  return sections.filter((s) => s.tasks.length > 0);
}

export function readChecklist(
  worktreeDir,
  ticketKey,
  { branch, repoRoot } = {},
) {
  const relPath = `.claude/plans/ticket-work-${ticketKey}.md`;

  if (worktreeDir) {
    const path = join(worktreeDir, relPath);
    if (existsSync(path)) {
      return parseChecklist(readFileSync(path, "utf-8"));
    }
  }

  if (branch && repoRoot) {
    const content = gitShow(branch, relPath, repoRoot);
    if (content) return parseChecklist(content);
  }

  return null;
}

export function readReviewPlan(
  worktreeDir,
  ticketKey,
  { branch, repoRoot } = {},
) {
  if (!ticketKey) return null;
  const escapedKey = ticketKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reviewPattern = new RegExp(
    `^(pr-review-|pr-)${escapedKey}(\\.md|[-_].*\\.md)$`,
  );

  if (worktreeDir) {
    const plansDir = join(worktreeDir, ".claude", "plans");
    if (existsSync(plansDir)) {
      const files = glob(plansDir, reviewPattern);
      if (files.length) {
        const content = readFileSync(join(plansDir, files[0]), "utf-8");
        return parseReviewContent(content);
      }
    }
  }

  if (branch && repoRoot) {
    const lsResult = gitShow(branch, ".claude/plans", repoRoot);
    if (lsResult) {
      const match = lsResult
        .split(/\s+/)
        .find((name) => reviewPattern.test(name));
      if (match) {
        const content = gitShow(branch, `.claude/plans/${match}`, repoRoot);
        if (content) return parseReviewContent(content);
      }
    }
  }

  return null;
}

export function readExecutionPlan(
  worktreeDir,
  ticketKey,
  { branch, repoRoot } = {},
) {
  const relPath = `.claude/plans/jira-${ticketKey}.md`;

  if (worktreeDir) {
    const path = join(worktreeDir, relPath);
    if (existsSync(path)) {
      return parseExecContent(readFileSync(path, "utf-8"));
    }
  }

  if (branch && repoRoot) {
    const content = gitShow(branch, relPath, repoRoot);
    if (content) return parseExecContent(content);
  }

  return null;
}

export function readExecutionPlanRaw(
  worktreeDir,
  ticketKey,
  { branch, repoRoot } = {},
) {
  const relPath = `.claude/plans/jira-${ticketKey}.md`;

  if (worktreeDir) {
    const path = join(worktreeDir, relPath);
    if (existsSync(path)) {
      return readFileSync(path, "utf-8");
    }
  }

  if (branch && repoRoot) {
    return gitShow(branch, relPath, repoRoot);
  }

  return null;
}
