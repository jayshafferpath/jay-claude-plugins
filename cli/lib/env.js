import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnvFile(path) {
  try {
    const content = readFileSync(path, "utf-8");
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
    // file is optional
  }
}

export function loadEnv() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  // Project .env (lowest priority — won't override existing env vars)
  loadEnvFile(resolve(root, ".env"));

  // Machine-level ~/.claude/.env (also won't override)
  loadEnvFile(join(homedir(), ".claude", ".env"));
}
