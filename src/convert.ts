import type { Code, PhrasingContent, RootContent } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { type BulletPreset, type Dimension, type DocRequest, fieldMask, pt } from "./docs";
import { inlineRuns, LINE_BREAK } from "./inline";
import type { Leaf } from "./plan";
import {
  AFTER_TABLE_SPACE,
  bodyFontTextStyle,
  captionParagraphStyle,
  codeBlockParagraphStyle,
  codeBlockTextStyle,
  headingParagraphStyle,
  LIST_AFTER_SPACE,
  listLaterBlockIndent,
  normalParagraphStyle,
  type ParagraphStyleSpec,
  spacedParagraphStyle,
  TIGHT_LIST_ITEM_SPACE,
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
  options: { afterTable?: boolean; startsContainer?: boolean; endsContainer?: boolean } = {},
): { requests: DocRequest[]; endIndex: number } {
  const ctx: Context = { requests: [], bullets: [], tabStrips: [], reuseNewline: false };
  let cursor = startIndex;
  let openRange: (BulletSpec & { list: number }) | undefined;
  const laterBlocks: { startIndex: number; endIndex: number; depth: number }[] = [];

  for (const [i, leaf] of leaves.entries()) {
    const start = cursor;
    const first = i === 0;
    const last = i === leaves.length - 1;
    // A table cell always keeps one paragraph of its own, so the last block of a
    // cell is written into it rather than leaving an empty line below.
    ctx.reuseNewline = options.endsContainer === true && last;
    const spacing: Spacing = {
      flushAbove: first && options.startsContainer === true,
      flushBelow: last && options.endsContainer === true,
      afterTable: first && options.afterTable === true,
      endsList: leaf.context.list !== undefined && leaves[i + 1]?.context.list?.id !== leaf.context.list.id,
      tightListText: leaf.context.list?.loose === false && leaf.node.type !== "heading" && leaf.node.type !== "code",
    };
    cursor = appendLeaf(leaf, cursor, ctx, spacing);
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
  }

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

/** Where a block sits among its neighbors, which decides the space around it. */
interface Spacing {
  /** First in a container: flush against its top edge, as rendered Markdown's first child is. */
  flushAbove: boolean;
  /** Last in a container: flush against its bottom edge. */
  flushBelow: boolean;
  /** First after a table, which carries no space below itself. */
  afterTable: boolean;
  /** Last of a list, whose tight items would otherwise butt against what follows. */
  endsList: boolean;
  /** Text in a tight list, which rendered Markdown sets without paragraph margins. */
  tightListText: boolean;
}

function spaceAbove(own: ParagraphStyleSpec, spacing: Spacing): Dimension | undefined {
  if (spacing.flushAbove) return pt(0);
  if (spacing.afterTable) return atLeast(own.paragraphStyle.spaceAbove, AFTER_TABLE_SPACE);
  if (spacing.tightListText) return pt(0);
  return undefined;
}

function spaceBelow(own: ParagraphStyleSpec, spacing: Spacing): Dimension | undefined {
  if (spacing.flushBelow) return pt(0);
  if (spacing.endsList) return atLeast(own.paragraphStyle.spaceBelow, LIST_AFTER_SPACE);
  if (spacing.tightListText) return TIGHT_LIST_ITEM_SPACE;
  return undefined;
}

function atLeast(own: Dimension | undefined, floor: Dimension): Dimension {
  if (own === undefined) return floor;
  return own.magnitude >= floor.magnitude ? own : floor;
}

function appendLeaf(leaf: Leaf, cursor: number, ctx: Context, spacing: Spacing): number {
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
  const own = ownStyle(node);
  const spec = spacedParagraphStyle(own, spaceAbove(own, spacing), spaceBelow(own, spacing));

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

/** A block's own style, from what it is alone; where it sits only changes its spacing. */
function ownStyle(node: RootContent): ParagraphStyleSpec {
  switch (node.type) {
    case "heading":
      return headingParagraphStyle(node.depth);
    case "code":
      return codeBlockParagraphStyle;
    default:
      return node.type === "paragraph" && isBoldOnly(node.children) ? captionParagraphStyle : normalParagraphStyle;
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
