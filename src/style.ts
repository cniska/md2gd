import type { AlignType, Heading } from "mdast";
import {
  type Alignment,
  type Dimension,
  fieldMask,
  type ParagraphStyle,
  pt,
  type TableCellBorder,
  type TableCellStyle,
  type TableRowStyle,
  type TextStyle,
} from "./docs";

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

export const normalParagraphStyle: ParagraphStyleSpec = spec({
  namedStyleType: "NORMAL_TEXT",
  lineSpacing: BODY_LINE_SPACING,
  spaceBelow: pt(8),
});

interface HeadingSpacing {
  above: Dimension;
  below: Dimension;
}

const HEADING_SPACING: Record<Heading["depth"], HeadingSpacing> = {
  1: { above: pt(20), below: pt(6) },
  2: { above: pt(16), below: pt(4) },
  3: { above: pt(14), below: pt(4) },
  4: { above: pt(12), below: pt(2) },
  5: { above: pt(12), below: pt(2) },
  6: { above: pt(12), below: pt(2) },
};

/**
 * Space below a tight list's item text, closer than between body paragraphs so
 * the list reads as one grouped block, as rendered Markdown's tight lists do.
 */
export const TIGHT_LIST_ITEM_SPACE: Dimension = pt(2);

/** Space below a list's final item, matching body paragraph spacing. */
export const LIST_AFTER_SPACE: Dimension = pt(8);

/**
 * A bold-only line (e.g. `**Customer journey**` above a table) is a caption, not
 * a heading. It keeps body text (out of the outline) but gets space above to
 * separate it from preceding content and tight space below so it groups with the
 * element it introduces; `keepWithNext` stops a page break splitting the pair.
 */
export const captionParagraphStyle: ParagraphStyleSpec = spec({
  namedStyleType: "NORMAL_TEXT",
  spaceAbove: pt(12),
  spaceBelow: pt(4),
  keepWithNext: true,
});

export function headingParagraphStyle(depth: Heading["depth"]): ParagraphStyleSpec {
  const spacing = HEADING_SPACING[depth];
  return spec({ namedStyleType: `HEADING_${depth}`, spaceAbove: spacing.above, spaceBelow: spacing.below });
}

/** Default body/heading font applied to all inserted text. */
const DEFAULT_FONT = "Montserrat";

/** Base font run applied to every paragraph and cell; specific runs override it. */
export const bodyFontTextStyle: TextStyle = { weightedFontFamily: { fontFamily: DEFAULT_FONT } };

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

/** Floor so a short-content column (e.g. a status column) never collapses. */
export const MIN_COLUMN_WIDTH_PT = 54;

/** Internal padding on every table cell, so text never touches the borders. */
export const CELL_PADDING: Dimension = pt(5);

export const tableCellStyle: TableCellStyle = {
  paddingTop: CELL_PADDING,
  paddingBottom: CELL_PADDING,
  paddingLeft: CELL_PADDING,
  paddingRight: CELL_PADDING,
};

/** A row that doesn't fit moves whole to the next page rather than splitting across the break. */
export const tableRowStyle: TableRowStyle = { preventOverflow: true };

/** A subtle grey fill distinguishing a table's header row. */
export const headerCellStyle: TableCellStyle = {
  backgroundColor: { color: { rgbColor: { red: 0.9, green: 0.9, blue: 0.9 } } },
};

/** A header cell's text is bold, as rendered Markdown sets a header row. */
export const headerCellTextStyle: TextStyle = { ...bodyFontTextStyle, bold: true };

const CELL_ALIGNMENT: Record<NonNullable<AlignType>, Alignment> = { left: "START", center: "CENTER", right: "END" };

/** A block's own style aligned as its table column says; a column without alignment keeps the block's own. */
export function alignedParagraphStyle(own: ParagraphStyleSpec, align: AlignType): ParagraphStyleSpec {
  if (!align) return own;
  return spec({ ...own.paragraphStyle, alignment: CELL_ALIGNMENT[align] });
}

/**
 * The Docs API injects an empty paragraph immediately before every table. Left
 * alone it inherits whatever style preceded it — which differs between a fresh
 * doc and a cleared one, so the same input would render tables differently in
 * create vs. update mode. Pinning it to a thin, zero-spacing line makes tables
 * sit consistently and lets a caption group tightly with the table below it.
 */
export const preTableParagraphStyle: ParagraphStyleSpec = spec({
  spaceAbove: pt(0),
  spaceBelow: pt(0),
  lineSpacing: 100,
});

/** Small font on that injected newline, so the spacer above a table stays subtle. */
export const preTableTextStyle: TextStyle = { fontSize: pt(6) };

/** Space above the first block after a table, since a table carries no space below itself. */
export const AFTER_TABLE_SPACE: Dimension = pt(10);

const BORDER_GREY = { color: { rgbColor: { red: 0.7, green: 0.7, blue: 0.7 } } };

/** Fenced/indented code block: shaded background, set apart from prose. */
export const codeBlockParagraphStyle: ParagraphStyleSpec = spec({
  shading: { backgroundColor: { color: { rgbColor: { red: 0.96, green: 0.96, blue: 0.96 } } } },
  spaceAbove: pt(6),
  spaceBelow: pt(10),
});

/** Monospace text style for whole code blocks (no per-run background). */
export const codeBlockTextStyle: TextStyle = { weightedFontFamily: { fontFamily: MONO_FONT } };

/** A bullet preset's text indent per nesting level, which an item's later blocks align under. */
const LIST_LEVEL_INDENT_PT = 36;

/**
 * The indent of a list item's blocks after its first, at the item's nesting
 * depth. Removing a paragraph's bullet drops it to the margin, so md2gd sets it.
 * The first-line indent matches the start indent: Docs applies indentStart to
 * every line after a break but indentFirstLine (default 0) to the first, so a
 * multi-line block would otherwise hang its continuation lines to the right.
 */
export function listLaterBlockIndent(depth: number): ParagraphStyleSpec {
  const indent = pt((depth + 1) * LIST_LEVEL_INDENT_PT);
  return spec({ indentStart: indent, indentFirstLine: indent });
}

/** A block's own style with the space its position calls for; unset sides keep the block's own. */
export function spacedParagraphStyle(
  own: ParagraphStyleSpec,
  above: Dimension | undefined,
  below: Dimension | undefined,
): ParagraphStyleSpec {
  if (above === undefined && below === undefined) return own;
  const style: ParagraphStyle = { ...own.paragraphStyle };
  if (above !== undefined) style.spaceAbove = above;
  if (below !== undefined) style.spaceBelow = below;
  return spec(style);
}

const QUOTE_ACCENT_WIDTH = pt(3);
const QUOTE_PADDING_LEFT = pt(8);
const NO_BORDER: TableCellBorder = { color: BORDER_GREY, width: pt(0), dashStyle: "SOLID" };

/** A quote's one cell: a left accent and nothing else, so it reads as a quote, not a table. */
export const quoteCellStyle: TableCellStyle = {
  borderLeft: { color: BORDER_GREY, width: QUOTE_ACCENT_WIDTH, dashStyle: "SOLID" },
  borderTop: NO_BORDER,
  borderRight: NO_BORDER,
  borderBottom: NO_BORDER,
  paddingLeft: QUOTE_PADDING_LEFT,
  paddingTop: pt(0),
  paddingRight: pt(0),
  paddingBottom: pt(0),
};

/**
 * How far a quote's contents sit in from its container's edge. Docs draws a cell
 * border centered on the cell's edge without taking width, so only the padding
 * moves the contents; the quote's column is the container's full width.
 */
export const QUOTE_INSET_PT = QUOTE_PADDING_LEFT.magnitude;
