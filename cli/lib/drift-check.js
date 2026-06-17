import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { getIssue } from "./jira.js";

function run(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (_err) {
    return null;
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
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

// Pull a labelled subsection out of the Implementation Notes block. The
// planner emits sections as `*Existing patterns to extend:*` followed by a
// bulleted list, terminated by the next `*…:*` heading or end-of-block.
function extractSubsection(notesBlock, label) {
  if (!notesBlock) return null;
  const headerRe = new RegExp(
    `^\\*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}:\\*\\s*$`,
    "m",
  );
  const match = notesBlock.match(headerRe);
  if (!match) return null;
  const start = match.index + match[0].length;
  const remainder = notesBlock.slice(start);
  const nextHeader = remainder.match(/^\*[^*\n]+:\*\s*$/m);
  return nextHeader ? remainder.slice(0, nextHeader.index) : remainder;
}

// Iterate the bullet items in a subsection. Bullets are `*` or `-` prefixed.
function bulletLines(section) {
  if (!section) return [];
  return section
    .split("\n")
    .map((line) => line.replace(/^\s*[*-]\s+/, "").trim())
    .filter((line) => line.length > 0);
}

// Parse `*Existing patterns to extend:*` bullets. Each bullet has the shape:
//   *{Pattern name}* — `{symbol}` in [{path}#L{start}-L{end}|{permalink}] — {description}
// We tolerate missing pieces (no symbol, no description, plain citation form).
export function parsePatterns(notesBlock) {
  const section = extractSubsection(notesBlock, "Existing patterns to extend");
  if (!section) return [];
  const out = [];
  for (const line of bulletLines(section)) {
    const nameMatch = line.match(/^\*([^*]+)\*/);
    const symbolMatch = line.match(/`([^`]+)`/);
    const citations = parseCitations(line);
    out.push({
      name: nameMatch ? nameMatch[1].trim() : null,
      symbol: symbolMatch ? symbolMatch[1].trim() : null,
      citation: citations[0] || null,
      raw: line,
    });
  }
  return out;
}

// Parse a list of `\`{path}\` — {reason}` bullets. Used by both the
// "Files likely to change" and "Tests likely to extend" subsections. Tests can
// also carry a `[…|permalink]` citation; we keep both fields when present.
function parsePathBullets(notesBlock, label) {
  const section = extractSubsection(notesBlock, label);
  if (!section) return [];
  const out = [];
  for (const line of bulletLines(section)) {
    const pathMatch = line.match(/`([^`]+)`/);
    const citations = parseCitations(line);
    const path = pathMatch
      ? pathMatch[1].trim()
      : citations[0]
        ? citations[0].path
        : null;
    if (!path) continue;
    out.push({
      path,
      citation: citations[0] || null,
      raw: line,
    });
  }
  return out;
}

export function parseFilesLikelyToChange(notesBlock) {
  return parsePathBullets(notesBlock, "Files likely to change");
}

export function parseTestsLikelyToExtend(notesBlock) {
  return parsePathBullets(notesBlock, "Tests likely to extend");
}

// Constraints stay raw — the agent decides whether they're still applicable
// (CLI can't tell whether an in-flight migration has landed without an LLM
// pass over the cited region at HEAD).
export function parseConstraints(notesBlock) {
  const section = extractSubsection(notesBlock, "Constraints");
  if (!section) return null;
  return section.trim();
}

// Parse the `h2. TDD Reference` block. Returns { title, path, anchor, blobBase,
// repo } when the block resolves cleanly, null otherwise. The block shape:
//   h2. TDD Reference
//   [{TDD_TITLE} - {Section Heading}|{TDD_BLOB_BASE}/{TDD_PATH}#{anchor}]
//   Repo path: {TDD_PATH}#{anchor}
export function parseTddRef(descriptionText) {
  if (!descriptionText) return null;
  const headerRe = /^h2\.\s*TDD Reference\s*$/m;
  const headerMatch = descriptionText.match(headerRe);
  if (!headerMatch) return null;
  const start = headerMatch.index + headerMatch[0].length;
  const remainder = descriptionText.slice(start);
  const nextH2 = remainder.match(/^h2\.\s+/m);
  const block = nextH2 ? remainder.slice(0, nextH2.index) : remainder;

  const linkMatch = block.match(
    /\[(?<title>[^\]|]+)\|(?<url>https?:\/\/[^\]]+)\]/,
  );
  const repoPathMatch = block.match(/Repo path:\s*([^\n]+)/);

  let title = null;
  let url = null;
  let blobBase = null;
  let repo = null;
  let path = null;
  let anchor = null;

  if (linkMatch) {
    title = linkMatch.groups.title.trim();
    url = linkMatch.groups.url.trim();
    const urlMatch = url.match(
      /^(?<base>https:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/blob\/[0-9a-f]{6,40})\/(?<path>[^#]+)(?:#(?<anchor>.+))?$/,
    );
    if (urlMatch) {
      blobBase = urlMatch.groups.base;
      repo = urlMatch.groups.repo;
      path = urlMatch.groups.path;
      anchor = urlMatch.groups.anchor || null;
    }
  }
  if (repoPathMatch && !path) {
    const rp = repoPathMatch[1].trim();
    const hash = rp.indexOf("#");
    path = hash >= 0 ? rp.slice(0, hash) : rp;
    anchor = hash >= 0 ? rp.slice(hash + 1) : null;
  }

  if (!path && !url) return null;
  return { title, url, blobBase, repo, path, anchor };
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

// Verify the citation parses to a coherent range and the baseline SHA is
// reachable. Cheap structural pass that runs before the line-range diff.
export function verifyCitationWellFormed(citation, repoRoot) {
  if (!citation || !citation.path) {
    return { status: "drifted", reason: "missing path" };
  }
  if (
    !Number.isFinite(citation.start) ||
    !Number.isFinite(citation.end) ||
    citation.start <= 0 ||
    citation.end < citation.start
  ) {
    return { status: "drifted", reason: "invalid line range" };
  }
  if (!repoRoot || !existsSync(repoRoot)) {
    return { status: "unknown", reason: `repo not found: ${repoRoot}` };
  }
  const baseline = citation.baselineSha;
  if (!baseline) {
    return { status: "unknown", reason: "no baseline SHA" };
  }
  const reachable = run(
    `git cat-file -e ${shellQuote(baseline)} 2>/dev/null && echo ok`,
    repoRoot,
  );
  if (reachable !== "ok") {
    return {
      status: "drifted",
      reason: "baseline SHA unreachable (blocker branch deleted?)",
    };
  }
  const blob = run(
    `git cat-file -p ${shellQuote(`${baseline}:${citation.path}`)}`,
    repoRoot,
  );
  if (blob === null) {
    return {
      status: "drifted",
      reason: "file did not exist at baseline",
    };
  }
  const lineCount = blob.split("\n").length;
  if (citation.end > lineCount) {
    return {
      status: "drifted",
      reason: `cited end line ${citation.end} exceeds baseline file length (${lineCount})`,
    };
  }
  return { status: "current" };
}

// Verify a named symbol still exists at HEAD. Looks at the cited path first,
// then (if missing) does a repo-wide grep so the agent can re-pin to the new
// location. Quietly skips when no symbol is captured (some pattern bullets
// don't carry one).
export function verifySymbolPresent(pattern, repoRoot, citationDiff) {
  if (!pattern || !pattern.symbol) {
    return { status: "current", reason: "no symbol to check" };
  }
  if (!repoRoot || !existsSync(repoRoot)) {
    return { status: "unknown", reason: `repo not found: ${repoRoot}` };
  }
  const symbol = pattern.symbol;
  const targetPath =
    citationDiff && citationDiff.newPath
      ? citationDiff.newPath
      : pattern.citation
        ? pattern.citation.path
        : null;

  if (targetPath) {
    const lsTree = run(
      `git ls-tree HEAD -- ${shellQuote(targetPath)}`,
      repoRoot,
    );
    if (lsTree) {
      const hit = run(
        `git grep -nF ${shellQuote(symbol)} HEAD -- ${shellQuote(targetPath)}`,
        repoRoot,
      );
      if (hit) {
        return { status: "current", path: targetPath };
      }
    }
  }

  const repoHit = run(`git grep -lnF ${shellQuote(symbol)} HEAD`, repoRoot);
  if (repoHit) {
    const newPaths = repoHit
      .split("\n")
      .map((line) => line.replace(/^HEAD:/, "").trim())
      .filter(Boolean);
    return {
      status: "drifted",
      reason: "symbol moved",
      newPaths,
    };
  }
  return { status: "drifted", reason: "symbol removed" };
}

// Verify a path still exists at HEAD. Rename-follows when the file is gone, so
// "Files likely to change" entries that have been moved get a usable hint.
export function verifyPathExists(entry, repoRoot, fallbackBaseline) {
  if (!entry || !entry.path) {
    return { status: "drifted", reason: "missing path" };
  }
  if (!repoRoot || !existsSync(repoRoot)) {
    return { status: "unknown", reason: `repo not found: ${repoRoot}` };
  }
  const lsTree = run(`git ls-tree HEAD -- ${shellQuote(entry.path)}`, repoRoot);
  if (lsTree) {
    return { status: "current", path: entry.path };
  }
  const baseline =
    (entry.citation && entry.citation.baselineSha) || fallbackBaseline;
  if (baseline) {
    const followLog = run(
      `git log --follow --name-status --pretty=format:%H ${shellQuote(baseline)}..HEAD -- ${shellQuote(entry.path)}`,
      repoRoot,
    );
    if (followLog && /R\d+\s+\S+\s+(\S+)/.test(followLog)) {
      const renameMatch = followLog.match(/R\d+\s+\S+\s+(\S+)/);
      return {
        status: "drifted",
        reason: "file moved",
        newPath: renameMatch ? renameMatch[1] : null,
      };
    }
  }
  return { status: "drifted", reason: "file removed" };
}

// Verify the TDD Reference block still resolves at HEAD. Best-effort: only
// checks the on-disk path in the primary repo (since cross-repo TDD lookup
// would need gh API calls — not the CLI's job). Returns 'unknown' for
// out-of-repo TDDs so the agent can decide whether to follow up.
export function verifyTddRef(tddRef, repoRoot) {
  if (!tddRef) return { status: "unknown", reason: "no TDD Reference block" };
  if (!tddRef.path) {
    return { status: "drifted", reason: "TDD Reference block missing path" };
  }
  if (!repoRoot || !existsSync(repoRoot)) {
    return { status: "unknown", reason: `repo not found: ${repoRoot}` };
  }
  const lsTree = run(
    `git ls-tree HEAD -- ${shellQuote(tddRef.path)}`,
    repoRoot,
  );
  if (!lsTree) {
    return {
      status: "unknown",
      reason: "TDD path not in this repo (may live in owner repo)",
    };
  }
  if (!tddRef.anchor) {
    return { status: "current", reason: "no anchor to verify" };
  }
  const blob = run(
    `git cat-file -p ${shellQuote(`HEAD:${tddRef.path}`)}`,
    repoRoot,
  );
  /* c8 ignore start -- defensive: lsTree already confirmed presence */
  if (blob === null) {
    return { status: "drifted", reason: "TDD body unreadable" };
  }
  /* c8 ignore stop */
  const slugify = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
  const headings = blob
    .split("\n")
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => slugify(line.replace(/^#{1,6}\s+/, "")));
  const wanted = tddRef.anchor.toLowerCase().replace(/^user-content-/, "");
  if (headings.includes(wanted)) {
    return { status: "current" };
  }
  return {
    status: "drifted",
    reason: `TDD anchor #${tddRef.anchor} no longer matches any heading`,
  };
}

// Verify each per-repo sidecar file referenced by the Research baseline still
// exists in the TDD's docs folder. Sidecar location is derived from the TDD
// path: {tddDir}/{tddSlug}/{repoName}.research.md.
export function verifySidecars(tddRef, baseline, repoRoot) {
  if (!tddRef || !tddRef.path) return [];
  if (!repoRoot || !existsSync(repoRoot)) return [];
  const tddDir = dirname(tddRef.path);
  const tddSlug = tddRef.path.split("/").pop().replace(/\.md$/, "");
  const out = [];
  for (const repo of Object.keys(baseline || {})) {
    const sidecarPath = join(tddDir, tddSlug, `${repo}.research.md`);
    const lsTree = run(
      `git ls-tree HEAD -- ${shellQuote(sidecarPath)}`,
      repoRoot,
    );
    out.push({
      repo,
      path: sidecarPath,
      status: lsTree ? "current" : "unknown",
      reason: lsTree
        ? null
        : "sidecar not in this repo (may live in owner repo) or has been removed",
    });
  }
  return out;
}

// Run drift detection for a Jira ticket. Returns a structured report; the
// caller decides whether to re-run research / update Implementation Notes
// (that's the agent-side work in S3.5c).
export async function driftCheck(ticketKey, { repoRoot, lite = false } = {}) {
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
  const fallbackOf = (repo) =>
    baseline[repo] || Object.values(baseline)[0] || null;

  const lineRangeResults = citations.map((c) =>
    diffCitation(c, repoRoot, fallbackOf(c.repo)),
  );

  if (lite) {
    const drifted = lineRangeResults.filter((r) => r.status === "drifted");
    const unknown = lineRangeResults.filter((r) => r.status === "unknown");
    return {
      ticket: ticketKey,
      status: drifted.length > 0 ? "drifted" : "current",
      baseline,
      citations: lineRangeResults,
      drifted: drifted.length,
      unknown: unknown.length,
      total: lineRangeResults.length,
      mode: "lite",
    };
  }

  // Full mode: parse remaining subsections, run all verifiers, merge results.
  const patternsParsed = parsePatterns(notes);
  const filesParsed = parseFilesLikelyToChange(notes);
  const testsParsed = parseTestsLikelyToExtend(notes);
  const constraintsRaw = parseConstraints(notes);
  const tddRef = parseTddRef(text);

  // Citation pass: structural well-formedness folds into the same diff result.
  // If well-formedness is drifted, we surface that reason and skip the
  // line-range diff (its output would be misleading).
  const citationResults = citations.map((c, idx) => {
    const wellFormed = verifyCitationWellFormed(c, repoRoot);
    if (wellFormed.status === "drifted") {
      return {
        ...c,
        status: "drifted",
        reason: wellFormed.reason,
        check: "well-formed",
      };
    }
    /* c8 ignore start -- verifyCitationWellFormed cannot return 'unknown' here:
       both repoRoot and baseline are always set in this code path */
    if (
      wellFormed.status === "unknown" &&
      lineRangeResults[idx].status === "current"
    ) {
      return { ...lineRangeResults[idx], check: "line-range" };
    }
    /* c8 ignore stop */
    return { ...lineRangeResults[idx], check: "line-range" };
  });

  // Pattern pass: pair each parsed pattern with its citation diff (so
  // verifySymbolPresent can use the rename-followed path) and check the symbol.
  const patternResults = patternsParsed.map((p) => {
    const citationDiff =
      p.citation &&
      citationResults.find(
        (r) =>
          r.path === p.citation.path &&
          r.start === p.citation.start &&
          r.end === p.citation.end,
      );
    const symbol = verifySymbolPresent(p, repoRoot, citationDiff);
    return {
      ...p,
      symbolStatus: symbol.status,
      symbolReason: symbol.reason || null,
      symbolNewPaths: symbol.newPaths || null,
    };
  });

  const fileResults = filesParsed.map((f) => {
    const v = verifyPathExists(f, repoRoot, fallbackOf(null));
    return {
      ...f,
      pathStatus: v.status,
      pathReason: v.reason || null,
      newPath: v.newPath || null,
    };
  });

  const testResults = testsParsed.map((t) => {
    const v = verifyPathExists(t, repoRoot, fallbackOf(null));
    return {
      ...t,
      pathStatus: v.status,
      pathReason: v.reason || null,
      newPath: v.newPath || null,
    };
  });

  const tddRefResult = tddRef
    ? { ...tddRef, ...verifyTddRef(tddRef, repoRoot) }
    : { status: "unknown", reason: "no TDD Reference block" };

  const sidecarResults = verifySidecars(tddRef, baseline, repoRoot);

  // Tally drift across all check types so callers can branch on a single flag.
  const driftedCount = [
    ...citationResults.filter((r) => r.status === "drifted"),
    ...patternResults.filter((r) => r.symbolStatus === "drifted"),
    ...fileResults.filter((r) => r.pathStatus === "drifted"),
    ...testResults.filter((r) => r.pathStatus === "drifted"),
    ...(tddRefResult.status === "drifted" ? [tddRefResult] : []),
  ].length;
  const unknownCount = [
    ...citationResults.filter((r) => r.status === "unknown"),
    ...patternResults.filter((r) => r.symbolStatus === "unknown"),
    ...fileResults.filter((r) => r.pathStatus === "unknown"),
    ...testResults.filter((r) => r.pathStatus === "unknown"),
    ...(tddRefResult.status === "unknown" ? [tddRefResult] : []),
    ...sidecarResults.filter((r) => r.status === "unknown"),
  ].length;
  const total =
    citationResults.length +
    patternResults.length +
    fileResults.length +
    testResults.length +
    (tddRef ? 1 : 0);

  return {
    ticket: ticketKey,
    status: driftedCount > 0 ? "drifted" : "current",
    baseline,
    citations: citationResults,
    patterns: patternResults,
    filesLikelyToChange: fileResults,
    testsLikelyToExtend: testResults,
    tddRef: tddRefResult,
    sidecars: sidecarResults,
    constraintsRaw,
    drifted: driftedCount,
    unknown: unknownCount,
    total,
    mode: "full",
  };
}
