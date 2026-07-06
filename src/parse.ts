import type { Root } from "mdast";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const processor = unified()
  .use(remarkParse)
  // GFM: tables, strikethrough, task lists, footnotes, autolinks.
  .use(remarkGfm)
  // FR-32 soft-break policy: a single newline within a paragraph becomes a
  // hard line break, reproducing the author's stacked-line intent.
  .use(remarkBreaks);

/**
 * Parse Markdown source into an mdast tree, with GFM extensions and the
 * project's soft-break policy applied. Pure and offline (NF-12).
 */
export function parseMarkdown(source: string): Root {
  const tree = processor.parse(source);
  return processor.runSync(tree) as Root;
}
