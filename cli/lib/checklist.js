import {
  checklistToAdf,
  parseChecklistFromComment,
  parsePlanFromComment,
  parsePlanSectionsFromComment,
  planToAdf,
} from "./adf.js";
import { addComment, getComments, updateComment } from "./jira.js";
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
