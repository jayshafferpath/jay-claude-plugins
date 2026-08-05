import { describe, expect, it } from "vitest";
import { shouldShowRepo } from "../ui/src/TicketBadges.jsx";

describe("shouldShowRepo", () => {
  it("hides the badge when every ticket is in the same repo", () => {
    // A badge repeating the same value on every row is pure noise.
    expect(
      shouldShowRepo([
        { repo: "alpha", repoResolved: true },
        { repo: "alpha", repoResolved: true },
      ]),
    ).toBe(false);
  });

  it("shows the badge when tickets span repos", () => {
    expect(
      shouldShowRepo([
        { repo: "alpha", repoResolved: true },
        { repo: "beta", repoResolved: true },
      ]),
    ).toBe(true);
  });

  it("shows the badge when a repo isn't cloned locally, even in a single repo", () => {
    // An unresolved repo explains why the ticket has no branch, PR, or merge
    // state — which otherwise reads as "nothing has happened yet".
    expect(shouldShowRepo([{ repo: "alpha", repoResolved: false }])).toBe(true);
  });

  it("ignores tickets with no repo label when counting distinct repos", () => {
    expect(
      shouldShowRepo([
        { repo: "alpha", repoResolved: true },
        { repo: null, repoResolved: false },
      ]),
    ).toBe(false);
  });

  it("returns false for an empty or missing list", () => {
    expect(shouldShowRepo([])).toBe(false);
    expect(shouldShowRepo(undefined)).toBe(false);
  });
});
