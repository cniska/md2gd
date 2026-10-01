import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { DocumentSchema, describeDocument, parseCliArgs } from "./render-doc";

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

describe("parseCliArgs", () => {
  test("takes the file and passes title and links through, links made absolute", () => {
    const args = parseCliArgs(["doc.md", "--title", "T", "--links", "map.json", "--rerender"]);
    expect(args).toMatchObject({
      file: resolve("doc.md"),
      rerender: true,
      keep: false,
      passthrough: ["--title", "T", "--links", resolve("map.json")],
    });
  });

  test("rejects a flag whose value is missing", () => {
    expect(parseCliArgs(["doc.md", "--title"])).toBeNull();
    expect(parseCliArgs(["doc.md", "--out", "--keep"])).toBeNull();
    expect(parseCliArgs(["doc.md", "--links", ""])).toBeNull();
  });

  test("rejects a second file or an unknown flag", () => {
    expect(parseCliArgs(["a.md", "b.md"])).toBeNull();
    expect(parseCliArgs(["a.md", "--update"])).toBeNull();
    expect(parseCliArgs([])).toBeNull();
  });
});
