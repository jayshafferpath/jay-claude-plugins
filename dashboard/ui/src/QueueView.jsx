// Tickets grouped by the classifier's next-action queues.
//
// Replaces the old three ad-hoc counters (plans pending / awaiting review /
// failed) with the real bucketing from cli/lib/classify-actions.js. The order
// is intentional: "Needs you" and "Awaiting review" outrank "Ready to run"
// because a human is the bottleneck there, while auto-safe work is mechanical.
//
// The ordering and titles come from the lib the server buckets with, so the
// column order can't drift from the queues it renders.

import { QUEUE_ORDER, QUEUE_TITLES } from "../../../cli/lib/dashboard-queues.js";
import { TicketAction } from "./TicketAction.jsx";

export function QueueView({
  stacks,
  queues,
  jiraBaseUrl,
  actionsEnabled,
  onRun,
  runningJobByTicket,
}) {
  if (!queues) return null;

  const ticketsByKey = new Map();
  for (const stack of stacks) {
    for (const ticket of stack.tickets) {
      ticketsByKey.set(ticket.key, ticket);
    }
  }

  // Idle is hidden unless it's all there is — an idle ticket needs no decision,
  // so showing it alongside actionable work just adds noise. "unknown" is not
  // collapsed the same way: it means the classifier couldn't judge the ticket,
  // which is a gap worth seeing even when there's real work to do.
  const populated = QUEUE_ORDER.filter((q) => (queues[q] || []).length > 0);
  const actionable = populated.filter((q) => q !== "idle");
  const visible = actionable.length > 0 ? actionable : populated;

  if (!visible.length) return null;

  return (
    <div className="queue-view">
      <h2 className="section-title">Next actions</h2>
      <div className="queue-columns">
        {visible.map((queue) => (
          <div className={`queue-column queue-column--${queue}`} key={queue}>
            <div className="queue-column-header">
              <span className="queue-column-title">{QUEUE_TITLES[queue]}</span>
              <span className="queue-column-count">
                {queues[queue].length}
              </span>
            </div>
            <div className="queue-items">
              {queues[queue].map((key) => {
                const ticket = ticketsByKey.get(key);
                if (!ticket) return null;
                return (
                  <div className="queue-item" key={key}>
                    <div className="queue-item-head">
                      {jiraBaseUrl ? (
                        <a
                          href={`${jiraBaseUrl}/${key}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="queue-item-key"
                        >
                          {key}
                        </a>
                      ) : (
                        <span className="queue-item-key">{key}</span>
                      )}
                      {ticket.pr && (
                        <a
                          href={ticket.pr.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="queue-item-pr"
                        >
                          PR
                        </a>
                      )}
                    </div>
                    <div className="queue-item-summary">{ticket.summary}</div>
                    {ticket.actionHint && (
                      <div
                        className={`queue-item-hint queue-item-hint--${ticket.actionTone}`}
                      >
                        {ticket.actionHint}
                      </div>
                    )}
                    {ticket.nextActionReason && (
                      <div className="queue-item-reason">
                        {ticket.nextActionReason}
                      </div>
                    )}
                    <TicketAction
                      ticket={ticket}
                      actionsEnabled={actionsEnabled}
                      onRun={onRun}
                      runningJob={runningJobByTicket?.get(ticket.key)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
