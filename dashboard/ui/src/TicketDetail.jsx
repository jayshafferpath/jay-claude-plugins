import { useState, useEffect } from "react";
import { PrPanel } from "./PrPanel.jsx";

function formatTimestamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TicketDetail({ ticketKey, onAction }) {
  const [detail, setDetail] = useState(null);
  const [plan, setPlan] = useState(null);
  const [activity, setActivity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showRawPlan, setShowRawPlan] = useState(false);
  const [reviewRequested, setReviewRequested] = useState(false);
  const [reviewError, setReviewError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch(`/api/tickets/${ticketKey}`).then((r) => r.json()),
      fetch(`/api/tickets/${ticketKey}/plan`).then((r) => r.json()),
      fetch(`/api/tickets/${ticketKey}/activity`).then((r) => r.json()),
    ])
      .then(([detailData, planData, activityData]) => {
        if (!cancelled) {
          setDetail(detailData);
          setPlan(planData.found ? planData : null);
          setActivity(activityData.found ? activityData : null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [ticketKey]);

  if (loading) return <div className="detail-panel">Loading...</div>;
  if (!detail) return <div className="detail-panel">Failed to load details.</div>;

  const canApprovePlan = detail.stateLabel === "ClaudePlanNeedsApproval";
  const canRequestReview = !!detail.pr;

  return (
    <div className="detail-panel">
      <div className="detail-grid">
        <div className="detail-section">
          <h3>Info</h3>
          <div className="meta-row">
            <span className="meta-label">Status</span>
            <span className="meta-value">{detail.status}</span>
          </div>
          {detail.stack && (
            <div className="meta-row">
              <span className="meta-label">Stack</span>
              <span className="meta-value">
                {detail.stack.key}: {detail.stack.summary}
              </span>
            </div>
          )}
          {detail.branch && (
            <div className="meta-row">
              <span className="meta-label">Branch</span>
              <span className="meta-value">{detail.branch}</span>
            </div>
          )}
          {detail.worktree && (
            <div className="meta-row">
              <span className="meta-label">Worktree</span>
              <span className="meta-value">{detail.worktree}</span>
            </div>
          )}
          {detail.pr && (
            <div className="meta-row">
              <span className="meta-label">PR</span>
              <span className="meta-value">
                <a href={detail.pr.url} target="_blank" rel="noreferrer">
                  #{detail.pr.number}
                </a>{" "}
                ({detail.pr.state})
              </span>
            </div>
          )}
        </div>

        <div className="detail-section">
          <h3>Dependencies</h3>
          {detail.blockedBy.length > 0 ? (
            <div className="meta-row">
              <span className="meta-label">Blocked by</span>
              <span className="meta-value">{detail.blockedBy.join(", ")}</span>
            </div>
          ) : (
            <div className="meta-row">
              <span className="meta-value" style={{ color: "#8b949e" }}>
                No blockers
              </span>
            </div>
          )}
          {detail.blocks.length > 0 && (
            <div className="meta-row">
              <span className="meta-label">Blocks</span>
              <span className="meta-value">{detail.blocks.join(", ")}</span>
            </div>
          )}
        </div>

        {detail.pr && <PrPanel ticketKey={ticketKey} />}

        {detail.checklist && (
          <div className="detail-section full-width">
            <h3>Checklist</h3>
            {detail.checklist.steps.map((step) => {
              const isNext =
                !step.done &&
                detail.checklist.steps.every(
                  (s) => s.num >= step.num || s.done
                );
              return (
                <div
                  key={step.num}
                  className={`checklist-item ${step.done ? "done" : ""} ${isNext ? "current" : ""}`}
                >
                  <span className="checklist-check">
                    {step.done ? "✓" : "○"}
                  </span>
                  <span>
                    {step.num}. {step.label}
                  </span>
                  {isNext && <span style={{ marginLeft: 8, fontSize: 11 }}>← next</span>}
                </div>
              );
            })}
            {detail.execPlan && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, color: "#8b949e" }}>
                  Execution: {detail.execPlan.completed}/{detail.execPlan.total} tasks
                </div>
                <div className="progress-bar">
                  <div
                    className="progress-bar-fill"
                    style={{
                      width: `${(detail.execPlan.completed / detail.execPlan.total) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {detail.reviewPlan && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, color: "#8b949e" }}>
                  Review: {detail.reviewPlan.resolved}/{detail.reviewPlan.total} issues resolved
                </div>
                <div className="progress-bar">
                  <div
                    className="progress-bar-fill"
                    style={{
                      width: `${(detail.reviewPlan.resolved / detail.reviewPlan.total) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {!detail.checklist && (
          <div className="detail-section full-width">
            <h3>Checklist</h3>
            <div style={{ color: "#8b949e", fontSize: 13 }}>
              No checklist file found. State inferred from labels: {detail.state}
            </div>
          </div>
        )}

        {plan && (
          <div className="detail-section full-width">
            <h3>
              Plan
              {plan.status && (
                <span className="plan-status">{plan.status}</span>
              )}
            </h3>
            {plan.summary && (
              <div className="plan-summary">{plan.summary}</div>
            )}
            {plan.acceptance.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="plan-subheading">Acceptance Criteria</div>
                {plan.acceptance.map((item, i) => (
                  <div
                    key={i}
                    className={`checklist-item ${item.done ? "done" : ""}`}
                  >
                    <span className="checklist-check">
                      {item.done ? "✓" : "○"}
                    </span>
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
            )}
            {plan.implementation.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="plan-subheading">Implementation</div>
                {plan.implementation.map((item, i) => (
                  <div
                    key={i}
                    className={`checklist-item ${item.done ? "done" : ""}`}
                  >
                    <span className="checklist-check">
                      {item.done ? "✓" : "○"}
                    </span>
                    <span>{item.label}</span>
                  </div>
                ))}
                <div className="progress-bar">
                  <div
                    className="progress-bar-fill"
                    style={{
                      width: `${(plan.implementation.filter((s) => s.done).length / plan.implementation.length) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}
            <button
              className="btn"
              style={{ marginTop: 12, fontSize: 12 }}
              onClick={() => setShowRawPlan(!showRawPlan)}
            >
              {showRawPlan ? "Hide" : "Show"} Full Plan
            </button>
            {showRawPlan && (
              <pre className="plan-raw">{plan.raw}</pre>
            )}
          </div>
        )}

        {activity && activity.entries.length > 0 && (
          <div className="detail-section full-width">
            <h3>Activity Log</h3>
            <div className="activity-log">
              {activity.entries.map((entry, i) => (
                <div key={i} className="activity-entry">
                  <div className="activity-entry-header">
                    <span className="activity-entry-heading">{entry.heading}</span>
                    {entry.timestamp && (
                      <span className="activity-entry-timestamp">
                        {formatTimestamp(entry.timestamp)}
                      </span>
                    )}
                  </div>
                  {entry.blocks.map((block, j) =>
                    block.kind === "bullets" ? (
                      <ul key={j} className="activity-bullets">
                        {block.items.map((item, k) => (
                          <li key={k}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p key={j} className="activity-paragraph">
                        {block.text}
                      </p>
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {(canApprovePlan || canRequestReview) && (
        <div className="detail-actions">
          {canApprovePlan && (
            <button
              className="btn btn--warn"
              onClick={() => onAction("approve-plan", ticketKey)}
            >
              Approve Plan
            </button>
          )}
          {canRequestReview && (
            <button
              className="btn btn--primary"
              disabled={reviewRequested}
              onClick={async () => {
                setReviewError(null);
                const res = await fetch(`/api/tickets/${ticketKey}/request-review`, { method: "POST" });
                const data = await res.json();
                if (data.ok) {
                  setReviewRequested(true);
                } else {
                  setReviewError(data.error);
                }
              }}
            >
              {reviewRequested ? "Review Requested" : "Request Review"}
            </button>
          )}
          {reviewError && (
            <span className="action-error">{reviewError}</span>
          )}
        </div>
      )}
    </div>
  );
}
