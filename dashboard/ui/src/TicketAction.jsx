// The action a ticket is waiting on, as something you can actually do.
//
// The dashboard has always known a ticket needs /cleanup-main; it printed that
// as prose and left you to switch windows and type it. This offers two paths:
//
//   - Copy: always available. The honest default for LLM-driven commands.
//   - Run: only when the server has DASHBOARD_ALLOW_ACTIONS=true, and only after
//     a confirm step that spells out what the command will do. These delete
//     remote branches and transition Jira, so a single misclick shouldn't.

import { useState } from "react";

export function TicketAction({ ticket, actionsEnabled, onRun, runningJob }) {
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const action = ticket.action;

  if (!action) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(action.slashCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access is denied outside a secure context. The command text
      // is on screen either way, so this needs no error surface.
    }
  };

  if (runningJob) {
    return (
      <span className="ticket-action ticket-action--running">
        <span className="ticket-action-spinner">◌</span>
        running {runningJob.prompt}
      </span>
    );
  }

  return (
    <span className="ticket-action">
      <button
        type="button"
        className="ticket-action-copy"
        title={`Copy "${action.slashCommand}"`}
        onClick={(e) => {
          e.stopPropagation();
          copy();
        }}
      >
        {copied ? "copied" : action.slashCommand}
      </button>

      {action.runnable && actionsEnabled && !confirming && (
        <button
          type="button"
          className="ticket-action-run"
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
        >
          {action.label}
        </button>
      )}

      {action.runnable && confirming && (
        <span className="ticket-action-confirm">
          <span className="ticket-action-effects">{action.effects}</span>
          <button
            type="button"
            className="ticket-action-confirm-yes"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(false);
              onRun(ticket.key, action.nextAction);
            }}
          >
            Confirm
          </button>
          <button
            type="button"
            className="ticket-action-confirm-no"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(false);
            }}
          >
            Cancel
          </button>
        </span>
      )}
    </span>
  );
}
