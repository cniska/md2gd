import type { Code, PhrasingContent, RootContent } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { type BulletPreset, type Dimension, type DocRequest, fieldMask, pt, type TextStyle } from "./docs";
import { inlineRuns, LINE_BREAK } from "./inline";
import type { Leaf } from "./plan";
import {
  AFTER_TABLE_SPACE,
  alignedParagraphStyle,
  bodyFontTextStyle,
  captionParagraphStyle,
  codeBlockParagraphStyle,
  codeBlockTextStyle,
  headerCellTextStyle,
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
  tabStrips: { index: number; tabs: number }[];
  reuseNewline: boolean;
}

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

  for (const b of [...ctx.bullets].sort((a, z) => z.startIndex - a.startIndex)) {
    ctx.requests.push({
      createParagraphBullets: { range: { startIndex: b.startIndex, endIndex: b.endIndex }, bulletPreset: b.preset },
    });
  }

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

interface Spacing {
  flushAbove: boolean;
  flushBelow: boolean;
  afterTable: boolean;
  endsList: boolean;
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
  const tabs = list ? "\t".repeat(list.depth) : "";
  const bulleted = list?.preset !== undefined;
  let lead = "";
  if (list?.first) lead = `${tabs}${list.prefix ?? ""}`;
  else if (list && !bulleted) lead = tabs;
  if (list?.first && bulleted && list.depth > 0) ctx.tabStrips.push({ index: cursor, tabs: list.depth });
  const own = ownStyle(leaf);
  const style: BlockStyle = {
    paragraph: spacedParagraphStyle(
      own.paragraph,
      spaceAbove(own.paragraph, spacing),
      spaceBelow(own.paragraph, spacing),
    ),
    text: own.text,
  };

  switch (node.type) {
    case "heading":
    case "paragraph":
      return appendInline(lead, node.children, cursor, ctx, style);
    case "code":
      return appendCode(lead, node, cursor, ctx, style);
    default:
      return emitParagraph(`${lead}${mdastToString(node)}`, [], cursor, ctx, style);
  }
}

interface BlockStyle {
  paragraph: ParagraphStyleSpec;
  text: TextStyle;
}

function ownStyle({ node, context }: Leaf): BlockStyle {
  const cell = context.cell;
  return {
    paragraph: alignedParagraphStyle(ownParagraphStyle(node), cell?.align ?? null),
    text: cell?.header ? headerCellTextStyle : bodyFontTextStyle,
  };
}

function ownParagraphStyle(node: RootContent): ParagraphStyleSpec {
  switch (node.type) {
    case "heading":
      return headingParagraphStyle(node.depth);
    case "code":
      return codeBlockParagraphStyle;
    default:
      return node.type === "paragraph" && isBoldOnly(node.children) ? captionParagraphStyle : normalParagraphStyle;
  }
}

const PLAIN_BOLD_CONTENT = new Set(["text", "emphasis", "delete", "break"]);

function isBoldOnly(children: PhrasingContent[]): boolean {
  const meaningful = children.filter((child) => child.type !== "text" || child.value.trim().length > 0);
  return (
    meaningful.length > 0 &&
    meaningful.every((child) => child.type === "strong" && child.children.every((c) => PLAIN_BOLD_CONTENT.has(c.type)))
  );
}

function appendCode(lead: string, node: Code, cursor: number, ctx: Context, style: BlockStyle): number {
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
  return emitParagraph(`${lead}${body}`, styleRequests, cursor, ctx, style);
}

function appendInline(
  lead: string,
  inline: PhrasingContent[],
  cursor: number,
  ctx: Context,
  style: BlockStyle,
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
  return emitParagraph(`${lead}${content.text}`, styleRequests, cursor, ctx, style);
}

function emitParagraph(
  body: string,
  inlineRequests: DocRequest[],
  cursor: number,
  ctx: Context,
  style: BlockStyle,
): number {
  const text = ctx.reuseNewline ? body : `${body}\n`;
  const start = cursor;
  const paragraphEnd = start + body.length + 1;

  if (text.length > 0) ctx.requests.push({ insertText: { text, location: { index: start } } });
  ctx.requests.push({
    updateParagraphStyle: {
      paragraphStyle: style.paragraph.paragraphStyle,
      fields: style.paragraph.fields,
      range: { startIndex: start, endIndex: paragraphEnd },
    },
  });
  if (body.length > 0) {
    ctx.requests.push({
      updateTextStyle: {
        textStyle: style.text,
        fields: fieldMask(style.text),
        range: { startIndex: start, endIndex: start + body.length },
      },
    });
  }
  ctx.requests.push(...inlineRequests);

  return start + text.length;
}
