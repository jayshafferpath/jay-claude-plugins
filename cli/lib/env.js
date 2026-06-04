import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnv() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  // Load project .env file (lowest priority — won't override existing env vars)
  try {
    const content = readFileSync(resolve(root, ".env"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed
        .slice(eqIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env file is optional
  }

  // Load dev-root.json fields into process.env (won't override existing env vars)
  // ~/.claude/ first (machine-specific), project-level second (shared/supplemental)
  const devRootPaths = [
    join(homedir(), ".claude", "dev-root.json"),
    resolve(root, "dev-root.json"),
  ];
  for (const devRootPath of devRootPaths) {
    try {
      const raw = JSON.parse(readFileSync(devRootPath, "utf-8"));
      if (raw.slackWebhookUrl && !process.env.SLACK_WEBHOOK_URL) {
        process.env.SLACK_WEBHOOK_URL = raw.slackWebhookUrl;
      }
      if (raw.root && !process.env.DEV_ROOT) {
        process.env.DEV_ROOT = raw.root.startsWith("~")
          ? raw.root.replace("~", homedir())
          : raw.root;
      }
    } catch {
      // dev-root.json is optional at each location
    }
  }
}
