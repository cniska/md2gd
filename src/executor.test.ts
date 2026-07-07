import { describe, expect, test } from "bun:test";
import type { DocRequest, DocumentResource } from "./docs";
import { executeDocument, updateDocument } from "./executor";
import { parseMarkdown } from "./parse";
import { planDocument } from "./plan";

/** Records calls in order; returns queued getDocument responses in order. */
class MockClient {
  batches: DocRequest[][] = [];
  getCalls = 0;
  renames: { id: string; name: string }[] = [];
  /** Ordered log of side-effecting calls, to assert read-before-destroy. */
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
    // GET #1: the inserted 2x2 table with known cell content indices.
    // GET #2: end-of-body lookup after fills.
    const tableGet: DocumentResource = {
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
    const endGet: DocumentResource = { body: { content: [{ startIndex: 1, endIndex: 60 }] } };
    const client = new MockClient([tableGet, endGet]);

    const md = "| H1 | H2 |\n|---|---|\n| a | b |\n";
    await executeDocument(client, "T", planDocument(parseMarkdown(md)));

    // insertTable batch, then the style+fill batch.
    expect(client.batches).toHaveLength(2);
    expect(client.batches[0]?.[0]).toHaveProperty("insertTable");

    const styleFill = client.batches[1] ?? [];
    // Column widths (one per column), padding (whole table), header shading.
    expect(styleFill.filter((r) => "updateTableColumnProperties" in r)).toHaveLength(2);
    expect(styleFill.some((r) => "updateTableCellStyle" in r && r.updateTableCellStyle.tableStartLocation)).toBe(true);
    expect(styleFill.some((r) => "updateTableCellStyle" in r && r.updateTableCellStyle.tableRange)).toBe(true);
    // Rows are set not to split across page breaks.
    expect(
      styleFill.some((r) => "updateTableRowStyle" in r && r.updateTableRowStyle.tableRowStyle.preventOverflow),
    ).toBe(true);

    // Cell fills are inserted in descending index order (last cell first).
    const inserts = styleFill.filter((r): r is Extract<DocRequest, { insertText: unknown }> => "insertText" in r);
    const indices = inserts.map((r) => r.insertText.location.index);
    expect(indices).toEqual([...indices].sort((a, b) => b - a));
    // Highest-index cell (14) is filled before the lowest (3).
    expect(indices[0]).toBe(14);
    expect(indices.at(-1)).toBe(3);
  });

  test("the injected paragraph before a table is pinned to a thin spacer", async () => {
    // A table not at the body start (startIndex 5) has a preceding paragraph at [4,5).
    const tableGet: DocumentResource = {
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
    const endGet: DocumentResource = { body: { content: [{ startIndex: 1, endIndex: 40 }] } };
    const client = new MockClient([tableGet, endGet]);
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

describe("updateDocument", () => {
  /** A populated body spanning [1, 30) — endIndex 30 means content ends at 29. */
  const populated: DocumentResource = {
    title: "Old title",
    body: { content: [{ startIndex: 1, endIndex: 30 }] },
  };

  test("reads the doc before any destructive call (FR-39)", async () => {
    const client = new MockClient([populated]);
    const segments = planDocument(parseMarkdown("# New\n\nBody.\n"));
    await updateDocument(client, "doc-x", "New", segments);
    // The very first call must be the read.
    expect(client.calls[0]).toBe("getDocument");
    expect(client.calls.indexOf("getDocument")).toBeLessThan(client.calls.indexOf("batchUpdate"));
  });

  test("clears the body: deletes content over [1, end-1] then resets the paragraph", async () => {
    const client = new MockClient([populated]);
    await updateDocument(client, "doc-x", "Old title", planDocument(parseMarkdown("Body.\n")));

    const clearBatch = client.batches[0] ?? [];
    const del = clearBatch.find((r) => "deleteContentRange" in r);
    expect(del).toEqual({ deleteContentRange: { range: { startIndex: 1, endIndex: 29 } } });
    // The surviving paragraph is reset to NORMAL_TEXT and stripped of bullets.
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
    // Rename happens only after the body is filled.
    expect(client.calls.lastIndexOf("batchUpdate")).toBeLessThan(client.calls.indexOf("renameDocument"));
  });

  test("does not rename when the title is unchanged", async () => {
    const client = new MockClient([populated]);
    await updateDocument(client, "doc-x", "Old title", planDocument(parseMarkdown("Body.\n")));
    expect(client.renames).toHaveLength(0);
  });
});
