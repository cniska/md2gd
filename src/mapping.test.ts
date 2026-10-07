import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig, lookupDoc, recordDoc } from "./mapping";

function tmpConfig(tag: string): string {
  return `${tmpdir()}/md2gd-map-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
}

async function markdown(tag: string): Promise<string> {
  const md = `${tmpdir()}/md2gd-map-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`;
  await Bun.write(md, "# R\n");
  return md;
}

describe("mapping store", () => {
  test("records a file→doc mapping and looks it up", async () => {
    const cfg = tmpConfig("roundtrip");
    const md = await markdown("roundtrip");

    await recordDoc(md, "doc-123", cfg);
    expect(await lookupDoc(await loadConfig(cfg), md)).toBe("doc-123");
  });

  test("returns null for an unknown file", async () => {
    const cfg = tmpConfig("unknown");
    await recordDoc(await markdown("a"), "doc-a", cfg);
    expect(await lookupDoc(await loadConfig(cfg), await markdown("b"))).toBeNull();
  });

  test("loads an empty config when no config file exists yet", async () => {
    expect(await loadConfig(tmpConfig("missing"))).toEqual({ docs: {} });
  });

  test("a later record overwrites the same file's mapping", async () => {
    const cfg = tmpConfig("overwrite");
    const md = await markdown("overwrite");

    await recordDoc(md, "doc-old", cfg);
    await recordDoc(md, "doc-new", cfg);
    expect(await lookupDoc(await loadConfig(cfg), md)).toBe("doc-new");
  });

  test("preserves unrelated config keys when writing", async () => {
    const cfg = tmpConfig("preserve");
    await Bun.write(cfg, JSON.stringify({ defaultTitle: "keepme", docs: {} }));
    const md = await markdown("preserve");

    await recordDoc(md, "doc-p", cfg);
    const written = JSON.parse(await Bun.file(cfg).text());
    expect(written.defaultTitle).toBe("keepme");
    expect(await lookupDoc(await loadConfig(cfg), md)).toBe("doc-p");
  });

  test("a record keeps a mapping another run wrote after this run loaded the config", async () => {
    const cfg = tmpConfig("concurrent");
    const mine = await markdown("mine");
    const theirs = await markdown("theirs");
    await recordDoc(mine, "doc-old", cfg);
    const loaded = await loadConfig(cfg);

    writeFileSync(cfg, JSON.stringify({ docs: { ...loaded.docs, [realpathSync(theirs)]: "doc-theirs" } }));
    await recordDoc(mine, "doc-mine", cfg);

    const fresh = await loadConfig(cfg);
    expect(await lookupDoc(fresh, theirs)).toBe("doc-theirs");
    expect(await lookupDoc(fresh, mine)).toBe("doc-mine");
  });

  test("refuses a config that is not JSON, and leaves it as it is", async () => {
    const cfg = tmpConfig("corrupt");
    await Bun.write(cfg, "{ not valid json");
    await expect(loadConfig(cfg)).rejects.toThrow(
      expect.objectContaining({
        code: "config_unparsed",
        kind: "refusal",
        meta: { path: cfg },
        cause: expect.any(SyntaxError),
      }),
    );
    expect(readFileSync(cfg, "utf8")).toBe("{ not valid json");
  });

  test("refuses a config that remembers an empty doc id, before any doc is touched", async () => {
    const cfg = tmpConfig("empty-id");
    const md = await markdown("empty-id");
    await Bun.write(cfg, JSON.stringify({ docs: { [md]: "" } }));
    await expect(loadConfig(cfg)).rejects.toThrow(
      expect.objectContaining({
        code: "config_invalid",
        kind: "refusal",
        meta: expect.objectContaining({ path: cfg }),
      }),
    );
  });

  test("refuses a config whose docs are not a path → id object", async () => {
    const cfg = tmpConfig("invalid");
    await Bun.write(cfg, JSON.stringify({ docs: ["a"] }));
    await expect(loadConfig(cfg)).rejects.toThrow(
      expect.objectContaining({
        code: "config_invalid",
        kind: "refusal",
        meta: { path: cfg, problem: "docs: Invalid input: expected record, received array" },
      }),
    );
  });

  test("refuses a record over a config that has become corrupt, leaving it as it is", async () => {
    const cfg = tmpConfig("corrupt-later");
    await Bun.write(cfg, "{ not valid json");
    await expect(recordDoc(await markdown("later"), "doc-l", cfg)).rejects.toThrow(
      expect.objectContaining({ code: "config_unparsed" }),
    );
    expect(readFileSync(cfg, "utf8")).toBe("{ not valid json");
  });

  test("refuses a config it may not read", async () => {
    const cfg = tmpConfig("locked");
    await Bun.write(cfg, JSON.stringify({ docs: {} }));
    chmodSync(cfg, 0o000);
    await expect(loadConfig(cfg)).rejects.toThrow(
      expect.objectContaining({ code: "config_unreadable", meta: { path: cfg, reason: "permission denied" } }),
    );
  });

  test("refuses a record it may not write", async () => {
    const dir = `${tmpdir()}/md2gd-map-ro-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(dir, { mode: 0o500 });
    const cfg = `${dir}/config.json`;
    await expect(recordDoc(await markdown("ro"), "doc-ro", cfg)).rejects.toThrow(
      expect.objectContaining({
        code: "config_unwritable",
        meta: { path: cfg, reason: "permission denied" },
        cause: expect.objectContaining({ code: "EACCES" }),
      }),
    );
  });
});
