#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { driftCheck } from "../lib/drift-check.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: drift-check <TICKET_KEY> [--repo-root <path>]\n" +
      "\n" +
      "Parses the ticket's `h2. Implementation Notes` block, extracts cited\n" +
      "permalinks, and diffs each cited line range against the recorded baseline\n" +
      "SHA. Outputs a structured JSON report; agent-side refresh (re-running\n" +
      "research, composing new notes) is the caller's responsibility.\n" +
      "\n" +
      "Output JSON:\n" +
      "  { ticket, status, baseline, citations[], drifted, unknown, total }\n" +
      "  status ∈ 'no-notes' | 'current' | 'drifted'\n" +
      "  citations[].status ∈ 'current' | 'drifted' | 'unknown'\n" +
      "\n" +
      "Exit code is 0 (regardless of drift) so callers can branch on the JSON.\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const ticketKey = args[0]?.toUpperCase();
const repoRoot = getFlag("--repo-root");

try {
  const result = await driftCheck(ticketKey, { repoRoot });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
