import type { Code, PhrasingContent, Root, RootContent } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import {
  BODY_START_INDEX,
  type BulletPreset,
  type Dimension,
  type DocRequest,
  fieldMask,
  type UpdateParagraphStyleRequest,
} from "./docs";
import { inlineRuns, LINE_BREAK } from "./inline";
import { type BlockContext, type Leaf, planDocument } from "./plan";
import {
  AFTER_TABLE_SPACE,
  bodyFontTextStyle,
  captionParagraphStyle,
  codeBlockParagraphStyle,
  codeBlockTextStyle,
  headingParagraphStyle,
  LIST_AFTER_SPACE,
  listItemParagraphStyle,
  listLaterBlockIndent,
  normalParagraphStyle,
  type ParagraphStyleSpec,
  tableCellParagraphStyle,
} from "./style";

interface BulletSpec {
  startIndex: number;
  endIndex: number;
  preset: BulletPreset;
}

interface Context {
  requests: DocRequest[];
  bullets: BulletSpec[];
  /**
   * Where `createParagraphBullets` will strip leading nesting tabs, and how many.
   * The cursor counts them (they exist while the requests run), but every index
   * after one is that many code units smaller once the bullets are applied.
   */
  tabStrips: { index: number; tabs: number }[];
  /** The paragraph being emitted ends its container, so it takes the container's own final newline. */
  reuseNewline: boolean;
}

/**
 * Convert a whole mdast tree into Google Docs `batchUpdate` requests, starting
 * at the body's first index. Assumes no tables or quotes (see `planDocument`);
 * one reaching here fails loud.
 */
export function convert(root: Root): DocRequest[] {
  const leaves = planDocument(root).flatMap((segment) => {
    // Tables and quotes cannot be emitted as absolute-indexed requests: their cell
    // indices only exist after the empty table is inserted and read back, which
    // only the executor can do. Fail loud rather than flatten one to garbage text.
    if (segment.kind !== "linear") {
      throw new Error("md2gd: tables and quotes are resolved by the document planner, not the linear converter");
    }
    return segment.leaves;
  });
  return convertLeaves(leaves, BODY_START_INDEX).requests;
}

/**
 * Convert a run of planned leaves into `batchUpdate` requests placed from
 * `startIndex`, returning the index just past the inserted content so the
 * caller can continue after it (e.g. following a table).
 *
 * Text is inserted at an advancing cursor; styling requests reference absolute
 * indices. Offsets come from JS string length — UTF-16 code units, matching the
 * Docs API — so emoji (surrogate pairs) count correctly. Pure and offline.
 */
export function convertLeaves(
  leaves: Leaf[],
  startIndex: number,
  options: { afterTable?: boolean; endsContainer?: boolean } = {},
): { requests: DocRequest[]; endIndex: number } {
  const ctx: Context = { requests: [], bullets: [], tabStrips: [], reuseNewline: false };
  let cursor = startIndex;
  let openRange: (BulletSpec & { list: number }) | undefined;
  const laterBlocks: { startIndex: number; endIndex: number; depth: number }[] = [];

  for (const [i, leaf] of leaves.entries()) {
    const start = cursor;
    const requestStart = ctx.requests.length;
    // A table cell always keeps one paragraph of its own, so the last block of a
    // cell is written into it rather than leaving an empty line below.
    ctx.reuseNewline = options.endsContainer === true && i === leaves.length - 1;
    cursor = appendLeaf(leaf, cursor, ctx);
    const paragraphEnd = ctx.reuseNewline ? cursor + 1 : cursor;

    // A list's blocks share one bullet range, so Docs counts the list as one;
    // an item's later blocks then lose their bullets below.
    const list = leaf.context.list;
    if (list?.preset) {
      if (openRange?.list === list.id && openRange.endIndex === start) {
        openRange.endIndex = paragraphEnd;
      } else {
        openRange = { list: list.id, startIndex: start, endIndex: paragraphEnd, preset: list.preset };
        ctx.bullets.push(openRange);
      }
      if (!list.first) laterBlocks.push({ startIndex: start, endIndex: paragraphEnd, depth: list.depth });
    } else {
      openRange = undefined;
    }

    // Items are tightly spaced; restore normal space below a list's final block
    // so the list doesn't butt against what follows.
    if (list && leaves[i + 1]?.context.list?.id !== list.id) {
      ensureSpaceBelowOnLast(ctx.requests, requestStart, LIST_AFTER_SPACE);
    }
  }

  // A run following a table needs space above its first block, since a table
  // carries no space below and a plain paragraph no space above.
  if (options.afterTable) ensureSpaceAbove(ctx.requests, AFTER_TABLE_SPACE);

  // Bulleting strips the leading tabs used to signal nesting, which shifts every
  // index after the list. Emitting bullet requests last and in reverse document
  // order keeps each range valid when its request runs.
  for (const b of [...ctx.bullets].sort((a, z) => z.startIndex - a.startIndex)) {
    ctx.requests.push({
      createParagraphBullets: { range: { startIndex: b.startIndex, endIndex: b.endIndex }, bulletPreset: b.preset },
    });
  }

  // An item's later blocks are unbulleted and indented under its text only once
  // every bullet is in place, so their ranges are in post-strip indices.
  const stripped = (index: number): number =>
    ctx.tabStrips.reduce((sum, strip) => (strip.index < index ? sum + strip.tabs : sum), 0);
  for (const block of laterBlocks) {
    const range = {
      startIndex: block.startIndex - stripped(block.startIndex),
      endIndex: block.endIndex - stripped(block.endIndex),
    };
    const indent = listLaterBlockIndent(block.depth);
    ctx.requests.push({ deleteParagraphBullets: { range } });
    ctx.requests.push({
      updateParagraphStyle: { paragraphStyle: indent.paragraphStyle, fields: indent.fields, range },
    });
  }

  return { requests: ctx.requests, endIndex: cursor - stripped(cursor) };
}

function appendLeaf(leaf: Leaf, cursor: number, ctx: Context): number {
  const { node, context } = leaf;
  const list = context.list;
  // An item's first block carries its marker: leading tabs that set its nesting
  // level, and a task item's glyph. Bulleting strips the tabs. A task list has no
  // bullets, so its tabs stay and every block of an item keeps them as its column.
  const tabs = list ? "\t".repeat(list.depth) : "";
  const bulleted = list?.preset !== undefined;
  let lead = "";
  if (list?.first) lead = `${tabs}${list.prefix ?? ""}`;
  else if (list && !bulleted) lead = tabs;
  if (list?.first && bulleted && list.depth > 0) ctx.tabStrips.push({ index: cursor, tabs: list.depth });
  const spec = ownStyle(node, context);

  switch (node.type) {
    case "heading":
    case "paragraph":
      return appendInline(lead, node.children, cursor, ctx, spec);
    case "code":
      return appendCode(lead, node, cursor, ctx, spec);
    default:
      return emitParagraph(`${lead}${mdastToString(node)}`, [], cursor, ctx, spec);
  }
}

function ownStyle(node: RootContent, context: BlockContext): ParagraphStyleSpec {
  switch (node.type) {
    case "heading":
      return headingParagraphStyle(node.depth);
    case "code":
      return codeBlockParagraphStyle;
    default:
      if (context.tableCell) return tableCellParagraphStyle;
      if (context.list) return listItemParagraphStyle();
      return node.type === "paragraph" && isBoldOnly(node.children) ? captionParagraphStyle() : normalParagraphStyle();
  }
}

/**
 * Raise the first paragraph's space-above to at least `floor`, cloning the style
 * so the shared spec object is never mutated. A first block that already has more
 * (e.g. a heading or caption) is left untouched.
 */
function ensureSpaceAbove(requests: DocRequest[], floor: Dimension): void {
  const first = requests.find((r): r is UpdateParagraphStyleRequest => "updateParagraphStyle" in r);
  if (!first) return;
  const style = first.updateParagraphStyle.paragraphStyle;
  if ((style.spaceAbove?.magnitude ?? 0) >= floor.magnitude) return;
  first.updateParagraphStyle.paragraphStyle = { ...style, spaceAbove: floor };
  if (!first.updateParagraphStyle.fields.split(",").includes("spaceAbove")) {
    first.updateParagraphStyle.fields = `${first.updateParagraphStyle.fields},spaceAbove`;
  }
}

/**
 * Raise the space-below of the last paragraph styled since `fromIndex` to at
 * least `floor` (cloning the shared spec). Used to restore normal spacing after
 * a tightly-spaced list.
 */
function ensureSpaceBelowOnLast(requests: DocRequest[], fromIndex: number, floor: Dimension): void {
  for (let i = requests.length - 1; i >= fromIndex; i--) {
    const request = requests[i];
    if (!request || !("updateParagraphStyle" in request)) continue;
    const style = request.updateParagraphStyle.paragraphStyle;
    if ((style.spaceBelow?.magnitude ?? 0) < floor.magnitude) {
      request.updateParagraphStyle.paragraphStyle = { ...style, spaceBelow: floor };
      if (!request.updateParagraphStyle.fields.split(",").includes("spaceBelow")) {
        request.updateParagraphStyle.fields = `${request.updateParagraphStyle.fields},spaceBelow`;
      }
    }
    return;
  }
}

// Inline content a caption's bold may contain. A strong wrapping a link, image,
// or code span is a bold link/code in prose, not a sub-label — so it's excluded.
const PLAIN_BOLD_CONTENT = new Set(["text", "emphasis", "delete", "break"]);

/**
 * A paragraph is a caption when every child is plain bold text (`**…**`), ignoring
 * whitespace-only text. Detected here rather than by lookahead because the caption
 * ends a linear segment and the table it introduces is the next segment.
 */
function isBoldOnly(children: PhrasingContent[]): boolean {
  const meaningful = children.filter((child) => child.type !== "text" || child.value.trim().length > 0);
  return (
    meaningful.length > 0 &&
    meaningful.every((child) => child.type === "strong" && child.children.every((c) => PLAIN_BOLD_CONTENT.has(c.type)))
  );
}

function appendCode(lead: string, node: Code, cursor: number, ctx: Context, spec: ParagraphStyleSpec): number {
  // Internal newlines become in-paragraph line breaks so the whole block reads
  // as one shaded region rather than many separately-shaded paragraphs.
  const body = node.value.replaceAll("\n", LINE_BREAK);
  const codeStart = cursor + lead.length;
  const styleRequests: DocRequest[] =
    body.length > 0
      ? [
          {
            updateTextStyle: {
              textStyle: codeBlockTextStyle,
              fields: fieldMask(codeBlockTextStyle),
              range: { startIndex: codeStart, endIndex: codeStart + body.length },
            },
          },
        ]
      : [];
  return emitParagraph(`${lead}${body}`, styleRequests, cursor, ctx, spec);
}

function appendInline(
  lead: string,
  inline: PhrasingContent[],
  cursor: number,
  ctx: Context,
  spec: ParagraphStyleSpec,
): number {
  const base = cursor + lead.length;
  const content = inlineRuns(inline);
  const styleRequests: DocRequest[] = content.runs.map((run) => ({
    updateTextStyle: {
      textStyle: run.style,
      fields: fieldMask(run.style),
      range: { startIndex: base + run.start, endIndex: base + run.end },
    },
  }));
  return emitParagraph(`${lead}${content.text}`, styleRequests, cursor, ctx, spec);
}

function emitParagraph(
  body: string,
  inlineRequests: DocRequest[],
  cursor: number,
  ctx: Context,
  spec: ParagraphStyleSpec,
): number {
  const text = ctx.reuseNewline ? body : `${body}\n`;
  const start = cursor;
  // The paragraph always ends at a newline: its own, or the container's it reuses.
  const paragraphEnd = start + body.length + 1;

  if (text.length > 0) ctx.requests.push({ insertText: { text, location: { index: start } } });
  ctx.requests.push({
    updateParagraphStyle: {
      paragraphStyle: spec.paragraphStyle,
      fields: spec.fields,
      range: { startIndex: start, endIndex: paragraphEnd },
    },
  });
  // Apply the base font over the text, then the specific runs, so run styles
  // (bold, monospace code, ...) win in their sub-ranges.
  if (body.length > 0) {
    ctx.requests.push({
      updateTextStyle: {
        textStyle: bodyFontTextStyle,
        fields: fieldMask(bodyFontTextStyle),
        range: { startIndex: start, endIndex: start + body.length },
      },
    });
  }
  ctx.requests.push(...inlineRequests);

  return start + text.length;
}
