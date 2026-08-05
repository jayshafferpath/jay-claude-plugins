import { describe, expect, it } from "vitest";
import {
  groupByDay,
  mergeTimeline,
  parseTimestamp,
} from "../lib/dashboard-timeline.js";

function log(key, entries) {
  return { key, entries };
}

function entry(timestamp, heading = "Did a thing") {
  return { timestamp, heading, blocks: [] };
}

describe("parseTimestamp", () => {
  it("parses an ISO timestamp", () => {
    expect(parseTimestamp("2026-08-05T12:00:00Z")).toBe(
      Date.parse("2026-08-05T12:00:00Z"),
    );
  });

  it.each([
    ["not a date"],
    [""],
    [null],
    [undefined],
    [12345],
  ])("returns null for %s rather than NaN", (input) => {
    // NaN would poison the sort comparator; null is handled explicitly.
    expect(parseTimestamp(input)).toBeNull();
  });
});

describe("mergeTimeline", () => {
  it("interleaves entries from several tickets newest-first", () => {
    const result = mergeTimeline({
      logs: [
        log("A-1", [
          entry("2026-08-05T09:00:00Z", "early"),
          entry("2026-08-05T15:00:00Z", "late"),
        ]),
        log("A-2", [entry("2026-08-05T12:00:00Z", "middle")]),
      ],
    });
    expect(result.entries.map((e) => e.heading)).toEqual([
      "late",
      "middle",
      "early",
    ]);
  });

  it("tags each entry with its ticket", () => {
    const result = mergeTimeline({
      logs: [log("A-1", [entry("2026-08-05T09:00:00Z")])],
    });
    expect(result.entries[0].ticketKey).toBe("A-1");
  });

  it("keeps undated entries but sorts them last", () => {
    // A malformed heading is still evidence something happened; dropping it
    // loses information, and sorting it as epoch 0 would float it to the top.
    const result = mergeTimeline({
      logs: [
        log("A-1", [entry(null, "undated")]),
        log("A-2", [entry("2026-08-05T09:00:00Z", "dated")]),
      ],
    });
    expect(result.entries.map((e) => e.heading)).toEqual(["dated", "undated"]);
    expect(result.counts.undated).toBe(1);
  });

  it("keeps two undated entries rather than collapsing them", () => {
    const result = mergeTimeline({
      logs: [log("A-1", [entry(null, "one"), entry(null, "two")])],
    });
    expect(result.entries).toHaveLength(2);
  });

  it("counts total, tickets and undated", () => {
    const result = mergeTimeline({
      logs: [
        log("A-1", [entry("2026-08-05T09:00:00Z"), entry(null)]),
        log("A-2", [entry("2026-08-05T10:00:00Z")]),
      ],
    });
    expect(result.counts).toMatchObject({
      total: 3,
      shown: 3,
      truncated: 0,
      tickets: 2,
      undated: 1,
    });
  });

  it("reports what a limit dropped rather than truncating silently", () => {
    const result = mergeTimeline({
      logs: [
        log("A-1", [
          entry("2026-08-05T09:00:00Z", "a"),
          entry("2026-08-05T10:00:00Z", "b"),
          entry("2026-08-05T11:00:00Z", "c"),
        ]),
      ],
      limit: 2,
    });
    expect(result.entries.map((e) => e.heading)).toEqual(["c", "b"]);
    expect(result.counts).toMatchObject({ total: 3, shown: 2, truncated: 1 });
  });

  it("treats a zero limit as showing nothing, not everything", () => {
    const result = mergeTimeline({
      logs: [log("A-1", [entry("2026-08-05T09:00:00Z")])],
      limit: 0,
    });
    expect(result.entries).toEqual([]);
    expect(result.counts.truncated).toBe(1);
  });

  it("ignores a log with no key", () => {
    const result = mergeTimeline({
      logs: [{ entries: [entry("2026-08-05T09:00:00Z")] }],
    });
    expect(result.entries).toEqual([]);
  });

  it("does not leak the internal sort key", () => {
    const result = mergeTimeline({
      logs: [log("A-1", [entry("2026-08-05T09:00:00Z")])],
    });
    expect(result.entries[0]).not.toHaveProperty("sortKey");
  });

  it("tolerates missing input", () => {
    expect(mergeTimeline().entries).toEqual([]);
    expect(mergeTimeline({ logs: [log("A-1", null)] }).entries).toEqual([]);
  });
});

describe("groupByDay", () => {
  it("groups entries under their calendar day", () => {
    const groups = groupByDay([
      { ticketKey: "A-1", timestamp: "2026-08-05T15:00:00Z" },
      { ticketKey: "A-2", timestamp: "2026-08-05T09:00:00Z" },
      { ticketKey: "A-3", timestamp: "2026-08-04T09:00:00Z" },
    ]);
    expect(groups.map((g) => g.day)).toEqual(["2026-08-05", "2026-08-04"]);
    expect(groups[0].entries).toHaveLength(2);
  });

  it("reads the date from the timestamp string, not a locale conversion", () => {
    // A 23:00 run must not drift into the next day depending on the viewer's
    // timezone, which is what new Date(...).toLocaleDateString() would do.
    const groups = groupByDay([
      { ticketKey: "A-1", timestamp: "2026-08-05T23:30:00Z" },
    ]);
    expect(groups[0].day).toBe("2026-08-05");
  });

  it("buckets undated entries together", () => {
    const groups = groupByDay([
      { ticketKey: "A-1", timestamp: null },
      { ticketKey: "A-2", timestamp: "nonsense" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].day).toBe("undated");
    expect(groups[0].entries).toHaveLength(2);
  });

  it("preserves within-day ordering from the input", () => {
    const groups = groupByDay([
      { ticketKey: "A-1", timestamp: "2026-08-05T15:00:00Z" },
      { ticketKey: "A-2", timestamp: "2026-08-05T09:00:00Z" },
    ]);
    expect(groups[0].entries.map((e) => e.ticketKey)).toEqual(["A-1", "A-2"]);
  });

  it("tolerates missing input", () => {
    expect(groupByDay()).toEqual([]);
  });
});
