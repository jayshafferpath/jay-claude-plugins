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

  it("rule 1a: phaseOneDone (merged/{KEY} tag) suppresses re-running phase-1 cleanup", () => {
    const branch = "feat/story-3";
    const out = classifyActions({
      stacks: [
        stack({
          container: {
            key: "STORY-3",
            featureBranch: branch,
            parentFeatureBranch: "feat/epic-99",
          },
          tickets: [ticket("STORY-3", { branch, phaseOneDone: true })],
        }),
      ],
      mergedToParentFeatureBranch: { [branch]: true },
    });
    expect(out.pendingProbes).toHaveLength(0);
    // Phase-1 already ran, so the next step is main promotion — not a repeat.
    expect(out.queues.autoSafe).toHaveLength(1);
    expect(out.queues.autoSafe[0].nextAction).toBe("promote-to-main");
  });

  it("rule 1a: phaseOneDone skips the probe entirely", () => {
    const branch = "feat/story-4";
    const out = classifyActions({
      stacks: [
        stack({
          container: {
            key: "STORY-4",
            featureBranch: branch,
            parentFeatureBranch: "feat/epic-99",
          },
          tickets: [ticket("STORY-4", { branch, phaseOneDone: true })],
        }),
      ],
      // No merge state supplied — would normally emit a pendingProbe.
      mergedToParentFeatureBranch: {},
    });
    expect(out.pendingProbes).toHaveLength(0);
    expect(out.queues.autoSafe[0].nextAction).toBe("promote-to-main");
  });

  it("rule 1a: a stale ClaudePendingMainPromotion label no longer suppresses anything", () => {
    const branch = "feat/story-5";
    const out = classifyActions({
      stacks: [
        stack({
          container: {
            key: "STORY-5",
            featureBranch: branch,
            parentFeatureBranch: "feat/epic-99",
          },
          tickets: [
            ticket("STORY-5", {
              branch,
              labels: ["ClaudePendingMainPromotion"],
            }),
          ],
        }),
      ],
      mergedToParentFeatureBranch: { [branch]: true },
    });
    expect(out.queues.autoSafe[0].nextAction).toBe("cleanup-phase-1");
  });

  // The three merge shapes differ only in fields the rest of these tests hold
  // constant, so each gets its own case: a leaf merged into its container's
  // feature branch, a Story-container merged into a parent Epic's branch, and a
  // ticket merged to main.
  describe("merge-shape discrimination", () => {
    it("rule 1c: leaf merged into the container's feature branch → cleanup-phase-1", () => {
      const out = classifyActions({
        stacks: [
          stack({
            container: { key: "EPIC-1", featureBranch: "NEV-1352" },
            tickets: [
              ticket("NEV-1616", {
                branch: "NEV-1616",
                mergedIntoFeature: true,
                mergedIntoMain: false,
                // The label survives until cleanup clears it — the whole point
                // is that it must not win over the merge state.
                labels: ["ClaudeStackReady"],
              }),
            ],
          }),
        ],
      });
      expect(out.queues.autoSafe).toHaveLength(1);
      expect(out.queues.autoSafe[0].nextAction).toBe("cleanup-phase-1");
      expect(out.queues.manual).toHaveLength(0);
    });

    // Regression: NEV-1446 shipped to Epic branch NEV-1352 and was classified
    // cleanup-terminal, which transitioned the Story to Done and would have
    // deleted a branch /promote-to-main still needs. A feature-branch merge is
    // never terminal — /promote-to-main promotes leaves individually (Step 1c
    // takes a leaf ticket key), so the branch and Jira state must survive.
    it("a leaf merged only into the feature branch is never terminal", () => {
      const out = classifyActions({
        stacks: [
          stack({
            container: { key: "NEV-1352", featureBranch: "NEV-1352" },
            tickets: [
              ticket("NEV-1446", {
                branch: "NEV-1446",
                mergedIntoFeature: true,
                mergedIntoMain: false,
                labels: ["ClaudeStackReady"],
              }),
            ],
          }),
        ],
      });
      expect(out.queues.autoSafe[0].nextAction).not.toBe("cleanup-terminal");
      expect(out.queues.autoSafe[0].nextAction).toBe("cleanup-phase-1");
      expect(out.queues.autoSafe[0].reason).toBe(
        "merged into feature branch, awaiting main promotion",
      );
    });

    // Regression: rule 1c re-emitted cleanup-phase-1 on every pass, because the
    // branch survives phase-1 and nothing else in the rule changed. The leaf
    // never advanced to the promotion that actually ships it — NEV-1446 sat on
    // the Epic branch with a merged/{KEY} tag and no PR to main.
    it("a leaf whose phase-1 already ran advances to promote-to-main, not another cleanup", () => {
      const out = classifyActions({
        stacks: [
          stack({
            container: { key: "NEV-1352", featureBranch: "NEV-1352" },
            tickets: [
              ticket("NEV-1446", {
                branch: "NEV-1446",
                mergedIntoFeature: true,
                mergedIntoMain: false,
                phaseOneDone: true,
              }),
            ],
          }),
        ],
      });
      expect(out.queues.autoSafe).toHaveLength(1);
      expect(out.queues.autoSafe[0].nextAction).toBe("promote-to-main");
      expect(out.queues.autoSafe[0].reason).toBe(
        "phase-1 cleanup done, awaiting main promotion",
      );
    });

    it("the same leaf becomes terminal once it reaches main", () => {
      const out = classifyActions({
        stacks: [
          stack({
            container: { key: "NEV-1352", featureBranch: "NEV-1352" },
            tickets: [
              ticket("NEV-1446", {
                branch: "NEV-1446",
                mergedIntoFeature: true,
                mergedIntoMain: true,
              }),
            ],
          }),
        ],
      });
      expect(out.queues.autoSafe[0].nextAction).toBe("cleanup-terminal");
      expect(out.queues.autoSafe[0].reason).toBe("mergedIntoMain=true");
    });

    it("rule 1a still wins for a Story-container merged into the parent Epic branch", () => {
      const branch = "feat/story-container";
      const out = classifyActions({
        stacks: [
          stack({
            container: {
              key: "STORY-1",
              featureBranch: branch,
              parentFeatureBranch: "feat/epic-99",
            },
            tickets: [
              ticket("STORY-1", {
                branch,
                mergedIntoFeature: true,
                mergedIntoMain: false,
              }),
            ],
          }),
        ],
        mergedToParentFeatureBranch: { [branch]: true },
      });
      // Not cleanup-terminal: a stack-container defers destructive cleanup so
      // /promote-to-main can still rebase its branch onto main.
      expect(out.queues.autoSafe[0].nextAction).toBe("cleanup-phase-1");
    });

    it("rule 1 still wins for a ticket merged to main", () => {
      const out = classifyActions({
        stacks: [
          stack({
            container: { key: "EPIC-1", featureBranch: "NEV-1352" },
            tickets: [
              ticket("NEV-1440", {
                branch: "NEV-1440",
                mergedIntoFeature: true,
                mergedIntoMain: true,
              }),
            ],
          }),
        ],
      });
      expect(out.queues.autoSafe[0].nextAction).toBe("cleanup-terminal");
      expect(out.queues.autoSafe[0].reason).toBe("mergedIntoMain=true");
    });

    it("a leaf that has not merged anywhere is untouched by rule 1c", () => {
      const out = classifyActions({
        stacks: [
          stack({
            container: { key: "EPIC-1", featureBranch: "NEV-1352" },
            tickets: [
              ticket("NEV-1446", {
                mergedIntoFeature: false,
                labels: ["ClaudeStackReady"],
              }),
            ],
          }),
        ],
      });
      expect(out.queues.autoSafe).toHaveLength(0);
      expect(out.queues.manual[0].nextAction).toBe("awaiting-review");
    });
  });

  describe("already-cleaned tickets", () => {
    it("merged to main with no branch → cleaned, not a doomed cleanup dispatch", () => {
      const out = classifyActions({
        stacks: [
          stack({
            container: { key: "EPIC-1", featureBranch: "NEV-1352" },
            tickets: [
              ticket("NEV-1440", { branch: null, mergedIntoMain: true }),
            ],
          }),
        ],
      });
      // /cleanup Step 1b refuses on a null branch, so queueing it auto-safe
      // guarantees a refusal every round.
      expect(out.queues.autoSafe).toHaveLength(0);
      expect(out.queues.idle[0].nextAction).toBe("cleaned");
    });

    // Regression: NEV-1442/NEV-1616 merged into Epic branch NEV-1352, had their
    // branches deleted by phase-1 cleanup, and classified as `cleaned` with
    // autoSafe:false. Nothing revisited them, so three commits sat on the Epic
    // branch with no PR to main and no rule that would ever open one. `cleaned`
    // now means "merged to main", and a feature-only merge with a replayable tag
    // is owed a promotion.
    it("merged into the feature branch with no branch but a merge tag → promote-to-main", () => {
      const out = classifyActions({
        stacks: [
          stack({
            container: { key: "EPIC-1", featureBranch: "NEV-1352" },
            tickets: [
              ticket("NEV-1616", {
                branch: null,
                mergedIntoFeature: true,
                phaseOneDone: true,
              }),
            ],
          }),
        ],
      });
      expect(out.queues.idle).toHaveLength(0);
      expect(out.queues.autoSafe).toHaveLength(1);
      expect(out.queues.autoSafe[0].nextAction).toBe("promote-to-main");
    });

    it("merged into the feature branch with neither branch nor tag → stranded, surfaced to a human", () => {
      const out = classifyActions({
        stacks: [
          stack({
            container: { key: "EPIC-1", featureBranch: "NEV-1352" },
            tickets: [
              ticket("NEV-1442", { branch: null, mergedIntoFeature: true }),
            ],
          }),
        ],
      });
      // Nothing left to replay from, so this must not be dispatched as auto-safe
      // work — but it must not read as idle either.
      expect(out.queues.autoSafe).toHaveLength(0);
      expect(out.queues.idle).toHaveLength(0);
      expect(out.queues.manual[0].nextAction).toBe("stranded");
    });

    it("an unmerged ticket with no branch is not treated as cleaned", () => {
      const out = classifyActions({
        stacks: [
          stack({
            container: { key: "EPIC-1", featureBranch: "NEV-1352" },
            tickets: [
              ticket("NEV-9999", { branch: null, labels: ["ClaudeReady"] }),
            ],
          }),
        ],
      });
      expect(out.queues.asks[0].nextAction).toBe("ticket-work");
    });
  });

  it("rule 2: ClaudeStackReady → awaiting-review manual", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [ticket("PROJ-3", { labels: ["ClaudeStackReady"] })],
        }),
      ],
    });
    expect(out.queues.manual[0].nextAction).toBe("awaiting-review");
  });

  it("never classifies on the retired ClaudePRApproved label", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "feat/x" },
          tickets: [ticket("PROJ-2", { labels: ["ClaudePRApproved"] })],
        }),
      ],
    });
    expect(out.queues.autoSafe).toHaveLength(0);
    expect(out.queues.idle[0].nextAction).toBe("idle");
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
            ticket("PROJ-9", { labels: ["ClaudeStackReady"] }),
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

  it("needs_stack_rebase: false when the branch has no unique commits", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "NEV-1352" },
          tickets: [
            ticket("NEV-1616", { mergedIntoFeature: true }),
            // Branch tip is byte-identical to the Epic branch: cut fresh from it
            // after its blocker merged, so a rebase would move nothing.
            ticket("NEV-1446", {
              mergedIntoFeature: false,
              blockers: ["NEV-1616"],
              hasUniqueCommits: false,
            }),
          ],
        }),
      ],
    });
    expect(out.stacks[0].stackFlags.needsStackRebase).toBe(false);
  });

  it("needs_stack_rebase: true when the branch has diverged from its base", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "NEV-1352" },
          tickets: [
            ticket("NEV-1616", { mergedIntoFeature: true }),
            ticket("NEV-1446", {
              mergedIntoFeature: false,
              blockers: ["NEV-1616"],
              hasUniqueCommits: true,
            }),
          ],
        }),
      ],
    });
    expect(out.stacks[0].stackFlags.needsStackRebase).toBe(true);
  });

  it("needs_stack_rebase: stays permissive when the probe is unavailable", () => {
    const out = classifyActions({
      stacks: [
        stack({
          container: { key: "EPIC-1", featureBranch: "NEV-1352" },
          tickets: [
            ticket("NEV-1616", { mergedIntoFeature: true }),
            // No hasUniqueCommits — repo root unresolved, or a ref wouldn't
            // resolve. Better to over-report than hide real staleness.
            ticket("NEV-1446", {
              mergedIntoFeature: false,
              blockers: ["NEV-1616"],
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
              labels: ["ClaudeStackReady"],
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
          tickets: [{ key: "PROJ-NB", labels: [], mergedIntoFeature: false }],
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

  it("returns S4.6 → manual", () => {
    expect(extractFailedStep("review at S4.6").recommendation).toBe("manual");
  });

  it("uses the last matching step when multiple appear", () => {
    const log = "## S4.2 plan\n## S4.3 verify";
    expect(extractFailedStep(log).failedStep).toBe("S4.3");
  });
});
