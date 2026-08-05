export function SummaryBar({ total, stackCount, plansPending, prsPending, failed }) {
  return (
    <div className="summary-bar">
      <div className="summary-stat">
        <span className="count">{total}</span> tickets
      </div>
      <div className="summary-stat">
        <span className="count">{stackCount}</span> stacks
      </div>
      {plansPending > 0 && (
        <div className="summary-stat" style={{ color: "#d29922" }}>
          <span className="count">{plansPending}</span> plans pending
        </div>
      )}
      {prsPending > 0 && (
        <div className="summary-stat" style={{ color: "#d29922" }}>
          <span className="count">{prsPending}</span> awaiting review
        </div>
      )}
      {failed > 0 && (
        <div className="summary-stat" style={{ color: "#da3633" }}>
          <span className="count">{failed}</span> failed
        </div>
      )}
    </div>
  );
}
