/**
 * Minimal typed subset of the Google Docs API `batchUpdate` request shapes we
 * emit. Field names and structures mirror the official reference:
 * https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request
 *
 * We model only what we use; the API accepts partial objects with a `fields`
 * mask naming which properties to apply.
 */

export type Unit = "PT";

export interface Dimension {
  magnitude: number;
  unit: Unit;
}

export type NamedStyleType =
  | "NORMAL_TEXT"
  | "TITLE"
  | "SUBTITLE"
  | "HEADING_1"
  | "HEADING_2"
  | "HEADING_3"
  | "HEADING_4"
  | "HEADING_5"
  | "HEADING_6";

export interface Range {
  startIndex: number;
  endIndex: number;
}

export interface Shading {
  backgroundColor: OptionalColor;
}

export type DashStyle = "SOLID";

export interface ParagraphBorder {
  color: OptionalColor;
  width: Dimension;
  padding: Dimension;
  dashStyle: DashStyle;
}

export interface ParagraphStyle {
  namedStyleType?: NamedStyleType;
  lineSpacing?: number;
  spaceAbove?: Dimension;
  spaceBelow?: Dimension;
  indentStart?: Dimension;
  shading?: Shading;
  borderLeft?: ParagraphBorder;
  borderBottom?: ParagraphBorder;
  /** Keep this paragraph on the same page as the one that follows it. */
  keepWithNext?: boolean;
}

export interface WeightedFontFamily {
  fontFamily: string;
  weight?: number;
}

export interface RgbColor {
  red?: number;
  green?: number;
  blue?: number;
}

export interface OptionalColor {
  color?: { rgbColor: RgbColor };
}

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  link?: { url: string };
  weightedFontFamily?: WeightedFontFamily;
  foregroundColor?: OptionalColor;
  backgroundColor?: OptionalColor;
}

export interface InsertTextRequest {
  insertText: {
    text: string;
    location: { index: number };
  };
}

export interface UpdateParagraphStyleRequest {
  updateParagraphStyle: {
    paragraphStyle: ParagraphStyle;
    fields: string;
    range: Range;
  };
}

export interface UpdateTextStyleRequest {
  updateTextStyle: {
    textStyle: TextStyle;
    fields: string;
    range: Range;
  };
}

export type BulletPreset = "BULLET_DISC_CIRCLE_SQUARE" | "NUMBERED_DECIMAL_ALPHA_ROMAN" | "BULLET_CHECKBOX";

export interface CreateParagraphBulletsRequest {
  createParagraphBullets: {
    range: Range;
    bulletPreset: BulletPreset;
  };
}

export interface DeleteContentRangeRequest {
  deleteContentRange: {
    range: Range;
  };
}

export interface DeleteParagraphBulletsRequest {
  deleteParagraphBullets: {
    range: Range;
  };
}

export interface InsertTableRequest {
  insertTable: {
    rows: number;
    columns: number;
    location: { index: number };
  };
}

export type WidthType = "FIXED_WIDTH";

export interface UpdateTableColumnPropertiesRequest {
  updateTableColumnProperties: {
    tableStartLocation: { index: number };
    columnIndices: number[];
    tableColumnProperties: { widthType: WidthType; width: Dimension };
    fields: string;
  };
}

export interface TableCellStyle {
  paddingTop?: Dimension;
  paddingBottom?: Dimension;
  paddingLeft?: Dimension;
  paddingRight?: Dimension;
  backgroundColor?: OptionalColor;
}

export interface TableCellLocation {
  tableStartLocation: { index: number };
  rowIndex: number;
  columnIndex: number;
}

export interface UpdateTableCellStyleRequest {
  updateTableCellStyle: {
    tableCellStyle: TableCellStyle;
    fields: string;
    tableStartLocation?: { index: number };
    tableRange?: { tableCellLocation: TableCellLocation; rowSpan: number; columnSpan: number };
  };
}

export type DocRequest =
  | InsertTextRequest
  | UpdateParagraphStyleRequest
  | UpdateTextStyleRequest
  | CreateParagraphBulletsRequest
  | DeleteContentRangeRequest
  | DeleteParagraphBulletsRequest
  | InsertTableRequest
  | UpdateTableColumnPropertiesRequest
  | UpdateTableCellStyleRequest;

// Minimal shape of a `documents.get` response — only what the executor reads to
// locate a freshly inserted table's real cell indices.
export interface DocStructuralElement {
  startIndex?: number;
  endIndex?: number;
  table?: DocTable;
}

export interface DocTable {
  tableRows: DocTableRow[];
}

export interface DocTableRow {
  tableCells: DocTableCell[];
}

export interface DocTableCell {
  startIndex?: number;
  endIndex?: number;
  content: DocStructuralElement[];
}

export interface DocumentResource {
  documentId?: string;
  title?: string;
  body?: { content: DocStructuralElement[] };
}

/** Index of the first insertable position in a freshly created document body. */
export const BODY_START_INDEX = 1;

export function pt(magnitude: number): Dimension {
  return { magnitude, unit: "PT" };
}

/**
 * Build a Docs API `fields` mask from a partial style object: the API applies
 * only the properties named here, so it must list exactly the keys that are set.
 */
export function fieldMask(style: object): string {
  return Object.keys(style).join(",");
}
