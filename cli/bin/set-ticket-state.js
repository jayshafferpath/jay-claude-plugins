#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { setTicketState } from "../lib/jira.js";
import { PROGRESS_LABELS } from "../lib/labels.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: set-ticket-state <TICKET_KEY> [--to <STATE>] [--clear-progress]\n" +
      "                                    [--add <LABEL>]... [--remove <LABEL>]...\n" +
      "\n" +
      "  --to <STATE>          Move the ticket to <STATE> (must be a PROGRESS_LABEL).\n" +
      "                        Implicitly clears every other progress label.\n" +
      "  --clear-progress      Remove every progress label currently applied.\n" +
      "                        (--to already clears them; redundant when --to is set.)\n" +
      "  --add <LABEL>         Add an arbitrary label (e.g. complexity:trivial).\n" +
      "  --remove <LABEL>      Remove an arbitrary label.\n" +
      "\n" +
      `Progress labels: ${PROGRESS_LABELS.join(", ")}\n`,
  );
  process.exit(1);
}

const ticketKey = args[0]?.toUpperCase();

function collectFlag(name) {
  const values = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === name) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error(`Error: ${name} requires a value`);
        process.exit(1);
      }
      values.push(next);
      i += 1;
    }
  }
  return values;
}

const toValues = collectFlag("--to");
if (toValues.length > 1) {
  console.error("Error: --to may only be specified once");
  process.exit(1);
}
const to = toValues[0] || null;
const add = collectFlag("--add");
const remove = collectFlag("--remove");
const clearProgress = args.includes("--clear-progress");

if (!to && !clearProgress && add.length === 0 && remove.length === 0) {
  console.error(
    "Error: nothing to do. Pass --to, --clear-progress, --add, or --remove.",
  );
  process.exit(1);
}

try {
  const ops = await setTicketState(ticketKey, { to, add, remove });
  if (!ops) {
    console.log(`No changes for ${ticketKey} (already in target state).`);
  } else {
    console.log(
      `Updated ${ticketKey}: ${ops
        .map((op) => (op.add ? `+${op.add}` : `-${op.remove}`))
        .join(", ")}`,
    );
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
