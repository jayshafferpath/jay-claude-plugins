// The sliced review file: parse it, merge into it, render it.
//
// `/review-slices` writes `.plans/review-<SLUG>.md`; `/build-sliced` reads it to
// decide where to rewind to. Two things about it are load-bearing and were
// previously specified only as prose the LLM was asked to reproduce:
//
//   1. **The rewrite is a merge, not a regeneration.** The agents that produce
//      findings are not deterministic, so a pass that fails to re-report a
//      finding is not evidence the finding is gone. The governing rule is that a
//      finding may only be removed by a pass that actually looked at the slice it
//      names *with the agent that produced it*.
//
//   2. **The machine state is a single versioned blob.** The next review's
//      comparison needs every slice's patch-id *and* touched-file list, and the
//      build loop needs this run's changed set in commit order. Three loose
//      `k=v` comments could not carry the file lists and left "earliest changed
//      slice" undefined; one JSON blob owned by this module carries all of it and
//      round-trips exactly.

const STATE_PREFIX = "<!-- sliced-state:";
const STATE_SUFFIX = "-->";
const STATE_VERSION = 1;

const SECTION_FINDINGS = "findings";
const SECTION_OUT_OF_SCOPE = "out-of-scope";
const SECTION_UNASSIGNED = "unassigned";

const STATE_OPEN = "open";
const STATE_ADDRESSED = "addressed";
const STATE_DECLINED = "declined";

const BOX = {
  [STATE_OPEN]: " ",
  [STATE_ADDRESSED]: "x",
  [STATE_DECLINED]: "~",
};

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

// - [ ] `s03` `file.ts:42` — summary. Fix: recommendation. (severity: high, source: diff-critic)
// - [ ] `file.ts:12` — summary. (severity: high, source: diff-critic, unverified)
const FINDING_RE =
  /^- \[( |x|~|X)\]\s+(?:`(?<id>[^`\s]+)`\s+)?`(?<loc>[^`]+)`\s+[—-]\s+(?<rest>.*)$/;

function parseBox(ch) {
  if (ch === "~") return STATE_DECLINED;
  if (ch.toLowerCase() === "x") return STATE_ADDRESSED;
  return STATE_OPEN;
}

function splitLocation(loc) {
  const at = loc.lastIndexOf(":");
  if (at < 0) return { file: loc, line: null };
  const line = Number.parseInt(loc.slice(at + 1), 10);
  if (Number.isNaN(line)) return { file: loc, line: null };
  return { file: loc.slice(0, at), line };
}

// The trailing parenthetical carries the machine-readable metadata: severity,
// the agent that produced the finding, and any flags. `source` is what makes the
// per-agent merge rule possible — without it, a finding cannot be matched to the
// agent whose coverage this pass either had or lacked.
function parseMeta(rest) {
  const match = rest.match(/\(([^()]*)\)\s*$/);
  if (!match)
    return { body: rest.trim(), severity: null, source: null, flags: [] };

  const body = rest.slice(0, match.index).trim();
  const parts = match[1]
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  let severity = null;
  let source = null;
  const flags = [];
  for (const part of parts) {
    const kv = part.match(/^(\w+)\s*:\s*(.+)$/);
    if (kv && kv[1].toLowerCase() === "severity")
      severity = kv[2].toLowerCase();
    else if (kv && kv[1].toLowerCase() === "source") source = kv[2];
    else flags.push(part);
  }
  return { body, severity, source, flags };
}

function splitFix(body) {
  const match = body.match(/^(.*?)(?:\s*Fix:\s*(.*))?$/s);
  const summary = (match?.[1] || body).trim();
  const fix = (match?.[2] || "").trim();
  return { summary, fix: fix || null };
}

// A finding's identity across passes. The agent is part of the key on purpose: a
// diff-security finding and a diff-critic finding at the same line are different
// findings, and only the pass that ran the matching agent may retract one.
export function findingKey(finding) {
  return [
    finding.sliceId || "",
    finding.file || "",
    finding.line ?? "",
    finding.source || "",
  ].join("|");
}

export function parseState(text) {
  const start = String(text || "").indexOf(STATE_PREFIX);
  if (start < 0) return null;
  const end = text.indexOf(STATE_SUFFIX, start);
  if (end < 0) return null;

  const json = text.slice(start + STATE_PREFIX.length, end).trim();
  try {
    const parsed = JSON.parse(json);
    return {
      version: parsed.version ?? null,
      base: parsed.base ?? null,
      generated: parsed.generated ?? null,
      slicemap: parsed.slicemap ?? {},
      changed: Array.isArray(parsed.changed) ? parsed.changed : [],
      agentsRun: Array.isArray(parsed.agentsRun) ? parsed.agentsRun : [],
    };
  } catch {
    return null;
  }
}

export function renderState({ base, generated, slicemap, changed, agentsRun }) {
  const payload = {
    version: STATE_VERSION,
    base: base ?? null,
    generated: generated ?? null,
    slicemap: slicemap ?? {},
    changed: changed ?? [],
    agentsRun: agentsRun ?? [],
  };
  return `${STATE_PREFIX} ${JSON.stringify(payload)} ${STATE_SUFFIX}`;
}

// Parse an existing review file into findings plus machine state.
//
// A line that does not match the finding grammar is preserved verbatim as an
// `unparsed` finding rather than dropped. The whole point of the merge is that
// nothing removes open work by accident, and a parser that silently discards
// what it does not understand is the most likely way to do exactly that.
export function parseReviewFile(text) {
  const state = parseState(text);
  const findings = [];
  const notes = [];

  let section = null;
  let inNotes = false;

  for (const line of String(text || "").split("\n")) {
    const heading = line.match(/^##+\s+(.*)$/);
    if (heading) {
      const title = heading[1].trim().toLowerCase();
      inNotes = title === "notes";
      if (title === "findings" || title.startsWith("depth ")) {
        section = SECTION_FINDINGS;
      } else if (title === "out of scope") {
        section = SECTION_OUT_OF_SCOPE;
      } else if (title === "unassigned") {
        section = SECTION_UNASSIGNED;
      } else {
        section = null;
      }
      continue;
    }

    if (inNotes) {
      if (line.trim()) notes.push(line.trimEnd());
      continue;
    }

    if (!line.startsWith("- [")) continue;

    const match = line.match(FINDING_RE);
    if (!match) {
      findings.push({
        state: parseBox(line.slice(3, 4)),
        section: section || SECTION_UNASSIGNED,
        unparsed: true,
        raw: line.trimEnd(),
        sliceId: null,
        file: null,
        line: null,
        source: null,
        severity: null,
        flags: [],
      });
      continue;
    }

    const { id, loc, rest } = match.groups;
    const { file, line: lineNo } = splitLocation(loc);
    const meta = parseMeta(rest);
    const { summary, fix } = splitFix(meta.body);

    findings.push({
      state: parseBox(match[1]),
      section: section || SECTION_UNASSIGNED,
      unparsed: false,
      raw: line.trimEnd(),
      sliceId: id || null,
      file,
      line: lineNo,
      summary,
      fix,
      severity: meta.severity,
      source: meta.source,
      flags: meta.flags,
    });
  }

  return { state, findings, notes };
}

// Apply the merge rules. One rule governs: a finding may only be removed by a
// pass that actually looked at the slice it names, with the agent that produced
// it.
//
//   prior `- [~]` declined                         -> verbatim, always
//   prior `- [x]` addressed                        -> dropped
//   prior `- [ ]` re-reported this pass             -> stays open, text refreshed
//   prior `- [ ]` on a stable slice                 -> verbatim (nothing beneath
//                                                      it moved, so it cannot
//                                                      have been fixed)
//   prior `- [ ]` from an agent this pass skipped   -> verbatim, flagged
//                                                      `unverified`
//   prior `- [ ]` this pass reviewed and did not
//     re-report                                     -> retracted
//
// Retraction is recorded, not silent. The stated reason for merging at all is
// that the agents are non-deterministic, and a rule that lets a single
// non-deterministic pass delete a real finding contradicts its own premise. A
// retracted finding becomes `- [x]` with a `not re-reported` flag: it stops
// triggering a replay, and it stays auditable.
//
// An Unassigned finding — one that resolved to no slice — is never retracted.
// Its slice is unknown, so no pass can prove it looked at it.
export function mergeFindings({
  prior = [],
  fresh = [],
  reviewedIds = new Set(),
  agentsRun = new Set(),
  stableIds = new Set(),
}) {
  const freshByKey = new Map(fresh.map((f) => [findingKey(f), f]));
  const merged = [];
  const retracted = [];
  const carried = [];
  const consumed = new Set();

  for (const finding of prior) {
    if (finding.state === STATE_DECLINED) {
      merged.push(finding);
      continue;
    }
    if (finding.state === STATE_ADDRESSED) continue;

    const key = findingKey(finding);
    const match = freshByKey.get(key);
    if (match) {
      consumed.add(key);
      merged.push({ ...match, state: STATE_OPEN, flags: [] });
      continue;
    }

    if (finding.unparsed || !finding.sliceId) {
      carried.push(finding);
      merged.push(finding);
      continue;
    }

    if (stableIds.has(finding.sliceId) || !reviewedIds.has(finding.sliceId)) {
      carried.push(finding);
      merged.push(finding);
      continue;
    }

    if (finding.source && !agentsRun.has(finding.source)) {
      const flagged = {
        ...finding,
        flags: [...new Set([...(finding.flags || []), "unverified"])],
      };
      carried.push(flagged);
      merged.push(flagged);
      continue;
    }

    const retraction = {
      ...finding,
      state: STATE_ADDRESSED,
      flags: [...new Set([...(finding.flags || []), "not re-reported"])],
    };
    retracted.push(retraction);
    merged.push(retraction);
  }

  for (const finding of fresh) {
    const key = findingKey(finding);
    if (consumed.has(key)) continue;
    merged.push({ ...finding, state: STATE_OPEN, flags: finding.flags || [] });
  }

  return { findings: merged, retracted, carried };
}

function severityRank(severity) {
  const idx = SEVERITY_ORDER.indexOf(String(severity || "").toLowerCase());
  return idx < 0 ? SEVERITY_ORDER.length : idx;
}

function sentence(text) {
  const trimmed = String(text || "")
    .trim()
    .replace(/\.+$/, "");
  return trimmed ? `${trimmed}.` : "";
}

function renderFinding(finding) {
  if (finding.unparsed) {
    // Re-emit the original line with only the checkbox updated, so a line this
    // module could not parse survives a round-trip intact.
    return finding.raw.replace(/^- \[.\]/, `- [${BOX[finding.state]}]`);
  }

  const id = finding.sliceId ? `\`${finding.sliceId}\` ` : "";
  const loc = `\`${finding.file}:${finding.line}\``;
  const fix = finding.fix ? ` Fix: ${sentence(finding.fix)}` : "";
  const meta = [
    finding.severity ? `severity: ${finding.severity}` : null,
    finding.source ? `source: ${finding.source}` : null,
    ...(finding.flags || []),
  ].filter(Boolean);
  const suffix = meta.length ? ` (${meta.join(", ")})` : "";

  return `- [${BOX[finding.state]}] ${id}${loc} — ${sentence(finding.summary)}${fix}${suffix}`;
}

function sortFindings(findings) {
  return [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      String(a.file).localeCompare(String(b.file)) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

// Render the whole file. Section placement is *derived* from the ledger on every
// write — a finding's section is a function of its slice's depth and whether that
// slice is in scope, so carrying the old section forward would let a stale
// grouping outlive the graph that produced it.
export function renderReviewFile({
  branch,
  base,
  slices = [],
  scope,
  findings = [],
  notes = [],
  agentsRun = [],
  generated = new Date().toISOString().slice(0, 10),
}) {
  const byId = new Map(slices.map((s) => [s.id, s]));
  const inScope = new Set(scope?.changed || []);

  const placed = { depths: new Map(), outOfScope: [], unassigned: [] };
  for (const finding of findings) {
    const slice = finding.sliceId ? byId.get(finding.sliceId) : null;
    if (!slice) {
      placed.unassigned.push(finding);
      continue;
    }
    if (!inScope.has(slice.id)) {
      placed.outOfScope.push(finding);
      continue;
    }
    const depth = slice.depth ?? 0;
    if (!placed.depths.has(depth)) placed.depths.set(depth, []);
    placed.depths.get(depth).push(finding);
  }

  const out = [];
  out.push(`# Sliced Review: ${branch}`);
  out.push("");
  out.push(`- **Base**: ${base}`);
  out.push(
    `- **Reviewed slices**: ${
      scope?.changed?.length ? scope.changed.join(", ") : "none — nothing moved"
    }`,
  );
  out.push(`- **Generated**: ${generated}`);
  out.push("");
  out.push(
    renderState({
      base,
      generated,
      slicemap: scope?.slicemap || {},
      changed: scope?.changed || [],
      agentsRun,
    }),
  );
  out.push("");
  out.push("## Findings");

  const depths = [...placed.depths.keys()].sort((a, b) => a - b);
  if (depths.length === 0) {
    out.push("");
    out.push("None in the reviewed scope.");
  }
  for (const depth of depths) {
    out.push("");
    out.push(`### Depth ${depth}`);
    for (const finding of sortFindings(placed.depths.get(depth))) {
      out.push(renderFinding(finding));
    }
  }

  out.push("");
  out.push("## Out of scope");
  if (placed.outOfScope.length === 0) {
    out.push("");
    out.push("None.");
  } else {
    out.push("");
    for (const finding of sortFindings(placed.outOfScope)) {
      out.push(renderFinding(finding));
    }
  }

  out.push("");
  out.push("## Unassigned");
  if (placed.unassigned.length === 0) {
    out.push("");
    out.push("None.");
  } else {
    out.push("");
    for (const finding of sortFindings(placed.unassigned)) {
      out.push(renderFinding(finding));
    }
  }

  out.push("");
  out.push("## Notes");
  out.push("");
  if (notes.length === 0) out.push("None.");
  else for (const note of notes) out.push(note);
  out.push("");

  return out.join("\n");
}

// Open findings are the only replay trigger. Declined (`- [~]`) is terminal by
// design: without it, a finding the user rejects stays open forever and pins
// /build-sliced in a permanent replay loop, re-deriving slices to fix something
// nobody intends to fix.
export function openFindings(findings) {
  return findings.filter((f) => f.state === STATE_OPEN);
}

export function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const finding of findings) {
    const key = String(finding.severity || "").toLowerCase();
    if (key in counts) counts[key] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

export const FINDING_STATES = {
  OPEN: STATE_OPEN,
  ADDRESSED: STATE_ADDRESSED,
  DECLINED: STATE_DECLINED,
};

export const SECTIONS = {
  FINDINGS: SECTION_FINDINGS,
  OUT_OF_SCOPE: SECTION_OUT_OF_SCOPE,
  UNASSIGNED: SECTION_UNASSIGNED,
};
