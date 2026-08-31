import { describe, expect, it } from "vitest";

import {
  emitAgent,
  emitCommand,
  FrontmatterError,
  mapAllowedTools,
  mapModel,
  parseFrontmatter,
} from "../lib/opencode-emit.js";

function agentSource(frontmatter, body = "\n# Body\n\nText.\n") {
  return `---\n${frontmatter}\n---\n${body}`;
}

describe("parseFrontmatter", () => {
  it("parses scalars, lists, and comments", () => {
    const { data, body } = parseFrontmatter(
      agentSource(
        [
          "name: thing",
          'description: "Does a thing"',
          "model: opus",
          "allowed-tools:",
          "  # a comment",
          "  - Read",
          "  - Bash(git *)",
        ].join("\n"),
      ),
    );

    expect(data).toEqual({
      name: "thing",
      description: "Does a thing",
      model: "opus",
      "allowed-tools": ["Read", "Bash(git *)"],
    });
    expect(body).toContain("# Body");
  });

  it("strips matching quotes but leaves inner ones alone", () => {
    const { data } = parseFrontmatter(
      agentSource('description: "a \\"quoted\\" thing"'),
    );
    expect(data.description).toBe('a \\"quoted\\" thing');
  });

  it("throws rather than skipping a line it does not understand", () => {
    // A parser that ignores what it cannot read is how an unmapped key reaches the
    // emitted file — and in opencode an unmapped key is a permission widening.
    expect(() => parseFrontmatter(agentSource("this is not yaml"))).toThrow(
      FrontmatterError,
    );
    expect(() => parseFrontmatter(agentSource("  - orphan"))).toThrow(
      /no parent key/,
    );
  });

  it("throws on a missing or unterminated fence", () => {
    expect(() => parseFrontmatter("# no frontmatter")).toThrow(
      /`---` frontmatter fence/,
    );
    expect(() => parseFrontmatter("---\nname: x\n")).toThrow(/unterminated/);
  });
});

describe("mapModel", () => {
  it("emits nothing for the capable-model alias — a subagent inherits its caller", () => {
    expect(mapModel("opus")).toEqual({ model: null, warnings: [] });
  });

  it("warns when a deliberate downgrade is dropped", () => {
    // `condensor` exists to run cheaper than its caller. Inheritance silently
    // discards that, which is the whole cost argument for the agent.
    const out = mapModel("sonnet");
    expect(out.model).toBeNull();
    expect(out.warnings[0]).toMatch(/inherits the invoking agent's model/);
    expect(out.warnings[0]).toMatch(/--model sonnet=/);
  });

  it("honours an explicit mapping", () => {
    expect(
      mapModel("sonnet", { modelMap: { sonnet: "amazon-bedrock/x" } }),
    ).toEqual({ model: "amazon-bedrock/x", warnings: [] });
  });

  it("passes a provider/model-id through unchanged", () => {
    expect(mapModel("amazon-bedrock/opus").model).toBe("amazon-bedrock/opus");
  });

  it("refuses an explicit id that opencode does not list", () => {
    expect(() =>
      mapModel("amazon-bedrock/nope", { available: ["amazon-bedrock/yes"] }),
    ).toThrow(/does not list/);
  });

  it("skips verification when the model list is unavailable", () => {
    expect(mapModel("amazon-bedrock/anything", { available: null }).model).toBe(
      "amazon-bedrock/anything",
    );
    expect(mapModel("amazon-bedrock/anything", { available: [] }).model).toBe(
      "amazon-bedrock/anything",
    );
  });

  it("emits nothing when the source declares no model", () => {
    expect(mapModel(null)).toEqual({ model: null, warnings: [] });
  });
});

describe("mapAllowedTools", () => {
  it("denies edit when no write tool is granted", () => {
    const { permission } = mapAllowedTools(["Read", "Glob", "Grep"]);
    expect(permission.edit).toBe("deny");
  });

  it("does not deny edit when Write or Edit is granted", () => {
    expect(mapAllowedTools(["Read", "Write"]).permission.edit).toBeUndefined();
    expect(mapAllowedTools(["Read", "Edit"]).permission.edit).toBeUndefined();
  });

  it("denies bash outright when no Bash(...) entry exists", () => {
    expect(mapAllowedTools(["Read"]).permission.bash).toBe("deny");
  });

  it("builds a deny-first bash object from the granted prefixes", () => {
    // opencode evaluates patterns in order and the LAST match wins, so the
    // catch-all deny has to come first or the narrow allows are pointless.
    const { permission } = mapAllowedTools(["Bash(git *)", "Bash(gh *)"]);
    expect(Object.keys(permission.bash)).toEqual(["*", "gh *", "git *"]);
    expect(permission.bash["*"]).toBe("deny");
    expect(permission.bash["git *"]).toBe("allow");
  });

  it("normalizes both bash spellings to the same pattern", () => {
    // `Bash(git:*)` and `Bash(git *)` mean the same thing, and a translator that
    // handles one spelling drops half an allowlist — which WIDENS access, because
    // the pattern object no longer denies what it failed to parse.
    expect(mapAllowedTools(["Bash(git:*)"]).permission.bash["git *"]).toBe(
      "allow",
    );
    expect(mapAllowedTools(["Bash(git *)"]).permission.bash["git *"]).toBe(
      "allow",
    );
    expect(
      mapAllowedTools(["Bash(git:*)", "Bash(git *)"]).bashPatterns,
    ).toEqual(["git *", "git *"]);
  });

  it("leaves a bare prefix pattern like python* alone", () => {
    expect(mapAllowedTools(["Bash(python*)"]).permission.bash["python*"]).toBe(
      "allow",
    );
  });

  it("reproduces an MCP allowlist as a server-wide deny plus per-tool allows", () => {
    // This is what preserves tdd-builder's deliberately read-only Atlassian
    // surface. Permission keys match as wildcard patterns against the tool name,
    // so MCP tools are restrictable after all.
    const { permission } = mapAllowedTools([
      "mcp__atlassian__getJiraIssue",
      "mcp__atlassian__getConfluencePage",
      "Read",
    ]);
    const keys = Object.keys(permission);
    expect(keys.indexOf("mcp__atlassian__*")).toBeLessThan(
      keys.indexOf("mcp__atlassian__getJiraIssue"),
    );
    expect(permission["mcp__atlassian__*"]).toBe("deny");
    expect(permission.mcp__atlassian__getJiraIssue).toBe("allow");
    expect(permission.mcp__atlassian__getConfluencePage).toBe("allow");
  });

  it("denies each server separately when several are listed", () => {
    const { permission } = mapAllowedTools(["mcp__a__one", "mcp__b__two"]);
    expect(permission["mcp__a__*"]).toBe("deny");
    expect(permission["mcp__b__*"]).toBe("deny");
  });

  it("maps Agent and Skill to task and skill", () => {
    expect(mapAllowedTools(["Read", "Agent"]).permission.task).toBeUndefined();
    expect(mapAllowedTools(["Read"]).permission.task).toBe("deny");
    expect(mapAllowedTools(["Read", "Skill"]).permission.skill).toBeUndefined();
  });

  it("reports a tool it does not recognize instead of dropping it quietly", () => {
    const { unknown } = mapAllowedTools(["Read", "NotARealTool"]);
    expect(unknown).toEqual(["NotARealTool"]);
  });

  it("does not deny keys the source never had an opinion about", () => {
    // A literal allowlist translation would deny todowrite, question, webfetch,
    // list, lsp — including tools that do not exist in Claude Code at all. That is
    // faithful to the letter and breaks working agents.
    const { permission } = mapAllowedTools([
      "Read",
      "Write",
      "Grep",
      "Glob",
      "Agent",
      "Skill",
    ]);
    expect(permission.todowrite).toBeUndefined();
    expect(permission.question).toBeUndefined();
    expect(permission.webfetch).toBeUndefined();
    expect(permission.list).toBeUndefined();
  });

  it("ignores blank entries", () => {
    expect(mapAllowedTools(["", "  ", "Read"]).unknown).toEqual([]);
  });
});

describe("emitAgent", () => {
  const readOnly = agentSource(
    [
      "name: diff-critic",
      'description: "Read-only reviewer"',
      "model: opus",
      "allowed-tools:",
      "  - Read",
      "  - Glob",
      "  - Grep",
      "  - Bash(git *)",
    ].join("\n"),
  );

  it("enforces read-only where the source only documented it", () => {
    // The source is documented read-only and enforced SOLELY by allowed-tools.
    // opencode's permission default is `allow`, so without this the agent can edit.
    const { content } = emitAgent({ text: readOnly });
    expect(content).toContain("edit: deny");
    expect(content).toContain('"*": deny');
    expect(content).toContain('"git *": allow');
  });

  it("adds mode: subagent, since an absent mode defaults to `all`", () => {
    // `all` would also expose these in the primary Tab cycle — a read-only
    // reviewer becomes an agent you can drive a whole session as.
    expect(emitAgent({ text: readOnly }).content).toContain("mode: subagent");
  });

  it("drops name: — opencode uses the filename, and unknown keys reach the provider", () => {
    const { content } = emitAgent({ text: readOnly });
    expect(content).not.toContain("name:");
    expect(content).not.toContain("allowed-tools");
  });

  it("keeps the body verbatim and marks the file generated", () => {
    const { content } = emitAgent({ text: readOnly });
    expect(content).toContain("# Body");
    expect(content).toContain("Generated by `sync-opencode`");
  });

  it("warns when the source granted no tools at all", () => {
    const { warnings } = emitAgent({
      text: agentSource(['description: "d"', "model: opus"].join("\n")),
    });
    expect(warnings.join(" ")).toMatch(/no `allowed-tools`/);
  });

  it("warns on a missing description, which opencode requires", () => {
    const { warnings } = emitAgent({ text: agentSource("name: x") });
    expect(warnings.join(" ")).toMatch(/no `description`/);
  });

  it("surfaces the model warning from the source alias", () => {
    const { warnings, content } = emitAgent({
      text: agentSource(
        [
          'description: "d"',
          "model: sonnet",
          "allowed-tools:",
          "  - Read",
        ].join("\n"),
      ),
    });
    expect(warnings.join(" ")).toMatch(/inherits the invoking agent/);
    expect(content).not.toContain("model:");
  });

  it("emits a pinned model when one is mapped", () => {
    const { content } = emitAgent({
      text: agentSource(
        [
          'description: "d"',
          "model: sonnet",
          "allowed-tools:",
          "  - Read",
        ].join("\n"),
      ),
      modelMap: { sonnet: "amazon-bedrock/s" },
    });
    expect(content).toContain("model: amazon-bedrock/s");
  });

  it("quotes only the keys that need it", () => {
    const { content } = emitAgent({ text: readOnly });
    expect(content).toContain("  edit: deny");
    expect(content).toContain('    "git *": allow');
  });
});

describe("emitCommand", () => {
  const command = `---\ndescription: Review a PR\nargument-hint: "[base]"\nallowed-tools: Read, Write, Bash(git:*)\n---\n\nDo the review of $ARGUMENTS.\n`;

  it("keeps description and drops the Claude Code-only keys", () => {
    const { content } = emitCommand({ text: command });
    expect(content).toContain('description: "Review a PR"');
    expect(content).not.toContain("argument-hint");
    expect(content).not.toContain("allowed-tools");
  });

  it("reports the allowed-tools drop as the widening it is", () => {
    // Commands have no permission field in opencode — a command runs under an
    // agent and inherits its permissions — so this is unmappable, not just
    // unmapped.
    const { warnings, dropped } = emitCommand({ text: command });
    expect(dropped).toContain("allowed-tools");
    expect(warnings.join(" ")).toMatch(/no permission field in opencode/);
  });

  it("keeps the body and its argument placeholders verbatim", () => {
    expect(emitCommand({ text: command }).content).toContain("$ARGUMENTS");
  });

  it("sets agent only when the caller supplies one", () => {
    expect(emitCommand({ text: command }).content).not.toContain("agent:");
    expect(
      emitCommand({ text: command, agentFor: () => "reviewer" }).content,
    ).toContain("agent: reviewer");
  });

  it("does not warn for a command that declared no tools", () => {
    const bare = `---\ndescription: Plain\n---\n\nBody.\n`;
    expect(emitCommand({ text: bare }).warnings).toEqual([]);
  });
});
