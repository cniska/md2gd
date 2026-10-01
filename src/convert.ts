import type { Code, PhrasingContent, Root, RootContent } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import {
  BODY_START_INDEX,
  type BulletPreset,
  type Dimension,
  type DocRequest,
  fieldMask,
  pt,
  type UpdateParagraphStyleRequest,
} from "./docs";
import { inlineRuns, LINE_BREAK } from "./inline";
import { type BlockContext, type Leaf, planDocument } from "./plan";
import {
  AFTER_TABLE_SPACE,
  bodyFontTextStyle,
  type ContainerOverlay,
  captionParagraphStyle,
  codeBlockParagraphStyle,
  codeBlockTextStyle,
  composeParagraphStyle,
  headingParagraphStyle,
  LIST_AFTER_SPACE,
  LIST_ITEM_INDENT,
  listItemParagraphStyle,
  normalParagraphStyle,
  type ParagraphStyleSpec,
  QUOTE_INDENT,
  quoteParagraphStyle,
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
   * Leading nesting tabs that `createParagraphBullets` will strip. The cursor
   * counts them (they exist while the requests run), but the stripped document
   * is that many code units shorter, so the returned end index subtracts them.
   */
  strippedTabs: number;
}

/**
 * Convert a whole mdast tree into Google Docs `batchUpdate` requests, starting
 * at the body's first index. Assumes no tables (see `planDocument`); a table
 * reaching here fails loud.
 */
export function convert(root: Root): DocRequest[] {
  const leaves = planDocument(root).flatMap((segment) => {
    // Tables cannot be emitted as absolute-indexed requests: their cell indices
    // only exist after the empty table is inserted and read back, which only the
    // executor can do. Fail loud rather than flatten one to garbage text.
    if (segment.kind === "table") {
      throw new Error("md2gd: tables are resolved by the document planner, not the linear converter");
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
  options: { afterTable?: boolean } = {},
): { requests: DocRequest[]; endIndex: number } {
  const ctx: Context = { requests: [], bullets: [], strippedTabs: 0 };
  let cursor = startIndex;
  let openRange: (BulletSpec & { list: number }) | undefined;

  for (const [i, leaf] of leaves.entries()) {
    const start = cursor;
    const requestStart = ctx.requests.length;
    cursor = appendLeaf(leaf, cursor, ctx);

    // Consecutive item-starting blocks of one list share a bullet range; any other
    // block between them ends it, so Docs restarts an ordered list's numbering there.
    const list = leaf.context.list;
    if (list?.first && list.preset) {
      if (openRange?.list === list.id && openRange.endIndex === start) {
        openRange.endIndex = cursor;
      } else {
        openRange = { list: list.id, startIndex: start, endIndex: cursor, preset: list.preset };
        ctx.bullets.push(openRange);
      }
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

  return { requests: ctx.requests, endIndex: cursor - ctx.strippedTabs };
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
  if (list?.first && bulleted) ctx.strippedTabs += list.depth;
  const spec = composeParagraphStyle(ownStyle(node, context), containerOverlay(context));

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
      if (context.list) return listItemParagraphStyle();
      if (context.quoteDepth > 0) return quoteParagraphStyle;
      return node.type === "paragraph" && isBoldOnly(node.children) ? captionParagraphStyle() : normalParagraphStyle();
  }
}

function containerOverlay(context: BlockContext): ContainerOverlay {
  const quoted = context.quoteDepth > 0;
  const list = context.list;
  // A bulleted list's geometry is its bullets': an item's first block takes its
  // nesting level's indent, and later blocks align under the item's text, so a
  // quote around the list adds its accent but no indent. Quotes opened inside an
  // item still indent within it.
  if (list?.preset !== undefined) {
    if (list.first) return { quoted };
    const innerQuotes = context.quoteDepth - list.quoteBase;
    return {
      quoted,
      indent: pt(innerQuotes * QUOTE_INDENT.magnitude + (list.depth + 1) * LIST_ITEM_INDENT.magnitude),
    };
  }
  const indent = context.quoteDepth * QUOTE_INDENT.magnitude;
  return { quoted, indent: indent > 0 ? pt(indent) : undefined };
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
  const text = `${body}\n`;
  const start = cursor;
  const end = cursor + text.length;

  ctx.requests.push({ insertText: { text, location: { index: start } } });
  ctx.requests.push({
    updateParagraphStyle: {
      paragraphStyle: spec.paragraphStyle,
      fields: spec.fields,
      range: { startIndex: start, endIndex: end },
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

  return end;
}
