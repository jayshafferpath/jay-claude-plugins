import { describe, expect, it } from "vitest";

import {
  DEFAULT_THRESHOLDS,
  detectStagnation,
  detectTicketStagnation,
  latestTimestamp,
  parseTimestamp,
  STAGNATION_KINDS,
} from "../lib/stagnation.js";

// Fixed clock so every age assertion is exact rather than relative to wall time.
const NOW = Date.parse("2026-08-04T12:00:00Z");

function hoursAgo(n) {
  return new Date(NOW - n * 60 * 60 * 1000).toISOString();
}

function daysAgo(n) {
  return new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
}

function ticket(key, overrides = {}) {
  return { key, branch: `${key}-branch`, labels: [], ...overrides };
}

function stack(tickets, container = { key: "EPIC-1" }) {
  return { container, tickets };
}

function detect(tickets, opts = {}) {
  return detectStagnation({
    stacks: [stack(tickets)],
    now: NOW,
    ...opts,
  });
}

describe("parseTimestamp", () => {
  it("parses ISO 8601 to epoch ms", () => {
    expect(parseTimestamp("2026-08-04T12:00:00Z")).toBe(NOW);
  });

  it("returns null for absent or unparseable values", () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("not a date")).toBeNull();
  });
});

describe("latestTimestamp", () => {
  it("returns the newest of several stamps, ignoring nulls", () => {
    expect(latestTimestamp([daysAgo(5), null, daysAgo(1), undefined])).toBe(
      Date.parse(daysAgo(1)),
    );
  });

  it("returns null when every value is missing", () => {
    expect(latestTimestamp([null, undefined])).toBeNull();
    expect(latestTimestamp([])).toBeNull();
    expect(latestTimestamp(undefined)).toBeNull();
  });
});

describe("abandoned-in-flight rule", () => {
  it("flags ClaudeExecuting gone quiet past the threshold", () => {
    const out = detect([
      ticket("PROJ-1", {
        labels: ["ClaudeWork", "ClaudeExecuting"],
        lastActivityAt: hoursAgo(30),
        lastCommitAt: hoursAgo(30),
        updatedAt: hoursAgo(30),
      }),
    ]);

    expect(out.counts.total).toBe(1);
    const finding = out.findings[0];
    expect(finding.kind).toBe(STAGNATION_KINDS.ABANDONED_IN_FLIGHT);
    expect(finding.label).toBe("ClaudeExecuting");
    expect(finding.ageHours).toBe(30);
    expect(finding.suggestedAction).toBe("clear-stale-in-flight");
    expect(finding.container).toBe("EPIC-1");
  });

  it("flags ClaudePlanning too", () => {
    const out = detect([
      ticket("PROJ-2", {
        labels: ["ClaudePlanning"],
        updatedAt: hoursAgo(48),
      }),
    ]);
    expect(out.findings[0].label).toBe("ClaudePlanning");
  });

  it("stays quiet when any one signal is recent", () => {
    const out = detect([
      ticket("PROJ-3", {
        labels: ["ClaudeExecuting"],
        // Activity log went quiet, but the branch is still receiving commits —
        // a long execute step, not an abandoned one.
        lastActivityAt: hoursAgo(40),
        lastCommitAt: hoursAgo(1),
        updatedAt: hoursAgo(40),
      }),
    ]);
    expect(out.counts.total).toBe(0);
  });

  it("stays quiet below the threshold and fires at exactly the boundary", () => {
    const under = detect([
      ticket("PROJ-4", {
        labels: ["ClaudeExecuting"],
        updatedAt: hoursAgo(DEFAULT_THRESHOLDS.inFlightHours - 0.5),
      }),
    ]);
    expect(under.counts.total).toBe(0);

    const at = detect([
      ticket("PROJ-4", {
        labels: ["ClaudeExecuting"],
        updatedAt: hoursAgo(DEFAULT_THRESHOLDS.inFlightHours),
      }),
    ]);
    expect(at.counts.total).toBe(1);
  });

  it("cannot judge a ticket with no timestamps at all", () => {
    const out = detect([ticket("PROJ-5", { labels: ["ClaudeExecuting"] })]);
    expect(out.counts.total).toBe(0);
  });

  it("ignores tickets carrying no in-flight label", () => {
    const out = detect([
      ticket("PROJ-6", {
        labels: ["ClaudeStackReady"],
        updatedAt: daysAgo(90),
      }),
    ]);
    expect(out.counts.total).toBe(0);
  });

  it("honors a custom threshold", () => {
    const out = detect(
      [
        ticket("PROJ-7", {
          labels: ["ClaudeExecuting"],
          updatedAt: hoursAgo(3),
        }),
      ],
      { thresholds: { inFlightHours: 2 } },
    );
    expect(out.counts.total).toBe(1);
  });
});

describe("unattended-failure rule", () => {
  it("flags ClaudeFailed past the threshold", () => {
    const out = detect([
      ticket("PROJ-10", { labels: ["ClaudeFailed"], updatedAt: daysAgo(9) }),
    ]);
    const finding = out.findings[0];
    expect(finding.kind).toBe(STAGNATION_KINDS.UNATTENDED_FAILURE);
    expect(finding.ageDays).toBe(9);
    expect(finding.suggestedAction).toBe("escalate-failure");
  });

  it("prefers failedSince over updatedAt when supplied", () => {
    const out = detect([
      ticket("PROJ-11", {
        labels: ["ClaudeFailed"],
        // A drive-by comment bumped updatedAt, but the failure is old.
        failedSince: daysAgo(20),
        updatedAt: hoursAgo(1),
      }),
    ]);
    expect(out.findings[0].ageDays).toBe(20);
  });

  it("stays quiet on a fresh failure", () => {
    const out = detect([
      ticket("PROJ-12", { labels: ["ClaudeFailed"], updatedAt: hoursAgo(2) }),
    ]);
    expect(out.counts.total).toBe(0);
  });

  it("cannot judge a failure with no timestamp", () => {
    const out = detect([ticket("PROJ-13", { labels: ["ClaudeFailed"] })]);
    expect(out.counts.total).toBe(0);
  });
});

describe("rotting-pr rule", () => {
  it("flags an open PR nobody has touched", () => {
    const out = detect([
      ticket("PROJ-20", {
        pr: {
          state: "OPEN",
          number: 42,
          url: "https://example.test/pr/42",
          lastCommitAt: daysAgo(11),
          updatedAt: daysAgo(11),
        },
      }),
    ]);
    const finding = out.findings[0];
    expect(finding.kind).toBe(STAGNATION_KINDS.ROTTING_PR);
    expect(finding.prNumber).toBe(42);
    expect(finding.ageDays).toBe(11);
    expect(finding.suggestedAction).toBe("ping-review");
    expect(finding.reasons).toHaveLength(1);
    expect(finding.reasons[0].reason).toBe("no-activity");
  });

  it("flags a PR whose base has moved far ahead even when recently touched", () => {
    const out = detect([
      ticket("PROJ-21", {
        pr: {
          state: "OPEN",
          number: 43,
          updatedAt: hoursAgo(1),
          behindBy: 80,
        },
      }),
    ]);
    const finding = out.findings[0];
    expect(finding.reasons).toHaveLength(1);
    expect(finding.reasons[0]).toMatchObject({
      reason: "base-moved",
      behindBy: 80,
    });
    expect(finding.suggestedAction).toBe("stack-rebase");
  });

  it("reports both reasons together, and rebase wins the tie", () => {
    const out = detect([
      ticket("PROJ-22", {
        pr: {
          state: "OPEN",
          number: 44,
          updatedAt: daysAgo(30),
          behindBy: 200,
        },
      }),
    ]);
    const finding = out.findings[0];
    expect(finding.reasons.map((r) => r.reason)).toEqual([
      "no-activity",
      "base-moved",
    ]);
    expect(finding.suggestedAction).toBe("stack-rebase");
    expect(finding.detail).toContain("200 commits behind");
  });

  it("uses the newest of commit, review, and comment activity", () => {
    const out = detect([
      ticket("PROJ-23", {
        pr: {
          state: "OPEN",
          number: 45,
          lastCommitAt: daysAgo(30),
          lastReviewAt: daysAgo(20),
          // A recent comment means the PR is not abandoned.
          lastCommentAt: hoursAgo(2),
        },
      }),
    ]);
    expect(out.counts.total).toBe(0);
  });

  it("ignores PRs that are not open", () => {
    const out = detect([
      ticket("PROJ-24", {
        pr: { state: "MERGED", number: 46, updatedAt: daysAgo(60) },
      }),
    ]);
    expect(out.counts.total).toBe(0);
  });

  it("ignores tickets with no PR", () => {
    expect(detect([ticket("PROJ-25")]).counts.total).toBe(0);
    expect(detect([ticket("PROJ-26", { pr: null })]).counts.total).toBe(0);
  });

  it("cannot judge behindBy when the probe returned null", () => {
    const out = detect([
      ticket("PROJ-27", {
        pr: {
          state: "OPEN",
          number: 47,
          updatedAt: hoursAgo(1),
          behindBy: null,
        },
      }),
    ]);
    expect(out.counts.total).toBe(0);
  });

  it("cannot judge a PR with no timestamps", () => {
    const out = detect([
      ticket("PROJ-28", { pr: { state: "OPEN", number: 48 } }),
    ]);
    expect(out.counts.total).toBe(0);
  });
});

describe("multi-rule behavior", () => {
  it("reports every matching rule for one ticket, unlike a first-match table", () => {
    const out = detect([
      ticket("PROJ-30", {
        labels: ["ClaudeFailed"],
        updatedAt: daysAgo(10),
        pr: { state: "OPEN", number: 50, updatedAt: daysAgo(10) },
      }),
    ]);
    expect(out.counts.total).toBe(2);
    expect(out.findings.map((f) => f.kind)).toEqual([
      STAGNATION_KINDS.UNATTENDED_FAILURE,
      STAGNATION_KINDS.ROTTING_PR,
    ]);
  });

  it("sorts worst-first by kind severity, then by age", () => {
    const out = detect([
      ticket("PROJ-41", {
        pr: { state: "OPEN", number: 61, updatedAt: daysAgo(30) },
      }),
      ticket("PROJ-42", { labels: ["ClaudeFailed"], updatedAt: daysAgo(4) }),
      ticket("PROJ-43", {
        labels: ["ClaudeExecuting"],
        updatedAt: hoursAgo(20),
      }),
      ticket("PROJ-44", {
        labels: ["ClaudeExecuting"],
        updatedAt: hoursAgo(99),
      }),
    ]);

    expect(out.findings.map((f) => f.key)).toEqual([
      "PROJ-44", // in-flight, oldest
      "PROJ-43", // in-flight
      "PROJ-42", // failure
      "PROJ-41", // rotting PR
    ]);
  });

  it("breaks age ties by key for stable output", () => {
    const out = detect([
      ticket("PROJ-52", { labels: ["ClaudeFailed"], updatedAt: daysAgo(5) }),
      ticket("PROJ-51", { labels: ["ClaudeFailed"], updatedAt: daysAgo(5) }),
    ]);
    expect(out.findings.map((f) => f.key)).toEqual(["PROJ-51", "PROJ-52"]);
  });

  it("buckets findings by kind with counts", () => {
    const out = detect([
      ticket("PROJ-60", {
        labels: ["ClaudeExecuting"],
        updatedAt: hoursAgo(50),
      }),
      ticket("PROJ-61", { labels: ["ClaudeFailed"], updatedAt: daysAgo(6) }),
    ]);
    expect(out.counts).toMatchObject({
      total: 2,
      [STAGNATION_KINDS.ABANDONED_IN_FLIGHT]: 1,
      [STAGNATION_KINDS.UNATTENDED_FAILURE]: 1,
      [STAGNATION_KINDS.ROTTING_PR]: 0,
    });
    expect(out.byKind[STAGNATION_KINDS.ROTTING_PR]).toEqual([]);
  });
});

describe("input handling", () => {
  it("accepts an ISO string for now", () => {
    const out = detectStagnation({
      stacks: [
        stack([
          ticket("PROJ-70", {
            labels: ["ClaudeFailed"],
            updatedAt: daysAgo(8),
          }),
        ]),
      ],
      now: "2026-08-04T12:00:00Z",
    });
    expect(out.findings[0].ageDays).toBe(8);
  });

  it("tolerates stacks with no container or no tickets", () => {
    const out = detectStagnation({
      stacks: [
        {
          tickets: [
            ticket("PROJ-71", {
              labels: ["ClaudeFailed"],
              updatedAt: daysAgo(8),
            }),
          ],
        },
        { container: { key: "EPIC-9" } },
        {},
      ],
      now: NOW,
    });
    expect(out.counts.total).toBe(1);
    expect(out.findings[0].container).toBeNull();
  });

  it("throws when stacks is not an array", () => {
    expect(() => detectStagnation({ stacks: null, now: NOW })).toThrow(
      /stacks must be an array/,
    );
  });

  it("throws when a ticket has no key", () => {
    expect(() => detectTicketStagnation({ labels: [] }, { now: NOW })).toThrow(
      /ticket.key is required/,
    );
  });

  it("throws when now is unusable", () => {
    expect(() =>
      detectTicketStagnation(ticket("PROJ-72"), { now: "nonsense" }),
    ).toThrow(/now must be a timestamp/);
  });

  it("clamps future timestamps to zero age rather than going negative", () => {
    const out = detect([
      ticket("PROJ-73", {
        labels: ["ClaudeExecuting"],
        updatedAt: hoursAgo(-5),
      }),
    ]);
    expect(out.counts.total).toBe(0);
  });
});
