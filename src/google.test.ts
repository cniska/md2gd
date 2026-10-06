import { describe, expect, test } from "bun:test";
import { documentUrl, GoogleDocsClient } from "./google";
import type { FetchFn } from "./http";

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function recorder(responses: unknown[]): { calls: Call[]; fetchFn: FetchFn } {
  const calls: Call[] = [];
  let i = 0;
  const fetchFn: FetchFn = (url, init) => {
    calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const body = responses[i++] ?? {};
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  return { calls, fetchFn };
}

const token = () => Promise.resolve("tok");

describe("documentUrl", () => {
  test("builds an edit url from the document id", () => {
    expect(documentUrl("abc123")).toBe("https://docs.google.com/document/d/abc123/edit");
  });
});

describe("GoogleDocsClient.createDocument", () => {
  test("creates the folder when absent, then creates the doc inside it", async () => {
    const { calls, fetchFn } = recorder([{ files: [] }, { id: "folder1" }, { id: "doc9" }]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });

    const result = await client.createDocument("My Title");
    expect(result.documentId).toBe("doc9");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]).toMatchObject({ method: "POST", body: { mimeType: "application/vnd.google-apps.folder" } });
    expect(calls[2]).toMatchObject({
      method: "POST",
      body: { name: "My Title", mimeType: "application/vnd.google-apps.document", parents: ["folder1"] },
    });
  });

  test("reuses an existing folder without creating a new one", async () => {
    const { calls, fetchFn } = recorder([{ files: [{ id: "existing" }] }, { id: "d" }]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    await client.createDocument("T");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.at(-1)?.body).toMatchObject({ parents: ["existing"] });
  });

  test("uses a given folder id directly, skipping the default-folder lookup", async () => {
    const { calls, fetchFn } = recorder([{ id: "docInFolder" }]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    const result = await client.createDocument("T", "chosen-folder");
    expect(result.documentId).toBe("docInFolder");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", body: { parents: ["chosen-folder"] } });
  });

  test("wraps a failure creating in a given folder with an actionable message", async () => {
    const fetchFn: FetchFn = () =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: "File not found: x." } }), { status: 404 }));
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    await expect(client.createDocument("T", "bad-folder")).rejects.toThrow(/cannot create in folder bad-folder/);
  });
});

describe("GoogleDocsClient.moveDocument", () => {
  test("reads current parents, then reparents via addParents/removeParents", async () => {
    const { calls, fetchFn } = recorder([{ parents: ["oldFolder"] }, {}]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    await client.moveDocument("doc9", "newFolder");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.url).toContain("addParents=newFolder");
    expect(calls[1]?.url).toContain("removeParents=oldFolder");
  });

  test("wraps a move into an inaccessible folder with an actionable message", async () => {
    let call = 0;
    const fetchFn: FetchFn = () => {
      call++;
      const status = call === 1 ? 200 : 404;
      const body = call === 1 ? { parents: ["old"] } : { error: { message: "File not found." } };
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    };
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    await expect(client.moveDocument("doc9", "bad")).rejects.toThrow(/cannot move into folder bad/);
  });
});

describe("shared drive reachability", () => {
  test("creating in a given folder declares shared-drive support", async () => {
    const { calls, fetchFn } = recorder([{ id: "d" }]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    await client.createDocument("T", "shared-drive-folder");
    expect(calls[0]?.url).toContain("supportsAllDrives=true");
  });

  test("renaming declares shared-drive support", async () => {
    const { calls, fetchFn } = recorder([{}]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    await client.renameDocument("doc9", "New name");
    expect(calls[0]?.url).toContain("supportsAllDrives=true");
  });

  test("both calls of a move declare shared-drive support", async () => {
    const { calls, fetchFn } = recorder([{ parents: ["old"] }, {}]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    await client.moveDocument("doc9", "newFolder");
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.url).toContain("supportsAllDrives=true");
  });
});

describe("GoogleDocsClient.batchUpdate", () => {
  test("posts requests to the batchUpdate endpoint with a bearer token", async () => {
    const { calls, fetchFn } = recorder([{}]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    await client.batchUpdate("doc9", [{ insertText: { text: "x", location: { index: 1 } } }]);
    expect(calls[0]?.url).toContain("doc9:batchUpdate");
    expect(calls[0]).toMatchObject({ method: "POST", body: { requests: [{ insertText: { text: "x" } }] } });
  });

  test("throws on a non-ok response", async () => {
    const fetchFn: FetchFn = () => Promise.resolve(new Response("nope", { status: 403 }));
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    await expect(client.batchUpdate("d", [])).rejects.toThrow(/failed \(403\)/);
  });
});

describe("GoogleDocsClient retries", () => {
  const noWait = () => Promise.resolve();

  test("retries a transient server error on a read and carries on", async () => {
    let call = 0;
    const fetchFn: FetchFn = () =>
      Promise.resolve(call++ === 0 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 200 }));
    const client = new GoogleDocsClient({ getToken: token, fetchFn, sleep: noWait });
    await client.getDocument("doc");
    expect(call).toBe(2);
  });

  test("reports Drive's lasting 403 rate limiting as rate limiting, not a permission problem", async () => {
    const body = JSON.stringify({ error: { message: "Rate limit", errors: [{ reason: "rateLimitExceeded" }] } });
    const fetchFn: FetchFn = () => Promise.resolve(new Response(body, { status: 403 }));
    const client = new GoogleDocsClient({ getToken: token, fetchFn, sleep: noWait });
    await expect(client.createDocument("T", "folder-1")).rejects.toThrow(
      "md2gd: Google API rate limit reached — wait a minute and try again",
    );
  });

  test("reports lasting rate limiting as a clear message, not a raw API error", async () => {
    const fetchFn: FetchFn = () => Promise.resolve(new Response("{}", { status: 429 }));
    const client = new GoogleDocsClient({ getToken: token, fetchFn, sleep: noWait });
    await expect(client.batchUpdate("doc", [])).rejects.toThrow(
      "md2gd: Google API rate limit reached — wait a minute and try again",
    );
  });
});

describe("GoogleDocsClient responses", () => {
  test("rejects a response missing what md2gd reads, with a clear message", async () => {
    const { fetchFn } = recorder([{ files: [{ id: "folder" }] }, { name: "no id here" }]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    await expect(client.createDocument("T")).rejects.toThrow(
      "md2gd: unexpected response from Google API POST /drive/v3/files (id:",
    );
  });

  test("reports a body that isn't JSON as an unexpected response, not a parse crash", async () => {
    const fetchFn: FetchFn = () => Promise.resolve(new Response("<html>oops</html>", { status: 200 }));
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    await expect(client.getDocument("d")).rejects.toThrow("md2gd: unexpected response from Google API GET");
  });

  test("accepts a real-shaped document, whose default values the API leaves out", async () => {
    const cell = (start: number, text: string) => ({
      startIndex: start,
      endIndex: start + text.length + 2,
      content: [
        {
          startIndex: start + 1,
          endIndex: start + text.length + 2,
          paragraph: { elements: [{ startIndex: start + 1, textRun: { content: `${text}\n`, textStyle: {} } }] },
        },
      ],
      tableCellStyle: { rowSpan: 1, columnSpan: 1, contentAlignment: "TOP" },
    });
    const document = {
      title: "Report",
      documentId: "d",
      revisionId: "r",
      documentStyle: {
        pageSize: { width: { magnitude: 612, unit: "PT" }, height: { magnitude: 792, unit: "PT" } },
        marginLeft: { magnitude: 72, unit: "PT" },
        marginRight: { unit: "PT" },
        marginTop: { magnitude: 72, unit: "PT" },
      },
      body: {
        content: [
          { endIndex: 1, sectionBreak: { sectionStyle: { columnSeparatorStyle: "NONE" } } },
          {
            startIndex: 1,
            endIndex: 2,
            paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: "\n", textStyle: {} } }] },
          },
          {
            startIndex: 2,
            endIndex: 14,
            table: {
              rows: 1,
              columns: 2,
              tableRows: [{ startIndex: 3, endIndex: 13, tableCells: [cell(4, "A"), cell(8, "")] }],
              tableStyle: { tableColumnProperties: [{ widthType: "EVENLY_DISTRIBUTED" }] },
            },
          },
        ],
      },
      headers: { h1: { headerId: "h1", content: [] } },
    };
    const { fetchFn } = recorder([document]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    const doc = await client.getDocument("d");
    expect(doc.documentStyle?.marginRight?.magnitude).toBeUndefined();
    expect(doc.body?.content[0]?.startIndex).toBeUndefined();
    expect(doc.body?.content[2]?.table?.tableRows[0]?.tableCells[1]?.content[0]?.startIndex).toBe(9);
  });

  test("keeps fields the API adds beyond what md2gd reads", async () => {
    const { fetchFn } = recorder([{ title: "T", revisionId: "r1", body: { content: [{ endIndex: 2 }] } }]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    expect(await client.getDocument("d")).toMatchObject({ title: "T", revisionId: "r1" });
  });
});
