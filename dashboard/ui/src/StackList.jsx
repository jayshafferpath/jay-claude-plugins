import { TicketRow } from "./TicketRow.jsx";
import { computeLayers, getParents } from "./dagLayout.js";

function ticketColor(ticket) {
  if (ticket.stateLabel === "ClaudeFailed") return "failed";
  if (ticket.waitingOn) return "waiting";
  if (ticket.state === "PR open") return "done";
  if (ticket.stateLabel === "ClaudeStackReady") return "done";
  if (["ClaudeExecuting", "ClaudePlanning"].includes(ticket.stateLabel)) return "active";
  if (["ClaudePlanNeedsApproval", "ClaudePlanApproved"].includes(ticket.stateLabel)) return "pending";
  return "idle";
}

export function StackList({ stacks, onAction, jiraBaseUrl }) {
  const filtered = stacks.filter((s) => !s.featureBranch);
  return (
    <div>
      {filtered.map((stack) => {
        const isStack = stack.containerKey !== "Standalone" && stack.tickets.length > 1;
        const { layers, depth } = isStack ? computeLayers(stack.tickets) : { layers: null, depth: new Map() };
        const flatOrder = layers ? layers.flat() : stack.tickets;

        return (
          <div className="stack" key={stack.containerKey}>
            <div className="stack-header">
              <span className="container-key">{stack.containerKey}</span>
              {stack.containerSummary && `: ${stack.containerSummary}`}
              {stack.featureBranch && (
                <span className="feature-branch">{stack.featureBranch}</span>
              )}
            </div>
            {flatOrder.map((ticket) => {
              const color = ticketColor(ticket);
              const parents = isStack ? getParents(ticket, stack.tickets) : [];
              const layer = depth.get(ticket.key) || 0;
              return (
                <TicketRow
                  key={ticket.key}
                  ticket={ticket}
                  onAction={onAction}
                  treeColor={color}
                  showTree={isStack}
                  parents={parents}
                  layer={layer}
                  jiraBaseUrl={jiraBaseUrl}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
