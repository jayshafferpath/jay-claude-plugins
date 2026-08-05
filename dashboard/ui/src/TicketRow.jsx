import { useState } from "react";
import { TicketDetail } from "./TicketDetail.jsx";
import { RepoBadge, StallBadges } from "./TicketBadges.jsx";
import { TicketAction } from "./TicketAction.jsx";

const BADGE_CLASS = {
  FAILED: "badge--failed",
  "PR open": "badge--pr-open",
  "PR approved": "badge--pr-approved",
  "stack ready": "badge--stack-ready",
  "executing...": "badge--executing",
  "plan approved": "badge--plan-approved",
  "plan ready": "badge--plan-ready",
  "planning...": "badge--planning",
  ready: "badge--ready",
  unknown: "badge--unknown",
};

export function TicketRow({
  ticket,
  onAction,
  treeColor,
  showTree,
  parents,
  layer,
  jiraBaseUrl,
  showRepo,
  actionsEnabled,
  onRun,
  runningJob,
}) {
  const [expanded, setExpanded] = useState(false);

  const badgeClass = ticket.waitingOn
    ? "badge--waiting"
    : BADGE_CLASS[ticket.state] || "badge--unknown";

  const displayState = ticket.waitingOn
    ? `waiting on ${ticket.waitingOn}`
    : ticket.state;

  const indent = showTree ? layer * 20 : 0;

  return (
    <div className="ticket-row-wrapper" id={`ticket-${ticket.key}`}>
      <div className="ticket-row-content">
        <div
          className={`ticket-row ${expanded ? "expanded" : ""}`}
          style={indent ? { paddingLeft: `${16 + indent}px` } : undefined}
          onClick={() => setExpanded(!expanded)}
        >
          {showTree && (
            <span className={`ticket-dot ticket-dot--${treeColor}`} />
          )}
          {jiraBaseUrl ? (
            <a
              href={`${jiraBaseUrl}/${ticket.key}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ticket-key"
              onClick={(e) => e.stopPropagation()}
            >
              {ticket.key}
            </a>
          ) : (
            <span className="ticket-key">{ticket.key}</span>
          )}
          <span className="ticket-summary">{ticket.summary}</span>
          <RepoBadge
            repo={ticket.repo}
            resolved={ticket.repoResolved}
            show={showRepo}
          />
          {showTree && parents.length > 0 && (
            <span className="ticket-deps">
              {parents.length > 1 ? `blocked by ${parents.length}` : `← ${parents[0]}`}
            </span>
          )}
          {ticket.pr && (
            <a
              href={ticket.pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ticket-pr-link"
              onClick={(e) => e.stopPropagation()}
            >
              PR
            </a>
          )}
          <span className={`badge ${badgeClass}`}>{displayState}</span>
          <StallBadges findings={ticket.stagnation} />
          {ticket.actionHint && !ticket.waitingOn && (
            <span className={`action-hint action-hint--${ticket.actionTone}`}>
              {ticket.actionHint}
            </span>
          )}
          <TicketAction
            ticket={ticket}
            actionsEnabled={actionsEnabled}
            onRun={onRun}
            runningJob={runningJob}
          />
        </div>
        {expanded && <TicketDetail ticketKey={ticket.key} onAction={onAction} />}
      </div>
    </div>
  );
}
