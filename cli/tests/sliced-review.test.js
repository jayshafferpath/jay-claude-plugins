import { describe, expect, it } from "vitest";

import {
  countBySeverity,
  FINDING_STATES,
  findingKey,
  mergeFindings,
  openFindings,
  parseReviewFile,
  parseState,
  renderReviewFile,
  renderState,
} from "../lib/sliced-review.js";

function finding(overrides = {}) {
  return {
    state: FINDING_STATES.OPEN,
    sliceId: "s01",
    file: "a.ts",
    line: 42,
    summary: "off by one",
    fix: "start at zero",
    severity: "high",
    source: "diff-critic",
    flags: [],
    unparsed: false,
    ...overrides,
  };
}

const SLICES = [
  { id: "s01", index: 0, depth: 0 },
  { id: "s02", index: 1, depth: 1 },
  { id: "s03", index: 2, depth: 0 },
];

describe("parseState / renderState", () => {
  it("round-trips patch-ids, touched-file lists, and the changed set", () => {
    const state = {
      base: "main",
      generated: "2026-01-01",
      slicemap: { s01: { patchId: "p1", touched: ["a.ts"] } },
      changed: ["s01", "s02"],
      agentsRun: ["diff-critic"],
    };
    const parsed = parseState(renderState(state));
    expect(parsed).toMatchObject({ ...state, version: 1 });
  });

  it("returns null for a missing or malformed blob rather than a half-parsed one", () => {
    expect(parseState("# no state here")).toBeNull();
    expect(parseState("<!-- sliced-state: {oops -->")).toBeNull();
    expect(parseState("<!-- sliced-state: {}")).toBeNull();
  });

  it("defaults the array fields so a hand-edited blob cannot crash a caller", () => {
    const parsed = parseState('<!-- sliced-state: {"changed":"nope"} -->');
    expect(parsed.changed).toEqual([]);
    expect(parsed.slicemap).toEqual({});
  });
});

describe("parseReviewFile", () => {
  const file = [
    "# Sliced Review: feat",
    "",
    "- **Base**: main",
    "",
    renderState({
      base: "main",
      slicemap: { s01: { patchId: "p1", touched: ["a.ts"] } },
      changed: ["s01", "s02"],
    }),
    "",
    "## Findings",
    "",
    "### Depth 0",
    "- [ ] `s01` `a.ts:42` — off by one. Fix: start at zero. (severity: high, source: diff-critic)",
    "- [x] `s01` `a.ts:7` — fixed already. (severity: low, source: diff-critic)",
    "",
    "### Depth 1",
    "- [~] `s02` `b.ts:9` — declined. (severity: medium, source: diff-security)",
    "",
    "## Out of scope",
    "- [ ] `s03` `c.ts:5` — elsewhere. (severity: medium, source: diff-critic)",
    "",
    "## Unassigned",
    "- [ ] `seam.ts:12` — nobody owns this. (severity: high, source: diff-critic)",
    "",
    "## Notes",
    "- diff-security skipped: security-inert.",
  ].join("\n");

  it("parses state, findings, sections, and notes", () => {
    const parsed = parseReviewFile(file);

    expect(parsed.state.changed).toEqual(["s01", "s02"]);
    expect(parsed.findings).toHaveLength(5);
    expect(parsed.notes).toEqual(["- diff-security skipped: security-inert."]);
  });

  it("reads the three checkbox states", () => {
    const byLine = new Map(
      parseReviewFile(file).findings.map((f) => [f.line, f.state]),
    );
    expect(byLine.get(42)).toBe(FINDING_STATES.OPEN);
    expect(byLine.get(7)).toBe(FINDING_STATES.ADDRESSED);
    expect(byLine.get(9)).toBe(FINDING_STATES.DECLINED);
  });

  it("splits summary from fix and pulls severity and source out of the parenthetical", () => {
    const first = parseReviewFile(file).findings[0];
    expect(first).toMatchObject({
      sliceId: "s01",
      file: "a.ts",
      line: 42,
      summary: "off by one.",
      fix: "start at zero.",
      severity: "high",
      source: "diff-critic",
    });
  });

  it("leaves an Unassigned finding with a null sliceId", () => {
    const unassigned = parseReviewFile(file).findings.find(
      (f) => f.file === "seam.ts",
    );
    expect(unassigned.sliceId).toBeNull();
  });

  it("keeps flags that are not key-value metadata", () => {
    const parsed = parseReviewFile(
      "## Findings\n- [ ] `s01` `a.ts:1` — x. (severity: low, source: diff-security, unverified)",
    );
    expect(parsed.findings[0].flags).toEqual(["unverified"]);
  });

  it("preserves a line it cannot parse instead of dropping it", () => {
    // A parser that silently discards what it does not understand is the most
    // likely way to lose open work, which is the one thing the merge forbids.
    const parsed = parseReviewFile(
      "## Findings\n- [ ] something freeform nobody formatted",
    );
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      unparsed: true,
      state: FINDING_STATES.OPEN,
      raw: "- [ ] something freeform nobody formatted",
    });
  });

  it("handles a path containing a colon by splitting on the last one", () => {
    const parsed = parseReviewFile(
      "## Findings\n- [ ] `s01` `a:b.ts:9` — x. (severity: low)",
    );
    expect(parsed.findings[0]).toMatchObject({ file: "a:b.ts", line: 9 });
  });

  it("returns empty structures for empty input", () => {
    expect(parseReviewFile("")).toMatchObject({
      state: null,
      findings: [],
      notes: [],
    });
    expect(parseReviewFile(null).findings).toEqual([]);
  });
});

describe("findingKey", () => {
  it("keys on the agent as well as the location", () => {
    // A diff-security finding and a diff-critic finding at the same line are
    // different findings, and only a pass that ran the matching agent may
    // retract either one.
    expect(findingKey(finding({ source: "diff-critic" }))).not.toBe(
      findingKey(finding({ source: "diff-security" })),
    );
  });
});

describe("mergeFindings", () => {
  const reviewedIds = new Set(["s01", "s02"]);
  const agentsRun = new Set(["diff-critic"]);

  it("carries a declined finding forward verbatim, always", () => {
    const declined = finding({ state: FINDING_STATES.DECLINED });
    const { findings } = mergeFindings({
      prior: [declined],
      fresh: [],
      reviewedIds,
      agentsRun,
      stableIds: new Set(),
    });
    expect(findings).toEqual([declined]);
  });

  it("drops a finding already marked addressed", () => {
    const { findings } = mergeFindings({
      prior: [finding({ state: FINDING_STATES.ADDRESSED })],
      fresh: [],
      reviewedIds,
      agentsRun,
      stableIds: new Set(),
    });
    expect(findings).toEqual([]);
  });

  it("keeps a re-reported finding open and refreshes its text", () => {
    const { findings, retracted } = mergeFindings({
      prior: [finding({ summary: "stale wording" })],
      fresh: [finding({ summary: "sharper wording" })],
      reviewedIds,
      agentsRun,
      stableIds: new Set(),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: FINDING_STATES.OPEN,
      summary: "sharper wording",
    });
    expect(retracted).toEqual([]);
  });

  it("carries an open finding on a stable slice forward untouched", () => {
    // Nothing beneath a stable slice moved, so it cannot have been fixed — no
    // matter what this pass looked at.
    const open = finding();
    const { findings, carried } = mergeFindings({
      prior: [open],
      fresh: [],
      reviewedIds,
      agentsRun,
      stableIds: new Set(["s01"]),
    });
    expect(findings).toEqual([open]);
    expect(carried).toEqual([open]);
  });

  it("carries an open finding on a slice this pass never looked at", () => {
    const open = finding({ sliceId: "s09" });
    const { findings } = mergeFindings({
      prior: [open],
      fresh: [],
      reviewedIds,
      agentsRun,
      stableIds: new Set(),
    });
    expect(findings).toEqual([open]);
  });

  it("flags a finding unverified when its agent was skipped, even in-scope", () => {
    // `unverified` tracks AGENT coverage, not slice coverage: a diff-security
    // finding on a slice reviewed with diff-critic alone was not re-examined.
    const { findings, carried } = mergeFindings({
      prior: [finding({ source: "diff-security" })],
      fresh: [],
      reviewedIds,
      agentsRun,
      stableIds: new Set(),
    });
    expect(findings[0].flags).toContain("unverified");
    expect(findings[0].state).toBe(FINDING_STATES.OPEN);
    expect(carried).toHaveLength(1);
  });

  it("does not duplicate the unverified flag across repeated passes", () => {
    const { findings } = mergeFindings({
      prior: [finding({ source: "diff-security", flags: ["unverified"] })],
      fresh: [],
      reviewedIds,
      agentsRun,
      stableIds: new Set(),
    });
    expect(findings[0].flags).toEqual(["unverified"]);
  });

  it("records a retraction rather than deleting the finding", () => {
    // The stated reason to merge at all is that the agents are
    // non-deterministic. A rule that lets one non-deterministic pass silently
    // delete a real finding contradicts its own premise, so a retraction becomes
    // an auditable `- [x] (not re-reported)` instead of a disappearance.
    const { findings, retracted } = mergeFindings({
      prior: [finding()],
      fresh: [],
      reviewedIds,
      agentsRun,
      stableIds: new Set(),
    });
    expect(retracted).toHaveLength(1);
    expect(findings[0]).toMatchObject({ state: FINDING_STATES.ADDRESSED });
    expect(findings[0].flags).toContain("not re-reported");
    expect(openFindings(findings)).toEqual([]);
  });

  it("never retracts an Unassigned finding — no pass can prove it looked", () => {
    const unassigned = finding({ sliceId: null, file: "seam.ts" });
    const { findings, retracted } = mergeFindings({
      prior: [unassigned],
      fresh: [],
      reviewedIds,
      agentsRun,
      stableIds: new Set(),
    });
    expect(retracted).toEqual([]);
    expect(findings[0].state).toBe(FINDING_STATES.OPEN);
  });

  it("never retracts a line it could not parse", () => {
    const unparsed = {
      state: FINDING_STATES.OPEN,
      unparsed: true,
      raw: "- [ ] freeform",
      sliceId: null,
      file: null,
      line: null,
      source: null,
      flags: [],
    };
    const { findings } = mergeFindings({
      prior: [unparsed],
      fresh: [],
      reviewedIds,
      agentsRun,
      stableIds: new Set(),
    });
    expect(findings).toEqual([unparsed]);
  });

  it("adds findings this pass found fresh as open", () => {
    const { findings } = mergeFindings({
      prior: [],
      fresh: [finding({ line: 99 })],
      reviewedIds,
      agentsRun,
      stableIds: new Set(),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].state).toBe(FINDING_STATES.OPEN);
  });

  it("keeps every open finding across a second pass that found nothing", () => {
    // A pass with nothing to look at is exactly a second consecutive review.
    // Regenerating from only what it found would empty the file.
    const prior = [finding({ line: 1 }), finding({ line: 2, sliceId: "s02" })];
    const { findings } = mergeFindings({
      prior,
      fresh: [],
      reviewedIds: new Set(),
      agentsRun: new Set(),
      stableIds: new Set(["s01", "s02"]),
    });
    expect(openFindings(findings)).toHaveLength(2);
  });
});

describe("renderReviewFile", () => {
  const scope = {
    changed: ["s01", "s02"],
    slicemap: { s01: { patchId: "p1", touched: [] } },
  };

  it("groups by derived depth, shallowest first, critical first within a depth", () => {
    const text = renderReviewFile({
      branch: "feat",
      base: "main",
      slices: SLICES,
      scope,
      findings: [
        finding({
          sliceId: "s02",
          line: 5,
          severity: "low",
          summary: "deep low",
        }),
        finding({
          sliceId: "s01",
          line: 6,
          severity: "medium",
          summary: "shallow medium",
        }),
        finding({
          sliceId: "s01",
          line: 7,
          severity: "critical",
          summary: "shallow critical",
        }),
      ],
      agentsRun: ["diff-critic"],
      generated: "2026-01-01",
    });

    expect(text.indexOf("### Depth 0")).toBeLessThan(
      text.indexOf("### Depth 1"),
    );
    expect(text.indexOf("shallow critical")).toBeLessThan(
      text.indexOf("shallow medium"),
    );
    expect(text.indexOf("shallow medium")).toBeLessThan(
      text.indexOf("deep low"),
    );
  });

  it("files a finding on a slice outside the scope under Out of scope, keeping its id", () => {
    const text = renderReviewFile({
      branch: "feat",
      base: "main",
      slices: SLICES,
      scope,
      findings: [finding({ sliceId: "s03", summary: "elsewhere" })],
    });
    const section = text.slice(
      text.indexOf("## Out of scope"),
      text.indexOf("## Unassigned"),
    );
    expect(section).toContain("`s03`");
    expect(section).toContain("elsewhere");
  });

  it("files a finding with no resolvable slice under Unassigned", () => {
    const text = renderReviewFile({
      branch: "feat",
      base: "main",
      slices: SLICES,
      scope,
      findings: [
        finding({
          sliceId: null,
          file: "seam.ts",
          summary: "nobody owns this",
        }),
      ],
    });
    const section = text.slice(
      text.indexOf("## Unassigned"),
      text.indexOf("## Notes"),
    );
    expect(section).toContain("nobody owns this");
  });

  it("re-derives section placement rather than trusting the prior grouping", () => {
    // A finding parsed out of Out of scope moves into a depth section once its
    // slice is back in scope — placement is a function of the current graph.
    const parsed = parseReviewFile(
      "## Out of scope\n- [ ] `s02` `b.ts:9` — moved back in. (severity: low, source: diff-critic)",
    );
    const text = renderReviewFile({
      branch: "feat",
      base: "main",
      slices: SLICES,
      scope,
      findings: parsed.findings,
    });
    expect(
      text.slice(text.indexOf("### Depth 1"), text.indexOf("## Out of scope")),
    ).toContain("moved back in");
  });

  it("says so explicitly when a section is empty", () => {
    const text = renderReviewFile({
      branch: "feat",
      base: "main",
      slices: SLICES,
      scope: { changed: [], slicemap: {} },
      findings: [],
    });
    expect(text).toContain("None in the reviewed scope.");
    expect(text).toContain("- **Reviewed slices**: none — nothing moved");
  });

  it("embeds machine state that survives a parse round-trip", () => {
    const text = renderReviewFile({
      branch: "feat",
      base: "main",
      slices: SLICES,
      scope: {
        changed: ["s02", "s01"],
        slicemap: { s01: { patchId: "p1", touched: ["a.ts"] } },
      },
      findings: [],
      agentsRun: ["diff-critic"],
      generated: "2026-01-01",
    });

    const state = parseReviewFile(text).state;
    // Order is preserved exactly: the build loop needs the FIRST changed id as a
    // replay anchor, so a re-sorted set would send it to the wrong commit.
    expect(state.changed).toEqual(["s02", "s01"]);
    expect(state.slicemap.s01.touched).toEqual(["a.ts"]);
    expect(state.agentsRun).toEqual(["diff-critic"]);
  });

  it("round-trips every finding state and flag through render and parse", () => {
    const original = [
      finding({ line: 1, state: FINDING_STATES.OPEN }),
      finding({ line: 2, state: FINDING_STATES.DECLINED }),
      finding({
        line: 3,
        state: FINDING_STATES.ADDRESSED,
        flags: ["not re-reported"],
      }),
      finding({ line: 4, source: "diff-security", flags: ["unverified"] }),
    ];
    const text = renderReviewFile({
      branch: "feat",
      base: "main",
      slices: SLICES,
      scope,
      findings: original,
    });

    const reparsed = parseReviewFile(text).findings;
    expect(reparsed.map((f) => f.state)).toEqual(original.map((f) => f.state));
    expect(reparsed.find((f) => f.line === 3).flags).toEqual([
      "not re-reported",
    ]);
    expect(reparsed.find((f) => f.line === 4).flags).toEqual(["unverified"]);
  });

  it("renders a finding with no fix or metadata without trailing punctuation noise", () => {
    const text = renderReviewFile({
      branch: "feat",
      base: "main",
      slices: SLICES,
      scope,
      findings: [
        finding({
          fix: null,
          severity: null,
          source: null,
          summary: "bare finding.",
        }),
      ],
    });
    expect(text).toContain("- [ ] `s01` `a.ts:42` — bare finding.\n");
  });

  it("preserves an unparsed line while still updating its checkbox", () => {
    const text = renderReviewFile({
      branch: "feat",
      base: "main",
      slices: SLICES,
      scope,
      findings: [
        {
          state: FINDING_STATES.ADDRESSED,
          unparsed: true,
          raw: "- [ ] freeform nobody formatted",
          sliceId: null,
        },
      ],
    });
    expect(text).toContain("- [x] freeform nobody formatted");
  });

  it("writes notes, or None when there are none", () => {
    const withNotes = renderReviewFile({
      branch: "feat",
      base: "main",
      slices: SLICES,
      scope,
      findings: [],
      notes: ["- diff-security skipped."],
    });
    expect(withNotes).toContain("- diff-security skipped.");

    const without = renderReviewFile({
      branch: "feat",
      base: "main",
      slices: SLICES,
      scope,
      findings: [],
    });
    expect(without.slice(without.indexOf("## Notes"))).toContain("None.");
  });

  it("defaults generated to today rather than emitting null", () => {
    const text = renderReviewFile({
      branch: "f",
      base: "main",
      scope,
      findings: [],
    });
    expect(text).toMatch(/- \*\*Generated\*\*: \d{4}-\d{2}-\d{2}/);
  });
});

describe("openFindings / countBySeverity", () => {
  it("counts only open findings as a replay trigger", () => {
    const all = [
      finding({ line: 1, state: FINDING_STATES.OPEN }),
      finding({ line: 2, state: FINDING_STATES.DECLINED }),
      finding({ line: 3, state: FINDING_STATES.ADDRESSED }),
    ];
    expect(openFindings(all)).toHaveLength(1);
  });

  it("buckets unknown severities separately instead of miscounting them", () => {
    expect(
      countBySeverity([
        finding({ severity: "critical" }),
        finding({ severity: "high" }),
        finding({ severity: null }),
        finding({ severity: "bogus" }),
      ]),
    ).toEqual({ critical: 1, high: 1, medium: 0, low: 0, unknown: 2 });
  });
});
