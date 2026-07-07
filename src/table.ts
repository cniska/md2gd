import type { Table } from "mdast";
import type { Dimension } from "./docs";
import { pt } from "./docs";
import { type InlineContent, inlineRuns } from "./inline";
import { CELL_PADDING, MIN_COLUMN_WIDTH_PT, TABLE_CONTENT_WIDTH_PT } from "./style";

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

// Approximate glyph advances at the 11pt body size, deliberately generous so a
// short column is never floored too narrow to hold its content on one line.
// Emoji are roughly twice a normal glyph; a space is much narrower.
const CHAR_WIDTH_PT = 7;
const SPACE_WIDTH_PT = 3.5;
const EMOJI_WIDTH_PT = 13;
const EMOJI = /\p{Extended_Pictographic}/u;

/** A column's floor is never allowed past this, so one column can't starve the rest. */
const NATURAL_FLOOR_CAP_PT = TABLE_CONTENT_WIDTH_PT * 0.5;

/** Estimated single-line width of a string at the body size, counting emoji as wide. */
function estimatedTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (EMOJI.test(ch)) width += EMOJI_WIDTH_PT;
    else if (ch === " ") width += SPACE_WIDTH_PT;
    else width += CHAR_WIDTH_PT;
  }
  return width;
}

/** The width a column needs to hold its widest cell on one line, floored and capped. */
function naturalWidth(cells: CellPlan[][], col: number): number {
  const longest = Math.max(0, ...cells.map((row) => estimatedTextWidth(row[col]?.text ?? "")));
  const needed = longest + 2 * CELL_PADDING.magnitude;
  return Math.min(Math.max(MIN_COLUMN_WIDTH_PT, needed), NATURAL_FLOOR_CAP_PT);
}

/**
 * Distribute the page content width across columns in proportion to each
 * column's longest cell text, but never below the width that column needs to
 * hold its widest cell on a single line. A short-content column (e.g. a status
 * or severity column beside long descriptions) is pinned to that natural width
 * so its values don't wrap; the remaining width is shared among the rest by
 * weight, so long-text columns still get the space they need.
 */
function distributeColumnWidths(cells: CellPlan[][], columns: number): Dimension[] {
  if (columns === 0) return [];

  const weights = Array.from({ length: columns }, (_, col) =>
    Math.max(1, ...cells.map((row) => row[col]?.text.length ?? 0)),
  );
  const floors = Array.from({ length: columns }, (_, col) => naturalWidth(cells, col));

  // If the columns' natural floors already exceed the page, share it in proportion
  // to those floors — every column shrinks together rather than one overflowing.
  const floorSum = floors.reduce((sum, f) => sum + f, 0);
  if (floorSum >= TABLE_CONTENT_WIDTH_PT) {
    return floors.map((f) => pt(round((TABLE_CONTENT_WIDTH_PT * f) / floorSum)));
  }

  const widths = new Array<number>(columns).fill(0);
  const flexible = new Set(weights.map((_, i) => i));
  const weightOf = (i: number): number => weights[i] ?? 1;
  const floorOf = (i: number): number => floors[i] ?? MIN_COLUMN_WIDTH_PT;
  let remaining = TABLE_CONTENT_WIDTH_PT;

  // Iteratively pin any column whose fair share is below its own natural floor.
  for (let changed = true; changed; ) {
    changed = false;
    const weightSum = [...flexible].reduce((sum, i) => sum + weightOf(i), 0);
    for (const i of [...flexible]) {
      if (remaining * (weightOf(i) / weightSum) < floorOf(i)) {
        widths[i] = floorOf(i);
        remaining -= floorOf(i);
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
