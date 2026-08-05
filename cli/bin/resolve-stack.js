#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { resolveStack } from "../lib/stack-resolver.js";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));

const ticketKey = positional[0]?.toUpperCase();

if (!ticketKey || flags.includes("--help")) {
  console.error(
    "Usage: resolve-stack <TICKET_KEY> [--repo-root <path>] [--fetch]",
  );
  process.exit(1);
}

const repoRootIdx = flags.indexOf("--repo-root");
const repoRoot =
  repoRootIdx >= 0 ? args[args.indexOf("--repo-root") + 1] : undefined;
const shouldFetch = flags.includes("--fetch");

try {
  // The fetch is the resolver's job: it knows the repo root even when the caller
  // did not pass --repo-root, and it prunes (see fetchPrune in lib/git.js).
  const result = await resolveStack(ticketKey, {
    repoRoot,
    fetch: shouldFetch,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
