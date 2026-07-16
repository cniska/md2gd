import { describe, expect, test } from "bun:test";
import type { Link, Root } from "mdast";
import { LinkMapSchema, resolveLinkMap, rewriteLinks } from "./links";
import { parseMarkdown } from "./parse";

/** Collect every link node's (text, url) so a rewrite's effect is observable. */
function links(tree: Root): { text: string; url: string }[] {
  const found: { text: string; url: string }[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; children?: unknown[] };
    if (n.type === "link") {
      const link = node as Link;
      const text = link.children.map((c) => (c.type === "text" ? c.value : "")).join("");
      found.push({ text, url: link.url });
    }
    if (Array.isArray(n.children)) for (const c of n.children) walk(c);
  };
  walk(tree);
  return found;
}

// A map keyed by absolute paths, as resolveLinkMap would produce, so the rewrite
// tests don't depend on a real map file on disk.
function mapFrom(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("resolveLinkMap", () => {
  test("resolves keys relative to the map file's directory", () => {
    const resolved = resolveLinkMap({ "docs/schema.md": "https://docs.google.com/document/d/SCHEMA" }, "/repo");
    expect(resolved.get("/repo/docs/schema.md")).toBe("https://docs.google.com/document/d/SCHEMA");
  });

  test("normalises a bare id and an edit URL to a Doc URL, passing a plain URL through", () => {
    const resolved = resolveLinkMap(
      {
        "a.md": "ABC123",
        "b.md": "https://docs.google.com/document/d/BID/edit",
        "c.md": "https://example.com/page",
      },
      "/repo",
    );
    expect(resolved.get("/repo/a.md")).toBe("https://docs.google.com/document/d/ABC123");
    expect(resolved.get("/repo/b.md")).toBe("https://docs.google.com/document/d/BID/edit");
    expect(resolved.get("/repo/c.md")).toBe("https://example.com/page");
  });
});

describe("rewriteLinks", () => {
  const map = mapFrom({
    "/repo/docs/schema.md": "https://docs.google.com/document/d/SCHEMA",
    "/repo/SPEC.md": "https://docs.google.com/document/d/SPEC",
  });

  test("a relative link to a mapped doc becomes the mapped Doc URL, text untouched", () => {
    const tree = parseMarkdown("See the [schema doc](schema.md).\n");
    const stats = rewriteLinks(tree, "/repo/docs/architecture.md", map);
    const [link] = links(tree);
    expect(link).toEqual({ text: "schema doc", url: "https://docs.google.com/document/d/SCHEMA" });
    expect(stats).toEqual({ rewritten: 1, anchorsDropped: 0, unmatched: 0 });
  });

  test("resolves a target relative to the source file's directory (../ climbs out)", () => {
    const tree = parseMarkdown("Back to the [spec](../SPEC.md).\n");
    rewriteLinks(tree, "/repo/docs/architecture.md", map);
    expect(links(tree)[0]?.url).toBe("https://docs.google.com/document/d/SPEC");
  });

  test("a matched link drops its #fragment and counts it", () => {
    const tree = parseMarkdown("See [tables](schema.md#tables).\n");
    const stats = rewriteLinks(tree, "/repo/docs/architecture.md", map);
    expect(links(tree)[0]?.url).toBe("https://docs.google.com/document/d/SCHEMA");
    expect(stats).toEqual({ rewritten: 1, anchorsDropped: 1, unmatched: 0 });
  });

  test("an unmatched relative link is left alone and counted as unmatched", () => {
    const tree = parseMarkdown("See [errors](errors.md).\n");
    const stats = rewriteLinks(tree, "/repo/docs/architecture.md", map);
    expect(links(tree)[0]?.url).toBe("errors.md");
    expect(stats).toEqual({ rewritten: 0, anchorsDropped: 0, unmatched: 1 });
  });

  test("an in-page anchor is not a cross-doc link — untouched and uncounted", () => {
    const tree = parseMarkdown("Jump [up](#section).\n");
    const stats = rewriteLinks(tree, "/repo/docs/architecture.md", map);
    expect(links(tree)[0]?.url).toBe("#section");
    expect(stats).toEqual({ rewritten: 0, anchorsDropped: 0, unmatched: 0 });
  });

  test("a link with a real scheme is left for the scheme gate — untouched and uncounted", () => {
    const tree = parseMarkdown("Visit [site](https://example.com).\n");
    const stats = rewriteLinks(tree, "/repo/docs/architecture.md", map);
    expect(links(tree)[0]?.url).toBe("https://example.com");
    expect(stats).toEqual({ rewritten: 0, anchorsDropped: 0, unmatched: 0 });
  });

  test("a percent-encoded relative target still matches its key", () => {
    const localMap = mapFrom({ "/repo/docs/a b.md": "https://docs.google.com/document/d/AB" });
    const tree = parseMarkdown("See [it](a%20b.md).\n");
    rewriteLinks(tree, "/repo/docs/architecture.md", localMap);
    expect(links(tree)[0]?.url).toBe("https://docs.google.com/document/d/AB");
  });

  test("an encoded #23 stays part of the filename, not a fragment", () => {
    const localMap = mapFrom({ "/repo/docs/a#b.md": "https://docs.google.com/document/d/HASH" });
    const tree = parseMarkdown("See [it](a%23b.md).\n");
    const stats = rewriteLinks(tree, "/repo/docs/architecture.md", localMap);
    expect(links(tree)[0]?.url).toBe("https://docs.google.com/document/d/HASH");
    // The `#` is a literal character here, so no anchor was dropped.
    expect(stats).toEqual({ rewritten: 1, anchorsDropped: 0, unmatched: 0 });
  });
});

describe("LinkMapSchema", () => {
  test("accepts a string→string record and rejects a non-string or empty value", () => {
    expect(LinkMapSchema.parse({ "a.md": "url" })).toEqual({ "a.md": "url" });
    expect(() => LinkMapSchema.parse({ "a.md": 5 })).toThrow();
    expect(() => LinkMapSchema.parse({ "a.md": "" })).toThrow();
  });
});
