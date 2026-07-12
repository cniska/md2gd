import { describe, expect, test } from "bun:test";
import { convert, convertNodes } from "./convert";
import type {
  CreateParagraphBulletsRequest,
  InsertTextRequest,
  UpdateParagraphStyleRequest,
  UpdateTextStyleRequest,
} from "./docs";
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

function textStyles(reqs: ReturnType<typeof convert>): UpdateTextStyleRequest[] {
  return reqs.filter((r): r is UpdateTextStyleRequest => "updateTextStyle" in r);
}

function bullets(reqs: ReturnType<typeof convert>): CreateParagraphBulletsRequest[] {
  return reqs.filter((r): r is CreateParagraphBulletsRequest => "createParagraphBullets" in r);
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

describe("convert inline formatting", () => {
  test("bold text becomes a bold text-style run over just the bold span", () => {
    // "a **bold** c\n" -> "a bold c\n"; "bold" is at indices 3..7.
    const reqs = convert(parseMarkdown("a **bold** c\n"));
    expect(insertedText(reqs)).toBe("a bold c\n");
    const bold = textStyles(reqs).find((r) => r.updateTextStyle.textStyle.bold);
    expect(bold).toBeDefined();
    if (!bold) throw new Error("no bold run");
    expect(bold.updateTextStyle.range).toEqual({ startIndex: 3, endIndex: 7 });
    expect(bold.updateTextStyle.fields).toContain("bold");
  });

  test("inline code keeps markdown-significant characters literal and monospace", () => {
    const reqs = convert(parseMarkdown("key `sk_test_` here\n"));
    // The underscores are not emphasis: the literal token survives verbatim.
    expect(insertedText(reqs)).toBe("key sk_test_ here\n");
    // The code run is distinguished by its background shade (the base body font
    // run also carries weightedFontFamily).
    const code = textStyles(reqs).find((r) => r.updateTextStyle.textStyle.backgroundColor);
    expect(code).toBeDefined();
    if (!code) throw new Error("no code run");
    expect(code.updateTextStyle.textStyle.weightedFontFamily).toBeDefined();
    expect(code.updateTextStyle.range).toEqual({ startIndex: 5, endIndex: 13 });
    expect(code.updateTextStyle.textStyle.bold).toBeUndefined();
    expect(code.updateTextStyle.textStyle.italic).toBeUndefined();
  });

  test("a link produces a link run carrying the url", () => {
    const reqs = convert(parseMarkdown("see [docs](https://example.com/x) now\n"));
    expect(insertedText(reqs)).toBe("see docs now\n");
    const link = textStyles(reqs).find((r) => r.updateTextStyle.textStyle.link);
    expect(link?.updateTextStyle.textStyle.link?.url).toBe("https://example.com/x");
    expect(link?.updateTextStyle.range).toEqual({ startIndex: 5, endIndex: 9 });
  });

  test("stacked lines join into one paragraph via a line break, not a new paragraph", () => {
    const reqs = convert(parseMarkdown("**Date:** July 5\n**Class:** Confidential\n"));
    // One paragraph => exactly one paragraph-style request.
    expect(paragraphStyles(reqs)).toHaveLength(1);
    // The two lines are joined by a vertical-tab line break, not "\n".
    const text = insertedText(reqs);
    expect(text).toContain(String.fromCharCode(0x0b));
    expect(text).toBe(`Date: July 5${String.fromCharCode(0x0b)}Class: Confidential\n`);
  });
});

describe("convert lists", () => {
  test("a flat unordered list bullets its items with the disc preset", () => {
    const reqs = convert(parseMarkdown("- one\n- two\n"));
    expect(insertedText(reqs)).toBe("one\ntwo\n");
    const bs = bullets(reqs);
    expect(bs).toHaveLength(1);
    expect(bs[0]?.createParagraphBullets.bulletPreset).toBe("BULLET_DISC_CIRCLE_SQUARE");
    expect(bs[0]?.createParagraphBullets.range).toEqual({ startIndex: 1, endIndex: 9 });
  });

  test("an ordered list uses the numbered preset", () => {
    const reqs = convert(parseMarkdown("1. first\n2. second\n"));
    const bs = bullets(reqs);
    expect(bs).toHaveLength(1);
    expect(bs[0]?.createParagraphBullets.bulletPreset).toBe("NUMBERED_DECIMAL_ALPHA_ROMAN");
  });

  test("list items are tightly spaced but the last item restores space after the list", () => {
    const styles = paragraphStyles(convert(parseMarkdown("- one\n- two\n- three\n")));
    const below = styles.map((s) => s.updateParagraphStyle.paragraphStyle.spaceBelow?.magnitude ?? 0);
    // Interior items are tight; the final item gets the larger after-list space.
    expect(below[0]).toBeLessThan(below[below.length - 1] ?? 0);
    expect(below[below.length - 1]).toBeGreaterThanOrEqual(8);
  });

  test("a nested list indents with a tab and is covered by one bullet request", () => {
    const reqs = convert(parseMarkdown("- a\n  - b\n"));
    // "a\n" then "\tb\n": the nested item carries one leading tab for depth.
    expect(insertedText(reqs)).toBe("a\n\tb\n");
    const bs = bullets(reqs);
    expect(bs).toHaveLength(1);
    expect(bs[0]?.createParagraphBullets.range).toEqual({ startIndex: 1, endIndex: 6 });
  });

  test("end index discounts the tabs bulleting will strip, so a following table lands", () => {
    // Nested list: "a\n\tb\n" is 5 code units from index 1, but bulleting strips
    // the one leading tab, so the real body ends at 5, not 6. A table placed at
    // the raw end would be past the segment's end and fail to insert.
    const nested = parseMarkdown("- a\n  - b\n");
    expect(convertNodes(nested.children, 1).endIndex).toBe(5);
    // A flat list has no nesting tabs, so its end index is unchanged.
    const flat = parseMarkdown("- a\n- b\n");
    expect(convertNodes(flat.children, 1).endIndex).toBe(5);
  });

  test("a task list keeps its tabs (no bullet preset strips them), so the end index counts them", () => {
    // A task list uses glyphs, not a bullet preset, so nothing strips the tab.
    const reqs = convertNodes(parseMarkdown("- [ ] a\n  - [ ] b\n").children, 1);
    expect(insertedText(reqs.requests)).toBe("☐ a\n\t☐ b\n");
    expect(reqs.endIndex).toBe(1 + "☐ a\n\t☐ b\n".length);
  });

  test("a task list renders checked and unchecked glyphs, preserving state", () => {
    const reqs = convert(parseMarkdown("- [ ] todo\n- [x] done\n"));
    // Checked state survives as a leading glyph rather than being dropped.
    expect(insertedText(reqs)).toBe("☐ todo\n☑ done\n");
    // No checkbox bullet: the glyph is the marker (the API can't pre-check one).
    expect(bullets(reqs)).toHaveLength(0);
  });

  test("a plain item mixed into a task list still gets a marker", () => {
    const reqs = convert(parseMarkdown("- [x] done\n- plain item\n"));
    // The plain item is prefixed with a bullet glyph, never left unmarked.
    expect(insertedText(reqs)).toBe("☑ done\n• plain item\n");
    expect(bullets(reqs)).toHaveLength(0);
  });

  test("bullet requests come last and in reverse document order", () => {
    const reqs = convert(parseMarkdown("- a\n\ntext\n\n- b\n"));
    const bs = bullets(reqs);
    expect(bs).toHaveLength(2);
    const [first, second] = bs;
    if (!first || !second) throw new Error("expected two bullet requests");
    // Later list first, so tab-stripping never invalidates an earlier range.
    expect(first.createParagraphBullets.range.startIndex).toBeGreaterThan(
      second.createParagraphBullets.range.startIndex,
    );
    // And they are the final requests in the batch.
    const lastTwo = reqs.slice(-2);
    expect(lastTwo.every((r) => "createParagraphBullets" in r)).toBe(true);
  });
});

describe("convert other block types", () => {
  test("a fenced code block is monospace, shaded, and keeps its lines in one block", () => {
    const reqs = convert(parseMarkdown("```\nconst x = 1\nmore\n```\n"));
    // Internal newline becomes an in-paragraph line break, not a new paragraph.
    expect(insertedText(reqs)).toBe(`const x = 1${String.fromCharCode(0x0b)}more\n`);
    const mono = textStyles(reqs).find((r) => r.updateTextStyle.textStyle.weightedFontFamily);
    expect(mono).toBeDefined();
    const shaded = paragraphStyles(reqs).find((s) => s.updateParagraphStyle.paragraphStyle.shading);
    expect(shaded).toBeDefined();
  });

  test("a blockquote is indented with a left accent border", () => {
    const reqs = convert(parseMarkdown("> quoted line\n"));
    const style = paragraphStyles(reqs).find((s) => s.updateParagraphStyle.paragraphStyle.borderLeft);
    expect(style).toBeDefined();
    if (!style) throw new Error("no blockquote style");
    const ps = style.updateParagraphStyle.paragraphStyle;
    expect(ps.indentStart?.magnitude).toBeGreaterThan(0);
    // First-line indent must match the start indent, or a multi-line quote hangs
    // its continuation lines to the right (Docs applies indentStart after a break).
    expect(ps.indentFirstLine?.magnitude).toBe(ps.indentStart?.magnitude);
    expect(insertedText(reqs)).toBe("quoted line\n");
  });

  test("a horizontal rule is ignored, contributing no paragraph", () => {
    const reqs = convert(parseMarkdown("above\n\n---\n\nbelow\n"));
    expect(paragraphStyles(reqs).some((s) => s.updateParagraphStyle.paragraphStyle.borderBottom)).toBe(false);
    expect(paragraphStyles(reqs)).toHaveLength(2);
    expect(insertedText(reqs)).toBe("above\nbelow\n");
  });
});

describe("convert deferred / unsupported blocks", () => {
  test("a table reaching the linear converter fails loud rather than flattening", () => {
    const tree = parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 |\n");
    expect(() => convert(tree)).toThrow(/planner/);
  });
});

describe("convert link safety and bare domains", () => {
  test("a javascript: link renders as plain text with no link attached", () => {
    const reqs = convert(parseMarkdown("click [here](javascript:alert(1)) ok\n"));
    expect(insertedText(reqs)).toBe("click here ok\n");
    expect(textStyles(reqs).some((r) => r.updateTextStyle.textStyle.link)).toBe(false);
  });

  test("a scheme-less bare domain in prose is not turned into a link", () => {
    const reqs = convert(parseMarkdown("see partybook-one.vercel.app today\n"));
    expect(textStyles(reqs).some((r) => r.updateTextStyle.textStyle.link)).toBe(false);
  });

  test("mailto and tel links stay clickable", () => {
    for (const url of ["mailto:team@example.com", "tel:+123456789"]) {
      const reqs = convert(parseMarkdown(`[reach us](${url})\n`));
      const link = textStyles(reqs).find((r) => r.updateTextStyle.textStyle.link);
      expect(link?.updateTextStyle.textStyle.link?.url).toBe(url);
    }
  });

  test("a relative-path link renders as plain text (dead in a Doc)", () => {
    const reqs = convert(parseMarkdown("see the [report](./report.md) here\n"));
    expect(insertedText(reqs)).toBe("see the report here\n");
    expect(textStyles(reqs).some((r) => r.updateTextStyle.textStyle.link)).toBe(false);
  });

  test("a bare-filename link renders as plain text", () => {
    const reqs = convert(parseMarkdown("open [notes](notes.md)\n"));
    expect(textStyles(reqs).some((r) => r.updateTextStyle.textStyle.link)).toBe(false);
  });

  test("an in-page anchor link renders as plain text", () => {
    const reqs = convert(parseMarkdown("jump to [summary](#summary)\n"));
    expect(textStyles(reqs).some((r) => r.updateTextStyle.textStyle.link)).toBe(false);
  });

  test("a file: link renders as plain text", () => {
    const reqs = convert(parseMarkdown("[local](file:///Users/me/doc.md)\n"));
    expect(textStyles(reqs).some((r) => r.updateTextStyle.textStyle.link)).toBe(false);
  });
});

describe("convert typography and styling coverage", () => {
  test("unicode punctuation passes through unchanged", () => {
    const reqs = convert(parseMarkdown("A — B – C → D “q” ‘r’\n"));
    expect(insertedText(reqs)).toBe("A — B – C → D “q” ‘r’\n");
  });

  test("a fully bold line becomes a caption: bold body text, not a heading, spaced to group with what follows", () => {
    const reqs = convert(parseMarkdown("**Customer journey**\n"));
    const styles = paragraphStyles(reqs);
    expect(styles).toHaveLength(1);
    const style = styles[0]?.updateParagraphStyle.paragraphStyle;
    // Stays body text (out of the outline), still bold.
    expect(style?.namedStyleType).toBe("NORMAL_TEXT");
    expect(textStyles(reqs).some((r) => r.updateTextStyle.textStyle.bold)).toBe(true);
    // Caption spacing: space above to separate, tight below to group with the table.
    expect(style?.spaceAbove?.magnitude).toBeGreaterThan(style?.spaceBelow?.magnitude ?? 0);
    expect(style?.keepWithNext).toBe(true);
  });

  test("a mixed bold+plain line stays an ordinary paragraph, not a caption", () => {
    const reqs = convert(parseMarkdown("**Note:** this is regular prose.\n"));
    const style = paragraphStyles(reqs)[0]?.updateParagraphStyle.paragraphStyle;
    expect(style?.keepWithNext).toBeUndefined();
  });

  test("a fully bold hyperlink is not treated as a caption", () => {
    const reqs = convert(parseMarkdown("**[the link](https://example.com)**\n"));
    const style = paragraphStyles(reqs)[0]?.updateParagraphStyle.paragraphStyle;
    expect(style?.keepWithNext).toBeUndefined();
    expect(style?.namedStyleType).toBe("NORMAL_TEXT");
  });

  test("a run following a table gets space above its first block", () => {
    const { requests } = convertNodes(parseMarkdown("Outro.\n").children, 1, { afterTable: true });
    const first = requests.find((r) => "updateParagraphStyle" in r);
    const style = first && "updateParagraphStyle" in first ? first.updateParagraphStyle : undefined;
    expect(style?.paragraphStyle.spaceAbove?.magnitude).toBeGreaterThanOrEqual(10);
    expect(style?.fields).toContain("spaceAbove");
  });

  test("a first heading after a table keeps its own larger space above", () => {
    const { requests } = convertNodes(parseMarkdown("## Next\n").children, 1, { afterTable: true });
    const first = requests.find((r) => "updateParagraphStyle" in r);
    const style = first && "updateParagraphStyle" in first ? first.updateParagraphStyle : undefined;
    // HEADING_2's 16pt is not reduced to the 10pt floor.
    expect(style?.paragraphStyle.spaceAbove?.magnitude).toBeGreaterThan(10);
  });

  test("headings carry more space above than below so they group with their content", () => {
    const reqs = convert(parseMarkdown("# Title\n"));
    const style = paragraphStyles(reqs)[0]?.updateParagraphStyle.paragraphStyle;
    expect(style?.spaceAbove?.magnitude).toBeGreaterThan(style?.spaceBelow?.magnitude ?? 0);
  });

  test("code and blockquote blocks carry space below so following text is separated", () => {
    const code = paragraphStyles(convert(parseMarkdown("```\nx\n```\n")))[0]?.updateParagraphStyle.paragraphStyle;
    const quote = paragraphStyles(convert(parseMarkdown("> q\n")))[0]?.updateParagraphStyle.paragraphStyle;
    expect(code?.spaceBelow?.magnitude).toBeGreaterThan(0);
    expect(quote?.spaceBelow?.magnitude).toBeGreaterThan(0);
  });
});

describe("convert list nesting limitation", () => {
  test("a mixed-type nested list uses the outer list's single preset (documented limitation)", () => {
    const reqs = convert(parseMarkdown("1. one\n   - sub\n2. two\n"));
    const bs = bullets(reqs);
    expect(bs).toHaveLength(1);
    expect(bs[0]?.createParagraphBullets.bulletPreset).toBe("NUMBERED_DECIMAL_ALPHA_ROMAN");
  });
});

describe("convert default font", () => {
  test("body text is set in the default font (Montserrat)", () => {
    const reqs = convert(parseMarkdown("Just some text.\n"));
    const font = textStyles(reqs).find((r) => r.updateTextStyle.textStyle.weightedFontFamily);
    expect(font?.updateTextStyle.textStyle.weightedFontFamily?.fontFamily).toBe("Montserrat");
  });
});
