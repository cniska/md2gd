import type { PhrasingContent } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import type { TextStyle } from "./docs";
import { codeTextStyle, linkTextStyle } from "./style";

/** A line break within the same paragraph (vertical tab), as opposed to "\n". */
export const LINE_BREAK = String.fromCharCode(0x0b);

/** A styled span, with offsets relative to the start of the inline content. */
export interface StyledRun {
  start: number;
  end: number;
  style: TextStyle;
}

/** Plain text of an inline sequence plus the styled runs within it. */
export interface InlineContent {
  text: string;
  runs: StyledRun[];
}

/**
 * Walk phrasing (inline) content into plain text and relative styled runs.
 * Offsets are 0-based from the start of this content and measured in UTF-16
 * code units (JS string length), matching the Docs API. The caller rebases the
 * runs onto absolute document indices once it knows where the text lands — which
 * is why table cells (whose indices only exist after insertion) can share this.
 *
 * Pure: no absolute indices, no requests, no network.
 */
export function inlineRuns(nodes: PhrasingContent[]): InlineContent {
  const runs: StyledRun[] = [];
  let text = "";

  const walk = (children: PhrasingContent[], active: TextStyle): void => {
    for (const node of children) {
      switch (node.type) {
        case "text":
          emit(node.value, active);
          break;
        case "inlineCode":
          // The node's value is already literal, so markdown-significant
          // characters inside a code span are never re-interpreted.
          emit(node.value, { ...active, ...codeTextStyle });
          break;
        case "strong":
          walk(node.children, { ...active, bold: true });
          break;
        case "emphasis":
          walk(node.children, { ...active, italic: true });
          break;
        case "delete":
          walk(node.children, { ...active, strikethrough: true });
          break;
        case "link":
          // Link out only to targets a reader of the Doc can follow; a local
          // path, anchor, or unsafe scheme renders as plain styled text.
          walk(node.children, isLinkableUrl(node.url) ? { ...active, ...linkTextStyle(node.url) } : active);
          break;
        case "break":
          emit(LINE_BREAK, active);
          break;
        default:
          emit(mdastToString(node), active);
          break;
      }
    }
  };

  const emit = (value: string, style: TextStyle): void => {
    if (value.length > 0 && Object.keys(style).length > 0) {
      runs.push({ start: text.length, end: text.length + value.length, style });
    }
    text += value;
  };

  walk(nodes, {});
  return { text, runs };
}

/** Schemes that resolve to something a reader of the Doc can actually follow. */
const LINKABLE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * A link target becomes a clickable link only if it resolves outside the
 * document. That means an absolute URL with a followable scheme (http, https,
 * mailto, tel). Relative paths, bare filenames, and in-page anchors (`#section`)
 * point at things that don't exist in a Google Doc; unsafe schemes
 * (`javascript:`, `data:`) and local `file:` URLs must never become live links.
 * All of these render as plain styled text instead.
 */
export function isLinkableUrl(url: string): boolean {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase();
  return scheme !== undefined && LINKABLE_SCHEMES.has(scheme);
}
