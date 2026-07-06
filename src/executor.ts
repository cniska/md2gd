import { convertNodes } from "./convert";
import { BODY_START_INDEX, type DocRequest, type DocumentResource, fieldMask, type TableCellStyle } from "./docs";
import type { Segment } from "./plan";
import { bodyFontTextStyle, CELL_PADDING, HEADER_SHADING } from "./style";
import type { TablePlan } from "./table";

/**
 * The Google surface the executor depends on. Injected so the executor is
 * tested against a mock and never touches the network in unit tests.
 */
export interface DocsClient {
  createDocument(title: string): Promise<{ documentId: string }>;
  batchUpdate(documentId: string, requests: DocRequest[]): Promise<void>;
  getDocument(documentId: string): Promise<DocumentResource>;
}

/**
 * Create a document and populate it from the planned segments. Linear segments
 * convert to deterministic requests; tables are inserted, read back for their
 * real cell indices, then filled — so no cell offsets are ever guessed.
 * Returns the new document id.
 */
export async function executeDocument(client: DocsClient, title: string, segments: Segment[]): Promise<string> {
  const { documentId } = await client.createDocument(title);
  let cursor = BODY_START_INDEX;

  for (const segment of segments) {
    if (segment.kind === "linear") {
      const { requests, endIndex } = convertNodes(segment.nodes, cursor);
      if (requests.length > 0) await client.batchUpdate(documentId, requests);
      cursor = endIndex;
    } else {
      cursor = await insertTableSegment(client, documentId, segment.table, cursor);
    }
  }

  return documentId;
}

async function insertTableSegment(
  client: DocsClient,
  documentId: string,
  plan: TablePlan,
  atIndex: number,
): Promise<number> {
  // 1. Insert the empty table structure.
  await client.batchUpdate(documentId, [
    { insertTable: { rows: plan.rows, columns: plan.columns, location: { index: atIndex } } },
  ]);

  // 2. Read back the real table start and per-cell content indices.
  const located = locateTable(await client.getDocument(documentId), atIndex);
  if (!located) throw new Error("md2gd: inserted table not found in document");

  // 3. Style the table and fill cells. Styling requests don't change indices;
  //    cell fills are ordered last-cell-first so each insertion never shifts a
  //    not-yet-filled cell's index.
  const requests: DocRequest[] = [
    ...columnWidthRequests(plan, located.startIndex),
    cellPaddingRequest(located.startIndex),
    ...(plan.header ? [headerShadingRequest(plan, located.startIndex)] : []),
    ...cellFillRequests(plan, located.cellIndices),
  ];
  await client.batchUpdate(documentId, requests);

  // 4. The table's size changed with the fills; read the new end to continue after it.
  return bodyEndInsertIndex(await client.getDocument(documentId));
}

interface LocatedTable {
  startIndex: number;
  /** cellIndices[row][col] = index at which to insert that cell's text. */
  cellIndices: number[][];
}

function locateTable(doc: DocumentResource, atIndex: number): LocatedTable | undefined {
  const element = (doc.body?.content ?? []).find((el) => el.table !== undefined && (el.startIndex ?? -1) >= atIndex);
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

function columnWidthRequests(plan: TablePlan, tableStart: number): DocRequest[] {
  // One request per column, since each column gets its own fixed width.
  return plan.columnWidths.map((width, columnIndex) => ({
    updateTableColumnProperties: {
      tableStartLocation: { index: tableStart },
      columnIndices: [columnIndex],
      tableColumnProperties: { widthType: "FIXED_WIDTH" as const, width },
      fields: "widthType,width",
    },
  }));
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
 * filled one. Within a cell, the text is inserted then its styled runs applied.
 */
function cellFillRequests(plan: TablePlan, cellIndices: number[][]): DocRequest[] {
  interface Fill {
    index: number;
    requests: DocRequest[];
  }
  const fills: Fill[] = [];

  for (let row = 0; row < plan.cells.length; row++) {
    const cellRow = plan.cells[row] ?? [];
    for (let col = 0; col < cellRow.length; col++) {
      const cell = cellRow[col];
      const index = cellIndices[row]?.[col];
      if (!cell || index === undefined || cell.text.length === 0) continue;

      const requests: DocRequest[] = [
        { insertText: { text: cell.text, location: { index } } },
        {
          updateTextStyle: {
            textStyle: bodyFontTextStyle,
            fields: fieldMask(bodyFontTextStyle),
            range: { startIndex: index, endIndex: index + cell.text.length },
          },
        },
      ];
      for (const run of cell.runs) {
        requests.push({
          updateTextStyle: {
            textStyle: run.style,
            fields: fieldMask(run.style),
            range: { startIndex: index + run.start, endIndex: index + run.end },
          },
        });
      }
      fills.push({ index, requests });
    }
  }

  return fills.sort((a, b) => b.index - a.index).flatMap((f) => f.requests);
}

function bodyEndInsertIndex(doc: DocumentResource): number {
  const content = doc.body?.content ?? [];
  const last = content[content.length - 1];
  // The body always ends with a paragraph whose newline is the final index;
  // insert new content just before it.
  return Math.max(BODY_START_INDEX, (last?.endIndex ?? BODY_START_INDEX + 1) - 1);
}
