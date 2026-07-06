import type { Root, RootContent } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { BODY_START_INDEX, type DocRequest } from "./docs";
import { headingParagraphStyle, normalParagraphStyle } from "./style";

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
  const text = `${mdastToString(node)}\n`;
  const start = cursor;
  const end = cursor + text.length;

  requests.push({ insertText: { text, location: { index: start } } });

  const { paragraphStyle, fields } =
    node.type === "heading" ? headingParagraphStyle(node.depth) : normalParagraphStyle();
  requests.push({
    updateParagraphStyle: { paragraphStyle, fields, range: { startIndex: start, endIndex: end } },
  });

  return end;
}
