// Emit opencode-dialect agent and command files from the canonical Claude Code
// sources.
//
// The repo stays in Claude Code dialect and `~/.claude/` keeps getting symlinks;
// opencode gets generated copies. Generation costs nothing on that side because
// opencode loads agent and command files at config time — it needs a restart to
// pick up a change regardless, so the loop was always `edit → restart` and is now
// `edit → sync → restart`. A symlink was never buying a live-edit loop there.
//
// Why this is code and not a shell one-liner: the frontmatter translation is
// lossy in exactly the ways that fail silently. opencode routes unknown
// frontmatter keys straight through to the provider as model options, and its
// permission defaults are **allow** — so a key this translator fails to map does
// not produce an error, it produces an agent with more authority than its source
// declared. `diff-critic` and `diff-security` document themselves read-only and
// are enforced solely by `allowed-tools`; a dropped mapping silently hands them
// write access. Every unmapped key is therefore reported, and a bad model id is a
// hard failure rather than a warning.

// Claude Code model aliases need no opencode equivalent by default, and giving
// them one is a portability bug.
//
// opencode resolves `model` as `provider/model-id`, and which ids are *invocable*
// depends on the user's provider config and region — not just on what
// `opencode models` lists. A Bedrock account in us-west-2 typically needs the
// `us.` cross-region inference profile (`us.anthropic.claude-opus-5`), while the
// bare `anthropic.claude-opus-5` also appears in the list. Hardcoding either into
// a shared repo pins every installer to one machine's setup. That is the actual
// defect in the in-flight attempt: `amazon-bedrock/opus` *does* resolve, but only
// because a personal `opencode.jsonc` aliases it, so the repo would depend on a
// private alias that exists on exactly one machine.
//
// The docs give a better answer for free: an agent with no `model` inherits the
// model of the primary agent that invoked it. Every agent here is a subagent, so
// omitting `model` reproduces the intent of Claude Code's `model: opus` — "use
// whatever the good model is" — without naming a provider.
//
// So: emit no `model` unless the caller explicitly maps an alias.
export const DEFAULT_MODEL_MAP = {};

// Aliases whose intent survives inheritance. `opus` means "use the capable
// model", which is what the invoking agent is already running. Anything else is a
// deliberate *downgrade* for cost — `condensor` exists precisely to run cheaper
// than its caller — and inheritance silently discards that, so it warns.
const INHERITABLE_ALIASES = new Set(["opus", "inherit", "default"]);

// Claude Code tool name → opencode permission key. Only tools that some agent in
// this repo actually lists appear here; that is the set the author was making a
// decision about, and it is the set whose absence therefore means "denied".
const TOOL_PERMISSION = {
  Read: "read",
  Write: "edit",
  Edit: "edit",
  Grep: "grep",
  Glob: "glob",
  Agent: "task",
  Task: "task",
  Skill: "skill",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  TodoWrite: "todowrite",
};

// Permission keys we are willing to emit a `deny` for when the source allowlist
// omits the corresponding tool.
//
// Deliberately narrow. Claude Code's `allowed-tools` is an allowlist, so a
// literal translation would deny every key the source never mentions — including
// infrastructure tools the agents plainly use (`todowrite`) and ones that do not
// exist in Claude Code at all (`question`, `list`, `lsp`, `doom_loop`). That
// translation is faithful to the letter and breaks working agents. What carries
// over is the restrictive *intent*: no write tool means no editing, no `Bash(...)`
// means no shell, no `Agent` means no subagents.
const DENIABLE = new Set([
  "read",
  "edit",
  "grep",
  "glob",
  "task",
  "skill",
  "bash",
]);

// `Bash(git *)` and `Bash(git:*)` both appear in this repo and mean the same
// thing. A translator that handles only one spelling drops half an allowlist —
// and a dropped bash entry *widens* access, because the pattern object no longer
// denies what it failed to parse. So both normalize to `git *`.
function normalizeBashPattern(inner) {
  const trimmed = inner.trim();
  if (trimmed === "*" || trimmed === "") return "*";
  // `git:*` → `git *`; `python*` is already a valid pattern and is left alone.
  const colon = trimmed.replace(/:\s*\*$/, " *");
  return colon.replace(/\s+/g, " ");
}

export class FrontmatterError extends Error {}

// Parse the narrow YAML subset this repo's frontmatter actually uses: scalar
// `key: value`, list `key:` followed by `  - item`, and `#` comments.
//
// It throws on anything outside that subset rather than skipping it. A parser
// that silently ignores what it does not understand is how an unmapped key ends
// up in the emitted file, and an unmapped key in opencode is a permission
// widening, not a no-op.
export function parseFrontmatter(text) {
  const lines = String(text || "").split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new FrontmatterError(
      "file does not start with a `---` frontmatter fence",
    );
  }

  const close = lines.indexOf("---", 1);
  if (close < 0) throw new FrontmatterError("unterminated frontmatter block");

  const data = {};
  const order = [];
  let currentKey = null;

  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const item = line.match(/^\s+-\s+(.*)$/);
    if (item) {
      if (!currentKey) {
        throw new FrontmatterError(
          `list item at line ${i + 1} has no parent key`,
        );
      }
      data[currentKey].push(item[1].trim());
      continue;
    }

    const scalar = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!scalar) {
      throw new FrontmatterError(
        `line ${i + 1} is neither a \`key: value\` pair nor a \`- item\`: ${line}`,
      );
    }

    const [, key, rawValue] = scalar;
    order.push(key);
    if (rawValue === "") {
      currentKey = key;
      data[key] = [];
    } else {
      currentKey = null;
      data[key] = stripQuotes(rawValue);
    }
  }

  return { data, order, body: lines.slice(close + 1).join("\n") };
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    /^["']/.test(trimmed) &&
    trimmed.endsWith(trimmed[0])
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Resolve a Claude Code model alias to an opencode `model` value, or to nothing.
//
// `available` is the output of `opencode models` when we could get it. It can only
// ever prove an id is *unknown*, never that it is invocable — a listed id can still
// fail at dispatch if the region lacks it — so it gates an explicit mapping and is
// not used to bless one.
export function mapModel(
  alias,
  { modelMap = DEFAULT_MODEL_MAP, available = null } = {},
) {
  if (!alias) return { model: null, warnings: [] };

  const explicit = modelMap[alias] || (alias.includes("/") ? alias : null);

  if (explicit) {
    if (available && available.length > 0 && !available.includes(explicit)) {
      throw new FrontmatterError(
        `\`${alias}\` maps to \`${explicit}\`, which \`opencode models\` does not list. ` +
          "An unresolvable id fails at dispatch rather than at load, so it is refused here.",
      );
    }
    return { model: explicit, warnings: [] };
  }

  if (INHERITABLE_ALIASES.has(alias)) return { model: null, warnings: [] };

  return {
    model: null,
    warnings: [
      `\`model: ${alias}\` was dropped — as a subagent it now inherits the invoking ` +
        "agent's model, which loses the deliberate choice of a cheaper one. Map it with " +
        "`--model " +
        alias +
        "=<provider/model-id>` to keep it.",
    ],
  };
}

// Translate a Claude Code `allowed-tools` list into an opencode `permission`
// object, plus the restrictions that could not be expressed.
export function mapAllowedTools(tools = []) {
  const granted = new Set();
  const bashPatterns = [];
  const mcpTools = [];
  const unknown = [];

  for (const raw of tools) {
    const entry = String(raw).trim();
    if (!entry) continue;

    const bash = entry.match(/^Bash\((.*)\)$/);
    if (bash) {
      granted.add("bash");
      bashPatterns.push(normalizeBashPattern(bash[1]));
      continue;
    }

    if (entry.startsWith("mcp__")) {
      mcpTools.push(entry);
      continue;
    }

    const key = TOOL_PERMISSION[entry];
    if (key) {
      granted.add(key);
      continue;
    }

    unknown.push(entry);
  }

  const permission = {};

  // Broad rules first, narrow ones after: opencode evaluates patterns in order
  // and the **last** match wins. Inverting that silently allows everything the
  // narrow rules were meant to carve out.
  for (const key of DENIABLE) {
    if (!granted.has(key)) permission[key] = "deny";
  }

  if (bashPatterns.length > 0) {
    const bash = { "*": "deny" };
    for (const pattern of [...new Set(bashPatterns)].sort())
      bash[pattern] = "allow";
    permission.bash = bash;
  }

  // MCP tools are restrictable after all: opencode matches permission keys as
  // wildcard patterns against the underlying tool name, so a server-wide deny
  // followed by per-tool allows reproduces the allowlist. This is what preserves
  // `tdd-builder`'s deliberately read-only Atlassian surface.
  const servers = [
    ...new Set(mcpTools.map((t) => t.split("__")[1]).filter(Boolean)),
  ];
  for (const server of servers.sort()) {
    permission[`mcp__${server}__*`] = "deny";
  }
  for (const tool of [...new Set(mcpTools)].sort()) {
    permission[tool] = "allow";
  }

  return { permission, unknown, mcpTools, bashPatterns };
}

function renderYamlValue(value, indent) {
  if (typeof value === "string") return ` ${quoteIfNeeded(value)}`;
  const pad = " ".repeat(indent + 2);
  const lines = Object.entries(value).map(
    ([k, v]) => `${pad}${quoteKey(k)}:${renderYamlValue(v, indent + 2)}`,
  );
  return `\n${lines.join("\n")}`;
}

function quoteKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : `"${key}"`;
}

function quoteIfNeeded(value) {
  return /^[A-Za-z0-9_./:-]+$/.test(value)
    ? value
    : `"${value.replace(/"/g, '\\"')}"`;
}

function renderFrontmatter(fields) {
  const out = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    out.push(`${quoteKey(key)}:${renderYamlValue(value, 0)}`);
  }
  out.push("---");
  return out.join("\n");
}

const GENERATED_BANNER =
  "<!-- Generated by `sync-opencode` from the Claude Code source of the same name.\n" +
  "     Do not edit here — edit the canonical file and re-run the sync. -->";

// `name:` is dropped on purpose: opencode takes the agent name from the filename,
// and an unrecognized `name` key would be forwarded to the provider as a model
// option.
export function emitAgent({ text, modelMap, available } = {}) {
  const { data } = parseFrontmatter(text);
  const warnings = [];

  if (!data.description) {
    warnings.push(
      "no `description` — opencode requires one for @-mention discovery",
    );
  }

  const { model, warnings: modelWarnings } = mapModel(data.model, {
    modelMap,
    available,
  });
  warnings.push(...modelWarnings);

  const tools = Array.isArray(data["allowed-tools"])
    ? data["allowed-tools"]
    : [];
  const { permission, unknown } = mapAllowedTools(tools);

  for (const entry of unknown) {
    warnings.push(`unmapped tool \`${entry}\` — no permission emitted for it`);
  }
  if (tools.length === 0) {
    warnings.push(
      "no `allowed-tools` in the source, so no restrictions were emitted; " +
        "opencode defaults are permissive",
    );
  }

  const fields = {
    description: data.description || null,
    // Absent `mode` defaults to `all` in opencode, which would also expose these
    // as primary agents in the Tab cycle. Every agent here is a subagent.
    mode: "subagent",
    model,
    permission: Object.keys(permission).length > 0 ? permission : null,
  };

  return {
    content: `${renderFrontmatter(fields)}\n\n${GENERATED_BANNER}\n${bodyOf(text)}`,
    warnings,
    permission,
  };
}

function bodyOf(text) {
  return parseFrontmatter(text).body;
}

// opencode command frontmatter accepts only `description`, `agent`, `model`,
// `subtask`, and `template`. There is no `permission` field on a command — a
// command runs under an agent and inherits that agent's permissions — so
// `allowed-tools` is not merely unmapped here, it is unmappable. `argument-hint`
// is likewise Claude Code-only. Both are dropped, and the drop is reported
// rather than hidden, because it is a real widening: whatever the source
// restricted, the invoking agent now decides.
export function emitCommand({ text, agentFor = () => null } = {}) {
  const { data } = parseFrontmatter(text);
  const warnings = [];

  const dropped = Object.keys(data).filter((k) =>
    ["allowed-tools", "argument-hint"].includes(k),
  );
  if (dropped.includes("allowed-tools")) {
    warnings.push(
      "`allowed-tools` dropped — commands have no permission field in opencode; " +
        "the invoking agent's permissions apply instead",
    );
  }

  const fields = {
    description: data.description || null,
    agent: agentFor(data) || null,
  };

  return {
    content: `${renderFrontmatter(fields)}\n\n${GENERATED_BANNER}\n${data ? bodyOf(text) : ""}`,
    warnings,
    dropped,
  };
}
