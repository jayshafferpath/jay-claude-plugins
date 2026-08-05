// One chronological stream from many per-ticket activity logs.
//
// Every ticket carries its own activity log as a Jira comment, and the detail
// panel shows one ticket's at a time. That answers "what happened to this
// ticket?" but not "what did the agents do overnight?" — which needs the logs
// interleaved.
//
// Pure merge: the caller fetches each ticket's entries (one Jira round-trip
// each, so this is on demand, never polled) and passes them in.

// Merge per-ticket entry lists into one newest-first stream.
//
// `logs` is [{ key, entries: [{ timestamp, heading, blocks }] }].
//
// Entries whose timestamp won't parse are kept, not dropped: an activity log
// with a malformed heading is still evidence something happened. They sort last,
// after everything with a usable time.
export function mergeTimeline({ logs, limit } = {}) {
  const merged = [];

  for (const log of logs || []) {
    if (!log?.key) continue;
    for (const entry of log.entries || []) {
      const parsed = parseTimestamp(entry.timestamp);
      merged.push({
        ticketKey: log.key,
        timestamp: entry.timestamp || null,
        sortKey: parsed,
        heading: entry.heading || "",
        blocks: entry.blocks || [],
      });
    }
  }

  merged.sort((a, b) => {
    // Unparseable timestamps sink to the bottom rather than sorting as epoch 0,
    // which would put them above everything real.
    if (a.sortKey === null && b.sortKey === null) return 0;
    if (a.sortKey === null) return 1;
    if (b.sortKey === null) return -1;
    return b.sortKey - a.sortKey;
  });

  const limited =
    typeof limit === "number" && limit >= 0 ? merged.slice(0, limit) : merged;

  return {
    entries: limited.map(({ sortKey, ...rest }) => rest),
    counts: {
      total: merged.length,
      shown: limited.length,
      // Reported so a truncated view never reads as the whole story.
      truncated: merged.length - limited.length,
      tickets: new Set(merged.map((e) => e.ticketKey)).size,
      undated: merged.filter((e) => e.sortKey === null).length,
    },
  };
}

// Activity-log timestamps are written by the CLI as ISO strings, but the heading
// parser also yields bare times for older entries. Anything Date can't read
// returns null rather than NaN so the sort stays total.
export function parseTimestamp(text) {
  if (!text || typeof text !== "string") return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

// Group a merged stream by calendar day, for date-headed rendering.
//
// Uses the timestamp's own date portion rather than a locale conversion, so a
// run at 23:00 doesn't drift into the next day depending on where it's viewed.
export function groupByDay(entries) {
  const groups = new Map();

  for (const entry of entries || []) {
    const day = dayOf(entry.timestamp);
    const bucket = groups.get(day) || [];
    bucket.push(entry);
    groups.set(day, bucket);
  }

  return [...groups.entries()].map(([day, dayEntries]) => ({
    day,
    entries: dayEntries,
  }));
}

function dayOf(timestamp) {
  if (!timestamp || typeof timestamp !== "string") return "undated";
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return "undated";
  return new Date(ms).toISOString().slice(0, 10);
}
