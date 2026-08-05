import { TicketRow } from "./TicketRow.jsx";
import { computeLayers, getParents } from "./dagLayout.js";
import {
  BlockedOnContainerBanner,
  StackRebaseBanner,
} from "./StackFlags.jsx";
import { shouldShowRepo } from "./TicketBadges.jsx";

function ticketColor(ticket) {
  if (ticket.stateLabel === "ClaudeFailed") return "failed";
  if (ticket.waitingOn) return "waiting";
  if (ticket.state === "PR open") return "done";
  if (ticket.stateLabel === "ClaudeStackReady") return "done";
  if (["ClaudeExecuting", "ClaudePlanning"].includes(ticket.stateLabel)) return "active";
  return "idle";
}

export function StackList({
  stacks,
  onAction,
  jiraBaseUrl,
  actionsEnabled,
  onRun,
  runningJobByTicket,
}) {
  const filtered = stacks.filter((s) => !s.featureBranch);
  // Repo is decided across every rendered stack, not per stack: the badge is
  // there to disambiguate, and a board where each stack sits in a different repo
  // needs it even though no single stack mixes repos.
  const showRepo = shouldShowRepo(filtered.flatMap((s) => s.tickets));

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
            <BlockedOnContainerBanner
              blockedOnContainer={stack.blockedOnContainer}
            />
            <StackRebaseBanner needsStackRebase={stack.needsStackRebase} />
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
                  showRepo={showRepo}
                  actionsEnabled={actionsEnabled}
                  onRun={onRun}
                  runningJob={runningJobByTicket?.get(ticket.key)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
