#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { driftCheck } from "../lib/drift-check.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: drift-check <TICKET_KEY> [--repo-root <path>] [--lite]\n" +
      "\n" +
      "Parses the ticket's `h2. Implementation Notes` block and verifies it\n" +
      "against the working tree. Default (full) mode runs:\n" +
      "  - Citation well-formedness (path, line range, baseline reachability)\n" +
      "  - Citation line-range diff (existing behavior)\n" +
      "  - Symbol presence for each `*Existing patterns to extend:*` bullet\n" +
      "  - Path existence for `*Files likely to change:*` bullets\n" +
      "  - Path existence for `*Tests likely to extend:*` bullets\n" +
      "  - TDD Reference path + anchor still resolve at HEAD\n" +
      "  - Per-repo sidecar files referenced by Research baseline\n" +
      "\n" +
      "Output JSON (full mode):\n" +
      "  { ticket, status, baseline,\n" +
      "    citations[], patterns[], filesLikelyToChange[], testsLikelyToExtend[],\n" +
      "    tddRef, sidecars[], constraintsRaw,\n" +
      "    drifted, unknown, total, mode }\n" +
      "  status ∈ 'no-notes' | 'current' | 'drifted'\n" +
      "\n" +
      "Pass --lite to run only the legacy citation line-range diff (cheaper\n" +
      "but doesn't catch symbol moves, file deletions, or TDD/sidecar issues).\n" +
      "\n" +
      "`constraintsRaw` is passed through unverified — checking whether listed\n" +
      "constraints (anti-patterns, in-flight migrations) are still in flight\n" +
      "needs an LLM pass over the cited region; that's the caller's job.\n" +
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
const lite = args.includes("--lite");

try {
  const result = await driftCheck(ticketKey, { repoRoot, lite });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
