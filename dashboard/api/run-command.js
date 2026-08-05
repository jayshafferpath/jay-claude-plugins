// Spawn a slash command headlessly and track it as a job.
//
// These commands are Claude Code skills, not deterministic scripts, so running
// one means starting a `claude -p` session. That takes minutes, which rules out
// doing it inside a request: the run is registered as a job and the UI polls it.
//
// Jobs live in memory only. A dashboard restart loses the log, which is
// acceptable — the durable record of what happened is the Jira activity log the
// commands write themselves, and the git state they leave behind.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Cap on retained output per job. These commands are chatty and a job list left
// open all day would otherwise grow without bound.
const MAX_LOG_CHARS = 100_000;

const jobs = new Map();

function truncate(text) {
  if (text.length <= MAX_LOG_CHARS) return text;
  return `…[earlier output truncated]\n${text.slice(-MAX_LOG_CHARS)}`;
}

// Start a command. Returns the job record immediately; the caller polls it.
//
// `cwd` is the ticket's resolved repo root: these commands operate on branches
// and worktrees, so running them from the dashboard's own directory would target
// the wrong repo.
export function startCommandJob({ ticketKey, prompt, cwd, now }) {
  const id = randomUUID();

  const job = {
    id,
    ticketKey,
    prompt,
    cwd,
    status: "running",
    startedAt: now,
    finishedAt: null,
    exitCode: null,
    log: "",
    error: null,
  };
  jobs.set(id, job);

  // --permission-mode acceptEdits rather than bypassing permissions outright:
  // these commands need to write files and run git, but a headless run should
  // still not be able to do literally anything.
  const child = spawn(
    "claude",
    ["-p", prompt, "--permission-mode", "acceptEdits"],
    {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const append = (chunk) => {
    job.log = truncate(job.log + chunk.toString());
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  child.on("error", (err) => {
    job.status = "failed";
    job.error = err.message;
  });

  child.on("close", (code) => {
    job.exitCode = code;
    // Leave an explicit failure set by the 'error' handler alone: spawn failure
    // is more informative than the exit code that follows it.
    if (job.status === "running") {
      job.status = code === 0 ? "succeeded" : "failed";
    }
  });

  return job;
}

// Serializable view of a job. The log is only included on request so the job
// list stays small.
export function serializeJob(job, { includeLog = false } = {}) {
  if (!job) return null;
  const { log, ...rest } = job;
  return includeLog ? { ...rest, log } : rest;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs() {
  return [...jobs.values()];
}

// Jobs still running, keyed by ticket. Used to stop a second run being started
// against a ticket that already has one in flight.
export function findRunningJobForTicket(ticketKey) {
  for (const job of jobs.values()) {
    if (job.ticketKey === ticketKey && job.status === "running") return job;
  }
  return null;
}

export const __test__ = { jobs, MAX_LOG_CHARS, truncate };
