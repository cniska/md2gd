import { convertLeaves } from "./convert";
import {
  BODY_START_INDEX,
  type DocRequest,
  type DocStructuralElement,
  type DocumentResource,
  fieldMask,
  pt,
} from "./docs";
import type { Leaf, QuoteSegment, Segment } from "./plan";
import {
  headerCellStyle,
  normalParagraphStyle,
  type ParagraphStyleSpec,
  preTableKeptParagraphStyle,
  preTableParagraphStyle,
  preTableTextStyle,
  QUOTE_INSET_PT,
  quoteCellStyle,
  tableCellStyle,
  tableRowStyle,
} from "./style";
import { columnWidths, type TablePlan } from "./table";

export interface DocsClient {
  createDocument(title: string, folderId?: string): Promise<{ documentId: string }>;
  batchUpdate(documentId: string, requests: DocRequest[]): Promise<void>;
  getDocument(documentId: string): Promise<DocumentResource>;
  renameDocument(documentId: string, name: string): Promise<void>;
  moveDocument(documentId: string, folderId: string): Promise<void>;
}

export async function executeDocument(
  client: DocsClient,
  title: string,
  segments: Segment[],
  folderId?: string,
): Promise<string> {
  const { documentId } = await client.createDocument(title, folderId);
  await fillSegments(client, documentId, segments);
  return documentId;
}

export async function updateDocument(
  client: DocsClient,
  documentId: string,
  title: string,
  segments: Segment[],
  folderId?: string,
): Promise<void> {
  let doc: DocumentResource;
  try {
    doc = await client.getDocument(documentId);
  } catch (error) {
    if (error instanceof Error && /\((?:403|404)\)/.test(error.message)) {
      throw new Error(
        `md2gd: cannot open document ${documentId} for update — check the URL/id and that you have edit access`,
      );
    }
    throw error;
  }

  if (folderId) await client.moveDocument(documentId, folderId);
  const clear = clearBodyRequests(doc);
  if (clear.length > 0) await client.batchUpdate(documentId, clear);
  await fillSegments(client, documentId, segments);
  if (doc.title !== title) await client.renameDocument(documentId, title);
}

async function fillSegments(client: DocsClient, documentId: string, segments: Segment[]): Promise<void> {
  await fillContainer(client, documentId, segments, BODY_START_INDEX, { inset: 0, isCell: false });
}

interface Container {
  inset: number;
  isCell: boolean;
}

async function fillContainer(
  client: DocsClient,
  documentId: string,
  segments: Segment[],
  startIndex: number,
  container: Container,
): Promise<number> {
  let cursor = startIndex;
  for (const [i, segment] of segments.entries()) {
    switch (segment.kind) {
      case "linear": {
        const { requests, endIndex } = convertLeaves(segment.leaves, cursor, {
          afterTable: segment.afterTable,
          startsContainer: container.isCell && i === 0,
          endsContainer: container.isCell && i === segments.length - 1,
        });
        if (requests.length > 0) await client.batchUpdate(documentId, requests);
        cursor = endIndex;
        break;
      }
      case "table":
        cursor = await insertTableSegment(client, documentId, segment.table, cursor, container.inset);
        break;
      case "quote":
        cursor = await insertQuoteSegment(client, documentId, segment, cursor, container.inset);
        break;
    }
  }
  return cursor;
}

function clearBodyRequests(doc: DocumentResource): DocRequest[] {
  const requests: DocRequest[] = [];
  const end = bodyEndInsertIndex(doc);
  if (end > BODY_START_INDEX) {
    requests.push({ deleteContentRange: { range: { startIndex: BODY_START_INDEX, endIndex: end } } });
  }

  const reset = normalParagraphStyle;
  const range = { startIndex: BODY_START_INDEX, endIndex: BODY_START_INDEX + 1 };
  requests.push({ updateParagraphStyle: { paragraphStyle: reset.paragraphStyle, fields: reset.fields, range } });
  requests.push({ deleteParagraphBullets: { range } });
  return requests;
}

async function insertTableSegment(
  client: DocsClient,
  documentId: string,
  plan: TablePlan,
  atIndex: number,
  inset: number,
): Promise<number> {
  await client.batchUpdate(documentId, [
    { insertTable: { rows: plan.rows, columns: plan.columns, location: { index: atIndex } } },
  ]);

  const doc = await client.getDocument(documentId);
  const located = locateTable(doc, atIndex);
  if (!located) throw new Error("md2gd: inserted table not found in document");
  const contentWidth = pageContentWidth(doc) - inset;

  const requests: DocRequest[] = [
    ...preTableSpacerRequests(located.startIndex),
    ...columnWidthRequests(plan, contentWidth, located.startIndex),
    cellStyleRequest(located.startIndex),
    rowStyleRequest(located.startIndex),
    ...(plan.header ? [headerCellStyleRequest(plan, located.startIndex)] : []),
    ...cellFillRequests(plan, located.cellIndices),
  ];
  await client.batchUpdate(documentId, requests);

  return tableEndIndex(await client.getDocument(documentId), located.startIndex);
}

async function insertQuoteSegment(
  client: DocsClient,
  documentId: string,
  quote: QuoteSegment,
  atIndex: number,
  inset: number,
): Promise<number> {
  await client.batchUpdate(documentId, [{ insertTable: { rows: 1, columns: 1, location: { index: atIndex } } }]);
  const doc = await client.getDocument(documentId);
  const located = locateTable(doc, atIndex);
  const cellStart = located?.cellIndices[0]?.[0];
  if (!located || cellStart === undefined) throw new Error("md2gd: inserted quote not found in document");

  const width = pt(pageContentWidth(doc) - inset);
  await client.batchUpdate(documentId, [
    ...preTableSpacerRequests(located.startIndex),
    {
      updateTableColumnProperties: {
        tableStartLocation: { index: located.startIndex },
        columnIndices: [0],
        tableColumnProperties: { widthType: "FIXED_WIDTH", width },
        fields: "widthType,width",
      },
    },
    {
      updateTableCellStyle: {
        tableCellStyle: quoteCellStyle,
        fields: fieldMask(quoteCellStyle),
        tableStartLocation: { index: located.startIndex },
      },
    },
  ]);

  const end = await fillContainer(client, documentId, quote.segments, cellStart, {
    inset: inset + QUOTE_INSET_PT,
    isCell: true,
  });
  const last = quote.segments.at(-1);
  if (last !== undefined && last.kind !== "linear")
    await client.batchUpdate(documentId, spacerRequests(end, preTableParagraphStyle));

  return tableEndIndex(await client.getDocument(documentId), located.startIndex);
}

function pageContentWidth(doc: DocumentResource): number {
  const style = doc.documentStyle;
  const page = style?.pageSize?.width?.magnitude;
  if (page === undefined) throw new Error("md2gd: document has no page size to fit tables to");
  return page - (style?.marginLeft?.magnitude ?? 0) - (style?.marginRight?.magnitude ?? 0);
}

interface LocatedTable {
  startIndex: number;
  cellIndices: number[][];
}

function findTable(
  content: DocStructuralElement[],
  matches: (start: number) => boolean,
): DocStructuralElement | undefined {
  for (const element of content) {
    if (!element.table || element.startIndex === undefined) continue;
    if (matches(element.startIndex)) return element;
    for (const row of element.table.tableRows) {
      for (const cell of row.tableCells) {
        const found = findTable(cell.content, matches);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function tableEndIndex(doc: DocumentResource, tableStart: number): number {
  const end = findTable(doc.body?.content ?? [], (start) => start === tableStart)?.endIndex;
  if (end === undefined) throw new Error("md2gd: filled table not found in document");
  return end;
}

function locateTable(doc: DocumentResource, atIndex: number): LocatedTable | undefined {
  const element = findTable(doc.body?.content ?? [], (start) => start >= atIndex);
  if (!element?.table || element.startIndex === undefined) return undefined;

  const cellIndices = element.table.tableRows.map((row) =>
    row.tableCells.map((cell) => {
      const index = cell.content[0]?.startIndex;
      if (index === undefined) throw new Error("md2gd: table cell has no content index");
      return index;
    }),
  );
  return { startIndex: element.startIndex, cellIndices };
}

function preTableSpacerRequests(tableStart: number): DocRequest[] {
  const paragraphStart = tableStart - 1;
  if (paragraphStart < BODY_START_INDEX) return [];
  return spacerRequests(paragraphStart, preTableKeptParagraphStyle);
}

function spacerRequests(paragraphStart: number, style: ParagraphStyleSpec): DocRequest[] {
  const range = { startIndex: paragraphStart, endIndex: paragraphStart + 1 };
  return [
    {
      updateParagraphStyle: {
        paragraphStyle: style.paragraphStyle,
        fields: style.fields,
        range,
      },
    },
    { updateTextStyle: { textStyle: preTableTextStyle, fields: fieldMask(preTableTextStyle), range } },
  ];
}

function columnWidthRequests(plan: TablePlan, contentWidth: number, tableStart: number): DocRequest[] {
  return columnWidths(plan, contentWidth).map((width, columnIndex) => ({
    updateTableColumnProperties: {
      tableStartLocation: { index: tableStart },
      columnIndices: [columnIndex],
      tableColumnProperties: { widthType: "FIXED_WIDTH" as const, width },
      fields: "widthType,width",
    },
  }));
}

function rowStyleRequest(tableStart: number): DocRequest {
  return {
    updateTableRowStyle: {
      tableStartLocation: { index: tableStart },
      tableRowStyle: tableRowStyle,
      fields: fieldMask(tableRowStyle),
    },
  };
}

function cellStyleRequest(tableStart: number): DocRequest {
  return {
    updateTableCellStyle: {
      tableCellStyle: tableCellStyle,
      fields: fieldMask(tableCellStyle),
      tableStartLocation: { index: tableStart },
    },
  };
}

function headerCellStyleRequest(plan: TablePlan, tableStart: number): DocRequest {
  return {
    updateTableCellStyle: {
      tableCellStyle: headerCellStyle,
      fields: fieldMask(headerCellStyle),
      tableRange: {
        tableCellLocation: { tableStartLocation: { index: tableStart }, rowIndex: 0, columnIndex: 0 },
        rowSpan: 1,
        columnSpan: plan.columns,
      },
    },
  };
}

function cellFillRequests(plan: TablePlan, cellIndices: number[][]): DocRequest[] {
  const fills = plan.cells.flatMap((cellRow, row) =>
    cellRow.flatMap((cell, col) => {
      const index = cellIndices[row]?.[col];
      if (index === undefined) return [];
      const leaf: Leaf = {
        node: { type: "paragraph", children: cell.content },
        context: { cell: { header: plan.header && row === 0, align: plan.align[col] ?? null } },
      };
      const fill = convertLeaves([leaf], index, { startsContainer: true, endsContainer: true });
      return [{ index, requests: fill.requests }];
    }),
  );

  return fills.sort((a, b) => b.index - a.index).flatMap((f) => f.requests);
}

function bodyEndInsertIndex(doc: DocumentResource): number {
  const content = doc.body?.content ?? [];
  const last = content[content.length - 1];
  return Math.max(BODY_START_INDEX, (last?.endIndex ?? BODY_START_INDEX + 1) - 1);
}
