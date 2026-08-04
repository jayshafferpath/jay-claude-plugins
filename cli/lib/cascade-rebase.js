// Cascade-rebase a chain of branches.
//
// Used by /cleanup (Step 7) and /stack-rebase (Scenario A) — both of which
// were maintaining nearly-identical inline implementations before this
// extraction. The shape is:
//
//   given (origin: <branch removed from main / merged>),
//        (downstreams: [{ ticket, branch }, ...] in stack order),
//        (newRoot: branch the first downstream should rebase onto)
//   →    rebase the first downstream `--onto newRoot origin firstDownstream`,
//        push --force-with-lease, then for each subsequent downstream rebase
//        `--onto previousDownstream previousOriginalBase nextDownstream`.
//
// On conflict the chain stops and remaining downstreams are reported as
// `not-attempted`.

import { execSync } from "node:child_process";

import { appendActivityLog } from "./checklist.js";

function runCapture(cmd, cwd) {
  try {
    return {
      ok: true,
      stdout: execSync(cmd, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout?.toString?.() ?? "",
      stderr: err.stderr?.toString?.() ?? String(err),
      code: err.status ?? 1,
    };
  }
}

function listConflicts(repoRoot) {
  const r = runCapture("git diff --name-only --diff-filter=U", repoRoot);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Cascade-rebase a downstream chain.
//
// opts:
//   repoRoot       — repo path
//   originBranch   — the branch the first downstream was *originally* based on
//                    (the branch we just merged/deleted)
//   newRoot        — what the first downstream should rebase onto
//                    (typically `main` or the parent feature branch)
//   downstreams    — [{ ticket, branch }, ...] in stack order
//   pushAfterRebase — when true (default) force-with-lease push each rebased
//                     branch; when false, callers must push themselves
//   activityLog    — when present, the per-ticket side-effect kicker. Pass
//                    `{ note }` (string used as the activity-log body suffix)
//                    or `false` to skip. Each rebased / pushed-failed entry
//                    triggers `append-activity {ticket} --heading "Branch rebased"
//                    --body "Rebased onto \`{new_base}\`. {note}"`.
//   retargetFirstPr — when present, retarget the head-of-chain ticket's PR
//                     base to `retargetFirstPr.newBase`. Skipped when no PR
//                     is open. Errors are folded into the result entry as
//                     `pr_retarget_warning`.
//
// Returns { results: [{ ticket, branch, status, ... }, ...] }
//   status ∈ "rebased" | "pushed-failed" | "conflict" | "not-attempted" | "skipped"
export function cascadeRebase(opts) {
  const {
    repoRoot,
    originBranch,
    newRoot,
    downstreams,
    pushAfterRebase = true,
    activityLog = null,
    retargetFirstPr = null,
  } = opts;

  if (!repoRoot) throw new Error("cascadeRebase: repoRoot is required");
  if (!originBranch) throw new Error("cascadeRebase: originBranch is required");
  if (!newRoot) throw new Error("cascadeRebase: newRoot is required");
  if (!Array.isArray(downstreams)) {
    throw new Error("cascadeRebase: downstreams must be an array");
  }

  return runCascade({
    repoRoot,
    originBranch,
    newRoot,
    downstreams,
    pushAfterRebase,
    activityLog,
    retargetFirstPr,
  });
}

async function runCascade({
  repoRoot,
  originBranch,
  newRoot,
  downstreams,
  pushAfterRebase,
  activityLog,
  retargetFirstPr,
}) {
  const results = [];

  let previousBase = newRoot;
  let previousOriginalBase = originBranch;
  let stopped = false;

  for (const entry of downstreams) {
    const { ticket, branch } = entry;

    if (stopped) {
      results.push({ ticket, branch, status: "not-attempted" });
      continue;
    }

    if (!branch) {
      results.push({
        ticket,
        branch: null,
        status: "skipped",
        reason: "no branch on record",
      });
      continue;
    }

    const checkout = runCapture(`git checkout ${branch}`, repoRoot);
    if (!checkout.ok) {
      results.push({
        ticket,
        branch,
        status: "skipped",
        reason: `checkout failed: ${checkout.stderr.trim() || "unknown"}`,
      });
      continue;
    }

    const rebase = runCapture(
      `git rebase --onto ${previousBase} ${previousOriginalBase} ${branch}`,
      repoRoot,
    );

    if (!rebase.ok) {
      const files = listConflicts(repoRoot);
      runCapture("git rebase --abort", repoRoot);
      results.push({
        ticket,
        branch,
        status: "conflict",
        files,
      });
      stopped = true;
      continue;
    }

    let push = null;
    if (pushAfterRebase) {
      push = runCapture(
        `git push --force-with-lease origin ${branch}`,
        repoRoot,
      );
    }

    const result =
      push && !push.ok
        ? {
            ticket,
            branch,
            status: "pushed-failed",
            new_base: previousBase,
            error: push.stderr.trim() || `exit ${push.code}`,
          }
        : {
            ticket,
            branch,
            status: "rebased",
            new_base: previousBase,
          };
    results.push(result);

    previousOriginalBase = branch;
    previousBase = branch;
  }

  if (activityLog) {
    for (const entry of results) {
      if (entry.status !== "rebased" && entry.status !== "pushed-failed") {
        continue;
      }
      let body = `Rebased onto \`${entry.new_base}\`.`;
      if (activityLog.note) body += ` ${activityLog.note}`;
      if (entry.status === "pushed-failed") {
        body += ` (local rebase succeeded but force-push failed: ${entry.error})`;
      }
      try {
        await appendActivityLog(entry.ticket, "Branch rebased", body);
      } catch (err) {
        entry.activity_log_warning = err.message;
      }
    }
  }

  if (retargetFirstPr?.newBase) {
    const head = results.find((r) => r.status === "rebased");
    if (head) {
      const probe = runCapture(
        `gh pr list --head ${head.branch} --state open --json number --limit 1`,
        repoRoot,
      );
      if (probe.ok) {
        let prNumber = null;
        try {
          const parsed = JSON.parse(probe.stdout || "[]");
          prNumber = parsed[0]?.number ?? null;
        } catch {
          prNumber = null;
        }
        if (prNumber) {
          // Retarget via the REST endpoint rather than `gh pr edit`. The
          // latter issues a GraphQL query that reads org-level fields
          // (login/name/slug) for reviewer resolution even when only --base
          // was passed, so it hard-fails on a token without read:org. REST
          // PATCH needs only `repo`. The {owner}/{repo} placeholders are
          // resolved by gh from the local remote (issue #35).
          const edit = runCapture(
            `gh api --method PATCH repos/{owner}/{repo}/pulls/${prNumber} -f base=${retargetFirstPr.newBase}`,
            repoRoot,
          );
          if (edit.ok) {
            head.pr_retargeted = {
              number: prNumber,
              new_base: retargetFirstPr.newBase,
            };
          } else {
            head.pr_retarget_warning =
              edit.stderr.trim() || `gh api pulls PATCH exit ${edit.code}`;
          }
        } else {
          head.pr_retarget_warning = "no open PR found for head-of-chain";
        }
      } else {
        head.pr_retarget_warning = probe.stderr.trim() || "gh pr list failed";
      }
    }
  }

  return { results };
}
