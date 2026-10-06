import { describe, expect, test } from "bun:test";
import type { DocRequest, DocumentResource } from "./docs";
import { executeDocument, updateDocument } from "./executor";
import { parseMarkdown } from "./parse";
import { planDocument } from "./plan";

const A4 = {
  pageSize: { width: { magnitude: 595.28, unit: "PT" as const }, height: { magnitude: 841.89, unit: "PT" as const } },
  marginLeft: { magnitude: 72, unit: "PT" as const },
  marginRight: { magnitude: 72, unit: "PT" as const },
};

class MockClient {
  batches: DocRequest[][] = [];
  getCalls = 0;
  renames: { id: string; name: string }[] = [];
  calls: string[] = [];
  constructor(private readonly getResponses: DocumentResource[] = []) {}

  createDocument(_title: string): Promise<{ documentId: string }> {
    this.calls.push("create");
    return Promise.resolve({ documentId: "doc-1" });
  }
  batchUpdate(_id: string, requests: DocRequest[]): Promise<void> {
    this.calls.push("batchUpdate");
    this.batches.push(requests);
    return Promise.resolve();
  }
  getDocument(_id: string): Promise<DocumentResource> {
    this.calls.push("getDocument");
    const response = this.getResponses[this.getCalls] ?? { body: { content: [] } };
    this.getCalls++;
    return Promise.resolve(response);
  }
  renameDocument(id: string, name: string): Promise<void> {
    this.calls.push("renameDocument");
    this.renames.push({ id, name });
    return Promise.resolve();
  }
  moves: { id: string; folderId: string }[] = [];
  moveDocument(id: string, folderId: string): Promise<void> {
    this.calls.push("moveDocument");
    this.moves.push({ id, folderId });
    return Promise.resolve();
  }
}

describe("executeDocument", () => {
  test("a linear document creates the doc and sends one batch, no GET", async () => {
    const client = new MockClient();
    const segments = planDocument(parseMarkdown("# Title\n\nBody.\n"));
    const id = await executeDocument(client, "T", segments);
    expect(id).toBe("doc-1");
    expect(client.batches).toHaveLength(1);
    expect(client.getCalls).toBe(0);
    expect(client.batches[0]?.some((r) => "insertText" in r)).toBe(true);
  });

  test("a table is inserted, read back, then styled and filled", async () => {
    const tableGet: DocumentResource = {
      documentStyle: A4,
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 40,
            table: {
              tableRows: [
                { tableCells: [{ content: [{ startIndex: 3 }] }, { content: [{ startIndex: 6 }] }] },
                { tableCells: [{ content: [{ startIndex: 10 }] }, { content: [{ startIndex: 14 }] }] },
              ],
            },
          },
        ],
      },
    };
    const client = new MockClient([tableGet, tableGet]);

    const md = "| H1 | H2 |\n|---|---|\n| a | b |\n";
    await executeDocument(client, "T", planDocument(parseMarkdown(md)));

    expect(client.batches).toHaveLength(2);
    expect(client.batches[0]?.[0]).toHaveProperty("insertTable");

    const styleFill = client.batches[1] ?? [];
    expect(styleFill.filter((r) => "updateTableColumnProperties" in r)).toHaveLength(2);
    expect(styleFill.some((r) => "updateTableCellStyle" in r && r.updateTableCellStyle.tableStartLocation)).toBe(true);
    expect(styleFill.some((r) => "updateTableCellStyle" in r && r.updateTableCellStyle.tableRange)).toBe(true);
    expect(
      styleFill.some((r) => "updateTableRowStyle" in r && r.updateTableRowStyle.tableRowStyle.preventOverflow),
    ).toBe(true);

    const inserts = styleFill.filter((r): r is Extract<DocRequest, { insertText: unknown }> => "insertText" in r);
    const indices = inserts.map((r) => r.insertText.location.index);
    expect(indices).toEqual([...indices].sort((a, b) => b - a));
    expect(indices[0]).toBe(14);
    expect(indices.at(-1)).toBe(3);

    expect(inserts.map((r) => r.insertText.text)).toEqual(["b", "a", "H2", "H1"]);
    const cellParagraph = styleFill.find(
      (r) => "updateParagraphStyle" in r && r.updateParagraphStyle.range.startIndex === 3,
    );
    if (!cellParagraph || !("updateParagraphStyle" in cellParagraph)) throw new Error("no cell paragraph style");
    expect(cellParagraph.updateParagraphStyle.range).toEqual({ startIndex: 3, endIndex: 6 });
    expect(cellParagraph.updateParagraphStyle.paragraphStyle.spaceBelow?.magnitude).toBe(0);
    expect(cellParagraph.updateParagraphStyle.paragraphStyle.spaceAbove?.magnitude).toBe(0);

    const widths = styleFill.flatMap((r) =>
      "updateTableColumnProperties" in r ? [r.updateTableColumnProperties.tableColumnProperties.width.magnitude] : [],
    );
    expect(Math.abs(widths.reduce((sum, w) => sum + w, 0) - 451.28)).toBeLessThanOrEqual(0.05);
  });

  test("the injected paragraph before a table is pinned to a thin spacer", async () => {
    const tableGet: DocumentResource = {
      documentStyle: A4,
      body: {
        content: [
          {
            startIndex: 5,
            endIndex: 30,
            table: {
              tableRows: [{ tableCells: [{ content: [{ startIndex: 7 }] }, { content: [{ startIndex: 10 }] }] }],
            },
          },
        ],
      },
    };
    const client = new MockClient([tableGet, tableGet]);
    await executeDocument(client, "T", planDocument(parseMarkdown("| a | b |\n|---|---|\n")));

    const styleFill = client.batches[1] ?? [];
    const spacerPara = styleFill.find(
      (r) => "updateParagraphStyle" in r && r.updateParagraphStyle.range.startIndex === 4,
    );
    expect(spacerPara).toBeDefined();
    const spacerFont = styleFill.find(
      (r) => "updateTextStyle" in r && r.updateTextStyle.range.startIndex === 4 && r.updateTextStyle.textStyle.fontSize,
    );
    expect(spacerFont).toBeDefined();
  });
});

class OneCellClient extends MockClient {
  override getDocument(_id: string): Promise<DocumentResource> {
    this.getCalls++;
    const inserts = this.batches.flat().flatMap((r) => ("insertTable" in r ? [r.insertTable.location.index] : []));
    const at = inserts.at(-1) ?? 1;
    const cell = { startIndex: at + 2, endIndex: at + 4, content: [{ startIndex: at + 3, endIndex: at + 4 }] };
    return Promise.resolve({
      documentStyle: A4,
      body: { content: [{ startIndex: at + 1, endIndex: at + 5, table: { tableRows: [{ tableCells: [cell] }] } }] },
    });
  }
}

async function renderQuote(markdown: string): Promise<OneCellClient> {
  const client = new OneCellClient();
  await executeDocument(client, "T", planDocument(parseMarkdown(markdown)));
  return client;
}

describe("executeDocument quotes", () => {
  test("a quote is a one-cell table with a left accent only, filled through its cell", async () => {
    const client = await renderQuote("> quoted\n");
    const requests = client.batches.flat();
    expect(requests[0]).toEqual({ insertTable: { rows: 1, columns: 1, location: { index: 1 } } });

    const cellStyle = requests.find((r) => "updateTableCellStyle" in r);
    if (!cellStyle || !("updateTableCellStyle" in cellStyle)) throw new Error("no quote cell style");
    const style = cellStyle.updateTableCellStyle.tableCellStyle;
    expect(style.borderLeft?.width.magnitude).toBe(3);
    expect([style.borderTop, style.borderRight, style.borderBottom].map((b) => b?.width.magnitude)).toEqual([0, 0, 0]);
    expect(cellStyle.updateTableCellStyle.fields.split(",")).toEqual(
      expect.arrayContaining(["borderLeft", "borderTop", "borderRight", "borderBottom", "paddingLeft"]),
    );

    expect(requests).toContainEqual({ insertText: { text: "quoted", location: { index: 4 } } });
  });

  test("a quote's column spans the page's content width", async () => {
    const client = await renderQuote("> quoted\n");
    const widths = client.batches
      .flat()
      .flatMap((r) =>
        "updateTableColumnProperties" in r ? [r.updateTableColumnProperties.tableColumnProperties.width.magnitude] : [],
      );
    expect(widths).toEqual([451.28]);
  });

  test("a list inside a quote is bulleted inside the quote's cell", async () => {
    const client = await renderQuote("> intro\n>\n> 1. first\n> 2. second\n");
    const bullets = client.batches.flat().flatMap((r) => ("createParagraphBullets" in r ? [r] : []));
    expect(bullets.map((b) => b.createParagraphBullets.range)).toEqual([{ startIndex: 10, endIndex: 23 }]);
  });

  test("a quote renders identically wherever it sits: at the top level, after a list, inside a list item", async () => {
    const quoteRequests = async (markdown: string) => {
      const client = await renderQuote(markdown);
      const quote = client.batches.flat().filter((r) => "insertTable" in r || "updateTableCellStyle" in r);
      const widths = client.batches.flat().filter((r) => "updateTableColumnProperties" in r);
      return JSON.parse(JSON.stringify([...quote, ...widths]).replace(/"index":\d+/g, '"index":0'));
    };
    const topLevel = await quoteRequests("> q\n");
    expect(await quoteRequests("- a\n\n> q\n")).toEqual(topLevel);
    expect(await quoteRequests("- a\n\n  > q\n")).toEqual(topLevel);
  });

  test("a quote inside a quote is a narrower one-cell table within the outer cell", async () => {
    const outerTable = (innerEnd: number): DocumentResource => ({
      documentStyle: A4,
      body: {
        content: [
          {
            startIndex: 2,
            endIndex: innerEnd + 2,
            table: {
              tableRows: [
                {
                  tableCells: [
                    {
                      startIndex: 3,
                      endIndex: innerEnd + 1,
                      content: [
                        { startIndex: 4, endIndex: 10 },
                        {
                          startIndex: 11,
                          endIndex: innerEnd,
                          table: {
                            tableRows: [{ tableCells: [{ startIndex: 12, content: [{ startIndex: 13 }] }] }],
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    const outerOnly: DocumentResource = {
      documentStyle: A4,
      body: {
        content: [
          {
            startIndex: 2,
            endIndex: 6,
            table: { tableRows: [{ tableCells: [{ startIndex: 3, content: [{ startIndex: 4, endIndex: 5 }] }] }] },
          },
        ],
      },
    };
    const client = new MockClient([outerOnly, outerTable(20), outerTable(20), outerTable(20)]);
    await executeDocument(client, "T", planDocument(parseMarkdown("> outer\n>\n> > inner\n")));

    const requests = client.batches.flat();
    const inserts = requests.flatMap((r) => ("insertTable" in r ? [r.insertTable.location.index] : []));
    expect(inserts).toEqual([1, 10]);
    const widths = requests.flatMap((r) =>
      "updateTableColumnProperties" in r ? [r.updateTableColumnProperties.tableColumnProperties.width.magnitude] : [],
    );
    expect(widths).toEqual([451.28, 443.28]);
    expect(client.getCalls).toBe(4);

    const spacer = requests.find((r) => "updateParagraphStyle" in r && r.updateParagraphStyle.range.startIndex === 20);
    expect(spacer && "updateParagraphStyle" in spacer ? spacer.updateParagraphStyle.range : undefined).toEqual({
      startIndex: 20,
      endIndex: 21,
    });
  });

  test("a quote after a quote is inserted where the first one ends", async () => {
    const client = await renderQuote("> first\n\n> second\n");
    const inserts = client.batches.flat().flatMap((r) => ("insertTable" in r ? [r.insertTable.location.index] : []));
    expect(inserts).toEqual([1, 6]);
  });
});

describe("updateDocument", () => {
  const populated: DocumentResource = {
    title: "Old title",
    body: { content: [{ startIndex: 1, endIndex: 30 }] },
  };

  test("reads the doc before any destructive call", async () => {
    const client = new MockClient([populated]);
    const segments = planDocument(parseMarkdown("# New\n\nBody.\n"));
    await updateDocument(client, "doc-x", "New", segments);
    expect(client.calls[0]).toBe("getDocument");
    expect(client.calls.indexOf("getDocument")).toBeLessThan(client.calls.indexOf("batchUpdate"));
  });

  test("clears the body: deletes content over [1, end-1] then resets the paragraph", async () => {
    const client = new MockClient([populated]);
    await updateDocument(client, "doc-x", "Old title", planDocument(parseMarkdown("Body.\n")));

    const clearBatch = client.batches[0] ?? [];
    const del = clearBatch.find((r) => "deleteContentRange" in r);
    expect(del).toEqual({ deleteContentRange: { range: { startIndex: 1, endIndex: 29 } } });
    const reset = clearBatch.find((r) => "updateParagraphStyle" in r);
    expect(reset).toBeDefined();
    expect(clearBatch.some((r) => "deleteParagraphBullets" in r)).toBe(true);
  });

  test("an already-empty body skips the delete but still resets the paragraph", async () => {
    const empty: DocumentResource = { title: "T", body: { content: [{ startIndex: 1, endIndex: 2 }] } };
    const client = new MockClient([empty]);
    await updateDocument(client, "doc-x", "T", planDocument(parseMarkdown("Body.\n")));

    const clearBatch = client.batches[0] ?? [];
    expect(clearBatch.some((r) => "deleteContentRange" in r)).toBe(false);
    expect(clearBatch.some((r) => "updateParagraphStyle" in r)).toBe(true);
    expect(clearBatch.some((r) => "deleteParagraphBullets" in r)).toBe(true);
  });

  test("renames the Drive file when the title changed", async () => {
    const client = new MockClient([populated]);
    await updateDocument(client, "doc-x", "New title", planDocument(parseMarkdown("Body.\n")));
    expect(client.renames).toEqual([{ id: "doc-x", name: "New title" }]);
    expect(client.calls.lastIndexOf("batchUpdate")).toBeLessThan(client.calls.indexOf("renameDocument"));
  });

  test("does not rename when the title is unchanged", async () => {
    const client = new MockClient([populated]);
    await updateDocument(client, "doc-x", "Old title", planDocument(parseMarkdown("Body.\n")));
    expect(client.renames).toHaveLength(0);
  });

  test("moves the doc into the given folder, before clearing", async () => {
    const client = new MockClient([populated]);
    await updateDocument(client, "doc-x", "Old title", planDocument(parseMarkdown("Body.\n")), "folder-9");
    expect(client.moves).toEqual([{ id: "doc-x", folderId: "folder-9" }]);
    expect(client.calls.indexOf("moveDocument")).toBeLessThan(client.calls.indexOf("batchUpdate"));
    expect(client.calls.indexOf("getDocument")).toBeLessThan(client.calls.indexOf("moveDocument"));
  });

  test("does not move when no folder is given", async () => {
    const client = new MockClient([populated]);
    await updateDocument(client, "doc-x", "Old title", planDocument(parseMarkdown("Body.\n")));
    expect(client.moves).toHaveLength(0);
  });
});
