import { execSync } from "node:child_process";

function run(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function runOrThrow(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

// Resolve the stage-start SHA: the most recent `[KEY]` stage commit, falling
// back to the merge-base with the base branch when no stage commit exists yet.
export function deriveStageStartSha(ticketKey, baseBranch, cwd) {
  const stage = run(`git log --grep="^\\[${ticketKey}\\]" -1 --format=%H`, cwd);
  if (stage) return stage;
  const base = baseBranch || "main";
  return run(`git merge-base HEAD origin/${base}`, cwd);
}

// Collapse every commit between STAGE_START_SHA and HEAD into a single squash
// commit titled `[{KEY}] {label}`. No-op when HEAD === STAGE_START_SHA.
//
// Returns: { action, label, sha?, pushed }
//   action ∈ "squashed" | "noop" | "push-failed"
export function stageSquash({
  ticketKey,
  branch,
  label,
  baseBranch,
  cwd,
  stageStartSha,
  push = true,
}) {
  if (!ticketKey) throw new Error("ticketKey is required");
  if (!label) throw new Error("label is required (e.g. 'plan: generated')");
  if (!cwd) throw new Error("cwd is required");

  const startSha =
    stageStartSha || deriveStageStartSha(ticketKey, baseBranch, cwd);
  if (!startSha) {
    throw new Error(
      `Cannot derive STAGE_START_SHA — no [${ticketKey}] commits and no merge-base for origin/${baseBranch || "main"}`,
    );
  }

  const log = run(`git log --oneline ${startSha}..HEAD`, cwd);
  if (!log) {
    return { action: "noop", label, pushed: false };
  }

  runOrThrow(`git reset --soft ${startSha}`, cwd);
  const message = `[${ticketKey}] ${label}`;
  runOrThrow(`git commit -m ${JSON.stringify(message)}`, cwd);
  const sha = runOrThrow("git rev-parse HEAD", cwd);

  if (!push) {
    return { action: "squashed", label, sha, pushed: false };
  }

  const branchName = branch || run("git rev-parse --abbrev-ref HEAD", cwd);
  if (!branchName) {
    return { action: "squashed", label, sha, pushed: false };
  }
  const pushed = run(`git push --force-with-lease origin ${branchName}`, cwd);
  if (pushed === null) {
    return {
      action: "push-failed",
      label,
      sha,
      pushed: false,
      branch: branchName,
    };
  }
  return { action: "squashed", label, sha, pushed: true, branch: branchName };
}
