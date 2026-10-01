import { describe, expect, test } from "bun:test";
import type { DocRequest, DocStructuralElement, DocumentResource } from "./docs";
import { type DocsClient, executeDocument } from "./executor";
import { parseMarkdown } from "./parse";
import { planDocument } from "./plan";

/**
 * Answers every read with each table inserted so far, as a top-level element
 * where it went: Docs puts a newline before a table, so it starts one index
 * later, with its cells' paragraphs two indices apart from there.
 */
class TableEchoClient implements DocsClient {
  batches: DocRequest[][] = [];
  createDocument(): Promise<{ documentId: string }> {
    return Promise.resolve({ documentId: "doc" });
  }
  batchUpdate(_id: string, requests: DocRequest[]): Promise<void> {
    this.batches.push(requests);
    return Promise.resolve();
  }
  getDocument(): Promise<DocumentResource> {
    const tables: DocStructuralElement[] = this.batches.flat().flatMap((r) => {
      if (!("insertTable" in r)) return [];
      const { rows, columns, location } = r.insertTable;
      const start = location.index + 1;
      const tableRows = Array.from({ length: rows }, (_, row) => ({
        tableCells: Array.from({ length: columns }, (_, col) => {
          const at = start + 2 + 2 * (row * columns + col);
          return { startIndex: at - 1, endIndex: at + 1, content: [{ startIndex: at, endIndex: at + 1 }] };
        }),
      }));
      // A wide end leaves room for whatever the cells are filled with, so nothing after the table overlaps it.
      return [{ startIndex: start, endIndex: start + 1000, table: { tableRows } }];
    });
    tables.sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0));
    return Promise.resolve({
      documentStyle: {
        pageSize: { width: { magnitude: 595.28, unit: "PT" } },
        marginLeft: { magnitude: 72, unit: "PT" },
        marginRight: { magnitude: 72, unit: "PT" },
      },
      body: { content: tables },
    });
  }
  renameDocument(): Promise<void> {
    return Promise.resolve();
  }
  moveDocument(): Promise<void> {
    return Promise.resolve();
  }
}

const indent = (markdown: string, prefix: string) =>
  markdown
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : prefix.trimEnd()))
    .join("\n");

const CONTEXTS: Record<string, (element: string) => string> = {
  "at the top level": (e) => e,
  "inside a quote": (e) => indent(e, "> "),
  "inside a nested quote": (e) => indent(e, "> > "),
  "after a table": (e) => `| x |\n|---|\n| y |\n\n${e}`,
  "as a list item's later block": (e) => `- item\n\n${indent(e, "  ")}`,
};

/** A GFM table cell holds a single line of inline content, so only inline elements can sit in one. */
const INLINE_CONTEXTS: Record<string, (element: string) => string> = {
  "in a table's body cell": (e) => `| head |\n|---|\n| ${e.trim()} |\n`,
};

const INLINE_ELEMENTS: Record<string, string> = {
  paragraph: "Element text with **bold** and `code`.\n",
  caption: "**Element caption**\n",
};

const TEXT_ELEMENTS: Record<string, string> = {
  ...INLINE_ELEMENTS,
  heading: "## Element heading\n",
  "code block": "```\nelement code\n```\n",
  "bulleted list": "- element one\n- element two\n",
  "numbered list": "1. element one\n2. element two\n",
  "task list": "- [ ] element one\n- [x] element two\n",
};

const TABLE_ELEMENTS: Record<string, string> = {
  table: "| a | b |\n|---|---|\n| 1 | 2 |\n",
  quote: "> element quote\n",
};

async function render(markdown: string): Promise<DocRequest[]> {
  const client = new TableEchoClient();
  await executeDocument(client, "T", planDocument(parseMarkdown(markdown)));
  return client.batches.flat();
}

/** Spacing and list-item indents follow a block's position by design; everything else is the element's own. */
const POSITIONAL = new Set(["spaceAbove", "spaceBelow", "indentStart", "indentFirstLine"]);

function own(style: object): object {
  return Object.fromEntries(Object.entries(style).filter(([key]) => !POSITIONAL.has(key)));
}

/** The paragraph, text and bullet styling of whatever was inserted with the word "element" in it. */
function textElementStyling(requests: DocRequest[]): unknown[] {
  const spans = requests.flatMap((r) =>
    "insertText" in r && r.insertText.text.toLowerCase().includes("element")
      ? [[r.insertText.location.index, r.insertText.location.index + r.insertText.text.length]]
      : [],
  );
  const inElement = (index: number) => spans.some(([start = 0, end = 0]) => index >= start && index < end);
  return requests.flatMap((r): unknown[] => {
    if ("updateParagraphStyle" in r && inElement(r.updateParagraphStyle.range.startIndex)) {
      const style = own(r.updateParagraphStyle.paragraphStyle);
      // A request setting only positional fields, such as a list item's later-block indent, is the position's.
      return Object.keys(style).length > 0 ? [{ paragraph: style }] : [];
    }
    if ("updateTextStyle" in r && inElement(r.updateTextStyle.range.startIndex)) {
      const { startIndex, endIndex } = r.updateTextStyle.range;
      return [{ text: r.updateTextStyle.textStyle, length: endIndex - startIndex }];
    }
    if ("createParagraphBullets" in r && inElement(r.createParagraphBullets.range.startIndex)) {
      return [{ bullets: r.createParagraphBullets.bulletPreset }];
    }
    return [];
  });
}

/** The styling of the last table inserted, the element itself, with indices and widths left out. */
function tableElementStyling(requests: DocRequest[]): unknown[] {
  const inserts = requests.flatMap((r) => ("insertTable" in r ? [r.insertTable] : []));
  const last = inserts.at(-1);
  if (!last) return [];
  const start = last.location.index + 1;
  return requests
    .flatMap((r): unknown[] => {
      if ("updateTableCellStyle" in r) {
        const { tableStartLocation, tableRange, tableCellStyle } = r.updateTableCellStyle;
        const at = tableStartLocation?.index ?? tableRange?.tableCellLocation.tableStartLocation.index;
        return at === start
          ? [{ cell: tableCellStyle, range: tableRange && { ...tableRange, tableCellLocation: 0 } }]
          : [];
      }
      if ("updateTableRowStyle" in r && r.updateTableRowStyle.tableStartLocation.index === start) {
        return [{ row: r.updateTableRowStyle.tableRowStyle }];
      }
      return [];
    })
    .concat([{ shape: { rows: last.rows, columns: last.columns } }]);
}

/** Each inserted text's paragraph alignment, keyed by the text. */
function alignments(requests: DocRequest[]): Record<string, string | undefined> {
  return Object.fromEntries(
    requests.flatMap((r) => {
      if (!("insertText" in r)) return [];
      const at = r.insertText.location.index;
      const paragraph = requests.find(
        (p) => "updateParagraphStyle" in p && p.updateParagraphStyle.range.startIndex === at,
      );
      if (!paragraph || !("updateParagraphStyle" in paragraph)) return [];
      return [[r.insertText.text.trim(), paragraph.updateParagraphStyle.paragraphStyle.alignment]];
    }),
  );
}

describe("table cells", () => {
  test("a header cell renders its content as a body cell does, in bold", async () => {
    const content = INLINE_ELEMENTS.paragraph?.trim();
    const body = textElementStyling(await render(`| head |\n|---|\n| ${content} |\n`));
    const header = textElementStyling(await render(`| ${content} |\n|---|\n`));
    const baseFont = { weightedFontFamily: { fontFamily: "Montserrat" } };
    const bolded = body.map((s) => {
      const entry = s as { text?: object };
      return entry.text && JSON.stringify(entry.text) === JSON.stringify(baseFont)
        ? { ...entry, text: { ...baseFont, bold: true } }
        : s;
    });
    expect(bolded).not.toEqual(body);
    expect(header).toEqual(bolded);
  });

  test("a column's alignment applies to its header and body cells", async () => {
    const markdown = "| a | b | c | d |\n|:--|:-:|--:|---|\n| e | f | g | h |\n";
    expect(alignments(await render(markdown))).toEqual({
      a: "START",
      b: "CENTER",
      c: "END",
      d: undefined,
      e: "START",
      f: "CENTER",
      g: "END",
      h: undefined,
    });
  });
});

describe("every element renders the same in every context", () => {
  for (const [element, markdown] of Object.entries(TEXT_ELEMENTS)) {
    for (const [context, wrap] of Object.entries(CONTEXTS)) {
      // A list nested in a list item is a nested list, with its own documented rules.
      if (context === "as a list item's later block" && element.endsWith("list")) continue;
      test(`a ${element} ${context}`, async () => {
        const expected = textElementStyling(await render(markdown));
        expect(expected.length).toBeGreaterThan(0);
        expect(textElementStyling(await render(wrap(markdown)))).toEqual(expected);
      });
    }
  }

  for (const [element, markdown] of Object.entries(INLINE_ELEMENTS)) {
    for (const [context, wrap] of Object.entries(INLINE_CONTEXTS)) {
      test(`a ${element} ${context}`, async () => {
        const expected = textElementStyling(await render(markdown));
        expect(textElementStyling(await render(wrap(markdown)))).toEqual(expected);
      });
    }
  }

  for (const [element, markdown] of Object.entries(TABLE_ELEMENTS)) {
    for (const [context, wrap] of Object.entries(CONTEXTS)) {
      test(`a ${element} ${context}`, async () => {
        const expected = tableElementStyling(await render(markdown));
        expect(expected.length).toBeGreaterThan(1);
        expect(tableElementStyling(await render(wrap(markdown)))).toEqual(expected);
      });
    }
  }
});
