import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

import { getIssue } from "./jira.js";

function run(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    return null;
  }
}

// Pull the description text out of a Jira issue. Atlassian's v3 description
// field is ADF (rich object) or, when fetched via the v2 endpoint shim,
// already a string. We render either to a flat string for regex parsing.
function descriptionText(fields) {
  const desc = fields?.description;
  if (!desc) return "";
  if (typeof desc === "string") return desc;
  // Best-effort flatten of ADF nodes.
  const parts = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
    }
  };
  walk(desc);
  return parts.join("\n");
}

// Locate the `h2. Implementation Notes` block in the description text. Returns
// the block content (everything between `h2. Implementation Notes` and the
// next `h2.` / EOF) or null when the block is absent.
export function extractImplementationNotes(text) {
  if (!text) return null;
  const headerRe = /^h2\.\s*Implementation Notes\s*$/m;
  const headerMatch = text.match(headerRe);
  if (!headerMatch) return null;
  const start = headerMatch.index + headerMatch[0].length;
  const remainder = text.slice(start);
  const nextH2 = remainder.match(/^h2\.\s+/m);
  return nextH2 ? remainder.slice(0, nextH2.index) : remainder;
}

// Parse `Research baseline: {repo}@{sha}, {repo2}@{sha2}` into a map.
export function parseResearchBaseline(notesBlock) {
  if (!notesBlock) return {};
  const m = notesBlock.match(/Research baseline:\s*([^\n]+)/);
  if (!m) return {};
  const out = {};
  for (const piece of m[1].split(",")) {
    const trimmed = piece.trim();
    const at = trimmed.lastIndexOf("@");
    if (at < 0) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

// Parse citations from a `[{path}#L{start}-L{end}|{permalink}]` link or
// `[{path}#L{start}-L{end}]` plain reference. Includes plain `path:start-end`
// shorthand for terser ticket prose.
export function parseCitations(notesBlock) {
  if (!notesBlock) return [];
  const citations = [];
  const linkRe =
    /\[(?<path>[^\]\s|]+?)#L(?<start>\d+)(?:-L(?<end>\d+))?(?:\|(?<perma>[^\]]+))?\]/g;
  for (const match of notesBlock.matchAll(linkRe)) {
    const { path, start, end, perma } = match.groups;
    let repo = null;
    let baselineSha = null;
    if (perma) {
      const permaMatch = perma.match(
        /github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/blob\/(?<sha>[0-9a-f]{6,40})\//,
      );
      if (permaMatch) {
        repo = permaMatch.groups.repo;
        baselineSha = permaMatch.groups.sha;
      }
    }
    citations.push({
      path,
      start: Number(start),
      end: end ? Number(end) : Number(start),
      repo,
      baselineSha,
      raw: match[0],
    });
  }
  return citations;
}

// Decide whether a single citation has drifted relative to its baseline SHA.
export function diffCitation(citation, repoRoot, fallbackBaseline) {
  const baseline = citation.baselineSha || fallbackBaseline;
  if (!baseline) {
    return { ...citation, status: "unknown", reason: "no baseline SHA" };
  }
  if (!repoRoot || !existsSync(repoRoot)) {
    return {
      ...citation,
      status: "unknown",
      reason: `repo not found: ${repoRoot}`,
    };
  }

  // git cat-file -e is silent on success; the more useful probe is ls-tree
  // (returns the entry on hit, empty string on miss → null).
  const lsTree = run(`git ls-tree HEAD -- ${citation.path}`, repoRoot);
  if (!lsTree) {
    // Try --follow to see if the file moved.
    const followLog = run(
      `git log --follow --name-status --pretty=format:%H ${baseline}..HEAD -- ${citation.path}`,
      repoRoot,
    );
    if (followLog && /R\d+\s+\S+\s+(\S+)/.test(followLog)) {
      const renameMatch = followLog.match(/R\d+\s+\S+\s+(\S+)/);
      return {
        ...citation,
        status: "drifted",
        reason: "file moved",
        newPath: renameMatch ? renameMatch[1] : null,
      };
    }
    return { ...citation, status: "drifted", reason: "file removed" };
  }

  const log = run(
    `git log --oneline -L ${citation.start},${citation.end}:${citation.path} ${baseline}..HEAD`,
    repoRoot,
  );
  if (log === null) {
    // git log -L can fail when the path's history doesn't reach the baseline
    // SHA (rare but possible after a rebase). Treat as unknown rather than
    // false-positive drift.
    return {
      ...citation,
      status: "unknown",
      reason: "git log -L failed (history mismatch?)",
    };
  }
  if (log.length === 0) {
    return { ...citation, status: "current" };
  }
  return {
    ...citation,
    status: "drifted",
    reason: "lines modified",
    commits: log.split("\n").filter(Boolean),
  };
}

// Run drift detection for a Jira ticket. Returns a structured report; the
// caller decides whether to re-run research / update Implementation Notes
// (that's the agent-side work in S3.5c).
export async function driftCheck(ticketKey, { repoRoot } = {}) {
  const issue = await getIssue(ticketKey);
  const text = descriptionText(issue.fields);
  const notes = extractImplementationNotes(text);

  if (!notes) {
    return {
      ticket: ticketKey,
      status: "no-notes",
      message: "Ticket has no h2. Implementation Notes block.",
    };
  }

  const baseline = parseResearchBaseline(notes);
  const citations = parseCitations(notes);

  const results = citations.map((c) =>
    diffCitation(c, repoRoot, baseline[c.repo] || Object.values(baseline)[0]),
  );

  const drifted = results.filter((r) => r.status === "drifted");
  const unknown = results.filter((r) => r.status === "unknown");

  return {
    ticket: ticketKey,
    status: drifted.length > 0 ? "drifted" : "current",
    baseline,
    citations: results,
    drifted: drifted.length,
    unknown: unknown.length,
    total: results.length,
  };
}
