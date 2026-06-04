#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { execSync } from "node:child_process";
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
  if (shouldFetch && repoRoot) {
    execSync("git fetch origin", {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  const result = await resolveStack(ticketKey, { repoRoot });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
