import { useState } from "react";
import { computeLayers, getParents } from "./dagLayout.js";
import { TicketDetail } from "./TicketDetail.jsx";

export function FeatureBranchStacks({ stacks, jiraBaseUrl, onAction }) {
  const featureStacks = stacks.filter((s) => s.featureBranch);
  if (!featureStacks.length) return null;

  return (
    <div className="feature-stacks">
      <h2 className="section-title">Feature Branches</h2>
      <div className="feature-stack-list">
        {featureStacks.map((stack) => {
          const mergeOrder = stack.mergeOrder || [];
          const { layers } = computeLayers(stack.tickets, mergeOrder);
          const total = stack.tickets.length;
          const counts = stack.tickets.reduce((acc, t) => {
            acc[t.stateLabel] = (acc[t.stateLabel] || 0) + 1;
            return acc;
          }, {});
          const done =
            (counts.ClaudeStackReady || 0) +
            (counts.ClaudePRApproved || 0) +
            (counts.ClaudeNeedsReview || 0);

          return (
            <div className="feature-stack" key={stack.containerKey}>
              <div className="feature-stack-banner">
                <div className="feature-stack-banner-main">
                  <span className="feature-stack-icon">⎇</span>
                  <span className="feature-stack-branch">
                    {stack.featureBranch}
                  </span>
                  <span className="feature-stack-divider">•</span>
                  <span className="feature-stack-container">
                    {stack.containerKey}: {stack.containerSummary}
                  </span>
                </div>
                <div className="feature-stack-meta">
                  <span className="feature-stack-progress">
                    {done}/{total} ready
                  </span>
                </div>
              </div>
              <FeatureDag
                layers={layers}
                tickets={stack.tickets}
                jiraBaseUrl={jiraBaseUrl}
                featureBranch={stack.featureBranch}
                mergeOrder={mergeOrder}
                onAction={onAction}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FeatureDag({ layers, tickets, jiraBaseUrl, featureBranch, mergeOrder, onAction }) {
  const [expandedKey, setExpandedKey] = useState(null);

  return (
    <div className="feature-dag">
      <div className="feature-dag-base">
        <span className="feature-dag-base-label">base</span>
        <span className="feature-dag-base-branch">{featureBranch}</span>
      </div>
      {layers.map((layer, layerIdx) => (
        <div key={layerIdx} className="feature-dag-layer">
          <div className="feature-dag-connector">
            {layer.map((ticket) => (
              <span
                key={`conn-${ticket.key}`}
                className={`feature-dag-edge feature-dag-edge--${nodeColor(ticket)}`}
              >
                │
              </span>
            ))}
          </div>
          <div className="feature-dag-nodes">
            {layer.map((ticket) => {
              const color = nodeColor(ticket);
              const parents = getParents(ticket, tickets, mergeOrder);
              const isExpanded = expandedKey === ticket.key;
              return (
                <div key={ticket.key} className="feature-dag-node-wrapper">
                  <div
                    role="button"
                    tabIndex={0}
                    className={`feature-dag-node feature-dag-node--${color} ${isExpanded ? "feature-dag-node--expanded" : ""}`}
                    onClick={() => setExpandedKey(isExpanded ? null : ticket.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setExpandedKey(isExpanded ? null : ticket.key);
                      }
                    }}
                  >
                    <span className="feature-dag-node-key">{ticket.key}</span>
                    <span className="feature-dag-node-summary">
                      {ticket.summary}
                    </span>
                    <span className="feature-dag-node-state">
                      {ticket.state}
                    </span>
                    {parents.length > 0 && (
                      <span className="feature-dag-node-base">
                        ← {parents.length === 1 ? parents[0] : `${parents.length} bases`}
                      </span>
                    )}
                    {jiraBaseUrl && (
                      <a
                        href={`${jiraBaseUrl}/${ticket.key}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="feature-dag-node-jira"
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
                        className="feature-dag-node-pr"
                        onClick={(e) => e.stopPropagation()}
                      >
                        PR
                      </a>
                    )}
                  </div>
                  {isExpanded && (
                    <TicketDetail ticketKey={ticket.key} onAction={onAction} />
                  )}
                </div>
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
  if (
    ["ClaudeStackReady", "ClaudePRApproved", "ClaudeNeedsReview"].includes(
      ticket.stateLabel,
    )
  ) {
    return "done";
  }
  if (["ClaudeExecuting", "ClaudePlanning"].includes(ticket.stateLabel)) {
    return "active";
  }
  if (
    ["ClaudePlanNeedsApproval", "ClaudePlanApproved"].includes(
      ticket.stateLabel,
    )
  ) {
    return "pending";
  }
  return "idle";
}
