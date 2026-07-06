import type { Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import type { DocsClient } from "./executor";
import { executeDocument } from "./executor";
import { parseMarkdown } from "./parse";
import { planDocument } from "./plan";

/** Title from the first H1, else the file's base name without extension. */
export function deriveTitle(tree: Root, filePath: string): string {
  const h1 = tree.children.find((node) => node.type === "heading" && node.depth === 1);
  if (h1) {
    const text = mdastToString(h1).trim();
    if (text) return text;
  }
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export interface ConvertOptions {
  title?: string;
}

/**
 * Read a Markdown file and produce a Google Doc via the given client.
 * Returns the new document id. Rejects with a clear message on missing/empty input.
 */
export async function convertFile(filePath: string, options: ConvertOptions, client: DocsClient): Promise<string> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) throw new Error(`md2gd: file not found: ${filePath}`);

  const source = await file.text();
  if (source.trim().length === 0) throw new Error(`md2gd: file is empty: ${filePath}`);

  const tree = parseMarkdown(source);
  const title = options.title ?? deriveTitle(tree, filePath);
  return executeDocument(client, title, planDocument(tree));
}
