import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { DocRequest, DocumentResource } from "./docs";
import type { DocsClient } from "./executor";
import { recordDoc } from "./mapping";
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
    await expect(convertFile(`${tmpdir()}/nope-${Date.now()}.md`, {}, new StubClient())).rejects.toThrow(/not found/);
  });

  test("rejects an empty file", async () => {
    const path = `${tmpdir()}/md2gd-empty-${Date.now()}.md`;
    await Bun.write(path, "   \n");
    await expect(convertFile(path, {}, new StubClient())).rejects.toThrow(/empty/);
  });

  test("passes the parsed --folder id to createDocument (FR-27b)", async () => {
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

    // Capture the requests the linked run produces, so the live link is observable.
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
    await expect(convertFile(path, { links: `${tmpdir()}/no-such-map-${Date.now()}.json` }, client)).rejects.toThrow(
      /link map not found/,
    );
    expect(client.createCalls).toBe(0);
  });

  test("a malformed link map (not path→string) fails with an actionable message", async () => {
    const mapPath = `${tmpdir()}/md2gd-map-bad-${Date.now()}.json`;
    await Bun.write(mapPath, JSON.stringify({ "a.md": 5 }));
    const path = `${tmpdir()}/md2gd-map-bad-src-${Date.now()}.md`;
    await Bun.write(path, "# H\n\nBody.\n");
    await expect(convertFile(path, { links: mapPath }, new StubClient())).rejects.toThrow(/path → url/);
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
  test("translates a 404 on the read into an actionable message (FR-43)", async () => {
    class NotFoundClient extends StubClient {
      override getDocument(_id: string): Promise<DocumentResource> {
        return Promise.reject(new Error("md2gd: Google API GET failed (404): File not found"));
      }
    }
    const md = `${tmpdir()}/upd-404-${Date.now()}.md`;
    await Bun.write(md, "# R\n\nBody.\n");
    await expect(updateFile(md, {}, new NotFoundClient(), "doc-x")).rejects.toThrow(
      /cannot open document .* for update/,
    );
  });

  test("translates a 403 on the read into the same actionable message (FR-43)", async () => {
    class ForbiddenClient extends StubClient {
      override getDocument(_id: string): Promise<DocumentResource> {
        return Promise.reject(new Error("md2gd: Google API GET failed (403): insufficient permission"));
      }
    }
    const md = `${tmpdir()}/upd-403-${Date.now()}.md`;
    await Bun.write(md, "# R\n\nBody.\n");
    await expect(updateFile(md, {}, new ForbiddenClient(), "doc-x")).rejects.toThrow(
      /cannot open document .* for update/,
    );
  });

  test("records the file→doc mapping so a later no-arg update finds it (FR-42)", async () => {
    const cfg = `${tmpdir()}/md2gd-adopt-${Date.now()}.json`;
    const md = `${tmpdir()}/adopt-${Date.now()}.md`;
    await Bun.write(md, "# R\n\nBody.\n");
    // Simulates adopting an explicitly-targeted doc: update once, then a no-arg
    // update resolves to that same doc without re-passing the URL.
    await updateFile(md, {}, new StubClient(), "adopted-doc", cfg);
    expect(await resolveUpdateTarget(md, undefined, cfg)).toBe("adopted-doc");
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

  test("does not record when the update fails at the read", async () => {
    class NotFoundClient extends StubClient {
      override getDocument(_id: string): Promise<DocumentResource> {
        return Promise.reject(new Error("md2gd: Google API GET failed (404): File not found"));
      }
    }
    const cfg = `${tmpdir()}/md2gd-noadopt-${Date.now()}.json`;
    const md = `${tmpdir()}/noadopt-${Date.now()}.md`;
    await Bun.write(md, "# R\n\nBody.\n");
    await expect(updateFile(md, {}, new NotFoundClient(), "missing", cfg)).rejects.toThrow();
    await expect(resolveUpdateTarget(md, undefined, cfg)).rejects.toThrow(/no document remembered/);
  });
});
