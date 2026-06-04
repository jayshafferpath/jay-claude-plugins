import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

export function checkPrExists(branch, base, cwd) {
  const result = run(
    `gh pr list --head ${branch} --base ${base} --json number,url,state --limit 1`,
    cwd,
  );
  if (!result) return null;
  try {
    const prs = JSON.parse(result);
    return prs.length > 0 ? prs[0] : null;
  } catch {
    return null;
  }
}

export function pushBranch(branch, cwd, force = false) {
  const flag = force ? "--force-with-lease" : "-u";
  const result = run(`git push ${flag} origin ${branch}`, cwd);
  return result !== null;
}

export function createPr(branch, base, title, body, draft, cwd) {
  const draftFlag = draft ? "--draft " : "";
  const escaped = body.replace(/'/g, "'\\''");
  const result = run(
    `gh pr create ${draftFlag}--base ${base} --title '${title.replace(/'/g, "'\\''")}' --body '${escaped}'`,
    cwd,
  );
  if (!result) return null;
  const prInfo = run(`gh pr view ${branch} --json number,url,state`, cwd);
  if (!prInfo) return null;
  try {
    return JSON.parse(prInfo);
  } catch {
    return null;
  }
}

export function ensurePr({
  branch,
  base,
  title,
  bodyFile,
  draft = false,
  forcePush = false,
  cwd,
}) {
  const existing = checkPrExists(branch, base, cwd);
  if (existing) {
    const pushed = pushBranch(branch, cwd, forcePush);
    return { action: "exists", pr: existing, pushed };
  }

  const pushed = pushBranch(branch, cwd, forcePush);
  if (!pushed) {
    return { action: "push_failed", pr: null, pushed: false };
  }

  let body = "";
  let prTitle = title || branch;
  if (bodyFile) {
    try {
      const content = readFileSync(bodyFile, "utf-8");
      const lines = content.split("\n");
      prTitle = title || lines[0].replace(/^#\s*/, "").trim();
      body = lines.slice(1).join("\n").trim();
    } catch {
      // bodyFile not found, proceed with empty body
    }
  }

  const pr = createPr(branch, base, prTitle, body, draft, cwd);
  if (!pr) {
    return { action: "create_failed", pr: null, pushed: true };
  }

  return { action: "created", pr, pushed: true };
}
