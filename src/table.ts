import type { AlignType, PhrasingContent, Table } from "mdast";
import type { Dimension } from "./docs";
import { pt } from "./docs";
import { inlineRuns } from "./inline";
import { CELL_PADDING, MIN_COLUMN_WIDTH_PT } from "./style";

export interface CellPlan {
  content: PhrasingContent[];
  text: string;
}

export interface TablePlan {
  rows: number;
  columns: number;
  header: boolean;
  align: AlignType[];
  cells: CellPlan[][];
}

function emptyCell(): CellPlan {
  return { content: [], text: "" };
}

export function buildTablePlan(table: Table): TablePlan {
  const cells: CellPlan[][] = table.children.map((row) =>
    row.children.map((cell) => ({ content: cell.children, text: inlineRuns(cell.children).text })),
  );
  const rows = cells.length;
  const columns = cells.reduce((max, row) => Math.max(max, row.length), 0);

  for (const row of cells) {
    while (row.length < columns) row.push(emptyCell());
  }

  const align = Array.from({ length: columns }, (_, col) => table.align?.[col] ?? null);
  return { rows, columns, header: rows > 0, align, cells };
}

const CHAR_WIDTH_PT = 7;
const SPACE_WIDTH_PT = 3.5;
const EMOJI_WIDTH_PT = 13;
const EMOJI = /\p{Extended_Pictographic}/u;

const NATURAL_FLOOR_CAP_SHARE = 0.5;

function estimatedTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (EMOJI.test(ch)) width += EMOJI_WIDTH_PT;
    else if (ch === " ") width += SPACE_WIDTH_PT;
    else width += CHAR_WIDTH_PT;
  }
  return width;
}

function naturalWidth(cells: CellPlan[][], col: number, contentWidth: number): number {
  const longest = Math.max(0, ...cells.map((row) => estimatedTextWidth(row[col]?.text ?? "")));
  const needed = longest + 2 * CELL_PADDING.magnitude;
  return Math.min(Math.max(MIN_COLUMN_WIDTH_PT, needed), contentWidth * NATURAL_FLOOR_CAP_SHARE);
}

function filledColumns(body: CellPlan[][], columns: number): Set<number> {
  const filled = new Set<number>();
  for (const row of body) {
    for (let col = 0; col < columns; col++) {
      if ((row[col]?.text.trim().length ?? 0) > 0) filled.add(col);
    }
  }
  return filled;
}

function fillInAdjustedWeights(cells: CellPlan[][], columns: number, filled: Set<number>): number[] {
  const weights = Array.from({ length: columns }, (_, col) =>
    Math.max(1, ...cells.map((row) => row[col]?.text.length ?? 0)),
  );
  if (filled.size === 0 || filled.size === columns) return weights;

  const average = [...filled].reduce((sum, col) => sum + (weights[col] ?? 1), 0) / filled.size;
  return weights.map((w, col) => (filled.has(col) ? w : Math.max(w, average)));
}

export function columnWidths(plan: TablePlan, contentWidth: number): Dimension[] {
  const { cells, columns } = plan;
  if (columns === 0) return [];

  const body = cells.slice(1);
  const filled = filledColumns(body, columns);
  if (body.length > 0 && filled.size === 0) return equalShares(contentWidth, columns);

  const weights = fillInAdjustedWeights(cells, columns, filled);
  const floors = Array.from({ length: columns }, (_, col) => naturalWidth(cells, col, contentWidth));

  const floorSum = floors.reduce((sum, f) => sum + f, 0);
  if (floorSum >= contentWidth) {
    if (columns * MIN_COLUMN_WIDTH_PT >= contentWidth) {
      return equalShares(contentWidth, columns);
    }
    const spare = contentWidth - columns * MIN_COLUMN_WIDTH_PT;
    const excessTotal = floors.reduce((sum, f) => sum + (f - MIN_COLUMN_WIDTH_PT), 0);
    return fitToHundredths(
      floors.map((f) => MIN_COLUMN_WIDTH_PT + (spare * (f - MIN_COLUMN_WIDTH_PT)) / excessTotal),
      contentWidth,
    );
  }

  const widths = new Array<number>(columns).fill(0);
  const flexible = new Set(weights.map((_, i) => i));
  const weightOf = (i: number): number => weights[i] ?? 1;
  const floorOf = (i: number): number => floors[i] ?? MIN_COLUMN_WIDTH_PT;
  let remaining = contentWidth;

  for (let changed = true; changed; ) {
    changed = false;
    const weightSum = [...flexible].reduce((sum, i) => sum + weightOf(i), 0);
    for (const i of [...flexible]) {
      if (remaining * (weightOf(i) / weightSum) < floorOf(i)) {
        widths[i] = floorOf(i);
        remaining -= floorOf(i);
        flexible.delete(i);
        changed = true;
        break;
      }
    }
  }

  const weightSum = [...flexible].reduce((sum, i) => sum + weightOf(i), 0);
  for (const i of flexible) {
    widths[i] = remaining * (weightOf(i) / weightSum);
  }

  return fitToHundredths(widths, contentWidth);
}

function equalShares(contentWidth: number, columns: number): Dimension[] {
  return fitToHundredths(new Array<number>(columns).fill(contentWidth / columns), contentWidth);
}

function fitToHundredths(raw: number[], contentWidth: number): Dimension[] {
  const total = Math.floor(contentWidth * 100 + 1e-6);
  const hundredths = raw.map((w) => Math.floor(w * 100));
  const leftover = total - hundredths.reduce((sum, h) => sum + h, 0);
  const byRemainder = raw
    .map((w, col) => ({ col, remainder: w * 100 - (hundredths[col] ?? 0) }))
    .sort((a, b) => b.remainder - a.remainder || a.col - b.col);
  for (const { col } of byRemainder.slice(0, leftover)) hundredths[col] = (hundredths[col] ?? 0) + 1;
  return hundredths.map((h) => pt(h / 100));
}
