import { z } from "zod";

const Dimension = z.strictObject({ magnitude: z.number(), unit: z.literal("PT") });
const Color = z.strictObject({
  color: z
    .strictObject({
      rgbColor: z.strictObject({
        red: z.number().optional(),
        green: z.number().optional(),
        blue: z.number().optional(),
      }),
    })
    .optional(),
});
const Range = z.strictObject({ startIndex: z.number().int(), endIndex: z.number().int() });
const Location = z.strictObject({ index: z.number().int() });
const Fields = z.string().min(1);
const ParagraphBorder = z.strictObject({
  color: Color,
  width: Dimension,
  padding: Dimension,
  dashStyle: z.literal("SOLID"),
});
const CellBorder = z.strictObject({ color: Color, width: Dimension, dashStyle: z.literal("SOLID") });

export const ParagraphStyle = z.strictObject({
  namedStyleType: z
    .enum([
      "NORMAL_TEXT",
      "TITLE",
      "SUBTITLE",
      "HEADING_1",
      "HEADING_2",
      "HEADING_3",
      "HEADING_4",
      "HEADING_5",
      "HEADING_6",
    ])
    .optional(),
  alignment: z.enum(["START", "CENTER", "END", "JUSTIFIED"]).optional(),
  lineSpacing: z.number().optional(),
  spaceAbove: Dimension.optional(),
  spaceBelow: Dimension.optional(),
  indentStart: Dimension.optional(),
  indentFirstLine: Dimension.optional(),
  shading: z.strictObject({ backgroundColor: Color }).optional(),
  borderLeft: ParagraphBorder.optional(),
  borderBottom: ParagraphBorder.optional(),
  keepWithNext: z.boolean().optional(),
});

export const TextStyle = z.strictObject({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  link: z.strictObject({ url: z.string() }).optional(),
  weightedFontFamily: z.strictObject({ fontFamily: z.string(), weight: z.number().optional() }).optional(),
  fontSize: Dimension.optional(),
  foregroundColor: Color.optional(),
  backgroundColor: Color.optional(),
});

export const TableCellStyle = z.strictObject({
  paddingTop: Dimension.optional(),
  paddingBottom: Dimension.optional(),
  paddingLeft: Dimension.optional(),
  paddingRight: Dimension.optional(),
  backgroundColor: Color.optional(),
  borderLeft: CellBorder.optional(),
  borderTop: CellBorder.optional(),
  borderRight: CellBorder.optional(),
  borderBottom: CellBorder.optional(),
});

export const TableRowStyle = z.strictObject({
  minRowHeight: Dimension.optional(),
  preventOverflow: z.boolean().optional(),
});

export const TableColumnProperties = z.strictObject({
  widthType: z.enum(["FIXED_WIDTH", "EVENLY_DISTRIBUTED"]),
  width: Dimension.optional(),
});

export const BulletPreset = z.enum(["BULLET_DISC_CIRCLE_SQUARE", "NUMBERED_DECIMAL_ALPHA_ROMAN"]);
export type BulletPreset = z.infer<typeof BulletPreset>;

export const DocsRequest = z.union([
  z.strictObject({ insertText: z.strictObject({ text: z.string(), location: Location }) }),
  z.strictObject({
    updateParagraphStyle: z.strictObject({ paragraphStyle: ParagraphStyle, fields: Fields, range: Range }),
  }),
  z.strictObject({ updateTextStyle: z.strictObject({ textStyle: TextStyle, fields: Fields, range: Range }) }),
  z.strictObject({ createParagraphBullets: z.strictObject({ range: Range, bulletPreset: BulletPreset }) }),
  z.strictObject({ deleteContentRange: z.strictObject({ range: Range }) }),
  z.strictObject({ deleteParagraphBullets: z.strictObject({ range: Range }) }),
  z.strictObject({
    insertTable: z.strictObject({
      rows: z.number().int().min(1),
      columns: z.number().int().min(1),
      location: Location,
    }),
  }),
  z.strictObject({
    updateTableColumnProperties: z.strictObject({
      tableStartLocation: Location,
      columnIndices: z.array(z.number().int()),
      tableColumnProperties: TableColumnProperties,
      fields: Fields,
    }),
  }),
  z.strictObject({
    updateTableCellStyle: z.strictObject({
      tableCellStyle: TableCellStyle,
      fields: Fields,
      tableStartLocation: Location.optional(),
      tableRange: z
        .strictObject({
          tableCellLocation: z.strictObject({
            tableStartLocation: Location,
            rowIndex: z.number().int(),
            columnIndex: z.number().int(),
          }),
          rowSpan: z.number().int().min(1),
          columnSpan: z.number().int().min(1),
        })
        .optional(),
    }),
  }),
  z.strictObject({
    updateTableRowStyle: z.strictObject({
      tableStartLocation: Location,
      rowIndices: z.array(z.number().int()).optional(),
      tableRowStyle: TableRowStyle,
      fields: Fields,
    }),
  }),
]);

export type DocsRequest = z.infer<typeof DocsRequest>;

export const BatchUpdateBody = z.strictObject({ requests: z.array(DocsRequest).min(1) });
