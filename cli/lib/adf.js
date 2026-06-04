export function extractTextFromAdf(node) {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (Array.isArray(node.content)) {
    return node.content.map(extractTextFromAdf).join("");
  }
  return "";
}

export function extractListItemTexts(adfBody) {
  const texts = [];
  function walk(node) {
    if (!node) return;
    if (node.type === "listItem") {
      texts.push(extractTextFromAdf(node));
      return;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
    }
  }
  walk(adfBody);
  return texts;
}

export function checklistToAdf(steps, marker) {
  const items = steps.map((s) => ({
    type: "listItem",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `${s.done ? "✅" : "⬜"} ${s.num}. ${s.label}`,
          },
        ],
      },
    ],
  }));

  return {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `${marker} `,
            marks: [{ type: "code" }],
          },
          {
            type: "text",
            text: "Execution checklist",
            marks: [{ type: "strong" }],
          },
        ],
      },
      { type: "bulletList", content: items },
    ],
  };
}

export function planToAdf(sections, marker) {
  const content = [
    {
      type: "paragraph",
      content: [
        { type: "text", text: `${marker} `, marks: [{ type: "code" }] },
        { type: "text", text: "Execution plan", marks: [{ type: "strong" }] },
      ],
    },
  ];

  for (const section of sections) {
    content.push({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: section.title }],
    });

    const items = section.tasks.map((t) => ({
      type: "listItem",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: `${t.done ? "✅" : "⬜"} ${t.label}` },
          ],
        },
      ],
    }));

    content.push({ type: "bulletList", content: items });
  }

  return { version: 1, type: "doc", content };
}

export function parseChecklistFromComment(adfBody) {
  const texts = extractListItemTexts(adfBody);
  const steps = [];
  for (const text of texts) {
    const match = text.match(/^(✅|⬜)\s*(\d+)\.\s*(.+)$/);
    if (match) {
      steps.push({
        num: parseInt(match[2], 10),
        done: match[1] === "✅",
        label: match[3],
      });
    }
  }
  return steps.length ? { steps, frontmatter: {} } : null;
}

export function parsePlanFromComment(adfBody) {
  let total = 0;
  let completed = 0;
  const texts = extractListItemTexts(adfBody);
  for (const text of texts) {
    const match = text.match(/^(✅|⬜)\s*.+$/);
    if (match) {
      total++;
      if (match[1] === "✅") completed++;
    }
  }
  return total ? { total, completed } : null;
}

export function parsePlanSectionsFromComment(adfBody) {
  const sections = [];
  let currentSection = null;

  if (!adfBody?.content) return null;

  for (const node of adfBody.content) {
    if (node.type === "heading") {
      currentSection = { title: extractTextFromAdf(node), tasks: [] };
      sections.push(currentSection);
    } else if (node.type === "bulletList" && currentSection) {
      for (const item of node.content || []) {
        const text = extractTextFromAdf(item);
        const match = text.match(/^(✅|⬜)\s*(.+)$/);
        if (match) {
          currentSection.tasks.push({
            done: match[1] === "✅",
            label: match[2],
          });
        }
      }
    }
  }

  const withTasks = sections.filter((s) => s.tasks.length > 0);
  if (!withTasks.length) return null;

  const total = withTasks.reduce((sum, s) => sum + s.tasks.length, 0);
  const completed = withTasks.reduce(
    (sum, s) => sum + s.tasks.filter((t) => t.done).length,
    0,
  );

  return { sections: withTasks, total, completed };
}
