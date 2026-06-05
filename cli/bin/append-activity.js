#!/usr/bin/env node

import { loadEnv } from "../lib/env.js";

loadEnv();

import { readFileSync } from "node:fs";
import {
  appendActivityLog,
  collapseActivityLog,
  readActivityLog,
} from "../lib/checklist.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    'Usage: append-activity <TICKET_KEY> --heading "<heading>" [--body "<text>" | --body-file <path>]\n' +
      "       append-activity <TICKET_KEY> --read\n" +
      "       append-activity <TICKET_KEY> --collapse",
  );
  process.exit(1);
}

const ticketKey = args[0]?.toUpperCase();

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const heading = getFlag("--heading");
const bodyArg = getFlag("--body");
const bodyFile = getFlag("--body-file");
const readMode = args.includes("--read");
const collapseMode = args.includes("--collapse");

try {
  if (readMode) {
    const result = await readActivityLog(ticketKey);
    if (!result) {
      console.error(`No activity log found for ${ticketKey}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
  } else if (collapseMode) {
    const result = await collapseActivityLog(ticketKey);
    if (result.action === "collapsed") {
      console.log(
        `Collapsed ${result.entriesCollapsed} entries for ${ticketKey}.`,
      );
    } else {
      console.log(`No activity entries to collapse for ${ticketKey}.`);
    }
  } else {
    if (!heading) {
      console.error("--heading is required");
      process.exit(1);
    }
    let body = bodyArg;
    if (bodyFile) {
      body = readFileSync(bodyFile, "utf-8");
    }
    if (body === undefined) body = "";
    const result = await appendActivityLog(ticketKey, heading, body);
    console.log(
      `${result.action === "created" ? "Created" : "Appended"} activity entry on ${ticketKey} (${result.timestamp}).`,
    );
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
