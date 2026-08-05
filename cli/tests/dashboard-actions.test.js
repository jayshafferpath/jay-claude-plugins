import { describe, expect, it } from "vitest";
import {
  __test__,
  formatSlashCommand,
  isExecutionEnabled,
  resolveAction,
  validateActionRequest,
} from "../lib/dashboard-actions.js";
import { ACTION_PRESENTATION } from "../lib/dashboard-queues.js";

const ENABLED = { DASHBOARD_ALLOW_ACTIONS: "true" };

describe("isExecutionEnabled", () => {
  it("is off unless DASHBOARD_ALLOW_ACTIONS is exactly 'true'", () => {
    expect(isExecutionEnabled({})).toBe(false);
    expect(isExecutionEnabled({ DASHBOARD_ALLOW_ACTIONS: "1" })).toBe(false);
    expect(isExecutionEnabled({ DASHBOARD_ALLOW_ACTIONS: "yes" })).toBe(false);
    expect(isExecutionEnabled({ DASHBOARD_ALLOW_ACTIONS: "TRUE" })).toBe(false);
    expect(isExecutionEnabled(ENABLED)).toBe(true);
  });
});

describe("formatSlashCommand", () => {
  it("builds the command a human would type", () => {
    expect(formatSlashCommand("cleanup-main", "PROJ-1", ["--yes"])).toBe(
      "/cleanup-main PROJ-1 --yes",
    );
  });

  it("omits args when there are none", () => {
    expect(formatSlashCommand("ticket-work", "PROJ-1")).toBe(
      "/ticket-work PROJ-1",
    );
  });
});

describe("resolveAction", () => {
  it.each([
    ["cleanup-terminal", "cleanup-main"],
    ["cleanup-phase-1", "cleanup-feature"],
    ["promote-to-main", "promote-to-main"],
  ])("maps %s to a runnable /%s", (nextAction, command) => {
    const action = resolveAction({ key: "PROJ-1", nextAction });
    expect(action).toMatchObject({ command, runnable: true });
    expect(action.effects).toBeTruthy();
    expect(action.label).toBeTruthy();
  });

  it("offers a copy-only command for actions it will not run", () => {
    const action = resolveAction({ key: "PROJ-1", nextAction: "failed" });
    expect(action).toMatchObject({
      command: "fix-drift",
      runnable: false,
      slashCommand: "/fix-drift PROJ-1",
    });
  });

  it("always exposes the flag-free command for copy-paste", () => {
    // The run path passes --yes because nobody is watching a headless run; a
    // human copying the command should get the reviewable form.
    const action = resolveAction({
      key: "PROJ-1",
      nextAction: "cleanup-terminal",
    });
    expect(action.slashCommand).toBe("/cleanup-main PROJ-1");
    expect(action.slashCommand).not.toContain("--yes");
  });

  it("returns null when there is nothing to offer", () => {
    expect(resolveAction({ key: "PROJ-1", nextAction: "idle" })).toBeNull();
    expect(
      resolveAction({ key: "PROJ-1", nextAction: "awaiting-review" }),
    ).toBeNull();
    expect(
      resolveAction({ key: "PROJ-1", nextAction: "in-flight" }),
    ).toBeNull();
    expect(resolveAction({ key: "PROJ-1", nextAction: "unknown" })).toBeNull();
  });

  it("returns null for a ticket with no classification", () => {
    expect(resolveAction({ key: "PROJ-1" })).toBeNull();
    expect(resolveAction(undefined)).toBeNull();
  });

  it("returns null for an action it has never heard of", () => {
    expect(resolveAction({ key: "PROJ-1", nextAction: "invented" })).toBeNull();
  });

  it("has an entry for every action the classifier can emit", () => {
    // Guards the two tables drifting apart: a new nextAction added to
    // ACTION_PRESENTATION without a decision here would silently offer nothing.
    const known = new Set([
      ...Object.keys(__test__.RUNNABLE_ACTIONS),
      ...Object.keys(__test__.SUGGESTED_COMMANDS),
    ]);
    for (const nextAction of Object.keys(ACTION_PRESENTATION)) {
      expect(known).toContain(nextAction);
    }
  });

  it("never marks a copy-only action runnable", () => {
    for (const nextAction of Object.keys(__test__.SUGGESTED_COMMANDS)) {
      const action = resolveAction({ key: "PROJ-1", nextAction });
      if (action) expect(action.runnable).toBe(false);
    }
  });
});

describe("validateActionRequest", () => {
  const cleanupTicket = { key: "PROJ-1", nextAction: "cleanup-terminal" };

  it("refuses when execution is not enabled", () => {
    const result = validateActionRequest({ ticket: cleanupTicket, env: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/DASHBOARD_ALLOW_ACTIONS/);
  });

  it("passes --yes to the spawned command", () => {
    // A headless run has no one to answer the confirmation prompt, which is why
    // reaching this path at all requires the env opt-in.
    const result = validateActionRequest({
      ticket: cleanupTicket,
      action: "cleanup-terminal",
      env: ENABLED,
    });
    expect(result).toMatchObject({
      ok: true,
      command: "cleanup-main",
      prompt: "/cleanup-main PROJ-1 --yes",
    });
  });

  it("refuses an unknown ticket", () => {
    const result = validateActionRequest({ ticket: null, env: ENABLED });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown ticket/);
  });

  it("refuses a ticket whose action is copy-only", () => {
    const result = validateActionRequest({
      ticket: { key: "PROJ-1", nextAction: "failed" },
      env: ENABLED,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No runnable action/);
  });

  it("refuses a ticket with no actionable state", () => {
    const result = validateActionRequest({
      ticket: { key: "PROJ-1", nextAction: "idle" },
      env: ENABLED,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No runnable action/);
  });

  it("rejects a click made against a stale render", () => {
    // The board polls every 10s. If the ticket reclassified between render and
    // click, running the action the browser asked for would repeat a step that
    // has already happened.
    const result = validateActionRequest({
      ticket: { key: "PROJ-1", nextAction: "promote-to-main" },
      action: "cleanup-terminal",
      env: ENABLED,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no longer cleanup-terminal/);
    expect(result.error).toMatch(/now promote-to-main/);
  });

  it("allows a request that omits the action name", () => {
    // Trusting the live classification, not the caller.
    const result = validateActionRequest({
      ticket: cleanupTicket,
      env: ENABLED,
    });
    expect(result.ok).toBe(true);
  });
});
