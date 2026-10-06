import type { PhrasingContent } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import type { TextStyle } from "./docs";
import { codeTextStyle, linkTextStyle } from "./style";

export const LINE_BREAK = String.fromCharCode(0x0b);

export interface StyledRun {
  start: number;
  end: number;
  style: TextStyle;
}

export interface InlineContent {
  text: string;
  runs: StyledRun[];
}

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

const LINKABLE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

export function isLinkableUrl(url: string): boolean {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase();
  return scheme !== undefined && LINKABLE_SCHEMES.has(scheme);
}
