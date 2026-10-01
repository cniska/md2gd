import { z } from "zod";

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

export type Alignment = "START" | "CENTER" | "END";

export interface ParagraphStyle {
  namedStyleType?: NamedStyleType;
  alignment?: Alignment;
  lineSpacing?: number;
  spaceAbove?: Dimension;
  spaceBelow?: Dimension;
  indentStart?: Dimension;
  indentFirstLine?: Dimension;
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
  fontSize?: Dimension;
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

export type BulletPreset = "BULLET_DISC_CIRCLE_SQUARE" | "NUMBERED_DECIMAL_ALPHA_ROMAN";

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

/** A cell border; a zero width hides it. Unlike a paragraph border, it has no padding of its own. */
export interface TableCellBorder {
  color: OptionalColor;
  width: Dimension;
  dashStyle: DashStyle;
}

export interface TableCellStyle {
  paddingTop?: Dimension;
  paddingBottom?: Dimension;
  paddingLeft?: Dimension;
  paddingRight?: Dimension;
  backgroundColor?: OptionalColor;
  borderLeft?: TableCellBorder;
  borderTop?: TableCellBorder;
  borderRight?: TableCellBorder;
  borderBottom?: TableCellBorder;
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

export interface TableRowStyle {
  minRowHeight?: Dimension;
  /** True if the row cannot overflow (split) across a page or column boundary. */
  preventOverflow?: boolean;
}

export interface UpdateTableRowStyleRequest {
  updateTableRowStyle: {
    tableStartLocation: { index: number };
    /** Omitted to apply to every row in the table. */
    rowIndices?: number[];
    tableRowStyle: TableRowStyle;
    fields: string;
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
  | UpdateTableCellStyleRequest
  | UpdateTableRowStyleRequest;

// Minimal shape of a `documents.get` response — only what the executor reads.
// Every field is optional because the API omits default values (a zero margin
// arrives without its `magnitude`), and objects stay loose so new API fields pass.
const ResponseDimensionSchema = z.looseObject({ magnitude: z.number().optional(), unit: z.string().optional() });

export const DocStructuralElementSchema = z.looseObject({
  startIndex: z.number().optional(),
  endIndex: z.number().optional(),
  get table() {
    return DocTableSchema.optional();
  },
});

export const DocTableCellSchema = z.looseObject({
  startIndex: z.number().optional(),
  endIndex: z.number().optional(),
  get content() {
    return z.array(DocStructuralElementSchema);
  },
});

export const DocTableSchema = z.looseObject({
  tableRows: z.array(z.looseObject({ tableCells: z.array(DocTableCellSchema) })),
});

export const DocumentStyleSchema = z.looseObject({
  pageSize: z
    .looseObject({ width: ResponseDimensionSchema.optional(), height: ResponseDimensionSchema.optional() })
    .optional(),
  marginLeft: ResponseDimensionSchema.optional(),
  marginRight: ResponseDimensionSchema.optional(),
});

export const DocumentResourceSchema = z.looseObject({
  documentId: z.string().optional(),
  title: z.string().optional(),
  documentStyle: DocumentStyleSchema.optional(),
  body: z.looseObject({ content: z.array(DocStructuralElementSchema) }).optional(),
});

export type DocStructuralElement = z.infer<typeof DocStructuralElementSchema>;
export type DocTable = z.infer<typeof DocTableSchema>;
export type DocTableCell = z.infer<typeof DocTableCellSchema>;
export type DocumentStyle = z.infer<typeof DocumentStyleSchema>;
export type DocumentResource = z.infer<typeof DocumentResourceSchema>;

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
