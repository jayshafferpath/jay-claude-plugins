#!/usr/bin/env node

import { execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "../lib/env.js";

loadEnv();

import {
  emitAgent,
  emitCommand,
  FrontmatterError,
} from "../lib/opencode-emit.js";

const args = process.argv.slice(2);

if (args.includes("--help")) {
  console.error(
    "Usage: sync-opencode [--source <repo>] [--dest <~/.config/opencode>]\n" +
      "                     [--model <alias>=<provider/model-id>]...\n" +
      "                     [--check] [--dry-run] [--quiet]\n" +
      "\n" +
      "Generate opencode-dialect copies of the canonical Claude Code agents and\n" +
      "commands. The repo stays in Claude Code dialect and ~/.claude/ keeps\n" +
      "symlinks; opencode gets generated files.\n" +
      "\n" +
      "Generation costs nothing on the opencode side: agent and command files are\n" +
      "config-time, so opencode needs a restart to pick up a change either way.\n" +
      "The loop was always `edit -> restart` and is now `edit -> sync -> restart`.\n" +
      "\n" +
      "What the translation does:\n" +
      "  agents    allowed-tools -> permission (including per-MCP-tool rules)\n" +
      "            adds mode: subagent (absent mode defaults to `all`, which would\n" +
      "              also expose them as primary agents in the Tab cycle)\n" +
      "            drops name: (opencode uses the filename)\n" +
      "            drops model: — see below\n" +
      "  commands  keeps description, drops allowed-tools and argument-hint\n" +
      "\n" +
      "No model id is emitted by default, on purpose. Which ids are *invocable*\n" +
      "depends on the user's provider config and region, so hardcoding one pins\n" +
      "every installer to one machine's setup. An opencode subagent with no model\n" +
      "inherits the invoking agent's, which is what Claude Code's `model: opus`\n" +
      "meant anyway. Use --model to pin an alias that must differ — an agent whose\n" +
      "point is running *cheaper* than its caller loses that intent otherwise, and\n" +
      "is warned about.\n" +
      "\n" +
      "Unmapped keys are reported, never silently passed through: opencode forwards\n" +
      "unknown frontmatter to the provider as model options, and its permission\n" +
      "defaults are ALLOW — so a missed mapping widens authority rather than\n" +
      "failing.\n" +
      "\n" +
      "--check exits 2 when any emitted file is out of date, without writing.\n",
  );
  process.exit(0);
}

function getFlag(name, fallback) {
  const idx = args.indexOf(name);
  if (idx < 0) return fallback;
  return args[idx + 1];
}

// `import.meta.dirname` needs Node >= 20.11; this resolves on every version the
// repo supports.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const source = getFlag("--source", REPO_ROOT);
const dest = getFlag("--dest", join(homedir(), ".config", "opencode"));
const check = args.includes("--check");
const dryRun = args.includes("--dry-run") || check;
const quiet = args.includes("--quiet");

// Repeatable `--model <alias>=<provider/model-id>` for aliases that must be
// pinned rather than inherited.
const modelMap = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--model") continue;
  const pair = args[i + 1] || "";
  const at = pair.indexOf("=");
  if (at < 1) {
    console.error(`--model expects <alias>=<provider/model-id>, got "${pair}"`);
    process.exit(1);
  }
  modelMap[pair.slice(0, at)] = pair.slice(at + 1);
}

function log(line) {
  if (!quiet) console.log(line);
}

// The resolvable model ids, so a mapping that looks plausible but resolves to
// nothing is caught here rather than at first dispatch. Best-effort: if opencode
// is not on PATH we skip the check rather than refusing to sync.
function availableModels() {
  try {
    return execSync("opencode models", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

// Commands whose posture is not the invoking agent's. Empty by design: setting
// `agent:` wrongly is worse than leaving it unset, because unset inherits the
// agent the user is already driving — the status quo — while a wrong value
// silently changes a command's authority. Populate deliberately, per command.
const COMMAND_AGENT = {};

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return (
    readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      // `_`-prefixed files are shared reference fragments cited by other files,
      // not agents or commands of their own.
      .filter((f) => !f.startsWith("_"))
      .sort()
      .map((f) => join(dir, f))
  );
}

function sync({ kind, srcDir, destDir, emit }) {
  const results = {
    written: [],
    stale: [],
    unchanged: [],
    warnings: [],
    errors: [],
  };
  const files = sourceFiles(srcDir);
  if (files.length === 0) return results;

  if (!dryRun) mkdirSync(destDir, { recursive: true });

  for (const file of files) {
    const name = basename(file);
    const target = join(destDir, name);

    let emitted;
    try {
      emitted = emit(readFileSync(file, "utf-8"));
    } catch (err) {
      const detail =
        err instanceof FrontmatterError ? err.message : err.message;
      results.errors.push(`${kind}/${name}: ${detail}`);
      continue;
    }

    for (const warning of emitted.warnings) {
      results.warnings.push(`${kind}/${name}: ${warning}`);
    }

    // Read through a symlink to compare, but never *write* through one. A
    // previous install pointed opencode straight at the canonical repo file, and
    // writeFileSync follows the link — so writing without unlinking first would
    // overwrite the Claude Code source with opencode dialect. Replacing that
    // symlink with a generated file is exactly the migration this performs.
    const isLink = existsSync(target) && lstatSync(target).isSymbolicLink();
    const current = existsSync(target) ? readFileSync(target, "utf-8") : null;

    if (current === emitted.content && !isLink) {
      results.unchanged.push(name);
      continue;
    }

    if (dryRun) {
      results.stale.push(name);
      continue;
    }

    if (isLink) rmSync(target);
    writeFileSync(target, emitted.content, "utf-8");
    results.written.push(name);
  }

  return results;
}

const available = availableModels();
if (available === null && !quiet) {
  log(
    "  Note: `opencode models` unavailable — skipping model-id verification.",
  );
}

const agents = sync({
  kind: "agents",
  srcDir: join(source, "agents"),
  destDir: join(dest, "agents"),
  emit: (text) => emitAgent({ text, modelMap, available }),
});

const commands = sync({
  kind: "commands",
  srcDir: join(source, "commands"),
  destDir: join(dest, "commands"),
  emit: (text) =>
    emitCommand({ text, agentFor: (d) => COMMAND_AGENT[d.name] || null }),
});

const errors = [...agents.errors, ...commands.errors];
const warnings = [...agents.warnings, ...commands.warnings];
const stale = [...agents.stale, ...commands.stale];

if (check) {
  if (errors.length > 0) {
    for (const e of errors) console.error(`  ERROR ${e}`);
    process.exit(2);
  }
  if (stale.length > 0) {
    log(`opencode files out of date (${stale.length}): ${stale.join(", ")}`);
    log("Run `sync-opencode` to regenerate, then restart opencode.");
    process.exit(2);
  }
  log("opencode files up to date.");
  process.exit(0);
}

if (errors.length > 0) {
  for (const e of errors) console.error(`  ERROR ${e}`);
}

if (dryRun) {
  log(
    `Would write ${stale.length} file(s); ${agents.unchanged.length + commands.unchanged.length} already current.`,
  );
} else {
  log(
    `  Emitted ${agents.written.length} agent(s), ${commands.written.length} command(s) to ${dest}`,
  );
  const unchanged = agents.unchanged.length + commands.unchanged.length;
  if (unchanged > 0) log(`  ${unchanged} already current`);
}

if (warnings.length > 0 && !quiet) {
  // Group by message: the `allowed-tools` drop applies to every command that had
  // one, and 23 identical lines bury the notes that are actually specific.
  const grouped = new Map();
  for (const warning of warnings) {
    const at = warning.indexOf(": ");
    const [where, message] = [warning.slice(0, at), warning.slice(at + 2)];
    if (!grouped.has(message)) grouped.set(message, []);
    grouped.get(message).push(where);
  }

  log("");
  log(`  ${grouped.size} translation note(s) — the port is not lossless:`);
  for (const [message, wheres] of grouped) {
    log(
      wheres.length === 1
        ? `    - ${wheres[0]}: ${message}`
        : `    - ${wheres.length} files: ${message}`,
    );
  }
}

process.exit(errors.length > 0 ? 1 : 0);
