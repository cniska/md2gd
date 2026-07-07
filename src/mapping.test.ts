import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { canonicalPath, lookupDoc, recordDoc } from "./mapping";

function tmpConfig(tag: string): string {
  return `${tmpdir()}/md2gd-map-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
}

describe("mapping store", () => {
  test("records a file→doc mapping and looks it up", async () => {
    const cfg = tmpConfig("roundtrip");
    const md = `${tmpdir()}/report-${Date.now()}.md`;
    await Bun.write(md, "# R\n");

    await recordDoc(md, "doc-123", cfg);
    expect(await lookupDoc(md, cfg)).toBe("doc-123");
  });

  test("returns undefined for an unknown file", async () => {
    const cfg = tmpConfig("unknown");
    await recordDoc(`${tmpdir()}/a-${Date.now()}.md`, "doc-a", cfg);
    expect(await lookupDoc(`${tmpdir()}/b-${Date.now()}.md`, cfg)).toBeUndefined();
  });

  test("returns undefined when no config file exists yet", async () => {
    expect(await lookupDoc(`${tmpdir()}/whatever.md`, tmpConfig("missing"))).toBeUndefined();
  });

  test("a later record overwrites the same file's mapping", async () => {
    const cfg = tmpConfig("overwrite");
    const md = `${tmpdir()}/re-${Date.now()}.md`;
    await Bun.write(md, "# R\n");

    await recordDoc(md, "doc-old", cfg);
    await recordDoc(md, "doc-new", cfg);
    expect(await lookupDoc(md, cfg)).toBe("doc-new");
  });

  test("preserves unrelated config keys when writing", async () => {
    const cfg = tmpConfig("preserve");
    await Bun.write(cfg, JSON.stringify({ defaultTitle: "keepme", docs: {} }));
    const md = `${tmpdir()}/p-${Date.now()}.md`;
    await Bun.write(md, "# R\n");

    await recordDoc(md, "doc-p", cfg);
    const written = JSON.parse(await Bun.file(cfg).text());
    expect(written.defaultTitle).toBe("keepme");
    expect(await lookupDoc(md, cfg)).toBe("doc-p");
  });

  test("a corrupt config is treated as empty, not fatal", async () => {
    const cfg = tmpConfig("corrupt");
    await Bun.write(cfg, "{ not valid json");
    expect(await lookupDoc(`${tmpdir()}/x.md`, cfg)).toBeUndefined();
  });

  test("canonicalPath expands a leading ~", async () => {
    const home = process.env.HOME ?? "";
    expect(await canonicalPath("~/some/nonexistent/file.md")).toBe(`${home}/some/nonexistent/file.md`);
  });
});
