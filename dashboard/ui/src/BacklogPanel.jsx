// Eligible work the board can't see, from cli/lib/queue.js.
//
// The board queries `labels = ClaudeWork`, so a ClaudeReady ticket that was never
// tagged into a stack is invisible to it — as is a subtask that inherits
// eligibility from a ClaudeReady parent instead of carrying labels itself. This
// panel answers "what could I start next?", which the rest of the dashboard
// structurally cannot.
//
// Fetched on demand rather than on the 10s poll: discoverQueue costs three Jira
// searches plus one per ClaudeReady parent.

import { useCallback, useEffect, useState } from "react";

export function BacklogPanel({ jiraBaseUrl }) {
  const [backlog, setBacklog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  const fetchBacklog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/backlog");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      setBacklog(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBacklog();
  }, [fetchBacklog]);

  const counts = backlog?.counts;
  const tickets = backlog?.tickets || [];
  const inheritance = backlog?.pendingInheritance || [];

  return (
    <div className="backlog-panel">
      <h2 className="section-title">
        Available to start
        {counts && <span className="backlog-count">{counts.total}</span>}
        <button
          type="button"
          className="backlog-refresh"
          onClick={fetchBacklog}
          disabled={loading}
          title="Costs several Jira searches, so it isn't on the auto-refresh"
        >
          {loading ? "checking..." : "refresh"}
        </button>
        {tickets.length > 0 && (
          <button
            type="button"
            className="backlog-refresh"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? "show" : "hide"}
          </button>
        )}
      </h2>

      {error && <div className="backlog-error">{error}</div>}

      {counts && counts.total === 0 && !error && (
        <div className="backlog-empty">
          Nothing eligible beyond what's already on the board
          {counts.alreadyOnBoard > 0 &&
            ` (${counts.alreadyOnBoard} already shown`}
          {counts.alreadyOnBoard > 0 && counts.alreadyUnderway > 0 && ", "}
          {counts.alreadyOnBoard === 0 && counts.alreadyUnderway > 0 && " ("}
          {counts.alreadyUnderway > 0 &&
            `${counts.alreadyUnderway} already in review`}
          {(counts.alreadyOnBoard > 0 || counts.alreadyUnderway > 0) && ")"}.
        </div>
      )}

      {/* Reported rather than filtered silently: a large number here means
          parent expansion is sweeping up finished work, not that nothing is
          available. */}
      {counts?.alreadyUnderway > 0 && counts.total > 0 && (
        <div className="backlog-note">
          {counts.alreadyUnderway} eligible-looking ticket
          {counts.alreadyUnderway === 1 ? "" : "s"} hidden — already out for
          review.
        </div>
      )}

      {!collapsed && tickets.length > 0 && (
        <div className="backlog-list">
          {tickets.map((ticket) => (
            <div className="backlog-item" key={ticket.key}>
              {jiraBaseUrl ? (
                <a
                  href={`${jiraBaseUrl}/${ticket.key}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="backlog-key"
                >
                  {ticket.key}
                </a>
              ) : (
                <span className="backlog-key">{ticket.key}</span>
              )}
              <span className="backlog-summary">{ticket.summary}</span>
              {ticket.issueType && (
                <span className="backlog-type">{ticket.issueType}</span>
              )}
              {/* A parent-expanded subtask is eligible by inheritance, not by
                  its own labels — which is exactly why the board missed it. */}
              {ticket.via === "parent" && (
                <span
                  className="backlog-via"
                  title={`Eligible via parent ${ticket.parentSeed}`}
                >
                  via {ticket.parentSeed}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {!collapsed && inheritance.length > 0 && (
        <div className="backlog-inheritance">
          <span className="backlog-inheritance-label">
            Needs label/assignee inheritance before it can start:
          </span>
          {inheritance.map((e) => (
            <span className="backlog-inheritance-item" key={e.child}>
              {e.child} ← {e.parent}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
