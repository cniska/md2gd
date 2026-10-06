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

const BODY_LINE_SPACING = 115;

export interface ParagraphStyleSpec {
  paragraphStyle: ParagraphStyle;
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

export const TIGHT_LIST_ITEM_SPACE: Dimension = pt(2);

export const LIST_AFTER_SPACE: Dimension = pt(8);

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

const DEFAULT_FONT = "Montserrat";

export const bodyFontTextStyle: TextStyle = { weightedFontFamily: { fontFamily: DEFAULT_FONT } };

const MONO_FONT = "Roboto Mono";
const CODE_BACKGROUND = { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } };
const LINK_BLUE = { color: { rgbColor: { red: 0.06, green: 0.45, blue: 0.87 } } };

export const codeTextStyle: TextStyle = {
  weightedFontFamily: { fontFamily: MONO_FONT },
  backgroundColor: CODE_BACKGROUND,
};

export function linkTextStyle(url: string): TextStyle {
  return { link: { url }, underline: true, foregroundColor: LINK_BLUE };
}

export const MIN_COLUMN_WIDTH_PT = 54;

export const CELL_PADDING: Dimension = pt(5);

export const tableCellStyle: TableCellStyle = {
  paddingTop: CELL_PADDING,
  paddingBottom: CELL_PADDING,
  paddingLeft: CELL_PADDING,
  paddingRight: CELL_PADDING,
};

export const tableRowStyle: TableRowStyle = { preventOverflow: true };

export const headerCellStyle: TableCellStyle = {
  backgroundColor: { color: { rgbColor: { red: 0.9, green: 0.9, blue: 0.9 } } },
};

export const headerCellTextStyle: TextStyle = { ...bodyFontTextStyle, bold: true };

const CELL_ALIGNMENT: Record<NonNullable<AlignType>, Alignment> = { left: "START", center: "CENTER", right: "END" };

export function alignedParagraphStyle(own: ParagraphStyleSpec, align: AlignType): ParagraphStyleSpec {
  if (!align) return own;
  return spec({ ...own.paragraphStyle, alignment: CELL_ALIGNMENT[align] });
}

export const preTableParagraphStyle: ParagraphStyleSpec = spec({
  spaceAbove: pt(0),
  spaceBelow: pt(0),
  lineSpacing: 100,
});

export const preTableKeptParagraphStyle: ParagraphStyleSpec = spec({
  ...preTableParagraphStyle.paragraphStyle,
  keepWithNext: true,
});

export const preTableTextStyle: TextStyle = { fontSize: pt(6) };

export const AFTER_TABLE_SPACE: Dimension = pt(10);

const BORDER_GREY = { color: { rgbColor: { red: 0.7, green: 0.7, blue: 0.7 } } };

export const codeBlockParagraphStyle: ParagraphStyleSpec = spec({
  shading: { backgroundColor: { color: { rgbColor: { red: 0.96, green: 0.96, blue: 0.96 } } } },
  spaceAbove: pt(6),
  spaceBelow: pt(10),
});

export const codeBlockTextStyle: TextStyle = { weightedFontFamily: { fontFamily: MONO_FONT } };

const LIST_LEVEL_INDENT_PT = 36;

export function listLaterBlockIndent(depth: number): ParagraphStyleSpec {
  const indent = pt((depth + 1) * LIST_LEVEL_INDENT_PT);
  return spec({ indentStart: indent, indentFirstLine: indent });
}

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

export const QUOTE_INSET_PT = QUOTE_PADDING_LEFT.magnitude;
