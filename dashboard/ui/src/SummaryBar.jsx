// Counts derived from the classifier's queues rather than from labels.
//
// The old "plans pending" stat counted a label that no longer exists in the
// lifecycle, so it was permanently 0. These read from the same bucketing the
// QueueView renders, so a number here always matches a visible column.
export function SummaryBar({ total, stackCount, queues, stalled }) {
  const needsYou = queues?.asks?.length || 0;
  const awaitingReview = queues?.manual?.length || 0;
  const readyToRun = queues?.autoSafe?.length || 0;

  return (
    <div className="summary-bar">
      <div className="summary-stat">
        <span className="count">{total}</span> tickets
      </div>
      <div className="summary-stat">
        <span className="count">{stackCount}</span> stacks
      </div>
      {needsYou > 0 && (
        <div className="summary-stat" style={{ color: "#da3633" }}>
          <span className="count">{needsYou}</span> need you
        </div>
      )}
      {awaitingReview > 0 && (
        <div className="summary-stat" style={{ color: "#d29922" }}>
          <span className="count">{awaitingReview}</span> awaiting review
        </div>
      )}
      {readyToRun > 0 && (
        <div className="summary-stat" style={{ color: "#238636" }}>
          <span className="count">{readyToRun}</span> ready to run
        </div>
      )}
      {stalled > 0 && (
        <div className="summary-stat" style={{ color: "#da3633" }}>
          <span className="count">{stalled}</span> stalled
        </div>
      )}
    </div>
  );
}
