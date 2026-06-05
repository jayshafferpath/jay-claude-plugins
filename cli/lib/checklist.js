import {
  appendActivityToAdf,
  checklistToAdf,
  collapseActivityAdf,
  parseActivityFromComment,
  parseChecklistFromComment,
  parsePlanFromComment,
  parsePlanSectionsFromComment,
  planToAdf,
} from "./adf.js";
import {
  addComment,
  deleteComment,
  getComments,
  updateComment,
} from "./jira.js";
import {
  parsePlanSections,
  readChecklist,
  readExecutionPlan,
  readExecutionPlanRaw,
  readReviewPlan,
} from "./plan-reader.js";

export {
  readChecklist,
  readExecutionPlan,
  readExecutionPlanRaw,
  readReviewPlan,
};

function findMarkerComment(comments, marker) {
  return comments.find((c) => JSON.stringify(c.body).includes(marker));
}

const CHECKLIST_MARKER = "[claude-checklist-sync]";
const PLAN_MARKER = "[claude-plan-sync]";
const ACTIVITY_MARKER = "[claude-activity-log]";
const COLLAPSE_LABEL = "Previous attempts (collapsed)";

export async function syncChecklistToJira(ticketKey, steps) {
  if (!steps?.length) return;

  const adfBody = checklistToAdf(steps, CHECKLIST_MARKER);

  const comments = await getComments(ticketKey);
  const existing = findMarkerComment(comments, CHECKLIST_MARKER);

  if (existing) {
    await updateComment(ticketKey, existing.id, adfBody);
  } else {
    await addComment(ticketKey, adfBody);
  }
}

export async function syncPlanToJira(ticketKey, planContent) {
  if (!planContent) return;

  const sections = parsePlanSections(planContent);
  if (!sections.length) return;

  const adfBody = planToAdf(sections, PLAN_MARKER);

  const comments = await getComments(ticketKey);
  const existing = findMarkerComment(comments, PLAN_MARKER);

  if (existing) {
    await updateComment(ticketKey, existing.id, adfBody);
  } else {
    await addComment(ticketKey, adfBody);
  }
}

export async function readChecklistFromJira(ticketKey) {
  const comments = await getComments(ticketKey);
  const comment = findMarkerComment(comments, CHECKLIST_MARKER);
  if (!comment) return null;
  return parseChecklistFromComment(comment.body);
}

export async function readExecutionPlanFromJira(ticketKey) {
  const comments = await getComments(ticketKey);
  const comment = findMarkerComment(comments, PLAN_MARKER);
  if (!comment) return null;
  return parsePlanFromComment(comment.body);
}

export async function readPlanSectionsFromJira(ticketKey) {
  const comments = await getComments(ticketKey);
  const comment = findMarkerComment(comments, PLAN_MARKER);
  if (!comment) return null;
  return parsePlanSectionsFromComment(comment.body);
}

export async function markPlanTaskDone(ticketKey, taskLabel) {
  const result = await readPlanSectionsFromJira(ticketKey);
  if (!result) throw new Error(`No plan found in Jira for ${ticketKey}`);

  let found = false;
  for (const section of result.sections) {
    for (const task of section.tasks) {
      if (task.label === taskLabel && !task.done) {
        task.done = true;
        found = true;
        break;
      }
    }
    if (found) break;
  }

  if (!found) throw new Error(`Task not found or already done: "${taskLabel}"`);

  const adfBody = planToAdf(result.sections, PLAN_MARKER);
  const comments = await getComments(ticketKey);
  const existing = findMarkerComment(comments, PLAN_MARKER);

  if (existing) {
    await updateComment(ticketKey, existing.id, adfBody);
  } else {
    await addComment(ticketKey, adfBody);
  }

  return {
    sections: result.sections,
    total: result.total,
    completed: result.completed + 1,
  };
}

export async function clearChecklistFromJira(ticketKey) {
  const comments = await getComments(ticketKey);
  const existing = findMarkerComment(comments, CHECKLIST_MARKER);
  if (existing) {
    await deleteComment(ticketKey, existing.id);
    return true;
  }
  return false;
}

export async function clearPlanFromJira(ticketKey) {
  const comments = await getComments(ticketKey);
  const existing = findMarkerComment(comments, PLAN_MARKER);
  if (existing) {
    await deleteComment(ticketKey, existing.id);
    return true;
  }
  return false;
}

export async function appendActivityLog(
  ticketKey,
  heading,
  body,
  options = {},
) {
  if (!heading) throw new Error("appendActivityLog requires a heading");

  const timestamp = options.timestamp || new Date().toISOString();
  const comments = await getComments(ticketKey);
  const existing = findMarkerComment(comments, ACTIVITY_MARKER);

  const nextBody = appendActivityToAdf(
    existing?.body || null,
    ACTIVITY_MARKER,
    timestamp,
    heading,
    body || "",
  );

  if (existing) {
    await updateComment(ticketKey, existing.id, nextBody);
    return { action: "appended", commentId: existing.id, timestamp };
  }
  const created = await addComment(ticketKey, nextBody);
  return { action: "created", commentId: created?.id || null, timestamp };
}

export async function collapseActivityLog(ticketKey) {
  const comments = await getComments(ticketKey);
  const existing = findMarkerComment(comments, ACTIVITY_MARKER);
  if (!existing) return { action: "noop", entriesCollapsed: 0 };

  const parsed = parseActivityFromComment(existing.body);
  const entriesCollapsed = parsed?.entries?.length || 0;
  if (!entriesCollapsed) return { action: "noop", entriesCollapsed: 0 };

  const nextBody = collapseActivityAdf(
    existing.body,
    ACTIVITY_MARKER,
    COLLAPSE_LABEL,
  );
  await updateComment(ticketKey, existing.id, nextBody);
  return {
    action: "collapsed",
    commentId: existing.id,
    entriesCollapsed,
  };
}

export async function readActivityLog(ticketKey) {
  const comments = await getComments(ticketKey);
  const existing = findMarkerComment(comments, ACTIVITY_MARKER);
  if (!existing) return null;
  return parseActivityFromComment(existing.body);
}
