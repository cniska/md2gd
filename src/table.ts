import type { Table } from "mdast";
import type { Dimension } from "./docs";
import { pt } from "./docs";
import { type InlineContent, inlineRuns } from "./inline";
import { MIN_COLUMN_WIDTH_PT, TABLE_CONTENT_WIDTH_PT } from "./style";

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

function emptyCell(): CellPlan {
  return { text: "", runs: [] };
}

export function buildTablePlan(table: Table): TablePlan {
  const cells: CellPlan[][] = table.children.map((row) => row.children.map((cell) => inlineRuns(cell.children)));
  const rows = cells.length;
  const columns = cells.reduce((max, row) => Math.max(max, row.length), 0);

  // Normalise ragged rows so every row has `columns` cells. Each padding cell is
  // a fresh object, never a shared reference.
  for (const row of cells) {
    while (row.length < columns) row.push(emptyCell());
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
 * column's longest cell text, but floor every column at a minimum so a
 * short-content column (e.g. a status column beside long descriptions) never
 * collapses. Any column whose proportional share falls below the floor is
 * pinned to it, and the remaining width is shared among the rest by weight.
 */
function distributeColumnWidths(cells: CellPlan[][], columns: number): Dimension[] {
  if (columns === 0) return [];

  const weights = Array.from({ length: columns }, (_, col) =>
    Math.max(1, ...cells.map((row) => row[col]?.text.length ?? 0)),
  );

  // If flooring every column already exceeds the page, just split evenly.
  if (columns * MIN_COLUMN_WIDTH_PT >= TABLE_CONTENT_WIDTH_PT) {
    return weights.map(() => pt(round(TABLE_CONTENT_WIDTH_PT / columns)));
  }

  const widths = new Array<number>(columns).fill(0);
  const flexible = new Set(weights.map((_, i) => i));
  const weightOf = (i: number): number => weights[i] ?? 1;
  let remaining = TABLE_CONTENT_WIDTH_PT;

  // Iteratively pin any column whose fair share is below the floor.
  for (let changed = true; changed; ) {
    changed = false;
    const weightSum = [...flexible].reduce((sum, i) => sum + weightOf(i), 0);
    for (const i of [...flexible]) {
      if (remaining * (weightOf(i) / weightSum) < MIN_COLUMN_WIDTH_PT) {
        widths[i] = MIN_COLUMN_WIDTH_PT;
        remaining -= MIN_COLUMN_WIDTH_PT;
        flexible.delete(i);
        changed = true;
      }
    }
  }

  const weightSum = [...flexible].reduce((sum, i) => sum + weightOf(i), 0);
  for (const i of flexible) {
    widths[i] = remaining * (weightOf(i) / weightSum);
  }

  return widths.map((w) => pt(round(w)));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
