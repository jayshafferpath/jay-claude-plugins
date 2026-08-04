import { loadEnv } from "../../cli/lib/env.js";
loadEnv();

import Fastify from "fastify";
import cors from "@fastify/cors";
import { searchIssues, getIssue, swapLabel, getComments, addComment, getPrFromDevStatus } from "../../cli/lib/jira.js";
import {
  findBranch,
  findWorktree,
  getFeatureBranchMergeOrder,
  getPrDetails,
  getPrDiffStat,
} from "../../cli/lib/git.js";
import {
  readActivityLog,
  readChecklistFromJira,
  readExecutionPlanFromJira,
  readPlanSectionsFromJira,
} from "../../cli/lib/checklist.js";
import { extractTextFromAdf } from "../../cli/lib/adf.js";
import {
  attachFeatureBranches,
  buildStacks as buildStacksCore,
} from "../../cli/lib/stacks.js";
import { labelState, actionHint, resolveRepoRoot } from "../../cli/lib/util.js";
import { loadDevRoot, getJiraAuth } from "../../cli/lib/config.js";

const DEV_ROOT = loadDevRoot();
const JIRA_DOMAIN = getJiraAuth()?.domain || null;
const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

async function buildStacks(issues) {
  const stacks = buildStacksCore(issues);

  await attachFeatureBranches(stacks);

  for (const stack of stacks) {
    if (stack.featureBranch) {
      const repoRoot = resolveRepoRoot(
        stack.tickets[0]?.labels || [],
        DEV_ROOT,
      );
      if (repoRoot) {
        stack.mergeOrder = getFeatureBranchMergeOrder(
          stack.featureBranch,
          repoRoot,
        );
      }
    }
  }

  const allTickets = stacks.flatMap((s) => s.tickets);
  await Promise.all(
    allTickets.map(async (ticket) => {
      const pr = await getPrFromDevStatus(ticket.key);
      ticket.pr = pr ? { url: pr.url, state: pr.state } : null;
    }),
  );

  // Display state resolves after the PR fetch so "PR open" can come from the
  // live PR rather than a label.
  for (const ticket of allTickets) {
    const state = labelState(ticket.labels, {
      openPr: ticket.pr?.state === "OPEN" ? ticket.pr : null,
      statusName: ticket.statusName,
    });
    ticket.state = state.display;
    ticket.stateLabel = state.label;
    ticket.actionHint = actionHint(state.label);
  }

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

  const repoRoot = resolveRepoRoot(labels, DEV_ROOT);

  const branch = findBranch(key, repoRoot);
  const worktree = findWorktree(key, repoRoot);
  const pr = await getPrFromDevStatus(key);
  const checklist = await readChecklistFromJira(key);
  const execPlan = await readExecutionPlanFromJira(key);
  const reviewPlan = null;
  const state = labelState(labels, {
    openPr: pr?.state === "OPEN" ? pr : null,
    statusName: status,
  });

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

function flattenActivityBody(bodyNodes) {
  const blocks = [];
  for (const node of bodyNodes || []) {
    if (node.type === "paragraph") {
      const text = extractTextFromAdf(node).trim();
      if (text) blocks.push({ kind: "paragraph", text });
    } else if (node.type === "bulletList") {
      const items = (node.content || [])
        .map((item) => extractTextFromAdf(item).trim())
        .filter(Boolean);
      if (items.length) blocks.push({ kind: "bullets", items });
    }
  }
  return blocks;
}

function parseEntryHeading(text) {
  const match = text.match(/^(\S+)\s+—\s+(.+)$/);
  if (!match) return { timestamp: null, heading: text };
  return { timestamp: match[1], heading: match[2] };
}

app.get("/api/tickets/:key/activity", async (request) => {
  const { key } = request.params;
  const result = await readActivityLog(key);
  if (!result) return { found: false, entries: [] };

  const entries = result.entries.map((entry) => {
    const { timestamp, heading } = parseEntryHeading(entry.heading);
    return {
      timestamp,
      heading,
      blocks: flattenActivityBody(entry.bodyNodes),
    };
  });

  return { found: true, entries };
});

app.get("/api/tickets/:key/pr-details", async (request) => {
  const { key } = request.params;
  const issue = await getIssue(key);
  const labels = issue.fields.labels || [];
  const repoRoot = resolveRepoRoot(labels, DEV_ROOT);

  const branch = findBranch(key, repoRoot);
  const worktree = findWorktree(key, repoRoot);
  const cwd = repoRoot || worktree;

  if (branch && cwd) {
    const details = getPrDetails(branch, cwd);
    if (details) {
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
    }
  }

  const pr = await getPrFromDevStatus(key);
  if (!pr) return { found: false };

  return {
    found: true,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    headRef: null,
    baseRef: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    mergeable: null,
    reviewDecision: null,
    checks: [],
    reviews: [],
    diffStat: null,
  };
});

const REVIEW_REQUESTED_MARKER = "[claude-review-requested]";

app.post("/api/tickets/:key/request-review", async (request) => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return { ok: false, error: "SLACK_WEBHOOK_URL not set" };
  }

  const { key } = request.params;
  const pr = await getPrFromDevStatus(key);

  if (!pr) {
    return { ok: false, error: "No PR found for this ticket" };
  }

  const comments = await getComments(key);
  const alreadyRequested = comments.find((c) => {
    const text = JSON.stringify(c.body);
    return text.includes(REVIEW_REQUESTED_MARKER) && text.includes(pr.url);
  });

  if (alreadyRequested) {
    return { ok: true, alreadyRequested: true };
  }

  const text = `:pr-review-request: ${pr.title || key}\n${pr.url}`;

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
          { type: "text", text: `Review requested: ${pr.url}` },
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
