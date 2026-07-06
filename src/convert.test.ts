import { describe, expect, test } from "bun:test";
import { convert } from "./convert";
import type { InsertTextRequest, UpdateParagraphStyleRequest } from "./docs";
import { parseMarkdown } from "./parse";

function insertedText(reqs: ReturnType<typeof convert>): string {
  return reqs
    .filter((r): r is InsertTextRequest => "insertText" in r)
    .map((r) => r.insertText.text)
    .join("");
}

function paragraphStyles(reqs: ReturnType<typeof convert>): UpdateParagraphStyleRequest[] {
  return reqs.filter((r): r is UpdateParagraphStyleRequest => "updateParagraphStyle" in r);
}

describe("convert paragraphs and headings", () => {
  test("a single paragraph inserts its text followed by a newline", () => {
    const reqs = convert(parseMarkdown("Hello world.\n"));
    expect(insertedText(reqs)).toBe("Hello world.\n");
  });

  test("an H2 maps to a HEADING_2 paragraph style over its own range", () => {
    const reqs = convert(parseMarkdown("## Scope\n"));
    const styles = paragraphStyles(reqs);
    const heading = styles.find((s) => s.updateParagraphStyle.paragraphStyle.namedStyleType === "HEADING_2");
    expect(heading).toBeDefined();
    if (!heading) throw new Error("no HEADING_2 style");
    // Range covers "Scope\n" starting at the body's first index.
    expect(heading.updateParagraphStyle.range).toEqual({ startIndex: 1, endIndex: 7 });
    expect(heading.updateParagraphStyle.fields).toContain("namedStyleType");
  });

  test("body paragraphs carry space-below so text does not run together", () => {
    const reqs = convert(parseMarkdown("A paragraph.\n"));
    const normal = paragraphStyles(reqs).find(
      (s) => s.updateParagraphStyle.paragraphStyle.namedStyleType === "NORMAL_TEXT",
    );
    expect(normal).toBeDefined();
    if (!normal) throw new Error("no NORMAL_TEXT style");
    const spaceBelow = normal.updateParagraphStyle.paragraphStyle.spaceBelow;
    expect(spaceBelow?.magnitude).toBeGreaterThan(0);
    expect(spaceBelow?.unit).toBe("PT");
    expect(normal.updateParagraphStyle.fields).toContain("spaceBelow");
  });

  test("cursor advances across blocks so ranges are contiguous and non-overlapping", () => {
    const reqs = convert(parseMarkdown("# Title\n\nBody text here.\n"));
    const [heading, body] = paragraphStyles(reqs);
    // "Title\n" = indices 1..7, then "Body text here.\n" = 7..23.
    expect(heading?.updateParagraphStyle.range).toEqual({ startIndex: 1, endIndex: 7 });
    expect(body?.updateParagraphStyle.range).toEqual({ startIndex: 7, endIndex: 23 });
  });

  test("a surrogate-pair emoji counts as two index units", () => {
    // 🟠 (U+1F7E0) is a surrogate pair = 2 UTF-16 code units. "🟠 High\n" is
    // 2 + 1 + 4 + 1 = 8 units, so the paragraph range must end at 9, not 8.
    const reqs = convert(parseMarkdown("🟠 High\n"));
    const [style] = paragraphStyles(reqs);
    expect(style?.updateParagraphStyle.range).toEqual({ startIndex: 1, endIndex: 9 });
  });
});
