import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export function loadDevRoot() {
  const configPath = join(homedir(), ".claude", "dev-root.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw).root;
  } catch {
    return null;
  }
}

export function getJiraAuth() {
  const email = process.env.JIRA_EMAIL || process.env.ATLASSIAN_EMAIL;
  const token = process.env.JIRA_API_TOKEN || process.env.ATLASSIAN_API_TOKEN;
  const domain = process.env.JIRA_DOMAIN || process.env.ATLASSIAN_DOMAIN;

  if (!email || !token || !domain) {
    return null;
  }

  return { email, token, domain };
}
