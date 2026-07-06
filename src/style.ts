import { type Dimension, fieldMask, type NamedStyleType, type ParagraphStyle, pt, type TextStyle } from "./docs";

/**
 * Central style table — the single source of truth for the "clean sensible
 * default" look. Because every document is styled from these fixed values, the
 * same input always produces the same result (reproducibility). Adjusting the
 * look later (e.g. brand fonts/colors) happens here without touching conversion.
 *
 * Spacing intent: body paragraphs breathe via space-below; headings carry more
 * space above than below so a heading groups with the content beneath it.
 */

/** Comfortable body line spacing as a percentage (100 = single). */
const BODY_LINE_SPACING = 115;

export interface ParagraphStyleSpec {
  paragraphStyle: ParagraphStyle;
  /** Field mask naming which paragraphStyle properties to apply. */
  fields: string;
}

function spec(style: ParagraphStyle): ParagraphStyleSpec {
  return { paragraphStyle: style, fields: fieldMask(style) };
}

const NORMAL: ParagraphStyleSpec = spec({
  namedStyleType: "NORMAL_TEXT",
  lineSpacing: BODY_LINE_SPACING,
  spaceBelow: pt(8),
});

interface HeadingSpacing {
  above: Dimension;
  below: Dimension;
}

const HEADING_SPACING: Record<1 | 2 | 3 | 4 | 5 | 6, HeadingSpacing> = {
  1: { above: pt(20), below: pt(6) },
  2: { above: pt(16), below: pt(4) },
  3: { above: pt(14), below: pt(4) },
  4: { above: pt(12), below: pt(2) },
  5: { above: pt(12), below: pt(2) },
  6: { above: pt(12), below: pt(2) },
};

export function normalParagraphStyle(): ParagraphStyleSpec {
  return NORMAL;
}

export function headingParagraphStyle(depth: number): ParagraphStyleSpec {
  const level = Math.min(Math.max(depth, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
  const spacing = HEADING_SPACING[level];
  return spec({
    namedStyleType: `HEADING_${level}` as NamedStyleType,
    spaceAbove: spacing.above,
    spaceBelow: spacing.below,
  });
}

/** Monospace family used for code; a Google-Docs-available mono font. */
const MONO_FONT = "Roboto Mono";
/** Light grey behind inline code, to set it apart from prose. */
const CODE_BACKGROUND = { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } };
/** Conventional link blue. */
const LINK_BLUE = { color: { rgbColor: { red: 0.06, green: 0.45, blue: 0.87 } } };

/** Inline code / code spans: monospace with a subtle background. */
export const codeTextStyle: TextStyle = {
  weightedFontFamily: { fontFamily: MONO_FONT },
  backgroundColor: CODE_BACKGROUND,
};

/** Hyperlink appearance: the link plus conventional coloured + underlined text. */
export function linkTextStyle(url: string): TextStyle {
  return { link: { url }, underline: true, foregroundColor: LINK_BLUE };
}

/**
 * Usable content width for a table, in points: US Letter (612pt) minus one-inch
 * (72pt) left and right margins. Column widths are distributed within this so
 * tables never overflow the page.
 */
export const TABLE_CONTENT_WIDTH_PT = 468;

/** Floor so a short-content column (e.g. a status column) never collapses. */
export const MIN_COLUMN_WIDTH_PT = 54;

/** Internal padding on every table cell, so text never touches the borders. */
export const CELL_PADDING: Dimension = pt(5);

/** Subtle grey fill distinguishing a table's header row. */
export const HEADER_SHADING = { color: { rgbColor: { red: 0.9, green: 0.9, blue: 0.9 } } };

const BORDER_GREY = { color: { rgbColor: { red: 0.7, green: 0.7, blue: 0.7 } } };

/** Fenced/indented code block: shaded background, set apart from prose. */
export const codeBlockParagraphStyle: ParagraphStyleSpec = spec({
  shading: { backgroundColor: { color: { rgbColor: { red: 0.96, green: 0.96, blue: 0.96 } } } },
  spaceAbove: pt(6),
  spaceBelow: pt(10),
});

/** Monospace text style for whole code blocks (no per-run background). */
export const codeBlockTextStyle: TextStyle = { weightedFontFamily: { fontFamily: MONO_FONT } };

/** Blockquote: indented with an accent bar on the left. */
export const blockquoteParagraphStyle: ParagraphStyleSpec = spec({
  indentStart: pt(24),
  borderLeft: { color: BORDER_GREY, width: pt(3), padding: pt(8), dashStyle: "SOLID" },
  spaceAbove: pt(6),
  spaceBelow: pt(10),
});

/** Horizontal rule: an empty paragraph carrying a bottom border. */
export const horizontalRuleParagraphStyle: ParagraphStyleSpec = spec({
  borderBottom: { color: BORDER_GREY, width: pt(1), padding: pt(0), dashStyle: "SOLID" },
  spaceAbove: pt(6),
  spaceBelow: pt(6),
});
