import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { DocRequest, DocumentResource } from "./docs";
import type { DocsClient } from "./executor";
import { parseMarkdown } from "./parse";
import { convertFile, deriveTitle } from "./pipeline";

describe("deriveTitle", () => {
  test("uses the first H1 when present", () => {
    expect(deriveTitle(parseMarkdown("# Quarterly Report\n\nBody\n"), "/x/doc.md")).toBe("Quarterly Report");
  });

  test("falls back to the filename without extension", () => {
    expect(deriveTitle(parseMarkdown("Body only\n"), "/x/due-diligence.md")).toBe("due-diligence");
  });
});

class StubClient implements DocsClient {
  createDocument(_title: string): Promise<{ documentId: string }> {
    return Promise.resolve({ documentId: "doc-x" });
  }
  batchUpdate(_id: string, _requests: DocRequest[]): Promise<void> {
    return Promise.resolve();
  }
  getDocument(_id: string): Promise<DocumentResource> {
    return Promise.resolve({ body: { content: [] } });
  }
  renameDocument(_id: string, _name: string): Promise<void> {
    return Promise.resolve();
  }
}

describe("convertFile", () => {
  test("converts an existing file and returns the document id", async () => {
    const path = `${tmpdir()}/md2gd-pipe-${Date.now()}.md`;
    await Bun.write(path, "# Hello\n\nWorld.\n");
    expect(await convertFile(path, {}, new StubClient())).toBe("doc-x");
  });

  test("rejects a missing file", async () => {
    await expect(convertFile(`${tmpdir()}/nope-${Date.now()}.md`, {}, new StubClient())).rejects.toThrow(/not found/);
  });

  test("rejects an empty file", async () => {
    const path = `${tmpdir()}/md2gd-empty-${Date.now()}.md`;
    await Bun.write(path, "   \n");
    await expect(convertFile(path, {}, new StubClient())).rejects.toThrow(/empty/);
  });
});
