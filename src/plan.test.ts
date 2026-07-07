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

  test("only a linear run that follows a table is flagged afterTable", () => {
    const md = "Intro.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nOutro.\n";
    const segments = planDocument(parseMarkdown(md));
    const linear = segments.filter((s) => s.kind === "linear");
    expect(linear[0]?.kind === "linear" && linear[0].afterTable).toBe(false);
    expect(linear[1]?.kind === "linear" && linear[1].afterTable).toBe(true);
  });
});
