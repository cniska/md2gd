import type { Blockquote, Code, List, ListItem, PhrasingContent, Root, RootContent } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { BODY_START_INDEX, type BulletPreset, type DocRequest, fieldMask } from "./docs";
import { inlineRuns, LINE_BREAK } from "./inline";
import {
  blockquoteParagraphStyle,
  codeBlockParagraphStyle,
  codeBlockTextStyle,
  headingParagraphStyle,
  horizontalRuleParagraphStyle,
  normalParagraphStyle,
  type ParagraphStyleSpec,
} from "./style";

interface BulletSpec {
  startIndex: number;
  endIndex: number;
  preset: BulletPreset;
}

interface Context {
  requests: DocRequest[];
  bullets: BulletSpec[];
}

/**
 * Convert an mdast tree into a sequence of Google Docs `batchUpdate` requests.
 *
 * Text is inserted first at a single advancing cursor; styling requests follow
 * and reference absolute indices in the resulting document. Offsets are computed
 * from JS string length, which is measured in UTF-16 code units — matching the
 * Docs API's own indexing, so emoji (surrogate pairs) count correctly.
 *
 * Pure and offline: produces request objects, touches no network.
 */
export function convert(root: Root): DocRequest[] {
  const ctx: Context = { requests: [], bullets: [] };
  let cursor = BODY_START_INDEX;

  for (const node of root.children) {
    cursor = appendBlock(node, cursor, ctx);
  }

  // Bulleting strips the leading tabs used to signal nesting, which shifts every
  // index after the list. Emitting bullet requests last and in reverse document
  // order keeps each range valid when its request runs.
  for (const b of [...ctx.bullets].sort((a, z) => z.startIndex - a.startIndex)) {
    ctx.requests.push({
      createParagraphBullets: { range: { startIndex: b.startIndex, endIndex: b.endIndex }, bulletPreset: b.preset },
    });
  }

  return ctx.requests;
}

function appendBlock(node: RootContent, cursor: number, ctx: Context): number {
  switch (node.type) {
    case "list":
      return appendList(node, 0, cursor, ctx);
    case "heading":
      return appendParagraph(node.children, cursor, ctx, 0, headingParagraphStyle(node.depth));
    case "paragraph":
      return appendParagraph(node.children, cursor, ctx, 0, normalParagraphStyle());
    case "code":
      return appendCode(node, cursor, ctx);
    case "blockquote":
      return appendBlockquote(node, cursor, ctx);
    case "thematicBreak":
      return emitParagraph("", [], cursor, ctx, horizontalRuleParagraphStyle);
    case "table":
      // Tables cannot be emitted as absolute-indexed requests: their cell indices
      // only exist after the empty table is inserted and read back. The document
      // planner handles them separately; one must never reach the linear
      // converter, so fail loud rather than flatten it to garbage text.
      throw new Error("md2gd: tables are resolved by the document planner, not the linear converter");
    default:
      return appendRaw(mdastToString(node), cursor, ctx, 0, normalParagraphStyle());
  }
}

function appendCode(node: Code, cursor: number, ctx: Context): number {
  // Internal newlines become in-paragraph line breaks so the whole block reads
  // as one shaded region rather than many separately-shaded paragraphs.
  const body = node.value.replaceAll("\n", LINE_BREAK);
  const styleRequests: DocRequest[] =
    body.length > 0
      ? [
          {
            updateTextStyle: {
              textStyle: codeBlockTextStyle,
              fields: fieldMask(codeBlockTextStyle),
              range: { startIndex: cursor, endIndex: cursor + body.length },
            },
          },
        ]
      : [];
  return emitParagraph(body, styleRequests, cursor, ctx, codeBlockParagraphStyle);
}

function appendBlockquote(node: Blockquote, cursor: number, ctx: Context): number {
  for (const child of node.children) {
    if (child.type === "paragraph") {
      cursor = appendParagraph(child.children, cursor, ctx, 0, blockquoteParagraphStyle);
    } else {
      cursor = appendRaw(mdastToString(child), cursor, ctx, 0, blockquoteParagraphStyle);
    }
  }
  return cursor;
}

function appendList(list: List, depth: number, cursor: number, ctx: Context): number {
  const preset = bulletPreset(list);
  const listStart = cursor;

  for (const item of list.children) {
    cursor = appendListItem(item, depth, cursor, ctx);
  }

  // Only the outermost list emits a bullet request; nested levels are covered by
  // the same range and distinguished by their leading-tab depth.
  if (depth === 0 && cursor > listStart) {
    ctx.bullets.push({ startIndex: listStart, endIndex: cursor, preset });
  }
  return cursor;
}

function appendListItem(item: ListItem, depth: number, cursor: number, ctx: Context): number {
  for (const child of item.children) {
    if (child.type === "list") {
      cursor = appendList(child, depth + 1, cursor, ctx);
    } else if (child.type === "paragraph") {
      cursor = appendParagraph(child.children, cursor, ctx, depth, normalParagraphStyle());
    } else {
      cursor = appendRaw(mdastToString(child), cursor, ctx, depth, normalParagraphStyle());
    }
  }
  return cursor;
}

// Known limitation: one preset applies to the whole (possibly nested) list, so a
// list of one type nested inside another still renders with the outer preset's
// per-level glyphs. Correct per-level presets for mixed nesting would need
// separate bullet requests per contiguous same-type run. The target documents
// use flat single-type lists, so this is documented rather than implemented.
function bulletPreset(list: List): BulletPreset {
  if (list.ordered) return "NUMBERED_DECIMAL_ALPHA_ROMAN";
  if (list.children.some((item) => typeof item.checked === "boolean")) return "BULLET_CHECKBOX";
  return "BULLET_DISC_CIRCLE_SQUARE";
}

function appendParagraph(
  inline: PhrasingContent[],
  cursor: number,
  ctx: Context,
  indent: number,
  spec: ParagraphStyleSpec,
): number {
  const tabs = "\t".repeat(indent);
  const base = cursor + tabs.length;
  const content = inlineRuns(inline);
  const styleRequests: DocRequest[] = content.runs.map((run) => ({
    updateTextStyle: {
      textStyle: run.style,
      fields: fieldMask(run.style),
      range: { startIndex: base + run.start, endIndex: base + run.end },
    },
  }));
  return emitParagraph(`${tabs}${content.text}`, styleRequests, cursor, ctx, spec);
}

function appendRaw(value: string, cursor: number, ctx: Context, indent: number, spec: ParagraphStyleSpec): number {
  return emitParagraph(`${"\t".repeat(indent)}${value}`, [], cursor, ctx, spec);
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
  ctx.requests.push(...inlineRequests);
  ctx.requests.push({
    updateParagraphStyle: {
      paragraphStyle: spec.paragraphStyle,
      fields: spec.fields,
      range: { startIndex: start, endIndex: end },
    },
  });

  return end;
}
