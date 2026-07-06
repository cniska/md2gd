import { describe, expect, test } from "bun:test";
import type { DocRequest, DocumentResource } from "./docs";
import { executeDocument } from "./executor";
import { parseMarkdown } from "./parse";
import { planDocument } from "./plan";

/** Records calls; returns queued getDocument responses in order. */
class MockClient {
  batches: DocRequest[][] = [];
  getCalls = 0;
  constructor(private readonly getResponses: DocumentResource[] = []) {}

  createDocument(_title: string): Promise<{ documentId: string }> {
    return Promise.resolve({ documentId: "doc-1" });
  }
  batchUpdate(_id: string, requests: DocRequest[]): Promise<void> {
    this.batches.push(requests);
    return Promise.resolve();
  }
  getDocument(_id: string): Promise<DocumentResource> {
    const response = this.getResponses[this.getCalls] ?? { body: { content: [] } };
    this.getCalls++;
    return Promise.resolve(response);
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

    // Cell fills are inserted in descending index order (last cell first).
    const inserts = styleFill.filter((r): r is Extract<DocRequest, { insertText: unknown }> => "insertText" in r);
    const indices = inserts.map((r) => r.insertText.location.index);
    expect(indices).toEqual([...indices].sort((a, b) => b - a));
    // Highest-index cell (14) is filled before the lowest (3).
    expect(indices[0]).toBe(14);
    expect(indices.at(-1)).toBe(3);
  });
});
