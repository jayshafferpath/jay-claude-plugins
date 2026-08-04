#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { transitionForEvent } from "../lib/jira.js";
import { STATUS_TRANSITIONS } from "../lib/labels.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: transition-jira <TICKET_KEY> --event <EVENT>\n" +
      "\n" +
      "Move a ticket's Jira workflow status for a named lifecycle event.\n" +
      "Best-effort: when the workflow offers no matching transition the status\n" +
      "is left alone and the command still exits 0 — callers treat Jira status\n" +
      "as advisory and probe the PR for ground truth.\n" +
      "\n" +
      `Events: ${Object.keys(STATUS_TRANSITIONS).join(", ")}\n`,
  );
  process.exit(1);
}

const ticketKey = args[0]?.toUpperCase();

const eventIdx = args.indexOf("--event");
if (eventIdx < 0 || !args[eventIdx + 1]) {
  console.error("Error: --event <EVENT> is required");
  process.exit(1);
}
const event = args[eventIdx + 1];

try {
  const match = await transitionForEvent(ticketKey, event);
  if (match) {
    console.log(`Transitioned ${ticketKey} to "${match.name}"`);
  } else {
    console.log(
      `No matching "${event}" transition for ${ticketKey}; status unchanged.`,
    );
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
