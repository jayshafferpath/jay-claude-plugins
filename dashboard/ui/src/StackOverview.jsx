import { computeLayers, getParents } from "./dagLayout.js";

export function StackOverview({ stacks, jiraBaseUrl }) {
  const realStacks = stacks.filter(
    (s) =>
      s.containerKey !== "Standalone" &&
      s.tickets.length > 1 &&
      !s.featureBranch,
  );
  if (!realStacks.length) return null;

  return (
    <div className="stack-overview">
      <h2 className="section-title">Stacks</h2>
      <div className="stack-cards">
        {realStacks.map((stack) => {
          const counts = stack.tickets.reduce((acc, t) => {
            acc[t.stateLabel] = (acc[t.stateLabel] || 0) + 1;
            return acc;
          }, {});

          // "PR open" has no label — it's derived from the live PR / Jira status.
          const prOpen = stack.tickets.filter((t) => t.state === "PR open").length;
          const done = (counts.ClaudeStackReady || 0) + (counts.ClaudePRApproved || 0) + prOpen;
          const inProgress = (counts.ClaudeExecuting || 0) + (counts.ClaudePlanning || 0);
          const waiting = stack.tickets.filter((t) => t.waitingOn).length;
          const failed = counts.ClaudeFailed || 0;
          const total = stack.tickets.length;
          const mergeOrder = stack.mergeOrder || [];
          const { layers } = computeLayers(stack.tickets, mergeOrder);

          return (
            <div className="stack-card" key={stack.containerKey}>
              <div className="stack-card-header">
                <span className="stack-card-key">{stack.containerKey}</span>
                {stack.featureBranch && (
                  <span className="stack-card-branch">{stack.featureBranch}</span>
                )}
              </div>
              <div className="stack-card-summary">{stack.containerSummary}</div>
              <div className="stack-card-progress">
                <div className="stack-card-bar">
                  {done > 0 && (
                    <div
                      className="stack-bar-segment stack-bar-done"
                      style={{ width: `${(done / total) * 100}%` }}
                    />
                  )}
                  {inProgress > 0 && (
                    <div
                      className="stack-bar-segment stack-bar-active"
                      style={{ width: `${(inProgress / total) * 100}%` }}
                    />
                  )}
                  {failed > 0 && (
                    <div
                      className="stack-bar-segment stack-bar-failed"
                      style={{ width: `${(failed / total) * 100}%` }}
                    />
                  )}
                </div>
                <div className="stack-card-stats">
                  <span className="stack-stat">{total} tickets</span>
                  {done > 0 && <span className="stack-stat stack-stat-done">{done} done</span>}
                  {inProgress > 0 && <span className="stack-stat stack-stat-active">{inProgress} active</span>}
                  {waiting > 0 && <span className="stack-stat stack-stat-waiting">{waiting} waiting</span>}
                  {failed > 0 && <span className="stack-stat stack-stat-failed">{failed} failed</span>}
                </div>
              </div>
              <DagTree layers={layers} tickets={stack.tickets} jiraBaseUrl={jiraBaseUrl} mergeOrder={mergeOrder} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DagTree({ layers, tickets, jiraBaseUrl, mergeOrder }) {
  return (
    <div className="dag-tree">
      {layers.map((layer, layerIdx) => (
        <div key={layerIdx} className="dag-layer">
          {layerIdx > 0 && (
            <div className="dag-edges">
              {layer.map((ticket) => {
                const parents = getParents(ticket, tickets, mergeOrder);
                const color = nodeColor(ticket);
                return parents.map((pKey) => (
                  <span key={`${pKey}-${ticket.key}`} className={`dag-edge dag-edge--${color}`}>
                    ↓
                  </span>
                ));
              })}
            </div>
          )}
          <div className="dag-nodes">
            {layer.map((ticket) => {
              const color = nodeColor(ticket);
              return (
                <a
                  key={ticket.key}
                  href={`#ticket-${ticket.key}`}
                  className={`dag-node dag-node--${color}`}
                >
                  <span className="dag-node-dot" />
                  <span className="dag-node-key">{ticket.key}</span>
                  <span className="dag-node-state">{ticket.state}</span>
                  {jiraBaseUrl && (
                    <a
                      href={`${jiraBaseUrl}/${ticket.key}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="dag-node-jira"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Jira
                    </a>
                  )}
                  {ticket.pr && (
                    <a
                      href={ticket.pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="dag-node-pr"
                      onClick={(e) => e.stopPropagation()}
                    >
                      PR
                    </a>
                  )}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function nodeColor(ticket) {
  if (ticket.stateLabel === "ClaudeFailed") return "failed";
  if (ticket.waitingOn) return "waiting";
  if (ticket.state === "PR open") return "done";
  if (["ClaudeStackReady", "ClaudePRApproved"].includes(ticket.stateLabel)) return "done";
  if (["ClaudeExecuting", "ClaudePlanning"].includes(ticket.stateLabel)) return "active";
  if (["ClaudePlanNeedsApproval", "ClaudePlanApproved"].includes(ticket.stateLabel)) return "pending";
  return "idle";
}
