import { loadEnv } from "../../cli/lib/env.js";
loadEnv();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { searchIssues, getIssue, getComments, addComment, getPrFromDevStatus } from "../../cli/lib/jira.js";
import {
  findBranch,
  findWorktree,
  getFeatureBranchMergeOrder,
  getPrDetails,
  getPrDiffStat,
  getWorktreeList,
} from "../../cli/lib/git.js";
import { classifyWorktrees } from "../../cli/lib/dashboard-hygiene.js";
import {
  groupByDay,
  mergeTimeline,
} from "../../cli/lib/dashboard-timeline.js";
import {
  attachBranches,
  attachFreshness,
  attachRepoIdentity,
  attachSignals,
  collectRepoSignals,
  groupTicketsByRepo,
} from "../../cli/lib/dashboard-signals.js";
import { buildDashboardView } from "../../cli/lib/dashboard-view.js";
import {
  isExecutionEnabled,
  resolveAction,
  validateActionRequest,
} from "../../cli/lib/dashboard-actions.js";
import {
  findRunningJobForTicket,
  getJob,
  listJobs,
  serializeJob,
  startCommandJob,
} from "./run-command.js";
import { driftCheck } from "../../cli/lib/drift-check.js";
import { discoverQueue } from "../../cli/lib/queue.js";
import {
  diffBacklog,
  pendingInheritance,
} from "../../cli/lib/dashboard-backlog.js";
import { isInFlight } from "../../cli/lib/labels.js";
import {
  readActivityLog,
  readChecklistFromJira,
  readExecutionPlanFromJira,
  readPlanSectionsFromJira,
} from "../../cli/lib/checklist.js";
import { extractTextFromAdf } from "../../cli/lib/adf.js";
import {
  findReviewPlanFile,
  formatSummary,
} from "../../cli/lib/review-summary.js";
import {
  attachFeatureBranches,
  buildStacks as buildStacksCore,
} from "../../cli/lib/stacks.js";
import { labelState, resolveRepoRoot } from "../../cli/lib/util.js";
import { loadDevRoot, getJiraAuth } from "../../cli/lib/config.js";

const DEV_ROOT = loadDevRoot();
const JIRA_DOMAIN = getJiraAuth()?.domain || null;
const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

// Assemble the stacks snapshot.
//
// All git/gh probing is batched per repo (see dashboard-signals) rather than
// per ticket: the old implementation made two Jira round-trips per ticket via
// getPrFromDevStatus on every 10s poll. `repo:` labels mean one stack can span
// repos, so signals are collected per resolved repo root.
async function buildStacks(issues) {
  const stacks = buildStacksCore(issues);

  await attachFeatureBranches(stacks);

  const allTickets = stacks.flatMap((s) => s.tickets);
  const inFlightKeys = new Set(
    allTickets.filter((t) => isInFlight(t.labels || [])).map((t) => t.key),
  );

  // Which repo each ticket lives in. A stack can span repos via `repo:` labels,
  // so this is per ticket rather than per stack.
  attachRepoIdentity(allTickets, DEV_ROOT);

  // Feature-branch → merge order, and the repo each stack lives in. Both are
  // per-stack, so they stay outside the per-repo signal loop.
  const rootByStack = new Map();
  for (const stack of stacks) {
    const repoRoot = resolveRepoRoot(stack.tickets[0]?.labels || [], DEV_ROOT);
    rootByStack.set(stack, repoRoot);
    if (stack.featureBranch && repoRoot) {
      stack.mergeOrder = getFeatureBranchMergeOrder(
        stack.featureBranch,
        repoRoot,
      );
    }
  }

  // One set of probes per repo, shared by every ticket in it.
  const byRepo = groupTicketsByRepo(allTickets, DEV_ROOT);
  const signalsByRoot = new Map();
  for (const [repoRoot, tickets] of byRepo) {
    const signals = collectRepoSignals(repoRoot);
    signalsByRoot.set(repoRoot, signals);
    attachBranches(tickets, repoRoot);
  }

  for (const stack of stacks) {
    const repoRoot = rootByStack.get(stack);
    const signals = signalsByRoot.get(repoRoot);
    if (!signals) continue;
    attachSignals(stack.tickets, signals, {
      featureBranch: stack.featureBranch,
    });
    attachFreshness(stack.tickets, repoRoot, { inFlightKeys });
  }

  // Display state resolves after the PR fetch so "PR open" can come from the
  // live PR rather than a label.
  for (const ticket of allTickets) {
    const state = labelState(ticket.labels, {
      openPr: ticket.pr?.state === "OPEN" ? ticket.pr : null,
      statusName: ticket.statusName,
    });
    ticket.state = state.display;
    ticket.stateLabel = state.label;
  }

  return stacks;
}

const STACK_FIELDS = [
  "key",
  "summary",
  "status",
  "labels",
  "issuelinks",
  "parent",
  "issuetype",
  "updated",
];

// The full decorated snapshot: Jira → stacks → classifier + stagnation.
//
// Shared by /api/stacks and the action endpoints. Those endpoints re-derive it
// rather than trusting the action name the browser sent, so a button clicked
// against a stale render can't run a command the ticket no longer needs.
async function buildSnapshot() {
  const issues = await searchIssues(
    'labels = "ClaudeWork" AND assignee = currentUser() AND statusCategory != Done',
    STACK_FIELDS,
  );
  const filtered = issues.filter((i) => i.fields.issuetype?.name !== "Epic");
  const stacks = await buildStacks(filtered);

  // `now` is injected rather than read inside the lib so the rules stay
  // deterministic under test.
  const view = buildDashboardView({ stacks, now: Date.now() });

  // What command each ticket's next action maps to. Attached server-side so the
  // UI doesn't re-derive the lifecycle's command names.
  for (const stack of view.stacks) {
    for (const ticket of stack.tickets) {
      ticket.action = resolveAction(ticket);
    }
  }

  return view;
}

app.get("/api/stacks", async () => {
  const view = await buildSnapshot();

  return {
    jiraBaseUrl: JIRA_DOMAIN ? `https://${JIRA_DOMAIN}/browse` : null,
    stacks: view.stacks,
    queues: view.queues,
    stagnation: view.stagnation,
    // Lets the UI show why an action button is absent rather than silently
    // hiding it.
    actionsEnabled: isExecutionEnabled(),
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
  const reviewPlan = readReviewPlan(key, repoRoot);
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

// Review-plan progress for the detail panel. The plan is a markdown file under
// the repo's .plans/ directory written by /jay-pr-review, so this needs the
// ticket's resolved repo root — no repo, no plan.
//
// Returns the { resolved, total } shape TicketDetail renders, or null when
// there is no plan file or it contains no checklist items.
function readReviewPlan(ticketKey, repoRoot) {
  if (!repoRoot) return null;
  try {
    const planFile = findReviewPlanFile(join(repoRoot, ".plans"), ticketKey);
    if (!planFile) return null;
    const { issuesFound, issuesResolved } = formatSummary(
      readFileSync(planFile, "utf-8"),
    );
    if (!issuesFound) return null;
    return { total: issuesFound, resolved: issuesResolved };
  } catch {
    return null;
  }
}

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

// On-demand drift check. Deliberately POST and never called from the polling
// path: driftCheck spawns git operations per citation, so it must stay a
// user-initiated action rather than something the 10s refresh triggers.
app.post("/api/tickets/:key/drift-check", async (request) => {
  const { key } = request.params;
  const issue = await getIssue(key);
  const repoRoot = resolveRepoRoot(issue.fields.labels || [], DEV_ROOT);

  if (!repoRoot) {
    return { ok: false, error: "No repo: label resolves to a local clone" };
  }

  try {
    const report = await driftCheck(key, { repoRoot, lite: true });
    return { ok: true, report };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Run the mechanical next action for a ticket.
//
// Gated three ways, because these commands delete remote branches and transition
// Jira:
//   1. DASHBOARD_ALLOW_ACTIONS=true must be set (validateActionRequest)
//   2. the ticket's *live* classification must still want this action, so a
//      click on a stale render is rejected rather than replayed
//   3. only one run per ticket at a time
//
// Returns a job id; the command takes minutes, so the UI polls /api/jobs/:id.
app.post("/api/tickets/:key/run-action", async (request, reply) => {
  const { key } = request.params;
  const requestedAction = request.body?.action || null;

  const view = await buildSnapshot();
  const ticket = view.stacks
    .flatMap((s) => s.tickets)
    .find((t) => t.key === key);

  const validation = validateActionRequest({
    ticket,
    action: requestedAction,
    env: process.env,
  });

  if (!validation.ok) {
    reply.code(400);
    return { ok: false, error: validation.error };
  }

  const existing = findRunningJobForTicket(key);
  if (existing) {
    reply.code(409);
    return {
      ok: false,
      error: `A command is already running for ${key}`,
      jobId: existing.id,
    };
  }

  // Commands operate on branches and worktrees, so they must run in the
  // ticket's repo rather than the dashboard's own directory.
  const repoRoot = resolveRepoRoot(ticket.labels || [], DEV_ROOT);
  if (!repoRoot) {
    reply.code(400);
    return {
      ok: false,
      error: "No repo: label resolves to a local clone",
    };
  }

  const job = startCommandJob({
    ticketKey: key,
    prompt: validation.prompt,
    cwd: repoRoot,
    now: new Date().toISOString(),
  });

  return { ok: true, job: serializeJob(job) };
});

app.get("/api/jobs", async () => ({
  actionsEnabled: isExecutionEnabled(),
  jobs: listJobs()
    .map((job) => serializeJob(job))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
}));

app.get("/api/jobs/:id", async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job) {
    reply.code(404);
    return { ok: false, error: "Unknown job" };
  }
  return { ok: true, job: serializeJob(job, { includeLog: true }) };
});

// Eligible work the board's own JQL can't see.
//
// Deliberately its own endpoint rather than folded into /api/stacks: discoverQueue
// costs three Jira searches plus one per ClaudeReady parent, which has no place
// in a 10s poll. The UI fetches this on load and on demand.
app.get("/api/backlog", async () => {
  const queue = await discoverQueue();

  // What the board already shows, so the backlog lists only what it's missing.
  const view = await buildSnapshot();
  const knownKeys = new Set(
    view.stacks.flatMap((s) => s.tickets).map((t) => t.key),
  );

  const backlog = diffBacklog({ queue, knownKeys });

  return {
    tickets: backlog.tickets,
    counts: backlog.counts,
    pendingInheritance: pendingInheritance(queue),
  };
});

// Worktrees left on disk that no active ticket claims.
//
// One `git worktree list` per repo the board touches. On demand rather than
// polled: stale worktrees accumulate over days, so there's no value in checking
// every 10 seconds.
app.get("/api/hygiene", async () => {
  const view = await buildSnapshot();
  const allTickets = view.stacks.flatMap((s) => s.tickets);
  const activeKeys = new Set(allTickets.map((t) => t.key));

  // Group by repo so each root is probed once even when several stacks share it.
  const byRepo = groupTicketsByRepo(allTickets, DEV_ROOT);
  const repos = [];

  for (const repoRoot of byRepo.keys()) {
    if (!repoRoot) continue;
    const result = classifyWorktrees({
      worktrees: getWorktreeList(repoRoot),
      activeKeys,
      repoRoot,
    });
    repos.push({
      repoRoot,
      name: repoRoot.split("/").filter(Boolean).pop(),
      ...result,
    });
  }

  return {
    repos,
    counts: {
      orphaned: repos.reduce((n, r) => n + r.counts.orphaned, 0),
      total: repos.reduce((n, r) => n + r.counts.total, 0),
    },
  };
});

// Every ticket's activity log, interleaved into one stream.
//
// Costs one Jira round-trip per ticket on the board, so it's on demand rather
// than polled. Answers "what did the agents do overnight?", which the per-ticket
// panels structurally can't.
app.get("/api/timeline", async (request) => {
  const limit = Number.parseInt(request.query?.limit || "150", 10);

  const view = await buildSnapshot();
  const tickets = view.stacks.flatMap((s) => s.tickets);

  // Fetched concurrently: these are independent reads, and serially they'd take
  // one round-trip per ticket in sequence.
  const logs = await Promise.all(
    tickets.map(async (ticket) => {
      try {
        const result = await readActivityLog(ticket.key);
        if (!result) return null;
        return {
          key: ticket.key,
          summary: ticket.summary,
          entries: result.entries.map((entry) => {
            const { timestamp, heading } = parseEntryHeading(entry.heading);
            return {
              timestamp,
              heading,
              blocks: flattenActivityBody(entry.bodyNodes),
            };
          }),
        };
      } catch {
        // One unreadable log shouldn't blank the whole timeline.
        return null;
      }
    }),
  );

  const present = logs.filter(Boolean);
  const timeline = mergeTimeline({ logs: present, limit });

  // Summaries so the UI can label a ticket key without another fetch.
  const summaries = Object.fromEntries(
    present.map((log) => [log.key, log.summary]),
  );

  return {
    days: groupByDay(timeline.entries),
    counts: timeline.counts,
    summaries,
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

// Overridable so a second instance can run alongside the usual one — useful for
// trying a change without stopping the dashboard you're working from.
const PORT = Number.parseInt(process.env.DASHBOARD_PORT || "3789", 10);

app.listen({ port: PORT }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
