#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { loadEnv } from "../lib/env.js";

loadEnv();

import {
  computeScope,
  readLedger,
  resolveFindingSlice,
  snapshot,
} from "../lib/sliced-ledger.js";
import { reviewPath } from "../lib/sliced-replay.js";
import {
  countBySeverity,
  mergeFindings,
  openFindings,
  parseReviewFile,
  renderReviewFile,
} from "../lib/sliced-review.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.error(
    "Usage: slice-review --base <branch> --findings <file|-> --agents <a,b>\n" +
      "                    [--branch <name>] [--plans-dir <path>] [--review <file>]\n" +
      "                    [--notes <file>] [--cwd <path>] [--dry-run]\n" +
      "\n" +
      "Resolve each fresh finding to the Slice-Id that owns its file:line, merge\n" +
      "the result into the existing review file, and write it back.\n" +
      "\n" +
      "--findings takes the agents' JSON array of\n" +
      "  { severity, file, line, summary, fix, source }\n" +
      "`source` may be omitted when only one agent ran; --agents supplies the\n" +
      "default and is also the per-agent coverage record the merge needs.\n" +
      "\n" +
      "The rewrite is a MERGE, never a regeneration. A finding is removed only by\n" +
      "a pass that looked at its slice with the agent that produced it:\n" +
      "  declined `- [~]`                    carried verbatim, always\n" +
      "  addressed `- [x]`                   dropped\n" +
      "  open, re-reported                   stays open\n" +
      "  open, on a stable slice             carried verbatim\n" +
      "  open, from an agent this pass\n" +
      "    skipped                           carried, flagged `unverified`\n" +
      "  open, slice reviewed by its agent,\n" +
      "    not re-reported                   retracted to `- [x] (not re-reported)`\n" +
      "\n" +
      "Retraction is recorded rather than silent: the reason to merge at all is\n" +
      "that the agents are non-deterministic, so a single pass deleting a real\n" +
      "finding outright would contradict the premise.\n" +
      "\n" +
      "A finding whose line was last changed before <base> is dropped with a note —\n" +
      "no replay can reach code this branch never touched.\n" +
      "\n" +
      "Output: { ok, reviewFile, changed[], stable[], counts, retracted[],\n" +
      "          carried[], droppedPreBase[], unassigned }\n" +
      "\n" +
      "Exit 0 clean, 2 when the ledger is unreadable, 1 on usage or git error.\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

const base = getFlag("--base");
const cwd = getFlag("--cwd") || process.cwd();
const plansDir = getFlag("--plans-dir") || ".plans";
const findingsArg = getFlag("--findings");
const agentsArg = getFlag("--agents") || "";
const notesFile = getFlag("--notes");
const dryRun = args.includes("--dry-run");

if (!base) {
  console.error("Missing required flag --base. Run with --help for usage.");
  process.exit(1);
}

function resolveBranch() {
  const explicit = getFlag("--branch");
  if (explicit) return explicit;
  try {
    return execSync("git branch --show-current", {
      cwd,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

function readFindingsInput() {
  if (!findingsArg) return [];
  const raw =
    findingsArg === "-"
      ? readFileSync(0, "utf-8")
      : readFileSync(findingsArg, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("--findings must contain a JSON array");
  }
  return parsed;
}

try {
  const branch = getFlag("--branch") || resolveBranch();
  if (!branch) {
    console.error("Could not resolve a branch. Pass --branch.");
    process.exit(1);
  }

  const agents = agentsArg
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  const ledger = readLedger({ base, head: branch, cwd, fingerprints: true });
  if (!ledger.ok) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: "unreadable-ledger",
          violations: ledger.violations,
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }

  const reviewFile = getFlag("--review") || reviewPath(plansDir, branch);
  const prior = existsSync(reviewFile)
    ? parseReviewFile(readFileSync(reviewFile, "utf-8"))
    : { state: null, findings: [], notes: [] };

  const scope = computeScope({
    slices: ledger.slices,
    prior: prior.state?.slicemap || {},
  });

  // Resolve each fresh finding to the slice that owns its line. Three outcomes:
  // an id, pre-BASE (dropped — no replay can reach it), or Unassigned.
  const fresh = [];
  const droppedPreBase = [];
  for (const raw of readFindingsInput()) {
    const resolution = resolveFindingSlice({
      file: raw.file,
      line: raw.line,
      base,
      head: branch,
      cwd,
    });

    const finding = {
      sliceId: resolution.sliceId,
      file: raw.file,
      line: raw.line,
      summary: String(raw.summary || "").replace(/\.\s*$/, ""),
      fix: raw.fix || null,
      severity: (raw.severity || "").toLowerCase() || null,
      source: raw.source || (agents.length === 1 ? agents[0] : null),
      flags: [],
    };

    if (resolution.reason === "pre-base") {
      droppedPreBase.push({ ...finding, owner: resolution.owner });
      continue;
    }
    fresh.push(finding);
  }

  const merged = mergeFindings({
    prior: prior.findings,
    fresh,
    reviewedIds: new Set(scope.changed),
    agentsRun: new Set(agents),
    stableIds: new Set(scope.stable),
  });

  const notes = [];
  if (notesFile && existsSync(notesFile)) {
    notes.push(...readFileSync(notesFile, "utf-8").split("\n").filter(Boolean));
  }
  if (droppedPreBase.length > 0) {
    notes.push(
      `- Dropped ${droppedPreBase.length} finding(s) whose lines last changed before \`${base}\`: ` +
        `${droppedPreBase.map((f) => `${f.file}:${f.line}`).join(", ")}.`,
    );
  }
  if (merged.retracted.length > 0) {
    notes.push(
      `- Retracted ${merged.retracted.length} finding(s) not re-reported by the agent that ` +
        "found them, on a slice this pass reviewed. Recorded as addressed, not deleted.",
    );
  }
  if (agents.length > 0) {
    notes.push(`- Agents run this pass: ${agents.join(", ")}.`);
  }

  const rendered = renderReviewFile({
    branch,
    base,
    slices: ledger.slices,
    scope: { ...scope, slicemap: snapshot(ledger.slices) },
    findings: merged.findings,
    notes,
    agentsRun: agents,
  });

  if (!dryRun) {
    mkdirSync(dirname(reviewFile), { recursive: true });
    writeFileSync(reviewFile, rendered, "utf-8");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        reviewFile,
        dryRun,
        changed: scope.changed,
        stable: scope.stable,
        contiguous: scope.contiguous,
        counts: countBySeverity(openFindings(merged.findings)),
        open: openFindings(merged.findings).length,
        retracted: merged.retracted.map((f) => `${f.file}:${f.line}`),
        carried: merged.carried.map((f) => `${f.file}:${f.line}`),
        droppedPreBase: droppedPreBase.map((f) => `${f.file}:${f.line}`),
        unassigned: merged.findings.filter((f) => !f.sliceId).length,
      },
      null,
      2,
    ),
  );
  process.exit(0);
} catch (err) {
  console.error(`slice-review: ${err.message}`);
  process.exit(1);
}
