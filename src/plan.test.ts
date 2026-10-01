import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "./parse";
import { planDocument } from "./plan";

describe("planDocument", () => {
  test("a table-free document is a single linear segment", () => {
    const segments = planDocument(parseMarkdown("# Title\n\nBody.\n"));
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("linear");
  });

  test("a table splits the document into linear, table, linear segments", () => {
    const md = "Intro.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nOutro.\n";
    const kinds = planDocument(parseMarkdown(md)).map((s) => s.kind);
    expect(kinds).toEqual(["linear", "table", "linear"]);
  });

  test("adjacent tables become separate table segments that do not merge", () => {
    const md = "| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 2 |\n";
    const segments = planDocument(parseMarkdown(md));
    expect(segments.map((s) => s.kind)).toEqual(["table", "table"]);
  });

  test("a quote becomes a container segment holding its own blocks", () => {
    const [quote] = planDocument(parseMarkdown("> quoted\n"));
    expect(quote?.kind).toBe("quote");
    if (quote?.kind !== "quote") return;
    expect(quote.segments.map((s) => s.kind)).toEqual(["linear"]);
    const [inner] = quote.segments;
    expect(inner?.kind === "linear" && inner.leaves[0]?.context).toEqual({});
  });

  test("a quote inside a quote nests as a quote segment within it", () => {
    const [outer] = planDocument(parseMarkdown("> outer\n>\n> > inner\n"));
    if (outer?.kind !== "quote") throw new Error("expected a quote");
    expect(outer.segments.map((s) => s.kind)).toEqual(["linear", "quote"]);
  });

  test("a table inside a quote is a table segment within the quote", () => {
    const md = "> before\n>\n> | A |\n> |---|\n> | 1 |\n>\n> after\n";
    const [quote] = planDocument(parseMarkdown(md));
    if (quote?.kind !== "quote") throw new Error("expected a quote");
    expect(quote.segments.map((s) => s.kind)).toEqual(["linear", "table", "linear"]);
  });

  test("a quote inside a list item sits between the item's blocks, which continue after it", () => {
    const segments = planDocument(parseMarkdown("- item\n\n  > quoted\n\n  more\n- next\n"));
    expect(segments.map((s) => s.kind)).toEqual(["linear", "quote", "linear"]);
    const after = segments[2];
    if (after?.kind !== "linear") throw new Error("expected a linear run");
    expect(after.leaves.map((l) => l.context.list?.first)).toEqual([false, true]);
  });

  test("a list item that opens with a quote keeps an empty first block to carry its marker", () => {
    const [marker, quote] = planDocument(parseMarkdown("- > quoted\n"));
    expect(quote?.kind).toBe("quote");
    if (marker?.kind !== "linear") throw new Error("expected a linear run");
    expect(marker.leaves).toHaveLength(1);
    expect(marker.leaves[0]?.context.list?.first).toBe(true);
  });

  test("the run after a quote is flagged afterTable, since a quote is a table in Docs", () => {
    const [, after] = planDocument(parseMarkdown("> quoted\n\nafter\n"));
    expect(after?.kind === "linear" && after.afterTable).toBe(true);
  });

  test("a table inside a list item becomes a table segment between the items", () => {
    const md = "- one\n\n  | A |\n  |---|\n  | 1 |\n\n- two\n";
    expect(planDocument(parseMarkdown(md)).map((s) => s.kind)).toEqual(["linear", "table", "linear"]);
  });

  test("only a linear run that follows a table is flagged afterTable", () => {
    const md = "Intro.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nOutro.\n";
    const segments = planDocument(parseMarkdown(md));
    const linear = segments.filter((s) => s.kind === "linear");
    expect(linear[0]?.kind === "linear" && linear[0].afterTable).toBe(false);
    expect(linear[1]?.kind === "linear" && linear[1].afterTable).toBe(true);
  });
});
