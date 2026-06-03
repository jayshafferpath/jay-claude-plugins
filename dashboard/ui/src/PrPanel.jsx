import { useState, useEffect } from "react";

const CHECK_ICONS = {
  SUCCESS: "✓",
  FAILURE: "✗",
  NEUTRAL: "—",
  PENDING: "◌",
};

const CHECK_COLORS = {
  SUCCESS: "#238636",
  FAILURE: "#da3633",
  NEUTRAL: "#8b949e",
  PENDING: "#d29922",
};

const REVIEW_COLORS = {
  APPROVED: "#238636",
  CHANGES_REQUESTED: "#da3633",
  COMMENTED: "#d29922",
  DISMISSED: "#8b949e",
};

export function PrPanel({ ticketKey }) {
  const [pr, setPr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tickets/${ticketKey}/pr-details`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setPr(data.found ? data : null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [ticketKey]);

  if (loading) return <div className="detail-section full-width">Loading PR...</div>;
  if (!pr) return null;

  const totalChecks = pr.checks.length;
  const passedChecks = pr.checks.filter((c) => c.conclusion === "SUCCESS").length;
  const failedChecks = pr.checks.filter((c) => c.conclusion === "FAILURE").length;

  return (
    <div className="detail-section full-width">
      <h3>
        Pull Request
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="pr-external-link"
        >
          #{pr.number}
        </a>
      </h3>

      <div className="pr-title">{pr.title}</div>

      <div className="pr-meta-grid">
        <div className="pr-stat">
          <span className="pr-stat-label">State</span>
          <span className={`pr-state pr-state--${pr.state.toLowerCase()}`}>
            {pr.state}
          </span>
        </div>
        <div className="pr-stat">
          <span className="pr-stat-label">Branch</span>
          <span className="pr-stat-value">
            {pr.headRef} → {pr.baseRef}
          </span>
        </div>
        <div className="pr-stat">
          <span className="pr-stat-label">Mergeable</span>
          <span className="pr-stat-value">
            {pr.mergeable === "MERGEABLE"
              ? "Yes"
              : pr.mergeable === "CONFLICTING"
                ? "Conflicts"
                : pr.mergeable || "Unknown"}
          </span>
        </div>
        <div className="pr-stat">
          <span className="pr-stat-label">Review</span>
          <span className="pr-stat-value">
            {pr.reviewDecision || "Pending"}
          </span>
        </div>
      </div>

      <div className="pr-diff-bar">
        <span className="pr-additions">+{pr.additions}</span>
        <span className="pr-deletions">-{pr.deletions}</span>
        <span className="pr-files">{pr.changedFiles} files</span>
      </div>

      {pr.reviews.length > 0 && (
        <div className="pr-reviews">
          <div className="plan-subheading">Reviews</div>
          {pr.reviews.map((r, i) => (
            <span
              key={i}
              className="pr-review-badge"
              style={{ color: REVIEW_COLORS[r.state] || "#8b949e" }}
            >
              {r.author}: {r.state.toLowerCase().replace("_", " ")}
            </span>
          ))}
        </div>
      )}

      {totalChecks > 0 && (
        <div className="pr-checks">
          <div className="plan-subheading">
            Checks ({passedChecks}/{totalChecks} passed
            {failedChecks > 0 && `, ${failedChecks} failed`})
          </div>
          <div className="pr-checks-grid">
            {pr.checks.map((c, i) => (
              <div key={i} className="pr-check-item">
                <span
                  style={{ color: CHECK_COLORS[c.conclusion] || "#8b949e" }}
                >
                  {CHECK_ICONS[c.conclusion] || "?"}
                </span>
                <span className="pr-check-name">{c.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {pr.diffStat && (
        <details className="pr-diffstat-toggle">
          <summary>Diff stat</summary>
          <pre className="pr-diffstat">{pr.diffStat}</pre>
        </details>
      )}
    </div>
  );
}
