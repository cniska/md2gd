import { convertLeaves } from "./convert";
import {
  BODY_START_INDEX,
  type DocRequest,
  type DocStructuralElement,
  type DocumentResource,
  fieldMask,
  pt,
  type TableCellStyle,
} from "./docs";
import type { Leaf, QuoteSegment, Segment } from "./plan";
import {
  CELL_PADDING,
  HEADER_SHADING,
  normalParagraphStyle,
  preTableParagraphStyle,
  preTableTextStyle,
  QUOTE_INSET_PT,
  quoteCellStyle,
} from "./style";
import { columnWidths, type TablePlan } from "./table";

/**
 * The Google surface the executor depends on. Injected so the executor is
 * tested against a mock and never touches the network in unit tests.
 */
export interface DocsClient {
  createDocument(title: string, folderId?: string): Promise<{ documentId: string }>;
  batchUpdate(documentId: string, requests: DocRequest[]): Promise<void>;
  getDocument(documentId: string): Promise<DocumentResource>;
  /** Rename the underlying Drive file (used to keep an updated doc's title in sync). */
  renameDocument(documentId: string, name: string): Promise<void>;
  /** Move the underlying Drive file into the given folder (used by `--update --folder`). */
  moveDocument(documentId: string, folderId: string): Promise<void>;
}

/**
 * Create a document and populate it from the planned segments. Linear segments
 * convert to deterministic requests; tables are inserted, read back for their
 * real cell indices, then filled — so no cell offsets are ever guessed.
 * Returns the new document id.
 */
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

/**
 * Re-render an existing document in place ("stable URL" mode). The doc is read
 * first (so an auth/404/permission failure leaves it untouched — FR-39), its
 * body cleared, then the normal fill pipeline runs into the emptied doc. If the
 * desired title differs from the doc's current name, the Drive file is renamed
 * so the title tracks the H1 (FR-41). The URL and Drive location never change.
 */
export async function updateDocument(
  client: DocsClient,
  documentId: string,
  title: string,
  segments: Segment[],
  folderId?: string,
): Promise<void> {
  // Read before any destructive call, so a missing or inaccessible target leaves
  // it untouched (FR-39). A 403/404 means the id is wrong, the doc was trashed,
  // or the user lacks access — translate it to an actionable message. Only the
  // read is wrapped; later failures surface as-is.
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

  // Relocate before clearing, so a bad --folder fails before the body is touched.
  if (folderId) await client.moveDocument(documentId, folderId);
  const clear = clearBodyRequests(doc);
  if (clear.length > 0) await client.batchUpdate(documentId, clear);
  await fillSegments(client, documentId, segments);
  if (doc.title !== title) await client.renameDocument(documentId, title);
}

/** Populate a document (create or freshly cleared) from planned segments. */
async function fillSegments(client: DocsClient, documentId: string, segments: Segment[]): Promise<void> {
  await fillContainer(client, documentId, segments, BODY_START_INDEX, { inset: 0, isCell: false });
}

/** Where segments are written: the body, or a quote's cell this many points in from the page's content edge. */
interface Container {
  inset: number;
  isCell: boolean;
}

/**
 * Write segments into a container from `startIndex`, returning the index after
 * them. Content is only ever appended at the end of the innermost open
 * container, so nothing before the cursor moves while a container fills.
 */
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

/**
 * Requests that empty a document's body. Deletes all content except the final
 * undeletable newline, then resets the surviving paragraph to NORMAL_TEXT with
 * no bullets so the previous render's trailing heading/list style can't bleed
 * into the new content (FR-40). An already-empty body skips the delete.
 */
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
  // 1. Insert the empty table structure.
  await client.batchUpdate(documentId, [
    { insertTable: { rows: plan.rows, columns: plan.columns, location: { index: atIndex } } },
  ]);

  // 2. Read back the real table start and per-cell content indices, and the page
  //    the columns must fit.
  const doc = await client.getDocument(documentId);
  const located = locateTable(doc, atIndex);
  if (!located) throw new Error("md2gd: inserted table not found in document");
  const contentWidth = pageContentWidth(doc) - inset;

  // 3. Style the table and fill cells. Styling requests don't change indices;
  //    cell fills are ordered last-cell-first so each insertion never shifts a
  //    not-yet-filled cell's index.
  const requests: DocRequest[] = [
    ...preTableSpacerRequests(located.startIndex),
    ...columnWidthRequests(plan, contentWidth, located.startIndex),
    cellPaddingRequest(located.startIndex),
    preventRowSplitRequest(located.startIndex),
    ...(plan.header ? [headerShadingRequest(plan, located.startIndex)] : []),
    ...cellFillRequests(plan, located.cellIndices),
  ];
  await client.batchUpdate(documentId, requests);

  // 4. The table's size changed with the fills; read its new end to continue after it.
  return tableEndIndex(await client.getDocument(documentId), located.startIndex);
}

/**
 * Insert a quote as a one-cell table with only a left accent, then fill its cell
 * with the quote's own segments through the same path as the body.
 */
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
  // A cell keeps a paragraph of its own after a table it ends with; pin it like
  // the spacer before every table, so it reads as the same thin gap.
  const last = quote.segments.at(-1);
  if (last !== undefined && last.kind !== "linear") await client.batchUpdate(documentId, spacerRequests(end));

  return tableEndIndex(await client.getDocument(documentId), located.startIndex);
}

/**
 * The width between the document's side margins. A document keeps the paper size
 * of the account that created it (A4 or US Letter), so it is read, never assumed.
 */
function pageContentWidth(doc: DocumentResource): number {
  const style = doc.documentStyle;
  const page = style?.pageSize?.width?.magnitude;
  if (page === undefined) throw new Error("md2gd: document has no page size to fit tables to");
  return page - (style?.marginLeft?.magnitude ?? 0) - (style?.marginRight?.magnitude ?? 0);
}

interface LocatedTable {
  startIndex: number;
  /** cellIndices[row][col] = index at which to insert that cell's text. */
  cellIndices: number[][];
}

/**
 * The first table, in document order and at any depth, that starts where `matches`
 * says. A table that starts earlier is an ancestor or an earlier sibling, so it
 * is searched through rather than matched.
 */
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

/**
 * Pin the empty paragraph the API injects before the table to a thin,
 * deterministic spacer. Skipped when the table starts at the body's first index
 * (no paragraph precedes it). This is what makes create and update modes render
 * tables identically, and lets a preceding caption group with its table.
 */
function preTableSpacerRequests(tableStart: number): DocRequest[] {
  const paragraphStart = tableStart - 1;
  if (paragraphStart < BODY_START_INDEX) return [];
  return spacerRequests(paragraphStart);
}

/** Style the empty paragraph at `paragraphStart` as the thin gap that sits beside every table. */
function spacerRequests(paragraphStart: number): DocRequest[] {
  const range = { startIndex: paragraphStart, endIndex: paragraphStart + 1 };
  return [
    {
      updateParagraphStyle: {
        paragraphStyle: preTableParagraphStyle.paragraphStyle,
        fields: preTableParagraphStyle.fields,
        range,
      },
    },
    { updateTextStyle: { textStyle: preTableTextStyle, fields: fieldMask(preTableTextStyle), range } },
  ];
}

function columnWidthRequests(plan: TablePlan, contentWidth: number, tableStart: number): DocRequest[] {
  // One request per column, since each column gets its own fixed width.
  return columnWidths(plan, contentWidth).map((width, columnIndex) => ({
    updateTableColumnProperties: {
      tableStartLocation: { index: tableStart },
      columnIndices: [columnIndex],
      tableColumnProperties: { widthType: "FIXED_WIDTH" as const, width },
      fields: "widthType,width",
    },
  }));
}

function preventRowSplitRequest(tableStart: number): DocRequest {
  // Applies to every row (no rowIndices) so a row is never split across a page
  // break — the whole row moves to the next page instead.
  const style = { preventOverflow: true };
  return {
    updateTableRowStyle: { tableStartLocation: { index: tableStart }, tableRowStyle: style, fields: fieldMask(style) },
  };
}

function cellPaddingRequest(tableStart: number): DocRequest {
  const style: TableCellStyle = {
    paddingTop: CELL_PADDING,
    paddingBottom: CELL_PADDING,
    paddingLeft: CELL_PADDING,
    paddingRight: CELL_PADDING,
  };
  return {
    updateTableCellStyle: {
      tableCellStyle: style,
      fields: fieldMask(style),
      tableStartLocation: { index: tableStart },
    },
  };
}

function headerShadingRequest(plan: TablePlan, tableStart: number): DocRequest {
  const style: TableCellStyle = { backgroundColor: HEADER_SHADING };
  return {
    updateTableCellStyle: {
      tableCellStyle: style,
      fields: fieldMask(style),
      tableRange: {
        tableCellLocation: { tableStartLocation: { index: tableStart }, rowIndex: 0, columnIndex: 0 },
        rowSpan: 1,
        columnSpan: plan.columns,
      },
    },
  };
}

/**
 * Build fill requests for every cell, ordered by descending index so that
 * inserting into a later cell never shifts the index of an earlier, not-yet-
 * filled one. A cell is a container holding one paragraph, written through the
 * same converter as every other block.
 */
function cellFillRequests(plan: TablePlan, cellIndices: number[][]): DocRequest[] {
  const fills = plan.cells.flatMap((cellRow, row) =>
    cellRow.flatMap((cell, col) => {
      const index = cellIndices[row]?.[col];
      if (index === undefined) return [];
      const leaf: Leaf = { node: { type: "paragraph", children: cell.content }, context: {} };
      const fill = convertLeaves([leaf], index, { startsContainer: true, endsContainer: true });
      return [{ index, requests: fill.requests }];
    }),
  );

  return fills.sort((a, b) => b.index - a.index).flatMap((f) => f.requests);
}

function bodyEndInsertIndex(doc: DocumentResource): number {
  const content = doc.body?.content ?? [];
  const last = content[content.length - 1];
  // The body always ends with a paragraph whose newline is the final index;
  // insert new content just before it.
  return Math.max(BODY_START_INDEX, (last?.endIndex ?? BODY_START_INDEX + 1) - 1);
}
