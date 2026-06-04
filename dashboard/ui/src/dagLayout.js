export function computeLayers(tickets) {
  const keySet = new Set(tickets.map((t) => t.key));
  const depth = new Map();

  const localBlockers = (t) =>
    (t.blockers || []).filter((b) => keySet.has(b));

  function getDepth(ticket) {
    if (depth.has(ticket.key)) return depth.get(ticket.key);
    const parents = localBlockers(ticket);
    if (!parents.length) {
      depth.set(ticket.key, 0);
      return 0;
    }
    const maxParent = Math.max(
      ...parents.map((pKey) => {
        const parent = tickets.find((t) => t.key === pKey);
        return parent ? getDepth(parent) : 0;
      })
    );
    depth.set(ticket.key, maxParent + 1);
    return maxParent + 1;
  }

  for (const t of tickets) getDepth(t);

  const maxDepth = Math.max(0, ...depth.values());
  const layers = [];
  for (let d = 0; d <= maxDepth; d++) {
    layers.push(tickets.filter((t) => depth.get(t.key) === d));
  }

  return { layers, depth };
}

export function getParents(ticket, tickets) {
  const keySet = new Set(tickets.map((t) => t.key));
  return (ticket.blockers || []).filter((b) => keySet.has(b));
}

export function getChildren(ticket, tickets) {
  const keySet = new Set(tickets.map((t) => t.key));
  return (ticket.blocks || []).filter((b) => keySet.has(b));
}
