import { describe, expect, test } from "bun:test";
import { documentUrl, GoogleDocsClient } from "./google";
import type { FetchFn } from "./oauth";

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** Records each call and replies with the next queued JSON body. */
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
  test("creates the doc, creates the folder when absent, and moves the doc into it", async () => {
    const { calls, fetchFn } = recorder([
      { documentId: "doc9" }, // create doc
      { files: [] }, // folder search: none
      { id: "folder1" }, // folder create
      { id: "doc9" }, // move
    ]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });

    const result = await client.createDocument("My Title");
    expect(result.documentId).toBe("doc9");
    expect(calls[0]).toMatchObject({ method: "POST", body: { title: "My Title" } });
    expect(calls[1]?.method).toBe("GET"); // folder search
    expect(calls[2]).toMatchObject({ method: "POST", body: { mimeType: "application/vnd.google-apps.folder" } });
    expect(calls[3]?.method).toBe("PATCH");
    expect(calls[3]?.url).toContain("addParents=folder1");
  });

  test("reuses an existing folder without creating a new one", async () => {
    const { calls, fetchFn } = recorder([{ documentId: "d" }, { files: [{ id: "existing" }] }, { id: "d" }]);
    const client = new GoogleDocsClient({ getToken: token, fetchFn });
    await client.createDocument("T");
    // No folder-create POST: create-doc, folder-search, move.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.at(-1)?.url).toContain("addParents=existing");
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
