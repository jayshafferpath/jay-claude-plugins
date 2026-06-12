import { describe, expect, it } from "vitest";

import { classifyActions, extractFailedStep } from "../lib/classify-actions.js";

function stack({ container, tickets }) {
  return { container, tickets };
}

function ticket(key, overrides = {}) {
  return {
    key,
    branch: `${key}-branch`,
    labels: [],
    mergedIntoMain: false,
    mergedIntoFeature: false,
    eligible: true,
    blockers: [],
    ...overrides,
  };
}

describe("classifyActions", () => {
  it("rule 1: mergedIntoMain → cleanup-terminal auto-safe", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [ticket("PROJ-1", { mergedIntoMain: true })],
        }),
      ],
    });
    expect(out.queues.autoSafe).toHaveLength(1);
    expect(out.queues.autoSafe[0].nextAction).toBe("cleanup-terminal");
  });

  it("rule 1a: Story-container merged to parent → cleanup-phase-1 auto-safe", () => {
    const branch = "feat/story-1";
    const out = classifyActions({
      stacks: [
        stack({
          container: {
            key: "STORY-1",
            featureBranch: branch,
            parentFeatureBranch: "feat/epic-99",
          },
          tickets: [ticket("STORY-1", { branch })],
        }),
      ],
      mergedToParentFeatureBranch: { [branch]: true },
    });
    expect(out.queues.autoSafe).toHaveLength(1);
    expect(out.queues.autoSafe[0].nextAction).toBe("cleanup-phase-1");
  });

  it("rule 1a: emits pendingProbes when PR-state map is missing the branch", () => {
    const branch = "feat/story-2";
    const out = classifyActions({
      stacks: [
        stack({
          container: {
            key: "STORY-2",
            featureBranch: branch,
            parentFeatureBranch: "feat/epic-99",
          },
          tickets: [ticket("STORY-2", { branch })],
        }),
      ],
    });
    expect(out.pendingProbes).toHaveLength(1);
    expect(out.pendingProbes[0]).toMatchObject({
      branch,
      base: "feat/epic-99",
      key: "STORY-2",
    });
    expect(out.queues.autoSafe).toHaveLength(0);
  });

  it("rule 1a: ClaudePendingMainPromotion suppresses re-classification", () => {
    const branch = "feat/story-3";
    const out = classifyActions({
      stacks: [
        stack({
          container: {
            key: "STORY-3",
            featureBranch: branch,
            parentFeatureBranch: "feat/epic-99",
          },
          tickets: [
            ticket("STORY-3", {
              branch,
              labels: ["ClaudePendingMainPromotion"],
            }),
          ],
        }),
      ],
      mergedToParentFeatureBranch: { [branch]: true },
    });
    expect(out.queues.autoSafe).toHaveLength(0);
    expect(out.pendingProbes).toHaveLength(0);
    expect(out.queues.idle).toHaveLength(1);
  });

  it("rule 2: ClaudePRApproved → promote-to-main auto-safe", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [ticket("PROJ-2", { labels: ["ClaudePRApproved"] })],
        }),
      ],
    });
    expect(out.queues.autoSafe[0].nextAction).toBe("promote-to-main");
  });

  it("rule 3-4: ClaudeStackReady → awaiting-pr-approval manual", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [ticket("PROJ-3", { labels: ["ClaudeStackReady"] })],
        }),
      ],
    });
    expect(out.queues.manual[0].nextAction).toBe("awaiting-pr-approval");
  });

  it("rule 5: ClaudeFailed → failed (asks queue)", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [ticket("PROJ-4", { labels: ["ClaudeFailed"] })],
        }),
      ],
    });
    expect(out.queues.asks[0].nextAction).toBe("failed");
  });

  it("rule 6: ClaudeExecuting → in-flight", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [ticket("PROJ-5", { labels: ["ClaudeExecuting"] })],
        }),
      ],
    });
    expect(out.queues.inFlight[0].nextAction).toBe("in-flight");
  });

  it("rule 7: ClaudeReady && eligible → ticket-work asks", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [
            ticket("PROJ-6", { labels: ["ClaudeReady"], eligible: true }),
          ],
        }),
      ],
    });
    expect(out.queues.asks[0].nextAction).toBe("ticket-work");
  });

  it("rule 8: ClaudeReady && !eligible → blocked-on-stack", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [
            ticket("PROJ-7", { labels: ["ClaudeReady"], eligible: false }),
          ],
        }),
      ],
    });
    expect(out.queues.blocked[0].nextAction).toBe("blocked-on-stack");
  });

  it("rule 9: no actionable label → idle", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [ticket("PROJ-8")],
        }),
      ],
    });
    expect(out.queues.idle[0].nextAction).toBe("idle");
  });

  it("container-blocked overrides every rule", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: {
            key: "EPIC-1",
            featureBranch: "feat/x",
            unmergedBlockers: ["EPIC-2"],
          },
          tickets: [
            ticket("PROJ-9", { labels: ["ClaudePRApproved"] }),
            ticket("PROJ-10", { mergedIntoMain: true }),
          ],
        }),
      ],
    });
    expect(out.stacks[0].stackFlags.blockedOnContainer).toEqual(["EPIC-2"]);
    expect(out.queues.autoSafe).toHaveLength(0);
    for (const c of out.stacks[0].classifications) {
      expect(c.nextAction).toBe("blocked-on-container");
    }
  });

  it("stack-level needs_stack_rebase: blocker merged but ticket isn't", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [
            ticket("PROJ-A", { mergedIntoFeature: true }),
            ticket("PROJ-B", {
              mergedIntoFeature: false,
              blockers: ["PROJ-A"],
            }),
          ],
        }),
      ],
    });
    expect(out.stacks[0].stackFlags.needsStackRebase).toBe(true);
  });

  it("rule precedence: mergedIntoMain wins over labels", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [
            ticket("PROJ-X", {
              mergedIntoMain: true,
              labels: ["ClaudePRApproved"],
            }),
          ],
        }),
      ],
    });
    expect(out.queues.autoSafe[0].nextAction).toBe("cleanup-terminal");
  });
});

describe("classifyActions input validation", () => {
  it("throws when stacks is not an array", () => {
    expect(() => classifyActions({ stacks: "not-array" })).toThrow(/array/);
    expect(() => classifyActions({ stacks: null })).toThrow(/array/);
    expect(() => classifyActions({})).toThrow(/array/);
  });

  it("tolerates a stack missing tickets/container", () => {
    const out = classifyActions({
      stacks: [{ container: null }, { container: { key: "X" } }],
    });
    expect(out.stacks[0].container).toBeNull();
    expect(out.stacks[0].classifications).toEqual([]);
    expect(out.stacks[1].container).toBe("X");
  });

  it("tolerates a ticket missing the blockers array", () => {
    const out = classifyActions({
      stacks: [
        {
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [
            { key: "PROJ-NB", labels: [], mergedIntoFeature: false },
          ],
        },
      ],
    });
    expect(out.stacks[0].stackFlags.needsStackRebase).toBe(false);
  });
});

describe("extractFailedStep", () => {
  it("returns null on empty input", () => {
    expect(extractFailedStep("")).toEqual({
      failedStep: null,
      recommendation: null,
    });
  });

  it("returns S4.2 → rework", () => {
    const log = "## ticket-work S4.2 plan\nbody";
    expect(extractFailedStep(log)).toEqual({
      failedStep: "S4.2",
      recommendation: "rework",
    });
  });

  it("returns S4.3 → fix-drift", () => {
    expect(extractFailedStep("## S4.3 verify failed").recommendation).toBe(
      "fix-drift",
    );
  });

  it("returns S4.7 → manual", () => {
    expect(extractFailedStep("review at S4.7").recommendation).toBe("manual");
  });

  it("uses the last matching step when multiple appear", () => {
    const log = "## S4.2 plan\n## S4.3 verify";
    expect(extractFailedStep(log).failedStep).toBe("S4.3");
  });
});
