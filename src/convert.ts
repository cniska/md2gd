import type { PhrasingContent, Root, RootContent } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { BODY_START_INDEX, type DocRequest, type TextStyle } from "./docs";
import { codeTextStyle, headingParagraphStyle, linkTextStyle, normalParagraphStyle } from "./style";

/** A line break within the same paragraph (vertical tab), as opposed to "\n". */
const LINE_BREAK = String.fromCharCode(0x0b);

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
  const requests: DocRequest[] = [];
  let cursor = BODY_START_INDEX;

  for (const node of root.children) {
    cursor = appendBlock(node, cursor, requests);
  }

  return requests;
}

function appendBlock(node: RootContent, cursor: number, requests: DocRequest[]): number {
  const inline =
    node.type === "paragraph" || node.type === "heading"
      ? walkInline(node.children, cursor, {})
      : { text: mdastToString(node), requests: [] as DocRequest[] };

  const text = `${inline.text}\n`;
  const start = cursor;
  const end = cursor + text.length;

  requests.push({ insertText: { text, location: { index: start } } });
  requests.push(...inline.requests);

  const { paragraphStyle, fields } =
    node.type === "heading" ? headingParagraphStyle(node.depth) : normalParagraphStyle();
  requests.push({
    updateParagraphStyle: { paragraphStyle, fields, range: { startIndex: start, endIndex: end } },
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
