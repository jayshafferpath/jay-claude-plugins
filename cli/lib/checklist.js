import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { glob } from "./util.js";
import { getComments, addComment, updateComment } from "./jira.js";

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

export function readChecklist(worktreeDir, ticketKey, { branch, repoRoot } = {}) {
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

export function readReviewPlan(worktreeDir, ticketKey, { branch, repoRoot } = {}) {
  if (worktreeDir) {
    const plansDir = join(worktreeDir, ".claude", "plans");
    if (existsSync(plansDir)) {
      const files = glob(plansDir, /^(pr-review-|pr-.*).md$/);
      if (files.length) {
        const content = readFileSync(join(plansDir, files[0]), "utf-8");
        return parseReviewContent(content);
      }
    }
  }

  if (branch && repoRoot) {
    const lsResult = gitShow(branch, ".claude/plans", repoRoot);
    if (lsResult) {
      const match = lsResult.match(/(pr-review-[^\s]+\.md|pr-[^\s]+\.md)/);
      if (match) {
        const content = gitShow(branch, `.claude/plans/${match[1]}`, repoRoot);
        if (content) return parseReviewContent(content);
      }
    }
  }

  return null;
}

function parseReviewContent(content) {
  const issues = (content.match(/^- \[[ x]\]/gm) || []).length;
  const resolved = (content.match(/^- \[x\]/gm) || []).length;
  return { total: issues, resolved, open: issues - resolved };
}

export function readExecutionPlan(worktreeDir, ticketKey, { branch, repoRoot } = {}) {
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

function parseExecContent(content) {
  const tasks = (content.match(/^- \[[ x]\]/gm) || []).length;
  const completed = (content.match(/^- \[x\]/gm) || []).length;
  return { total: tasks, completed };
}

const CHECKLIST_MARKER = "[claude-checklist-sync]";

function checklistToAdf(steps) {
  const items = steps.map((s) => ({
    type: "listItem",
    content: [{
      type: "paragraph",
      content: [{ type: "text", text: `${s.done ? "✅" : "⬜"} ${s.num}. ${s.label}` }],
    }],
  }));

  return {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: `${CHECKLIST_MARKER} `, marks: [{ type: "code" }] },
          { type: "text", text: "Execution checklist", marks: [{ type: "strong" }] },
        ],
      },
      { type: "bulletList", content: items },
    ],
  };
}

export async function syncChecklistToJira(ticketKey, steps) {
  if (!steps || !steps.length) return;

  const adfBody = checklistToAdf(steps);

  const comments = await getComments(ticketKey);
  const existing = comments.find((c) => {
    const text = JSON.stringify(c.body);
    return text.includes(CHECKLIST_MARKER);
  });

  if (existing) {
    await updateComment(ticketKey, existing.id, adfBody);
  } else {
    await addComment(ticketKey, adfBody);
  }
}

const PLAN_MARKER = "[claude-plan-sync]";

function parsePlanSections(content) {
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

function planToAdf(sections) {
  const content = [
    {
      type: "paragraph",
      content: [
        { type: "text", text: `${PLAN_MARKER} `, marks: [{ type: "code" }] },
        { type: "text", text: "Execution plan", marks: [{ type: "strong" }] },
      ],
    },
  ];

  for (const section of sections) {
    content.push({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: section.title }],
    });

    const items = section.tasks.map((t) => ({
      type: "listItem",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: `${t.done ? "✅" : "⬜"} ${t.label}` }],
      }],
    }));

    content.push({ type: "bulletList", content: items });
  }

  return { version: 1, type: "doc", content };
}

export function readExecutionPlanRaw(worktreeDir, ticketKey, { branch, repoRoot } = {}) {
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

export async function syncPlanToJira(ticketKey, planContent) {
  if (!planContent) return;

  const sections = parsePlanSections(planContent);
  if (!sections.length) return;

  const adfBody = planToAdf(sections);

  const comments = await getComments(ticketKey);
  const existing = comments.find((c) => {
    const text = JSON.stringify(c.body);
    return text.includes(PLAN_MARKER);
  });

  if (existing) {
    await updateComment(ticketKey, existing.id, adfBody);
  } else {
    await addComment(ticketKey, adfBody);
  }
}

function extractTextFromAdf(node) {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (Array.isArray(node.content)) {
    return node.content.map(extractTextFromAdf).join("");
  }
  return "";
}

function extractListItemTexts(adfBody) {
  const texts = [];
  function walk(node) {
    if (!node) return;
    if (node.type === "listItem") {
      texts.push(extractTextFromAdf(node));
      return;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
    }
  }
  walk(adfBody);
  return texts;
}

function parseChecklistFromComment(adfBody) {
  const texts = extractListItemTexts(adfBody);
  const steps = [];
  for (const text of texts) {
    const match = text.match(/^(✅|⬜)\s*(\d+)\.\s*(.+)$/);
    if (match) {
      steps.push({
        num: parseInt(match[2], 10),
        done: match[1] === "✅",
        label: match[3],
      });
    }
  }
  return steps.length ? { steps, frontmatter: {} } : null;
}

function parsePlanFromComment(adfBody) {
  let total = 0;
  let completed = 0;
  const texts = extractListItemTexts(adfBody);
  for (const text of texts) {
    const match = text.match(/^(✅|⬜)\s*.+$/);
    if (match) {
      total++;
      if (match[1] === "✅") completed++;
    }
  }
  return total ? { total, completed } : null;
}

export async function readChecklistFromJira(ticketKey) {
  const comments = await getComments(ticketKey);
  const comment = comments.find((c) => {
    const text = JSON.stringify(c.body);
    return text.includes(CHECKLIST_MARKER);
  });
  if (!comment) return null;
  return parseChecklistFromComment(comment.body);
}

export async function readExecutionPlanFromJira(ticketKey) {
  const comments = await getComments(ticketKey);
  const comment = comments.find((c) => {
    const text = JSON.stringify(c.body);
    return text.includes(PLAN_MARKER);
  });
  if (!comment) return null;
  return parsePlanFromComment(comment.body);
}

export async function readPlanSectionsFromJira(ticketKey) {
  const comments = await getComments(ticketKey);
  const comment = comments.find((c) => {
    const text = JSON.stringify(c.body);
    return text.includes(PLAN_MARKER);
  });
  if (!comment) return null;
  return parsePlanSectionsFromComment(comment.body);
}

function parsePlanSectionsFromComment(adfBody) {
  const sections = [];
  let currentSection = null;

  if (!adfBody || !adfBody.content) return null;

  for (const node of adfBody.content) {
    if (node.type === "heading") {
      currentSection = { title: extractTextFromAdf(node), tasks: [] };
      sections.push(currentSection);
    } else if (node.type === "bulletList" && currentSection) {
      for (const item of node.content || []) {
        const text = extractTextFromAdf(item);
        const match = text.match(/^(✅|⬜)\s*(.+)$/);
        if (match) {
          currentSection.tasks.push({
            done: match[1] === "✅",
            label: match[2],
          });
        }
      }
    }
  }

  const withTasks = sections.filter((s) => s.tasks.length > 0);
  if (!withTasks.length) return null;

  const total = withTasks.reduce((sum, s) => sum + s.tasks.length, 0);
  const completed = withTasks.reduce((sum, s) => sum + s.tasks.filter((t) => t.done).length, 0);

  return { sections: withTasks, total, completed };
}
