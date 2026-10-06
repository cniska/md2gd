import { z } from "zod";

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
  preventOverflow?: boolean;
}

export interface UpdateTableRowStyleRequest {
  updateTableRowStyle: {
    tableStartLocation: { index: number };
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

export const BODY_START_INDEX = 1;

export function pt(magnitude: number): Dimension {
  return { magnitude, unit: "PT" };
}

export function fieldMask(style: object): string {
  return Object.keys(style).join(",");
}
