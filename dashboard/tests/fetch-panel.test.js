import { describe, expect, it } from "vitest";
import { panelErrorMessage } from "../ui/src/fetchPanel.js";

describe("panelErrorMessage", () => {
  it("reads a 404 as a stale API server rather than a missing route", () => {
    // The panels' endpoints are always present in the current source, so a 404
    // means the browser reached an older server — the message has to point at
    // the restart, not at the route.
    const message = panelErrorMessage(404, "/api/backlog");
    expect(message).toContain("/api/backlog");
    expect(message).toContain("older than this UI");
    expect(message).toContain("npm run dev:api");
  });

  it("names the endpoint that failed, so the panel is identifiable", () => {
    expect(panelErrorMessage(404, "/api/hygiene")).toContain("/api/hygiene");
  });

  it("passes other statuses through as a plain API error", () => {
    // A 500 is a real server-side failure; blaming a stale build would send the
    // reader in the wrong direction.
    expect(panelErrorMessage(500, "/api/timeline")).toBe("API error: 500");
    expect(panelErrorMessage(502, "/api/timeline")).toBe("API error: 502");
  });
});
