import { z } from "zod";

type Style = Record<string, unknown>;

const TextRun = z.strictObject({ content: z.string(), textStyle: z.record(z.string(), z.unknown()) });
const ParagraphElement = z.strictObject({ startIndex: z.number(), endIndex: z.number(), textRun: TextRun });
const Bullet = z.strictObject({ listId: z.string(), nestingLevel: z.number().optional() });

type StructuralElement = {
  startIndex: number;
  endIndex: number;
  paragraph?: {
    elements: z.infer<typeof ParagraphElement>[];
    paragraphStyle: Style;
    bullet?: z.infer<typeof Bullet> | undefined;
  };
  table?: {
    rows: number;
    columns: number;
    tableRows: {
      startIndex: number;
      endIndex: number;
      tableRowStyle: Style;
      tableCells: { startIndex: number; endIndex: number; tableCellStyle: Style; content: StructuralElement[] }[];
    }[];
    tableStyle: { tableColumnProperties: Style[] };
  };
};

const Structural: z.ZodType<StructuralElement> = z.lazy(() =>
  z.union([
    z.strictObject({
      startIndex: z.number(),
      endIndex: z.number(),
      paragraph: z.strictObject({
        elements: z.array(ParagraphElement),
        paragraphStyle: z.record(z.string(), z.unknown()),
        bullet: Bullet.optional(),
      }),
    }),
    z.strictObject({
      startIndex: z.number(),
      endIndex: z.number(),
      table: z.strictObject({
        rows: z.number(),
        columns: z.number(),
        tableRows: z.array(
          z.strictObject({
            startIndex: z.number(),
            endIndex: z.number(),
            tableRowStyle: z.record(z.string(), z.unknown()),
            tableCells: z.array(
              z.strictObject({
                startIndex: z.number(),
                endIndex: z.number(),
                tableCellStyle: z.record(z.string(), z.unknown()),
                content: z.array(Structural),
              }),
            ),
          }),
        ),
        tableStyle: z.strictObject({ tableColumnProperties: z.array(z.record(z.string(), z.unknown())) }),
      }),
    }),
  ]),
);

const Dimension = z.strictObject({ magnitude: z.number(), unit: z.literal("PT") });

const Resource = z.strictObject({
  title: z.string(),
  documentId: z.string(),
  revisionId: z.string(),
  documentStyle: z.strictObject({
    pageSize: z.strictObject({ width: Dimension, height: Dimension }),
    marginLeft: Dimension,
    marginRight: Dimension,
    marginTop: Dimension,
    marginBottom: Dimension,
  }),
  body: z.strictObject({
    content: z.tuple([z.strictObject({ endIndex: z.literal(1), sectionBreak: z.unknown() })], Structural),
  }),
  namedStyles: z.strictObject({
    styles: z.array(
      z.looseObject({
        namedStyleType: z.string(),
        textStyle: z.record(z.string(), z.unknown()),
        paragraphStyle: z.record(z.string(), z.unknown()),
      }),
    ),
  }),
  lists: z.record(
    z.string(),
    z.strictObject({ listProperties: z.strictObject({ nestingLevels: z.array(z.record(z.string(), z.unknown())) }) }),
  ),
});

export type Run = { readonly text: string; readonly style: Style };

export type ParagraphView = {
  readonly text: string;
  readonly runs: readonly Run[];
  readonly style: Style;
  readonly bullet: { readonly listId: string; readonly nestingLevel: number } | undefined;
  readonly tableDepth: number;
};

export type CellView = { readonly style: Style; readonly blocks: readonly BlockView[] };

export type TableView = {
  readonly kind: "table";
  readonly rows: readonly (readonly CellView[])[];
  readonly rowStyles: readonly Style[];
  readonly columns: readonly Style[];
  readonly tableDepth: number;
};

export type BlockView = ({ readonly kind: "paragraph" } & ParagraphView) | TableView;

export type DocView = {
  readonly title: string;
  readonly contentWidth: number;
  readonly marginLeft: number;
  readonly marginRight: number;
  readonly blocks: readonly BlockView[];
  readonly paragraphs: readonly ParagraphView[];
  readonly tables: readonly TableView[];
  readonly lists: Readonly<Record<string, readonly Style[]>>;
  readonly namedTextStyles: Readonly<Record<string, Style>>;
};

function blocksOf(content: readonly StructuralElement[], depth: number): BlockView[] {
  return content.map((element): BlockView => {
    if (element.paragraph) {
      const runs = element.paragraph.elements.map((run) => ({
        text: run.textRun.content,
        style: run.textRun.textStyle,
      }));
      const bullet = element.paragraph.bullet;
      return {
        kind: "paragraph",
        text: runs
          .map((run) => run.text)
          .join("")
          .replace(/\n$/, ""),
        runs,
        style: element.paragraph.paragraphStyle,
        bullet: bullet ? { listId: bullet.listId, nestingLevel: bullet.nestingLevel ?? 0 } : undefined,
        tableDepth: depth,
      };
    }
    const table = element.table;
    if (!table) throw new Error("a structural element is neither a paragraph nor a table");
    return {
      kind: "table",
      rows: table.tableRows.map((row) =>
        row.tableCells.map((cell) => ({ style: cell.tableCellStyle, blocks: blocksOf(cell.content, depth + 1) })),
      ),
      rowStyles: table.tableRows.map((row) => row.tableRowStyle),
      columns: table.tableStyle.tableColumnProperties,
      tableDepth: depth,
    };
  });
}

function flatten(blocks: readonly BlockView[]): BlockView[] {
  return blocks.flatMap((block) =>
    block.kind === "paragraph"
      ? [block]
      : [block, ...block.rows.flatMap((row) => row.flatMap((cell) => flatten(cell.blocks)))],
  );
}
export function viewOf(resource: unknown): DocView {
  const parsed = Resource.parse(resource);
  const [, ...content] = parsed.body.content;
  const blocks = blocksOf(content, 0);
  const all = flatten(blocks);
  const style = parsed.documentStyle;
  return {
    title: parsed.title,
    contentWidth: style.pageSize.width.magnitude - style.marginLeft.magnitude - style.marginRight.magnitude,
    marginLeft: style.marginLeft.magnitude,
    marginRight: style.marginRight.magnitude,
    blocks,
    paragraphs: all.filter((block): block is { kind: "paragraph" } & ParagraphView => block.kind === "paragraph"),
    tables: all.filter((block): block is TableView => block.kind === "table"),
    namedTextStyles: Object.fromEntries(
      parsed.namedStyles.styles.map((named) => [named.namedStyleType, named.textStyle]),
    ),
    lists: Object.fromEntries(
      Object.entries(parsed.lists).map(([id, list]) => [id, list.listProperties.nestingLevels]),
    ),
  };
}

export const magnitude = (value: unknown): number | undefined =>
  z.object({ magnitude: z.number() }).safeParse(value).data?.magnitude;

export const fontOf = (style: Style): string | undefined =>
  z.object({ fontFamily: z.string() }).safeParse(style.weightedFontFamily).data?.fontFamily;
export function paragraph(view: DocView, text: string): ParagraphView {
  const found = view.paragraphs.filter((p) => p.text === text);
  if (found.length !== 1)
    throw new Error(
      `expected one paragraph "${text}", found ${found.length} in:\n${view.paragraphs.map((p) => p.text).join("\n")}`,
    );
  const [only] = found;
  if (!only) throw new Error("unreachable");
  return only;
}
export function run(p: ParagraphView, text: string): Run {
  const found = p.runs.find((r) => r.text === text || r.text === `${text}\n`);
  if (!found) throw new Error(`no run "${text}" in "${p.text}": ${JSON.stringify(p.runs.map((r) => r.text))}`);
  return found;
}
export function styleAt(p: ParagraphView, text: string): Style {
  const at = p.text.indexOf(text);
  if (at === -1) throw new Error(`"${text}" is not in "${p.text}"`);
  let offset = 0;
  const covering: Style[] = [];
  for (const r of p.runs) {
    const start = offset;
    offset += r.text.length;
    if (offset > at && start < at + text.length) covering.push(r.style);
  }
  const first = covering[0] ?? {};
  if (covering.some((style) => JSON.stringify(style) !== JSON.stringify(first)))
    throw new Error(`"${text}" spans runs of different style in "${p.text}"`);
  return first;
}
