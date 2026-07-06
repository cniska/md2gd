import type { Table } from "mdast";
import type { Dimension } from "./docs";
import { pt } from "./docs";
import { type InlineContent, inlineRuns } from "./inline";
import { TABLE_CONTENT_WIDTH_PT } from "./style";

/** The inline content of a single table cell. */
export type CellPlan = InlineContent;

/**
 * A structured, index-free description of a table. The send layer inserts the
 * empty table, reads back the real cell indices, then fills and styles cells —
 * so this plan carries no absolute document indices, only content and geometry.
 */
export interface TablePlan {
  rows: number;
  columns: number;
  /** Whether the first row is a header (GFM tables always have one). */
  header: boolean;
  /** Fixed width per column, distributed to fit the page content width. */
  columnWidths: Dimension[];
  /** Cell content indexed as cells[row][column]. */
  cells: CellPlan[][];
}

const EMPTY_CELL: CellPlan = { text: "", runs: [] };

export function buildTablePlan(table: Table): TablePlan {
  const cells: CellPlan[][] = table.children.map((row) => row.children.map((cell) => inlineRuns(cell.children)));
  const rows = cells.length;
  const columns = cells.reduce((max, row) => Math.max(max, row.length), 0);

  // Normalise ragged rows so every row has `columns` cells.
  for (const row of cells) {
    while (row.length < columns) row.push(EMPTY_CELL);
  }

  return {
    rows,
    columns,
    header: rows > 0,
    columnWidths: distributeColumnWidths(cells, columns),
    cells,
  };
}

/**
 * Distribute the page content width across columns in proportion to each
 * column's longest cell text, so description-heavy columns get more room and
 * the table never exceeds the page width. Falls back to equal widths.
 */
function distributeColumnWidths(cells: CellPlan[][], columns: number): Dimension[] {
  if (columns === 0) return [];

  const weights = Array.from({ length: columns }, (_, col) =>
    Math.max(1, ...cells.map((row) => row[col]?.text.length ?? 0)),
  );
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  return weights.map((w) => pt(round(TABLE_CONTENT_WIDTH_PT * (w / totalWeight))));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
