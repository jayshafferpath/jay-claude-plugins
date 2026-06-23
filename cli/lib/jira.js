import { getJiraAuth } from "./config.js";
import { LABEL_TO_STATUS_TRANSITIONS, PROGRESS_LABELS } from "./labels.js";

function auth() {
  const creds = getJiraAuth();
  if (!creds) {
    throw new Error(
      "Missing Jira credentials. Set JIRA_EMAIL, JIRA_API_TOKEN, and JIRA_DOMAIN env vars.",
    );
  }
  return creds;
}

function headers(creds) {
  const encoded = Buffer.from(`${creds.email}:${creds.token}`).toString(
    "base64",
  );
  return {
    Authorization: `Basic ${encoded}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function baseUrl(creds) {
  const protocol = process.env.JIRA_PROTOCOL || "https";
  return `${protocol}://${creds.domain}/rest/api/3`;
}

export async function searchIssues(jql, fields = []) {
  const creds = auth();
  const body = {
    jql,
    maxResults: 100,
  };
  if (fields.length) {
    body.fields = fields;
  }

  const res = await fetch(`${baseUrl(creds)}/search/jql`, {
    method: "POST",
    headers: headers(creds),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira search failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.issues || [];
}

export async function getIssue(key) {
  const creds = auth();
  const res = await fetch(
    `${baseUrl(creds)}/issue/${key}?fields=summary,status,labels,issuelinks,parent,issuetype,assignee,description`,
    { headers: headers(creds) },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira getIssue failed (${res.status}): ${body}`);
  }

  return res.json();
}

export async function editIssue(key, update) {
  const creds = auth();
  const res = await fetch(`${baseUrl(creds)}/issue/${key}`, {
    method: "PUT",
    headers: headers(creds),
    body: JSON.stringify({ update }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira editIssue failed (${res.status}): ${body}`);
  }
}

export async function addLabel(key, label) {
  await editIssue(key, { labels: [{ add: label }] });
}

export async function removeLabel(key, label) {
  await editIssue(key, { labels: [{ remove: label }] });
}

export async function swapLabel(key, remove, add) {
  await editIssue(key, { labels: [{ remove }, { add }] });
}

// Build a labels patch that clears all PROGRESS_LABELS currently on the ticket
// and applies the given additions/removals. Returns null when there is nothing
// to change, so callers can skip the API call entirely.
export function buildSetStatePatch(currentLabels, { add = [], remove = [] }) {
  const current = Array.isArray(currentLabels) ? currentLabels : [];
  const removeSet = new Set();

  for (const label of PROGRESS_LABELS) {
    if (current.includes(label)) removeSet.add(label);
  }
  for (const label of remove) {
    if (current.includes(label)) removeSet.add(label);
  }

  const ops = [];
  for (const label of removeSet) {
    if (!add.includes(label)) ops.push({ remove: label });
  }
  for (const label of add) {
    if (!current.includes(label)) ops.push({ add: label });
  }

  return ops.length === 0 ? null : { labels: ops };
}

export async function getTransitions(key) {
  const creds = auth();
  const res = await fetch(`${baseUrl(creds)}/issue/${key}/transitions`, {
    headers: headers(creds),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira getTransitions failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.transitions || [];
}

export async function transitionIssue(key, transitionId) {
  const creds = auth();
  const res = await fetch(`${baseUrl(creds)}/issue/${key}/transitions`, {
    method: "POST",
    headers: headers(creds),
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira transitionIssue failed (${res.status}): ${body}`);
  }
}

// Picks the first transition from `transitions` whose name matches (case-
// insensitively) one of `candidateNames`. Returns the matched transition or
// null when nothing matches.
export function pickTransition(transitions, candidateNames) {
  const lookup = new Map(
    (transitions || []).map((t) => [t.name?.toLowerCase(), t]),
  );
  for (const name of candidateNames) {
    const hit = lookup.get(name.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// Idempotent state transition: clears every PROGRESS_LABEL currently set,
// then applies add/remove. `to` is sugar for "add this single state label and
// clear the rest". When `to` is set and `LABEL_TO_STATUS_TRANSITIONS` defines
// candidate workflow transitions for it, the matching Jira workflow status is
// transitioned too (best-effort: missing transitions log a warning and the
// label change still proceeds). Returns the operations that were applied (or
// null when neither labels nor status would change).
export async function setTicketState(
  key,
  { to = null, add = [], remove = [] } = {},
) {
  if (to && !PROGRESS_LABELS.includes(to)) {
    throw new Error(
      `--to must be one of: ${PROGRESS_LABELS.join(", ")}. Got: ${to}`,
    );
  }

  const issue = await getIssue(key);
  const currentLabels = issue?.fields?.labels || [];

  const additions = [...add];
  if (to && !additions.includes(to)) additions.push(to);

  const patch = buildSetStatePatch(currentLabels, { add: additions, remove });
  if (patch) await editIssue(key, patch);

  if (to && LABEL_TO_STATUS_TRANSITIONS[to]) {
    const candidates = LABEL_TO_STATUS_TRANSITIONS[to];
    try {
      const transitions = await getTransitions(key);
      const match = pickTransition(transitions, candidates);
      if (match) {
        await transitionIssue(key, match.id);
      } else {
        const available = transitions.map((t) => t.name).join(", ") || "(none)";
        console.warn(
          `setTicketState: no workflow transition matching [${candidates.join(", ")}] for ${key}. Available: ${available}. Label updated; status unchanged.`,
        );
      }
    } catch (err) {
      console.warn(
        `setTicketState: status transition for ${key} failed: ${err.message}. Label updated; status unchanged.`,
      );
    }
  }

  return patch ? patch.labels : null;
}

export async function getPrFromDevStatus(key) {
  const creds = auth();
  const issueRes = await fetch(`${baseUrl(creds)}/issue/${key}?fields=id`, {
    headers: headers(creds),
  });
  if (!issueRes.ok) return null;
  const issue = await issueRes.json();

  const protocol = process.env.JIRA_PROTOCOL || "https";
  const devUrl = `${protocol}://${creds.domain}/rest/dev-status/latest/issue/detail?issueId=${issue.id}&applicationType=GitHub&dataType=pullrequest`;
  const devRes = await fetch(devUrl, { headers: headers(creds) });
  if (!devRes.ok) return null;

  const devData = await devRes.json();
  const prs = devData.detail?.flatMap((d) => d.pullRequests || []) || [];
  const open = prs.find((p) => p.status === "OPEN") || prs[0];
  if (!open) return null;

  return {
    url: open.url,
    number: parseInt(open.id.replace("#", ""), 10),
    state:
      open.status === "OPEN"
        ? "OPEN"
        : open.status === "MERGED"
          ? "MERGED"
          : "CLOSED",
    title: open.name || null,
  };
}

export async function getComments(key) {
  const creds = auth();
  const res = await fetch(
    `${baseUrl(creds)}/issue/${key}/comment?orderBy=-created`,
    { headers: headers(creds) },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira getComments failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.comments || [];
}

export async function addComment(key, adfBody) {
  const creds = auth();
  const res = await fetch(`${baseUrl(creds)}/issue/${key}/comment`, {
    method: "POST",
    headers: headers(creds),
    body: JSON.stringify({ body: adfBody }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira addComment failed (${res.status}): ${body}`);
  }

  return res.json();
}

export async function updateComment(key, commentId, adfBody) {
  const creds = auth();
  const res = await fetch(
    `${baseUrl(creds)}/issue/${key}/comment/${commentId}`,
    {
      method: "PUT",
      headers: headers(creds),
      body: JSON.stringify({ body: adfBody }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira updateComment failed (${res.status}): ${body}`);
  }

  return res.json();
}

export async function deleteComment(key, commentId) {
  const creds = auth();
  const res = await fetch(
    `${baseUrl(creds)}/issue/${key}/comment/${commentId}`,
    {
      method: "DELETE",
      headers: headers(creds),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira deleteComment failed (${res.status}): ${body}`);
  }
}
