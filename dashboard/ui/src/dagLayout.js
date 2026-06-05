export function computeLayers(tickets, mergeOrder) {
  if (mergeOrder && mergeOrder.length > 0) {
    return computeLayersFromMergeOrder(tickets, mergeOrder);
  }
  return computeLayersFromBlockers(tickets);
}

function computeLayersFromMergeOrder(tickets, mergeOrder) {
  const keySet = new Set(tickets.map((t) => t.key));
  const orderIndex = new Map(mergeOrder.map((key, i) => [key, i]));

  const depth = new Map();
  for (const ticket of tickets) {
    const idx = orderIndex.get(ticket.key);
    if (idx !== undefined) {
      depth.set(ticket.key, idx);
    } else {
      // Unmerged tickets go after the last merged one
      depth.set(ticket.key, mergeOrder.length);
    }
  }

  const maxDepth = Math.max(0, ...depth.values());
  const layers = [];
  for (let d = 0; d <= maxDepth; d++) {
    const layer = tickets.filter((t) => depth.get(t.key) === d);
    if (layer.length > 0) layers.push(layer);
  }

  return { layers, depth };
}

function computeLayersFromBlockers(tickets) {
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

export function getParents(ticket, tickets, mergeOrder) {
  if (mergeOrder && mergeOrder.length > 0) {
    const idx = mergeOrder.indexOf(ticket.key);
    if (idx > 0) return [mergeOrder[idx - 1]];
    if (idx === 0) return [];
    // Unmerged: parent is the last merged ticket
    if (mergeOrder.length > 0) return [mergeOrder[mergeOrder.length - 1]];
    return [];
  }
  const keySet = new Set(tickets.map((t) => t.key));
  return (ticket.blockers || []).filter((b) => keySet.has(b));
}

export function getChildren(ticket, tickets, mergeOrder) {
  if (mergeOrder && mergeOrder.length > 0) {
    const idx = mergeOrder.indexOf(ticket.key);
    if (idx >= 0 && idx < mergeOrder.length - 1) return [mergeOrder[idx + 1]];
    // Last merged ticket: unmerged tickets are children
    const mergedSet = new Set(mergeOrder);
    if (idx === mergeOrder.length - 1) {
      return tickets
        .filter((t) => !mergedSet.has(t.key))
        .map((t) => t.key);
    }
    return [];
  }
  const keySet = new Set(tickets.map((t) => t.key));
  return (ticket.blocks || []).filter((b) => keySet.has(b));
}
