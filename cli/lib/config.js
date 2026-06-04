export function loadDevRoot() {
  return process.env.DEV_ROOT || null;
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
