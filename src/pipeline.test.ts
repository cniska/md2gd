import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { DocRequest, DocumentResource } from "./docs";
import type { DocsClient } from "./executor";
import { recordDoc } from "./mapping";
import { parseMarkdown } from "./parse";
import { convertFile, deriveTitle, parseDocId, resolveUpdateTarget, updateFile } from "./pipeline";

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

describe("parseDocId", () => {
  test("extracts the id from a full Docs edit URL", () => {
    expect(parseDocId("https://docs.google.com/document/d/1AbC_dEf-123/edit")).toBe("1AbC_dEf-123");
  });

  test("accepts a bare id unchanged", () => {
    expect(parseDocId("1AbC_dEf-123")).toBe("1AbC_dEf-123");
  });
});

describe("resolveUpdateTarget", () => {
  test("an explicit url/id argument wins over the mapping", async () => {
    const target = await resolveUpdateTarget(
      "doc.md",
      "https://docs.google.com/document/d/explicit/edit",
      "/nope.json",
    );
    expect(target).toBe("explicit");
  });

  test("with no argument, falls back to the file's remembered doc", async () => {
    const cfg = `${tmpdir()}/md2gd-resolve-${Date.now()}.json`;
    const md = `${tmpdir()}/resolve-${Date.now()}.md`;
    await Bun.write(md, "# R\n");
    await recordDoc(md, "doc-remembered", cfg);
    expect(await resolveUpdateTarget(md, undefined, cfg)).toBe("doc-remembered");
  });

  test("errors when nothing is remembered and no argument is given", async () => {
    const cfg = `${tmpdir()}/md2gd-none-${Date.now()}.json`;
    await expect(resolveUpdateTarget(`${tmpdir()}/unknown.md`, undefined, cfg)).rejects.toThrow(
      /no document remembered/,
    );
  });
});

describe("updateFile", () => {
  test("translates a drive.file 404 into an actionable message (FR-43)", async () => {
    class NotFoundClient extends StubClient {
      override getDocument(_id: string): Promise<DocumentResource> {
        return Promise.reject(new Error("md2gd: Google API GET failed (404): File not found"));
      }
    }
    const md = `${tmpdir()}/upd-404-${Date.now()}.md`;
    await Bun.write(md, "# R\n\nBody.\n");
    await expect(updateFile(md, {}, new NotFoundClient(), "doc-x")).rejects.toThrow(
      /can only update documents it created/,
    );
  });
});
