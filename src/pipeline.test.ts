import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { DocRequest, DocumentResource } from "./docs";
import type { DocsClient } from "./executor";
import { GoogleDocsClient } from "./google";
import { loadConfig, recordDoc } from "./mapping";
import { parseMarkdown } from "./parse";
import { convertFile, deriveTitle, parseDocId, parseFolderId, resolveUpdateTarget, updateFile } from "./pipeline";

describe("deriveTitle", () => {
  test("uses the first H1 when present", () => {
    expect(deriveTitle(parseMarkdown("# Quarterly Report\n\nBody\n"), "/x/doc.md")).toBe("Quarterly Report");
  });

  test("falls back to the title-cased filename, splitting on - and _", () => {
    expect(deriveTitle(parseMarkdown("Body only\n"), "/x/due-diligence.md")).toBe("Due Diligence");
    expect(deriveTitle(parseMarkdown("Body only\n"), "/x/service_readiness_review.md")).toBe(
      "Service Readiness Review",
    );
    expect(deriveTitle(parseMarkdown("Body only\n"), "/x/schema.md")).toBe("Schema");
  });

  test("preserves acronym casing in the filename fallback", () => {
    expect(deriveTitle(parseMarkdown("Body only\n"), "/x/API-reference.md")).toBe("API Reference");
  });
});

class StubClient implements DocsClient {
  lastFolderId?: string;
  createCalls = 0;
  createDocument(_title: string, folderId?: string): Promise<{ documentId: string }> {
    this.createCalls++;
    this.lastFolderId = folderId;
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
  movedTo?: string;
  moveDocument(_id: string, folderId: string): Promise<void> {
    this.movedTo = folderId;
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
    const path = `${tmpdir()}/nope-${Date.now()}.md`;
    await expect(convertFile(path, {}, new StubClient())).rejects.toThrow(
      expect.objectContaining({ code: "file_not_found", kind: "refusal", meta: { path } }),
    );
  });

  test("rejects an empty file", async () => {
    const path = `${tmpdir()}/md2gd-empty-${Date.now()}.md`;
    await Bun.write(path, "   \n");
    await expect(convertFile(path, {}, new StubClient())).rejects.toThrow(
      expect.objectContaining({ code: "file_empty", meta: { path } }),
    );
  });

  test("passes the parsed --folder id to createDocument", async () => {
    const path = `${tmpdir()}/md2gd-folder-${Date.now()}.md`;
    await Bun.write(path, "# Hello\n\nWorld.\n");
    const client = new StubClient();
    await convertFile(path, { folder: "https://drive.google.com/drive/folders/FOLDER123" }, client);
    expect(client.lastFolderId).toBe("FOLDER123");
  });

  test("defaults to no folder id when --folder is absent", async () => {
    const path = `${tmpdir()}/md2gd-nofolder-${Date.now()}.md`;
    await Bun.write(path, "# Hello\n\nWorld.\n");
    const client = new StubClient();
    await convertFile(path, {}, client);
    expect(client.lastFolderId).toBeUndefined();
  });

  test("with --links, a relative cross-doc link is inserted as a live Doc link", async () => {
    const stamp = `${Date.now()}`;
    const dir = `${tmpdir()}/md2gd-links-${stamp}`;
    await Bun.write(
      `${dir}/docs-map.json`,
      JSON.stringify({ "docs/schema.md": "https://docs.google.com/document/d/SCHEMA" }),
    );
    const src = `${dir}/docs/architecture.md`;
    await Bun.write(src, "# Arch\n\nSee the [schema](schema.md).\n");

    class Recorder extends StubClient {
      requests: DocRequest[] = [];
      override batchUpdate(_id: string, requests: DocRequest[]): Promise<void> {
        this.requests.push(...requests);
        return Promise.resolve();
      }
    }
    const client = new Recorder();
    let stats: { rewritten: number } | undefined;
    await convertFile(src, { links: `${dir}/docs-map.json`, onLinks: (s) => (stats = s) }, client);

    expect(stats?.rewritten).toBe(1);
    const linked = client.requests.some(
      (r) =>
        "updateTextStyle" in r && r.updateTextStyle.textStyle.link?.url === "https://docs.google.com/document/d/SCHEMA",
    );
    expect(linked).toBe(true);
  });

  test("a missing link map fails before writing anything", async () => {
    const path = `${tmpdir()}/md2gd-badmap-${Date.now()}.md`;
    await Bun.write(path, "# H\n\nBody.\n");
    const client = new StubClient();
    const links = `${tmpdir()}/no-such-map-${Date.now()}.json`;
    await expect(convertFile(path, { links }, client)).rejects.toThrow(
      expect.objectContaining({ code: "link_map_not_found", meta: { path: links } }),
    );
    expect(client.createCalls).toBe(0);
  });

  test("a malformed link map (not path→string) fails with an actionable message", async () => {
    const mapPath = `${tmpdir()}/md2gd-map-bad-${Date.now()}.json`;
    await Bun.write(mapPath, JSON.stringify({ "a.md": 5 }));
    const path = `${tmpdir()}/md2gd-map-bad-src-${Date.now()}.md`;
    await Bun.write(path, "# H\n\nBody.\n");
    await expect(convertFile(path, { links: mapPath }, new StubClient())).rejects.toThrow(
      expect.objectContaining({
        code: "link_map_invalid",
        meta: { path: mapPath, problem: "a.md: Invalid input: expected string, received number" },
      }),
    );
  });

  test("a link map that is not JSON fails as unparsed", async () => {
    const mapPath = `${tmpdir()}/md2gd-map-nojson-${Date.now()}.json`;
    await Bun.write(mapPath, "{ nope");
    const path = `${tmpdir()}/md2gd-map-nojson-src-${Date.now()}.md`;
    await Bun.write(path, "# H\n\nBody.\n");
    await expect(convertFile(path, { links: mapPath }, new StubClient())).rejects.toThrow(
      expect.objectContaining({ code: "link_map_unparsed", meta: { path: mapPath } }),
    );
  });

  test("rejects an unreadable file with a message naming it", async () => {
    const path = `${tmpdir()}/md2gd-locked-${Date.now()}.md`;
    await Bun.write(path, "# Locked\n");
    chmodSync(path, 0o000);
    const client = new StubClient();
    await expect(convertFile(path, {}, client)).rejects.toThrow(
      expect.objectContaining({
        code: "file_unreadable",
        meta: { path, reason: "permission denied" },
        cause: expect.objectContaining({ code: "EACCES" }),
      }),
    );
    expect(client.createCalls).toBe(0);
    rmSync(path);
  });

  test("rejects an unreadable link map with a message naming it", async () => {
    const mapPath = `${tmpdir()}/md2gd-locked-map-${Date.now()}.json`;
    await Bun.write(mapPath, "{}");
    chmodSync(mapPath, 0o000);
    const path = `${tmpdir()}/md2gd-locked-map-src-${Date.now()}.md`;
    await Bun.write(path, "# H\n\nBody.\n");
    const client = new StubClient();
    await expect(convertFile(path, { links: mapPath }, client)).rejects.toThrow(
      expect.objectContaining({ code: "link_map_unreadable", meta: { path: mapPath, reason: "permission denied" } }),
    );
    expect(client.createCalls).toBe(0);
    rmSync(mapPath);
  });

  test("converts text whatever its file extension", async () => {
    for (const name of ["notes.txt", "NOTES"]) {
      const path = `${tmpdir()}/md2gd-ext-${Date.now()}-${name}`;
      await Bun.write(path, "# Notes\n\nBody.\n");
      expect(await convertFile(path, {}, new StubClient())).toBe("doc-x");
    }
  });

  test("rejects a file holding a NUL byte as non-Markdown", async () => {
    const path = `${tmpdir()}/md2gd-nul-${Date.now()}.md`;
    await Bun.write(path, "# Title\0\n");
    const client = new StubClient();
    await expect(convertFile(path, {}, client)).rejects.toThrow(
      expect.objectContaining({ code: "file_not_markdown", meta: { path } }),
    );
    expect(client.createCalls).toBe(0);
  });

  test("rejects a file that is not valid UTF-8 as non-Markdown", async () => {
    const path = `${tmpdir()}/md2gd-latin-${Date.now()}.md`;
    await Bun.write(path, new Uint8Array([0x23, 0x20, 0xc3, 0x28]));
    const client = new StubClient();
    await expect(convertFile(path, {}, client)).rejects.toThrow(
      expect.objectContaining({ code: "file_not_markdown", meta: { path } }),
    );
    expect(client.createCalls).toBe(0);
  });

  test("rejects a directory with a message naming it", async () => {
    const dir = `${tmpdir()}/md2gd-dir-${Date.now()}`;
    mkdirSync(dir);
    const client = new StubClient();
    await expect(convertFile(dir, {}, client)).rejects.toThrow(
      expect.objectContaining({ code: "file_unreadable", meta: { path: dir, reason: "is a directory" } }),
    );
    expect(client.createCalls).toBe(0);
  });
});

describe("parseFolderId", () => {
  test("extracts the id from a Drive folder URL", () => {
    expect(parseFolderId("https://drive.google.com/drive/folders/1QzE1-xPW_zbF?usp=sharing")).toBe("1QzE1-xPW_zbF");
  });

  test("accepts a bare id unchanged", () => {
    expect(parseFolderId("1QzE1-xPW_zbF")).toBe("1QzE1-xPW_zbF");
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
    const target = await resolveUpdateTarget("doc.md", "https://docs.google.com/document/d/explicit/edit", {
      docs: {},
    });
    expect(target).toBe("explicit");
  });

  test("with no argument, falls back to the file's remembered doc", async () => {
    const cfg = `${tmpdir()}/md2gd-resolve-${Date.now()}.json`;
    const md = `${tmpdir()}/resolve-${Date.now()}.md`;
    await Bun.write(md, "# R\n");
    await recordDoc(md, "doc-remembered", cfg);
    expect(await resolveUpdateTarget(md, undefined, await loadConfig(cfg))).toBe("doc-remembered");
  });

  test("names a path that needs quoting in its resolve as one shell word", async () => {
    const cfg = `${tmpdir()}/md2gd-none-q-${Date.now()}.json`;
    await expect(resolveUpdateTarget("my notes.md", undefined, await loadConfig(cfg))).rejects.toThrow(
      expect.objectContaining({ resolve: "md2gd 'my notes.md' --update <url|id>" }),
    );
  });

  test("errors when nothing is remembered and no argument is given", async () => {
    const cfg = `${tmpdir()}/md2gd-none-${Date.now()}.json`;
    const path = `${tmpdir()}/unknown.md`;
    await expect(resolveUpdateTarget(path, undefined, await loadConfig(cfg))).rejects.toThrow(
      expect.objectContaining({ code: "no_document_remembered", kind: "refusal", meta: { path } }),
    );
  });
});

class InaccessibleClient extends StubClient {
  batchUpdates = 0;
  private readonly google = new GoogleDocsClient({
    getToken: () => Promise.resolve("tok"),
    fetchFn: () =>
      Promise.resolve(Response.json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, { status: 404 })),
  });
  override getDocument(id: string): Promise<DocumentResource> {
    return this.google.getDocument(id);
  }
  override batchUpdate(_id: string, _requests: DocRequest[]): Promise<void> {
    this.batchUpdates++;
    return Promise.resolve();
  }
}

describe("updateFile", () => {
  test("refuses a target the read cannot open before writing to it", async () => {
    const md = `${tmpdir()}/upd-404-${Date.now()}.md`;
    await Bun.write(md, "# R\n\nBody.\n");
    const client = new InaccessibleClient();
    await expect(updateFile(md, { folder: "DEST9" }, client, "doc-x")).rejects.toThrow(
      expect.objectContaining({ code: "document_inaccessible" }),
    );
    expect(client.batchUpdates).toBe(0);
    expect(client.movedTo).toBeUndefined();
  });

  test("moves the doc when --folder is given on update (relocate)", async () => {
    const md = `${tmpdir()}/relocate-${Date.now()}.md`;
    await Bun.write(md, "# R\n\nBody.\n");
    const client = new StubClient();
    await updateFile(md, { folder: "https://drive.google.com/drive/folders/DEST9" }, client, "doc-x");
    expect(client.movedTo).toBe("DEST9");
  });

  test("does not move when --folder is absent on update", async () => {
    const md = `${tmpdir()}/norelocate-${Date.now()}.md`;
    await Bun.write(md, "# R\n\nBody.\n");
    const client = new StubClient();
    await updateFile(md, {}, client, "doc-x");
    expect(client.movedTo).toBeUndefined();
  });
});
