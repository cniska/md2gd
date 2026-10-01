import { describe, expect, test } from "bun:test";
import { DocumentSchema, describeDocument } from "./render-doc";

const run = (content: string) => ({ textRun: { content } });

describe("describeDocument", () => {
  test("lists each paragraph with its named style and bullet nesting", () => {
    const doc = DocumentSchema.parse({
      title: "Report",
      body: {
        content: [
          { sectionBreak: {} },
          { paragraph: { elements: [run("Report\n")], paragraphStyle: { namedStyleType: "HEADING_1" } } },
          {
            paragraph: {
              elements: [run("nested "), run("item 🙂\n")],
              paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
              bullet: { listId: "l1", nestingLevel: 1 },
            },
          },
        ],
      },
    });
    expect(describeDocument(doc)).toBe(
      ["title: Report", '[HEADING_1] "Report"', '[NORMAL_TEXT bullet@1] "nested item 🙂"'].join("\n"),
    );
  });

  test("shows a table's shape and each cell's paragraphs", () => {
    const cell = (text: string) => ({
      content: [{ paragraph: { elements: [run(`${text}\n`)], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } }],
    });
    const doc = DocumentSchema.parse({
      title: "T",
      body: { content: [{ table: { tableRows: [{ tableCells: [cell("A"), cell("B")] }] } }] },
    });
    expect(describeDocument(doc)).toBe(
      ["title: T", "[TABLE 1x2]", "  (0,0)", '    [NORMAL_TEXT] "A"', "  (0,1)", '    [NORMAL_TEXT] "B"'].join("\n"),
    );
  });
});
