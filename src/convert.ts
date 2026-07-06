import type { List, ListItem, PhrasingContent, Root, RootContent } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { BODY_START_INDEX, type BulletPreset, type DocRequest, type ParagraphStyle, type TextStyle } from "./docs";
import { codeTextStyle, headingParagraphStyle, linkTextStyle, normalParagraphStyle } from "./style";

/** A line break within the same paragraph (vertical tab), as opposed to "\n". */
const LINE_BREAK = String.fromCharCode(0x0b);

interface ParagraphSpec {
  paragraphStyle: ParagraphStyle;
  fields: string;
}

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
    default:
      return appendRaw(mdastToString(node), cursor, ctx, 0, normalParagraphStyle());
  }
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
  spec: ParagraphSpec,
): number {
  const tabs = "\t".repeat(indent);
  const walked = walkInline(inline, cursor + tabs.length, {});
  return emitParagraph(`${tabs}${walked.text}`, walked.requests, cursor, ctx, spec);
}

function appendRaw(value: string, cursor: number, ctx: Context, indent: number, spec: ParagraphSpec): number {
  return emitParagraph(`${"\t".repeat(indent)}${value}`, [], cursor, ctx, spec);
}

function emitParagraph(
  body: string,
  inlineRequests: DocRequest[],
  cursor: number,
  ctx: Context,
  spec: ParagraphSpec,
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

interface InlineResult {
  text: string;
  requests: DocRequest[];
}

/**
 * Walk phrasing (inline) content, accumulating the plain text and one
 * `updateTextStyle` request per styled run. `active` carries styles inherited
 * from enclosing nodes (bold, italic, link, ...) so nesting composes.
 */
function walkInline(nodes: PhrasingContent[], startIndex: number, active: TextStyle): InlineResult {
  let index = startIndex;
  let text = "";
  const requests: DocRequest[] = [];

  const emitLeaf = (value: string, style: TextStyle): void => {
    if (value.length > 0 && hasStyle(style)) {
      requests.push({
        updateTextStyle: {
          textStyle: style,
          fields: styleFields(style),
          range: { startIndex: index, endIndex: index + value.length },
        },
      });
    }
    text += value;
    index += value.length;
  };

  const descend = (children: PhrasingContent[], style: TextStyle): void => {
    const nested = walkInline(children, index, style);
    text += nested.text;
    index += nested.text.length;
    requests.push(...nested.requests);
  };

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        emitLeaf(node.value, active);
        break;
      case "inlineCode":
        // The node's value is already literal, so markdown-significant
        // characters inside a code span are never re-interpreted.
        emitLeaf(node.value, { ...active, ...codeTextStyle });
        break;
      case "strong":
        descend(node.children, { ...active, bold: true });
        break;
      case "emphasis":
        descend(node.children, { ...active, italic: true });
        break;
      case "delete":
        descend(node.children, { ...active, strikethrough: true });
        break;
      case "link":
        descend(node.children, { ...active, ...linkTextStyle(node.url) });
        break;
      case "break":
        emitLeaf(LINE_BREAK, active);
        break;
      default:
        emitLeaf(mdastToString(node), active);
        break;
    }
  }

  return { text, requests };
}

function hasStyle(style: TextStyle): boolean {
  return Object.keys(style).length > 0;
}

function styleFields(style: TextStyle): string {
  return Object.keys(style).join(",");
}
