import google from "../fixtures/probe.google.json";
import {
  type BulletPreset,
  type DocsRequest,
  ParagraphStyle,
  TableCellStyle,
  TableColumnProperties,
  TableRowStyle,
  TextStyle,
} from "./docs-requests";

export class InvalidDocsRequest extends Error {
  readonly status = 400;
}

type Style = Readonly<Record<string, unknown>>;
type Char = { readonly unit: string; readonly style: Style };
type Bullet = { readonly listId: string; readonly nestingLevel: number };
type Paragraph = { readonly kind: "paragraph"; chars: Char[]; style: Style; bullet: Bullet | undefined };
type Cell = { style: Style; content: Element[] };
type Row = { style: Style; cells: Cell[] };
type Table = { readonly kind: "table"; rows: Row[]; columns: Style[] };
type Element = Paragraph | Table;

type ParagraphVisit = {
  readonly kind: "paragraph";
  readonly node: Paragraph;
  readonly start: number;
  readonly end: number;
  readonly container: Element[];
  readonly index: number;
};
type ContainerVisit = { readonly kind: "container"; readonly content: Element[]; readonly start: number };
type TableVisit = {
  readonly kind: "table";
  readonly node: Table;
  readonly start: number;
  readonly end: number;
  readonly container: Element[];
};
type Visit = ParagraphVisit | ContainerVisit | TableVisit;

export type PageSetup = {
  readonly width: number;
  readonly height: number;
  readonly marginLeft: number;
  readonly marginRight: number;
  readonly marginTop: number;
  readonly marginBottom: number;
};

export const A4: PageSetup = {
  width: 595.2755905511812,
  height: 841.8897637795277,
  marginLeft: 72,
  marginRight: 72,
  marginTop: 72,
  marginBottom: 72,
};

const BODY_START = 1;
const LEVELS = 9;
const BULLET_GLYPHS = ["●", "○", "■"];
const NUMBER_GLYPHS = ["DECIMAL", "ALPHA", "ROMAN"];
const LIST_INDENT_PT = 36;
const LIST_FIRST_LINE_PT = 18;

const keysOf = (schema: { shape: Record<string, unknown> }): readonly string[] => Object.keys(schema.shape);
const PARAGRAPH_FIELDS = keysOf(ParagraphStyle);
const TEXT_FIELDS = keysOf(TextStyle);
const CELL_FIELDS = keysOf(TableCellStyle);
const ROW_FIELDS = keysOf(TableRowStyle);
const COLUMN_FIELDS = keysOf(TableColumnProperties);

function invalid(message: string): never {
  throw new InvalidDocsRequest(message);
}

function withFields(target: Style, source: Style, fields: string, allowed: readonly string[]): Style {
  const next: Record<string, unknown> = { ...target };
  for (const field of fields.split(",").map((name) => name.trim())) {
    if (!allowed.includes(field)) invalid(`Invalid field: ${field}`);
    if (source[field] === undefined) delete next[field];
    else next[field] = source[field];
  }
  return next;
}

const newline = (style: Style = {}): Char => ({ unit: "\n", style });
const emptyParagraph = (): Paragraph => ({ kind: "paragraph", chars: [newline()], style: {}, bullet: undefined });

function contentLength(content: readonly Element[]): number {
  return content.reduce((sum, element) => sum + elementLength(element), 0);
}

function elementLength(element: Element): number {
  if (element.kind === "paragraph") return element.chars.length;
  const rows = element.rows.reduce(
    (sum, row) => sum + 1 + row.cells.reduce((cells, cell) => cells + 1 + contentLength(cell.content), 0),
    0,
  );
  return 1 + rows + 1;
}

function* walk(content: Element[], start: number): Generator<Visit> {
  yield { kind: "container", content, start };
  let position = start;
  for (const [index, node] of content.entries()) {
    const end = position + elementLength(node);
    if (node.kind === "paragraph") {
      yield { kind: "paragraph", node, start: position, end, container: content, index };
    } else {
      yield { kind: "table", node, start: position, end, container: content };
      let inner = position + 1;
      for (const row of node.rows) {
        inner += 1;
        for (const cell of row.cells) {
          inner += 1;
          yield* walk(cell.content, inner);
          inner += contentLength(cell.content);
        }
      }
    }
    position = end;
  }
}

const isHigh = (unit: string | undefined): boolean => unit !== undefined && /[\uD800-\uDBFF]/.test(unit);
const isLow = (unit: string | undefined): boolean => unit !== undefined && /[\uDC00-\uDFFF]/.test(unit);

function splitAtNewlines(paragraph: Paragraph): Paragraph[] {
  const parts: Paragraph[] = [];
  let chars: Char[] = [];
  for (const char of paragraph.chars) {
    chars.push(char);
    if (char.unit === "\n") {
      parts.push({ kind: "paragraph", chars, style: paragraph.style, bullet: paragraph.bullet });
      chars = [];
    }
  }
  return parts;
}

export class DocsDocument {
  private body: Element[] = [emptyParagraph()];
  private lists = new Map<string, BulletPreset>();
  private listCount = 0;
  revision = 0;

  constructor(
    readonly id: string,
    readonly page: PageSetup,
  ) {}

  apply(requests: readonly DocsRequest[]): void {
    const saved = structuredClone({ body: this.body, lists: this.lists, listCount: this.listCount });
    try {
      for (const request of requests) this.applyOne(request);
    } catch (error) {
      this.body = saved.body;
      this.lists = saved.lists;
      this.listCount = saved.listCount;
      throw error;
    }
    this.revision += 1;
  }

  private end(): number {
    return BODY_START + contentLength(this.body);
  }

  private visits(): Visit[] {
    return [...walk(this.body, BODY_START)];
  }

  private paragraphAt(index: number): ParagraphVisit {
    const found = this.visits().find(
      (visit): visit is ParagraphVisit => visit.kind === "paragraph" && visit.start <= index && index < visit.end,
    );
    return found ?? invalid(`The insertion index ${index} must be inside the bounds of an existing paragraph.`);
  }

  private paragraphsIn(startIndex: number, endIndex: number): ParagraphVisit[] {
    if (endIndex <= startIndex) invalid("The range must have an end index greater than its start index.");
    if (startIndex < BODY_START || endIndex > this.end()) invalid("The range is outside the document.");
    return this.visits().filter(
      (visit): visit is ParagraphVisit =>
        visit.kind === "paragraph" && visit.start < endIndex && startIndex < visit.end,
    );
  }

  private tableAt(index: number): Table {
    const found = this.visits().find((visit): visit is TableVisit => visit.kind === "table" && visit.start === index);
    return found?.node ?? invalid(`The provided table start location ${index} is invalid.`);
  }

  private applyOne(request: DocsRequest): void {
    if ("insertText" in request) {
      this.insertText(request.insertText.text, request.insertText.location.index);
      return;
    }
    if ("insertTable" in request) {
      const { rows, columns, location } = request.insertTable;
      this.insertTable(rows, columns, location.index);
      return;
    }
    if ("deleteContentRange" in request) {
      const { startIndex, endIndex } = request.deleteContentRange.range;
      this.deleteContent(startIndex, endIndex);
      return;
    }
    if ("updateParagraphStyle" in request) {
      const { paragraphStyle, fields, range } = request.updateParagraphStyle;
      for (const { node } of this.paragraphsIn(range.startIndex, range.endIndex))
        node.style = withFields(node.style, paragraphStyle, fields, PARAGRAPH_FIELDS);
      return;
    }
    if ("updateTextStyle" in request) {
      const { textStyle, fields, range } = request.updateTextStyle;
      for (const visit of this.paragraphsIn(range.startIndex, range.endIndex)) {
        visit.node.chars = visit.node.chars.map((char, offset) => {
          const at = visit.start + offset;
          return at >= range.startIndex && at < range.endIndex
            ? { unit: char.unit, style: withFields(char.style, textStyle, fields, TEXT_FIELDS) }
            : char;
        });
      }
      return;
    }
    if ("createParagraphBullets" in request) {
      const { range, bulletPreset } = request.createParagraphBullets;
      this.createBullets(range.startIndex, range.endIndex, bulletPreset);
      return;
    }
    if ("deleteParagraphBullets" in request) {
      const { range } = request.deleteParagraphBullets;
      for (const { node } of this.paragraphsIn(range.startIndex, range.endIndex)) {
        if (node.bullet === undefined) continue;
        const level = node.bullet.nestingLevel;
        node.style = {
          ...node.style,
          indentStart: { magnitude: LIST_INDENT_PT * (level + 1), unit: "PT" },
          indentFirstLine: { magnitude: LIST_FIRST_LINE_PT + LIST_INDENT_PT * level, unit: "PT" },
        };
        node.bullet = undefined;
      }
      return;
    }
    if ("updateTableColumnProperties" in request) {
      const { tableStartLocation, columnIndices, tableColumnProperties, fields } = request.updateTableColumnProperties;
      const table = this.tableAt(tableStartLocation.index);
      for (const column of columnIndices) {
        const current = table.columns[column] ?? invalid(`Column ${column} is outside the table.`);
        table.columns[column] = withFields(current, tableColumnProperties, fields, COLUMN_FIELDS);
      }
      return;
    }
    if ("updateTableCellStyle" in request) {
      const { tableCellStyle, fields, tableStartLocation, tableRange } = request.updateTableCellStyle;
      if ((tableStartLocation === undefined) === (tableRange === undefined))
        invalid("Exactly one of tableStartLocation and tableRange must be set.");
      const table = this.tableAt(
        tableStartLocation?.index ?? tableRange?.tableCellLocation.tableStartLocation.index ?? -1,
      );
      table.rows.forEach((row, rowIndex) => {
        row.cells.forEach((cell, columnIndex) => {
          const location = tableRange?.tableCellLocation;
          const inRange =
            tableRange === undefined ||
            location === undefined ||
            (rowIndex >= location.rowIndex &&
              rowIndex < location.rowIndex + tableRange.rowSpan &&
              columnIndex >= location.columnIndex &&
              columnIndex < location.columnIndex + tableRange.columnSpan);
          if (inRange) cell.style = withFields(cell.style, tableCellStyle, fields, CELL_FIELDS);
        });
      });
      return;
    }
    if ("updateTableRowStyle" in request) {
      const { tableStartLocation, rowIndices, tableRowStyle, fields } = request.updateTableRowStyle;
      const table = this.tableAt(tableStartLocation.index);
      const targets = rowIndices ?? table.rows.map((_, index) => index);
      for (const index of targets) {
        const row = table.rows[index] ?? invalid(`Row ${index} is outside the table.`);
        row.style = withFields(row.style, tableRowStyle, fields, ROW_FIELDS);
      }
      return;
    }
    request satisfies never;
  }

  private insertText(text: string, index: number): void {
    if (text.length === 0) invalid("The text to insert must not be empty.");
    const visit = this.paragraphAt(index);
    const offset = index - visit.start;
    const chars = visit.node.chars;
    if (isHigh(chars[offset - 1]?.unit) && isLow(chars[offset]?.unit))
      invalid(`The insertion index ${index} splits a surrogate pair.`);
    const inherited = offset > 0 ? chars[offset - 1]?.style : chars[offset]?.style;
    const { link: _link, ...style } = inherited ?? {};
    const inserted = Array.from({ length: text.length }, (_, i) => ({ unit: text.charAt(i), style }));
    const grown: Paragraph = { ...visit.node, chars: [...chars.slice(0, offset), ...inserted, ...chars.slice(offset)] };
    visit.container.splice(visit.index, 1, ...splitAtNewlines(grown));
  }

  private insertTable(rows: number, columns: number, index: number): void {
    const visit = this.paragraphAt(index);
    const offset = index - visit.start;
    const chars = visit.node.chars;
    const before: Paragraph = {
      kind: "paragraph",
      chars: [...chars.slice(0, offset), newline(chars[offset]?.style)],
      style: visit.node.style,
      bullet: visit.node.bullet,
    };
    const after: Paragraph = { ...visit.node, chars: chars.slice(offset) };
    const table: Table = {
      kind: "table",
      rows: Array.from({ length: rows }, () => ({
        style: {},
        cells: Array.from({ length: columns }, () => ({ style: {}, content: [emptyParagraph()] })),
      })),
      columns: Array.from({ length: columns }, () => ({ widthType: "EVENLY_DISTRIBUTED" })),
    };
    visit.container.splice(visit.index, 1, before, table, after);
  }

  private deleteContent(startIndex: number, endIndex: number): void {
    if (endIndex <= startIndex) invalid("The range must have an end index greater than its start index.");
    const owner = this.visits()
      .filter((visit): visit is ContainerVisit => visit.kind === "container")
      .filter((visit) => visit.start <= startIndex && endIndex <= visit.start + contentLength(visit.content))
      .at(-1);
    if (owner === undefined) invalid("Invalid deletion range. Cannot delete the requested range.");
    if (endIndex === owner.start + contentLength(owner.content))
      invalid("Invalid deletion range. Cannot delete the final newline of a segment.");

    const kept: Element[] = [];
    let position = owner.start;
    for (const element of owner.content) {
      const start = position;
      const end = start + elementLength(element);
      position = end;
      if (end <= startIndex || endIndex <= start) {
        kept.push(element);
      } else if (element.kind === "table") {
        if (start < startIndex || endIndex < end) invalid("Invalid deletion range. Cannot delete the requested range.");
      } else {
        const chars = element.chars.filter((_, offset) => start + offset < startIndex || start + offset >= endIndex);
        if (chars.length > 0) kept.push({ ...element, chars });
      }
    }

    const merged: Element[] = [];
    for (const element of kept) {
      const previous = merged.at(-1);
      if (previous?.kind === "paragraph" && previous.chars.at(-1)?.unit !== "\n") {
        if (element.kind === "table") invalid("Invalid deletion range. Cannot delete the requested range.");
        merged[merged.length - 1] = { ...element, chars: [...previous.chars, ...element.chars] };
      } else {
        merged.push(element);
      }
    }
    owner.content.splice(0, owner.content.length, ...merged);
  }

  private createBullets(startIndex: number, endIndex: number, preset: BulletPreset): void {
    const targets = this.paragraphsIn(startIndex, endIndex);
    const first = targets[0];
    if (first === undefined) return;
    const previous = first.container[first.index - 1];
    const joined =
      previous?.kind === "paragraph" && previous.bullet && this.lists.get(previous.bullet.listId) === preset
        ? previous.bullet.listId
        : undefined;
    const listId = joined ?? this.newList(preset);
    for (const { node } of targets) {
      const tabs = node.chars.findIndex((char) => char.unit !== "\t");
      node.chars = node.chars.slice(tabs);
      node.bullet = { listId, nestingLevel: tabs };
    }
  }

  private newList(preset: BulletPreset): string {
    this.listCount += 1;
    const listId = `kix.list${this.listCount}`;
    this.lists.set(listId, preset);
    return listId;
  }

  resource(title: string): Record<string, unknown> {
    const dimension = (magnitude: number) => ({ magnitude, unit: "PT" });
    return {
      title,
      documentId: this.id,
      revisionId: `rev-${this.revision}`,
      documentStyle: {
        pageSize: { width: dimension(this.page.width), height: dimension(this.page.height) },
        marginLeft: dimension(this.page.marginLeft),
        marginRight: dimension(this.page.marginRight),
        marginTop: dimension(this.page.marginTop),
        marginBottom: dimension(this.page.marginBottom),
      },
      body: {
        content: [
          {
            endIndex: BODY_START,
            sectionBreak: {
              sectionStyle: {
                columnSeparatorStyle: "NONE",
                contentDirection: "LEFT_TO_RIGHT",
                sectionType: "CONTINUOUS",
              },
            },
          },
          ...renderContent(this.body, BODY_START),
        ],
      },
      namedStyles: google.namedStyles,
      lists: Object.fromEntries(
        [...this.lists].map(([listId, preset]) => [
          listId,
          {
            listProperties: {
              nestingLevels: Array.from({ length: LEVELS }, (_, level) =>
                preset === "BULLET_DISC_CIRCLE_SQUARE"
                  ? { glyphSymbol: BULLET_GLYPHS[level % BULLET_GLYPHS.length] }
                  : { glyphType: NUMBER_GLYPHS[level % NUMBER_GLYPHS.length], glyphFormat: `%${level}.` },
              ),
            },
          },
        ]),
      ),
    };
  }
}

const sameStyle = (a: Style, b: Style): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (style: Style): Style =>
  Object.fromEntries(Object.entries(style).sort(([a], [b]) => a.localeCompare(b)));

function renderContent(content: readonly Element[], start: number): Record<string, unknown>[] {
  let position = start;
  return content.map((element) => {
    const rendered = element.kind === "paragraph" ? renderParagraph(element, position) : renderTable(element, position);
    position += elementLength(element);
    return rendered;
  });
}

function renderParagraph(paragraph: Paragraph, start: number): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];
  let runStart = 0;
  for (let offset = 1; offset <= paragraph.chars.length; offset++) {
    const current = paragraph.chars[offset];
    const runFirst = paragraph.chars[runStart];
    if (current !== undefined && runFirst !== undefined && sameStyle(current.style, runFirst.style)) continue;
    elements.push({
      startIndex: start + runStart,
      endIndex: start + offset,
      textRun: {
        content: paragraph.chars
          .slice(runStart, offset)
          .map((char) => char.unit)
          .join(""),
        textStyle: runFirst?.style ?? {},
      },
    });
    runStart = offset;
  }
  const bullet =
    paragraph.bullet === undefined
      ? {}
      : {
          bullet: {
            listId: paragraph.bullet.listId,
            ...(paragraph.bullet.nestingLevel > 0 ? { nestingLevel: paragraph.bullet.nestingLevel } : {}),
          },
        };
  return {
    startIndex: start,
    endIndex: start + paragraph.chars.length,
    paragraph: {
      elements,
      paragraphStyle: { namedStyleType: "NORMAL_TEXT", ...paragraph.style },
      ...bullet,
    },
  };
}

function renderTable(table: Table, start: number): Record<string, unknown> {
  let position = start + 1;
  const tableRows = table.rows.map((row) => {
    const rowStart = position;
    position += 1;
    const tableCells = row.cells.map((cell) => {
      const cellStart = position;
      const content = renderContent(cell.content, cellStart + 1);
      position = cellStart + 1 + contentLength(cell.content);
      return { startIndex: cellStart, endIndex: position, content, tableCellStyle: cell.style };
    });
    return { startIndex: rowStart, endIndex: position, tableCells, tableRowStyle: row.style };
  });
  return {
    startIndex: start,
    endIndex: position + 1,
    table: {
      rows: table.rows.length,
      columns: table.columns.length,
      tableRows,
      tableStyle: { tableColumnProperties: table.columns },
    },
  };
}
