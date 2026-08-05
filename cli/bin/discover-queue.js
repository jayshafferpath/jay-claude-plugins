#!/usr/bin/env node

// @legacy — no in-repo caller as of the ticket-work diet.
//
// `/ticket-work` dropped its queue-discovery mode (bare invocation) and its
// Story→subtask expansion; `/orchestrate` owns finding eligible work now, and
// `agents/planner.md` forbids code-touching Subtasks outright. This script and
// the `queue.js` helpers behind it are retained because the dashboard and README
// still speak the queue vocabulary — unpicking that is a separate change.
//
// Safe to delete once nothing references parent/subtask queue discovery.

import { loadEnv } from "../lib/env.js";

loadEnv();

import { applyParentInheritance, discoverQueue } from "../lib/queue.js";

const args = process.argv.slice(2);

if (args.includes("--help")) {
  console.error(
    "Usage: discover-queue [--apply-inheritance]\n" +
      "\n" +
      "Runs the three Q2 JQL queries (ready / parent / in-flight), expands parent\n" +
      "Stories/Tasks into eligible subtasks, and emits a deduped JSON list:\n" +
      "  { tickets, parents, subtaskExpansions }\n" +
      "\n" +
      "Pass --apply-inheritance to additionally apply Q2e: copy parent labels and\n" +
      "assignee onto each newly-promoted subtask before printing the result.\n",
  );
  process.exit(args.includes("--help") ? 0 : 1);
}

try {
  const result = await discoverQueue();

  if (args.includes("--apply-inheritance")) {
    const applied = await applyParentInheritance(result.subtaskExpansions);
    result.inheritanceApplied = applied;
  }

  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
