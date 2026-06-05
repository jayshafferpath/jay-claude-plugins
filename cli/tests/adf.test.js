import { describe, expect, it } from "vitest";
import {
  activityEntryNodes,
  activityHeader,
  appendActivityToAdf,
  checklistToAdf,
  collapseActivityAdf,
  extractListItemTexts,
  extractTextFromAdf,
  parseActivityFromComment,
  parseChecklistFromComment,
  parsePlanFromComment,
  parsePlanSectionsFromComment,
  planToAdf,
} from "../lib/adf.js";

describe("extractTextFromAdf", () => {
  it("returns empty string for null/undefined", () => {
    expect(extractTextFromAdf(null)).toBe("");
    expect(extractTextFromAdf(undefined)).toBe("");
  });

  it("returns text from a text node", () => {
    expect(extractTextFromAdf({ type: "text", text: "hi" })).toBe("hi");
  });

  it("returns empty string for text node with no text", () => {
    expect(extractTextFromAdf({ type: "text" })).toBe("");
  });

  it("recursively concatenates content arrays", () => {
    const node = {
      type: "paragraph",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    };
    expect(extractTextFromAdf(node)).toBe("ab");
  });

  it("returns empty string for unknown node types without content", () => {
    expect(extractTextFromAdf({ type: "rule" })).toBe("");
  });
});

describe("extractListItemTexts", () => {
  it("walks nested content and extracts listItem text", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "one" }] },
              ],
            },
          ],
        },
      ],
    };
    expect(extractListItemTexts(adf)).toEqual(["one"]);
  });

  it("handles empty doc", () => {
    expect(extractListItemTexts({ type: "doc" })).toEqual([]);
  });

  it("handles null", () => {
    expect(extractListItemTexts(null)).toEqual([]);
  });
});

describe("checklistToAdf", () => {
  it("renders steps with done/undone markers", () => {
    const adf = checklistToAdf(
      [
        { num: 1, label: "first", done: true },
        { num: 2, label: "second", done: false },
      ],
      "<!--m-->",
    );
    expect(adf.type).toBe("doc");
    const items = adf.content[1].content;
    expect(items).toHaveLength(2);
    expect(items[0].content[0].content[0].text).toBe("✅ 1. first");
    expect(items[1].content[0].content[0].text).toBe("⬜ 2. second");
  });
});

describe("planToAdf", () => {
  it("renders sections with tasks", () => {
    const adf = planToAdf(
      [
        {
          title: "Section A",
          tasks: [
            { label: "Task 1", done: true },
            { label: "Task 2", done: false },
          ],
        },
      ],
      "<!--m-->",
    );
    expect(adf.content[1].content[0].text).toBe("Section A");
    const items = adf.content[2].content;
    expect(items[0].content[0].content[0].text).toBe("✅ Task 1");
    expect(items[1].content[0].content[0].text).toBe("⬜ Task 2");
  });
});

describe("parseChecklistFromComment", () => {
  it("parses a checklist back from ADF", () => {
    const adf = checklistToAdf(
      [
        { num: 1, label: "first", done: true },
        { num: 2, label: "second", done: false },
      ],
      "<!--m-->",
    );
    expect(parseChecklistFromComment(adf)).toEqual({
      steps: [
        { num: 1, done: true, label: "first" },
        { num: 2, done: false, label: "second" },
      ],
      frontmatter: {},
    });
  });

  it("returns null when no list items match", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "x" }] },
              ],
            },
          ],
        },
      ],
    };
    expect(parseChecklistFromComment(adf)).toBeNull();
  });
});

describe("parsePlanFromComment", () => {
  it("counts total/completed", () => {
    const adf = planToAdf(
      [
        {
          title: "S",
          tasks: [
            { label: "a", done: true },
            { label: "b", done: false },
            { label: "c", done: true },
          ],
        },
      ],
      "<!--m-->",
    );
    expect(parsePlanFromComment(adf)).toEqual({ total: 3, completed: 2 });
  });

  it("returns null when no list items match", () => {
    expect(parsePlanFromComment({ type: "doc", content: [] })).toBeNull();
  });
});

describe("appendActivityToAdf", () => {
  it("creates a new doc when existing is null", () => {
    const result = appendActivityToAdf(
      null,
      "<!--m-->",
      "2026-06-05T10:00:00Z",
      "Plan",
      "did some planning",
    );
    expect(result.type).toBe("doc");
    expect(result.content[0]).toEqual(activityHeader("<!--m-->"));
    expect(result.content[1].type).toBe("heading");
  });

  it("creates a new doc when existing has no content", () => {
    const result = appendActivityToAdf(
      { content: [] },
      "<!--m-->",
      "2026-06-05T10:00:00Z",
      "Plan",
      "x",
    );
    expect(result.content[0]).toEqual(activityHeader("<!--m-->"));
  });

  it("appends entries to an existing doc", () => {
    const initial = appendActivityToAdf(
      null,
      "<!--m-->",
      "2026-06-05T10:00:00Z",
      "First",
      "body 1",
    );
    const next = appendActivityToAdf(
      initial,
      "<!--m-->",
      "2026-06-05T11:00:00Z",
      "Second",
      "- bullet a\n- bullet b",
    );
    const headings = next.content.filter((n) => n.type === "heading");
    expect(headings).toHaveLength(2);
  });

  it("handles body with paragraphs and bullets and blank lines", () => {
    const nodes = activityEntryNodes("ts", "h", "para 1\n- bullet\n\npara 2");
    const types = nodes.map((n) => n.type);
    expect(types).toEqual(["heading", "paragraph", "bulletList", "paragraph"]);
  });

  it("handles empty body", () => {
    const nodes = activityEntryNodes("ts", "h", "");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("heading");
  });
});

describe("collapseActivityAdf", () => {
  it("returns header-only doc when existing is null", () => {
    const result = collapseActivityAdf(null, "<!--m-->", "Collapsed");
    expect(result.content).toEqual([activityHeader("<!--m-->")]);
  });

  it("returns header-only doc when existing has no entries", () => {
    const result = collapseActivityAdf(
      { content: [activityHeader("<!--m-->")] },
      "<!--m-->",
      "Collapsed",
    );
    expect(result.content).toEqual([activityHeader("<!--m-->")]);
  });

  it("collapses entries into a summary heading + paragraph", () => {
    const initial = appendActivityToAdf(
      null,
      "<!--m-->",
      "2026-06-05T10:00:00Z",
      "First",
      "x",
    );
    const result = collapseActivityAdf(initial, "<!--m-->", "Collapsed prior");
    expect(result.content).toHaveLength(3);
    expect(result.content[1].content[0].text).toBe("Collapsed prior");
    expect(result.content[2].content[0].text).toContain("1 prior entries");
  });
});

describe("parseActivityFromComment", () => {
  it("returns null for empty content", () => {
    expect(parseActivityFromComment(null)).toBeNull();
    expect(parseActivityFromComment({ content: [] })).toBeNull();
  });

  it("parses entries from heading + body nodes", () => {
    const initial = appendActivityToAdf(
      null,
      "<!--m-->",
      "2026-06-05T10:00:00Z",
      "First",
      "body 1",
    );
    const next = appendActivityToAdf(
      initial,
      "<!--m-->",
      "2026-06-05T11:00:00Z",
      "Second",
      "body 2",
    );
    const parsed = parseActivityFromComment(next);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].heading).toContain("First");
    expect(parsed.entries[1].heading).toContain("Second");
  });
});

describe("parsePlanSectionsFromComment", () => {
  it("returns null when adfBody has no content", () => {
    expect(parsePlanSectionsFromComment({})).toBeNull();
    expect(parsePlanSectionsFromComment(null)).toBeNull();
  });

  it("returns null when no sections have tasks", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "heading",
          content: [{ type: "text", text: "Empty" }],
        },
      ],
    };
    expect(parsePlanSectionsFromComment(adf)).toBeNull();
  });

  it("parses sections + counts done/total", () => {
    const adf = planToAdf(
      [
        {
          title: "A",
          tasks: [
            { label: "t1", done: true },
            { label: "t2", done: false },
          ],
        },
        {
          title: "B",
          tasks: [{ label: "t3", done: true }],
        },
      ],
      "<!--m-->",
    );
    const parsed = parsePlanSectionsFromComment(adf);
    expect(parsed.total).toBe(3);
    expect(parsed.completed).toBe(2);
    expect(parsed.sections).toHaveLength(2);
  });

  it("ignores list items that don't match the marker pattern", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "heading",
          content: [{ type: "text", text: "S" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "hi" }] },
              ],
            },
          ],
        },
      ],
    };
    expect(parsePlanSectionsFromComment(adf)).toBeNull();
  });
});
