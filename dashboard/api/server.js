import { loadEnv } from "../../cli/lib/env.js";
loadEnv();

import Fastify from "fastify";
import cors from "@fastify/cors";
import { searchIssues, getIssue, swapLabel, getComments, addComment } from "../../cli/lib/jira.js";
import {
  findBranch,
  findWorktree,
  getPrInfo,
  getPrDetails,
  getPrDiffStat,
} from "../../cli/lib/git.js";
import {
  readChecklistFromJira,
  readExecutionPlanFromJira,
  readPlanSectionsFromJira,
} from "../../cli/lib/checklist.js";
import { labelState, actionHint, topologicalSort } from "../../cli/lib/util.js";
import { loadDevRoot, getJiraAuth } from "../../cli/lib/config.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const DEV_ROOT = loadDevRoot();
const JIRA_DOMAIN = getJiraAuth()?.domain || null;
const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

async function buildStacks(issues) {
  const containerCache = new Map();
  const containerLabels = new Map();
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
          l.outwardIssue?.fields?.issuetype?.name === "Epic"
      );
      if (epicLink?.outwardIssue) {
        containerKey = epicLink.outwardIssue.key;
        containerCache.set(
          containerKey,
          epicLink.outwardIssue.fields?.summary || ""
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
            i.fields.labels?.includes("ClaudeNeedsReview"))
      );

    const unfinishedBlockers = blockers.filter(
      (b) => issues.some((i) => i.key === b) && !isFinished(b)
    );

    const state = labelState(labels);

    grouped.get(containerKey).push({
      key,
      summary: fields.summary,
      labels,
      blockers,
      blocks,
      waitingOn: unfinishedBlockers.length ? unfinishedBlockers[0] : null,
      state: state.display,
      stateLabel: state.label,
      actionHint: actionHint(state.label),
    });
  }

  const containerKeys = [...grouped.keys()].filter((k) => k !== "Standalone");
  await Promise.all(
    containerKeys.map(async (key) => {
      try {
        const issue = await getIssue(key);
        containerLabels.set(key, issue.fields.labels || []);
      } catch {
        containerLabels.set(key, []);
      }
    })
  );

  const allTickets = [...grouped.values()].flat();
  await Promise.all(
    allTickets.map(async (ticket) => {
      const repoLabel = ticket.labels.find((l) => l.startsWith("repo:"));
      let repoRoot = null;
      if (repoLabel && DEV_ROOT) {
        const repoName = repoLabel.slice(5);
        const candidate = join(DEV_ROOT, repoName);
        if (existsSync(candidate)) repoRoot = candidate;
      }
      const branch = findBranch(ticket.key, repoRoot);
      const worktree = findWorktree(ticket.key, repoRoot);
      const pr = getPrInfo(branch, repoRoot || worktree);
      ticket.pr = pr ? { url: pr.url, state: pr.state } : null;
    })
  );

  const stacks = [];
  for (const [containerKey, tickets] of grouped) {
    const sorted = topologicalSort(tickets, blockingLinks);
    const orderedTickets = sorted
      .map((k) => tickets.find((t) => t.key === k))
      .filter(Boolean);
    const remaining = tickets.filter((t) => !sorted.includes(t.key));

    const labels = containerLabels.get(containerKey) || [];
    const branchLabel = labels.find((l) => l.startsWith("branch:"));
    const featureBranch = branchLabel ? branchLabel.slice(7) : null;

    stacks.push({
      containerKey,
      containerSummary: containerCache.get(containerKey) || "",
      featureBranch,
      tickets: [...orderedTickets, ...remaining],
    });
  }

  stacks.sort((a, b) => a.containerKey.localeCompare(b.containerKey));
  return stacks;
}

app.get("/api/stacks", async () => {
  const issues = await searchIssues(
    'labels = "ClaudeWork" AND assignee = currentUser() AND statusCategory != Done',
    ["key", "summary", "status", "labels", "issuelinks", "parent", "issuetype"]
  );
  const filtered = issues.filter(
    (i) => i.fields.issuetype?.name !== "Epic"
  );
  const stacks = await buildStacks(filtered);
  return {
    jiraBaseUrl: JIRA_DOMAIN ? `https://${JIRA_DOMAIN}/browse` : null,
    stacks,
  };
});

app.get("/api/tickets/:key", async (request) => {
  const { key } = request.params;
  const issue = await getIssue(key);
  const fields = issue.fields;
  const labels = fields.labels || [];
  const status = fields.status?.name || "Unknown";

  const parent = fields.parent;
  const isSubtask = ["Sub-task", "Subtask"].includes(
    fields.issuetype?.name || ""
  );
  let stack = null;
  if (isSubtask && parent) {
    stack = { key: parent.key, summary: parent.fields?.summary || "" };
  }

  const blockedBy = (fields.issuelinks || [])
    .filter((l) => l.type?.inward === "is blocked by" && l.inwardIssue)
    .map((l) => l.inwardIssue.key);

  const blocks = (fields.issuelinks || [])
    .filter((l) => l.type?.outward === "blocks" && l.outwardIssue)
    .map((l) => l.outwardIssue.key);

  let repoRoot = null;
  const repoLabel = labels.find((l) => l.startsWith("repo:"));
  if (repoLabel && DEV_ROOT) {
    const repoName = repoLabel.slice(5);
    const candidate = join(DEV_ROOT, repoName);
    if (existsSync(candidate)) repoRoot = candidate;
  }

  const branch = findBranch(key, repoRoot);
  const worktree = findWorktree(key, repoRoot);
  const pr = getPrInfo(branch, repoRoot || worktree);
  const checklist = await readChecklistFromJira(key);
  const execPlan = await readExecutionPlanFromJira(key);
  const reviewPlan = null;
  const state = labelState(labels);

  return {
    key,
    summary: fields.summary,
    status,
    labels,
    stack,
    blockedBy,
    blocks,
    branch,
    worktree,
    pr,
    checklist,
    reviewPlan,
    execPlan,
    state: state.display,
    stateLabel: state.label,
    actionHint: actionHint(state.label),
  };
});

app.post("/api/tickets/:key/approve-plan", async (request) => {
  const { key } = request.params;
  await swapLabel(key, "ClaudePlanNeedsApproval", "ClaudePlanApproved");
  return { ok: true, action: "plan approved" };
});

app.post("/api/tickets/:key/approve-pr", async (request) => {
  const { key } = request.params;
  await swapLabel(key, "ClaudeStackReady", "ClaudePRApproved");
  return { ok: true, action: "PR approved" };
});

app.get("/api/tickets/:key/plan", async (request) => {
  const { key } = request.params;
  const planData = await readPlanSectionsFromJira(key);

  if (!planData) {
    return { found: false, content: null };
  }

  const implementation = planData.sections.flatMap((s) => s.tasks);

  return {
    found: true,
    status: null,
    summary: null,
    acceptance: [],
    implementation,
    sections: planData.sections,
    raw: null,
  };
});

app.get("/api/tickets/:key/pr-details", async (request) => {
  const { key } = request.params;
  const issue = await getIssue(key);
  const labels = issue.fields.labels || [];

  let repoRoot = null;
  const repoLabel = labels.find((l) => l.startsWith("repo:"));
  if (repoLabel && DEV_ROOT) {
    const repoName = repoLabel.slice(5);
    const candidate = join(DEV_ROOT, repoName);
    if (existsSync(candidate)) repoRoot = candidate;
  }

  const branch = findBranch(key, repoRoot);
  const worktree = findWorktree(key, repoRoot);
  const cwd = repoRoot || worktree;

  if (!branch || !cwd) {
    return { found: false };
  }

  const details = getPrDetails(branch, cwd);
  if (!details) {
    return { found: false };
  }

  const diffStat = getPrDiffStat(branch, cwd);

  return {
    found: true,
    number: details.number,
    url: details.url,
    title: details.title,
    state: details.state,
    headRef: details.headRefName,
    baseRef: details.baseRefName,
    additions: details.additions,
    deletions: details.deletions,
    changedFiles: details.changedFiles,
    mergeable: details.mergeable,
    reviewDecision: details.reviewDecision,
    checks: (details.statusCheckRollup || []).map((c) => ({
      name: c.name || c.context,
      status: c.status,
      conclusion: c.conclusion,
    })),
    reviews: (details.reviews || []).map((r) => ({
      author: r.author?.login,
      state: r.state,
    })),
    diffStat,
  };
});

const REVIEW_REQUESTED_MARKER = "[claude-review-requested]";

app.post("/api/tickets/:key/request-review", async (request) => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return { ok: false, error: "SLACK_WEBHOOK_URL not set" };
  }

  const { key } = request.params;
  const issue = await getIssue(key);
  const labels = issue.fields.labels || [];

  let repoRoot = null;
  const repoLabel = labels.find((l) => l.startsWith("repo:"));
  if (repoLabel && DEV_ROOT) {
    const repoName = repoLabel.slice(5);
    const candidate = join(DEV_ROOT, repoName);
    if (existsSync(candidate)) repoRoot = candidate;
  }

  const branch = findBranch(key, repoRoot);
  const worktree = findWorktree(key, repoRoot);
  const cwd = repoRoot || worktree;
  const details = cwd && branch ? getPrDetails(branch, cwd) : null;

  if (!details) {
    return { ok: false, error: "No PR found for this ticket" };
  }

  const comments = await getComments(key);
  const alreadyRequested = comments.find((c) => {
    const text = JSON.stringify(c.body);
    return text.includes(REVIEW_REQUESTED_MARKER) && text.includes(details.url);
  });

  if (alreadyRequested) {
    return { ok: true, alreadyRequested: true };
  }

  const text = `:pr-review-request: ${details.title}\n${details.url}`;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    return { ok: false, error: `Slack responded ${res.status}` };
  }

  await addComment(key, {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: `${REVIEW_REQUESTED_MARKER} `, marks: [{ type: "code" }] },
          { type: "text", text: `Review requested: ${details.url}` },
        ],
      },
    ],
  });

  return { ok: true };
});

app.listen({ port: 3789 }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
