import { describe, expect, it } from "vitest";
import {
  ACTION_PRESENTATION,
  buildDashboardView,
  indexClassifications,
  indexStagnation,
  QUEUE_ORDER,
  QUEUE_TITLES,
  queueForClassification,
  toClassifierSnapshot,
} from "../lib/dashboard-view.js";

const NOW = Date.parse("2026-08-05T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function ticket(key, opts = {}) {
  return {
    key,
    summary: opts.summary || `Summary ${key}`,
    labels: opts.labels || [],
    blockers: opts.blockers || [],
    blocks: opts.blocks || [],
    branch: opts.branch ?? key,
    ...opts,
  };
}

function stack(opts = {}) {
  return {
    containerKey: opts.containerKey || "Standalone",
    containerSummary: opts.containerSummary || "",
    featureBranch: opts.featureBranch || null,
    tickets: opts.tickets || [],
    ...opts,
  };
}

describe("toClassifierSnapshot", () => {
  it("nests flat stack fields into the container shape the classifier expects", () => {
    const snapshot = toClassifierSnapshot([
      stack({ containerKey: "EPIC-1", featureBranch: "EPIC-1" }),
    ]);
    expect(snapshot[0].container).toEqual({
      key: "EPIC-1",
      featureBranch: "EPIC-1",
      parentFeatureBranch: null,
      unmergedBlockers: [],
    });
  });

  it("maps the Standalone sentinel to a null container key", () => {
    const snapshot = toClassifierSnapshot([
      stack({ containerKey: "Standalone" }),
    ]);
    expect(snapshot[0].container.key).toBeNull();
  });

  it("returns an empty array for missing input", () => {
    expect(toClassifierSnapshot(undefined)).toEqual([]);
  });
});

describe("indexClassifications", () => {
  it("indexes classifications by ticket key", () => {
    const indexed = indexClassifications({
      stacks: [
        {
          classifications: [
            { key: "A-1", nextAction: "idle" },
            { key: "A-2", nextAction: "failed" },
          ],
        },
      ],
    });
    expect(indexed.get("A-2").nextAction).toBe("failed");
  });

  it("surfaces pendingProbes as an explicit unknown rather than dropping them", () => {
    const indexed = indexClassifications({
      stacks: [],
      pendingProbes: [{ key: "A-1", branch: "A-1", base: "EPIC-1" }],
    });
    expect(indexed.get("A-1").nextAction).toBe("unknown");
    expect(indexed.get("A-1").reason).toContain("EPIC-1");
  });

  it("skips inline pendingProbe classifications", () => {
    const indexed = indexClassifications({
      stacks: [
        {
          classifications: [
            { key: "A-1", nextAction: null, pendingProbe: { branch: "A-1" } },
          ],
        },
      ],
    });
    expect(indexed.has("A-1")).toBe(false);
  });
});

describe("queueForClassification", () => {
  it("routes autoSafe work ahead of its nextAction", () => {
    expect(
      queueForClassification({
        nextAction: "cleanup-terminal",
        autoSafe: true,
      }),
    ).toBe("autoSafe");
  });

  it.each([
    ["failed", "asks"],
    ["ticket-work", "asks"],
    ["awaiting-review", "manual"],
    ["blocked-on-stack", "blocked"],
    ["blocked-on-container", "blocked"],
    ["in-flight", "inFlight"],
    ["idle", "idle"],
    ["unknown", "unknown"],
  ])("routes %s to the %s queue", (nextAction, expected) => {
    expect(queueForClassification({ nextAction, autoSafe: false })).toBe(
      expected,
    );
  });

  it("defaults a missing classification to idle", () => {
    expect(queueForClassification(null)).toBe("idle");
  });

  it("routes every queue it can emit to a titled column", () => {
    // Pins the two tables together: a queue name with no QUEUE_TITLES entry
    // renders as an untitled column, and one missing from QUEUE_ORDER never
    // renders at all.
    for (const nextAction of Object.keys(ACTION_PRESENTATION)) {
      const queue = queueForClassification({ nextAction, autoSafe: false });
      expect(QUEUE_ORDER).toContain(queue);
      expect(QUEUE_TITLES[queue]).toBeTruthy();
    }
    expect(queueForClassification({ autoSafe: true })).toBe("autoSafe");
    expect(QUEUE_ORDER).toContain("autoSafe");
  });
});

describe("indexStagnation", () => {
  it("keeps every finding for a ticket that trips more than one rule", () => {
    const indexed = indexStagnation({
      findings: [
        { key: "A-1", kind: "unattended-failure" },
        { key: "A-1", kind: "rotting-pr" },
      ],
    });
    expect(indexed.get("A-1")).toHaveLength(2);
  });

  it("returns an empty map when there are no findings", () => {
    expect(indexStagnation({}).size).toBe(0);
  });
});

describe("buildDashboardView", () => {
  it("decorates tickets with nextAction, hint and tone", () => {
    const view = buildDashboardView({
      stacks: [
        stack({
          tickets: [ticket("A-1", { labels: ["ClaudeStackReady"] })],
        }),
      ],
      now: NOW,
    });

    const decorated = view.stacks[0].tickets[0];
    expect(decorated.nextAction).toBe("awaiting-review");
    expect(decorated.actionHint).toBe(
      ACTION_PRESENTATION["awaiting-review"].hint,
    );
    expect(decorated.actionTone).toBe("review");
  });

  it("groups ticket keys into queues", () => {
    const view = buildDashboardView({
      stacks: [
        stack({
          tickets: [
            ticket("A-1", { labels: ["ClaudeStackReady"] }),
            ticket("A-2", { labels: ["ClaudeFailed"] }),
            ticket("A-3", { labels: ["ClaudeExecuting"] }),
          ],
        }),
      ],
      now: NOW,
    });

    expect(view.queues.manual).toEqual(["A-1"]);
    expect(view.queues.asks).toEqual(["A-2"]);
    expect(view.queues.inFlight).toEqual(["A-3"]);
  });

  it("attaches stagnation findings to the tickets that own them", () => {
    // ClaudeExecuting with a signal 20h old trips abandoned-in-flight (12h).
    const view = buildDashboardView({
      stacks: [
        stack({
          tickets: [
            ticket("A-1", {
              labels: ["ClaudeExecuting"],
              updatedAt: new Date(NOW - 20 * HOUR).toISOString(),
            }),
          ],
        }),
      ],
      now: NOW,
    });

    const findings = view.stacks[0].tickets[0].stagnation;
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("abandoned-in-flight");
    expect(view.stagnation.counts.total).toBe(1);
  });

  it("leaves a fresh in-flight ticket unflagged", () => {
    const view = buildDashboardView({
      stacks: [
        stack({
          tickets: [
            ticket("A-1", {
              labels: ["ClaudeExecuting"],
              updatedAt: new Date(NOW - 1 * HOUR).toISOString(),
            }),
          ],
        }),
      ],
      now: NOW,
    });
    expect(view.stacks[0].tickets[0].stagnation).toEqual([]);
    expect(view.stagnation.counts.total).toBe(0);
  });

  it("honors overridden thresholds", () => {
    const stacks = [
      stack({
        tickets: [
          ticket("A-1", {
            labels: ["ClaudeFailed"],
            updatedAt: new Date(NOW - 2 * DAY).toISOString(),
          }),
        ],
      }),
    ];

    // Default failedDays is 3, so 2d is clean...
    expect(
      buildDashboardView({ stacks, now: NOW }).stagnation.counts.total,
    ).toBe(0);
    // ...but not under a 1-day threshold.
    const strict = buildDashboardView({
      stacks,
      now: NOW,
      thresholds: { failedDays: 1 },
    });
    expect(strict.stagnation.counts.total).toBe(1);
  });

  it("marks a stack needing rebase when a merged blocker left a sibling behind", () => {
    const view = buildDashboardView({
      stacks: [
        stack({
          containerKey: "EPIC-1",
          featureBranch: "EPIC-1",
          tickets: [
            ticket("A-1", { mergedIntoFeature: true }),
            ticket("A-2", { blockers: ["A-1"], mergedIntoFeature: false }),
          ],
        }),
      ],
      now: NOW,
    });
    expect(view.stacks[0].needsStackRebase).toBe(true);
  });

  it("marks a standalone stack needing rebase", () => {
    // Regression: the flag used to be looked up by matching the classifier's
    // `container` against stack.containerKey. toClassifierSnapshot maps the
    // "Standalone" sentinel to null, so that comparison was null === "Standalone"
    // and the flag could never be true for a standalone stack.
    const view = buildDashboardView({
      stacks: [
        stack({
          containerKey: "Standalone",
          tickets: [
            ticket("A-1", { mergedIntoFeature: true }),
            ticket("A-2", { blockers: ["A-1"], mergedIntoFeature: false }),
          ],
        }),
      ],
      now: NOW,
    });
    expect(view.stacks[0].needsStackRebase).toBe(true);
  });

  it("keeps per-stack flags aligned when several stacks classify alike", () => {
    // Two standalone stacks both classify to `container: null`, so a key-based
    // lookup would resolve both to whichever came first.
    const view = buildDashboardView({
      stacks: [
        stack({ containerKey: "Standalone", tickets: [ticket("A-1")] }),
        stack({
          containerKey: "Standalone",
          tickets: [
            ticket("B-1", { mergedIntoFeature: true }),
            ticket("B-2", { blockers: ["B-1"], mergedIntoFeature: false }),
          ],
        }),
      ],
      now: NOW,
    });
    expect(view.stacks[0].needsStackRebase).toBe(false);
    expect(view.stacks[1].needsStackRebase).toBe(true);
  });

  it("does not mutate the input stacks", () => {
    const input = [stack({ tickets: [ticket("A-1")] })];
    buildDashboardView({ stacks: input, now: NOW });
    expect(input[0].tickets[0].nextAction).toBeUndefined();
    expect(input[0].needsStackRebase).toBeUndefined();
  });

  it("surfaces a probe-pending ticket as explicitly indeterminate", () => {
    // A ticket awaiting a merge probe classifies as "unknown". It gets its own
    // hint, tone, and queue rather than falling into idle: idle is collapsed by
    // the UI whenever actionable work exists, so a ticket the classifier could
    // not judge would silently vanish from the picture.
    const view = buildDashboardView({
      stacks: [
        stack({
          containerKey: "EPIC-1",
          featureBranch: "EPIC-1",
          parentFeatureBranch: "EPIC-0",
          tickets: [ticket("EPIC-1", { branch: "EPIC-1" })],
        }),
      ],
      now: NOW,
    });

    const decorated = view.stacks[0].tickets[0];
    expect(decorated.nextAction).toBe("unknown");
    expect(decorated.actionHint).toBe("state unknown");
    expect(decorated.actionTone).toBe("unknown");
    expect(view.queues.unknown).toContain("EPIC-1");
    expect(view.queues.idle).not.toContain("EPIC-1");
  });

  it("falls back to a null hint for an action with no presentation entry", () => {
    // Guards the ACTION_PRESENTATION lookup itself: a nextAction the table has
    // never heard of must render as idle rather than throw.
    expect(ACTION_PRESENTATION["not-a-real-action"]).toBeUndefined();
    expect(queueForClassification({ nextAction: "not-a-real-action" })).toBe(
      "idle",
    );
  });

  it("defaults needsStackRebase to false when the stack has no classifier entry", () => {
    const view = buildDashboardView({
      stacks: [stack({ containerKey: "Standalone", tickets: [ticket("A-1")] })],
      now: NOW,
    });
    expect(view.stacks[0].needsStackRebase).toBe(false);
  });

  it("tolerates a stack with no tickets array", () => {
    const view = buildDashboardView({
      stacks: [{ containerKey: "EPIC-1" }],
      now: NOW,
    });
    expect(view.stacks[0].tickets).toEqual([]);
  });

  it("defaults to an empty snapshot when stacks is omitted", () => {
    const view = buildDashboardView({ now: NOW });
    expect(view.stacks).toEqual([]);
  });

  it("handles an empty snapshot", () => {
    const view = buildDashboardView({ stacks: [], now: NOW });
    expect(view.stacks).toEqual([]);
    expect(view.stagnation.findings).toEqual([]);
    expect(Object.values(view.queues).every((q) => q.length === 0)).toBe(true);
  });
});
