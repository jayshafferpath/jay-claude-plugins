// Every ticket's activity log, interleaved.
//
// The detail panel shows one ticket's log at a time, which answers "what
// happened to this ticket?". This answers "what did the agents do overnight?" —
// the question you actually have when you sit down in the morning.
//
// Collapsed by default and fetched on demand: it costs one Jira round-trip per
// ticket on the board.

import { useCallback, useState } from "react";

export function TimelinePanel({ jiraBaseUrl }) {
  const [timeline, setTimeline] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);

  const fetchTimeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/timeline");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      setTimeline(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Fetched on first open rather than on mount: one Jira call per ticket is
    // too much to spend on a panel nobody has asked for yet.
    if (next && !timeline) fetchTimeline();
  };

  const days = timeline?.days || [];
  const counts = timeline?.counts;

  return (
    <div className="timeline-panel">
      <h2 className="section-title">
        <button type="button" className="timeline-toggle" onClick={toggle}>
          {open ? "▾" : "▸"} Activity
        </button>
        {counts && (
          <span className="timeline-count">
            {counts.shown} entries across {counts.tickets} tickets
          </span>
        )}
        {open && (
          <button
            type="button"
            className="backlog-refresh"
            onClick={fetchTimeline}
            disabled={loading}
          >
            {loading ? "loading..." : "refresh"}
          </button>
        )}
      </h2>

      {open && error && <div className="backlog-error">{error}</div>}

      {open && loading && !timeline && (
        <div className="backlog-empty">Reading activity logs...</div>
      )}

      {open && timeline && days.length === 0 && (
        <div className="backlog-empty">No activity logged yet.</div>
      )}

      {open &&
        days.map((group) => (
          <div className="timeline-day" key={group.day}>
            <div className="timeline-day-head">{group.day}</div>
            {group.entries.map((entry, i) => (
              <div
                className="timeline-entry"
                key={`${entry.ticketKey}-${entry.timestamp}-${i}`}
              >
                <div className="timeline-entry-head">
                  <span className="timeline-time">
                    {formatTime(entry.timestamp)}
                  </span>
                  {jiraBaseUrl ? (
                    <a
                      href={`${jiraBaseUrl}/${entry.ticketKey}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="timeline-key"
                    >
                      {entry.ticketKey}
                    </a>
                  ) : (
                    <span className="timeline-key">{entry.ticketKey}</span>
                  )}
                  <span className="timeline-heading">{entry.heading}</span>
                </div>
                {entry.blocks.map((block, bi) => (
                  <div className="timeline-block" key={bi}>
                    {block.kind === "bullets" ? (
                      <ul className="timeline-bullets">
                        {block.items.map((item, ii) => (
                          <li key={ii}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <div className="timeline-text">{block.text}</div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}

      {/* Never let a capped view read as the whole story. */}
      {open && counts?.truncated > 0 && (
        <div className="backlog-note">
          {counts.truncated} older entr
          {counts.truncated === 1 ? "y" : "ies"} not shown.
        </div>
      )}
    </div>
  );
}

// Time-of-day only: the date is already the group heading.
function formatTime(timestamp) {
  if (!timestamp) return "—";
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return timestamp;
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
