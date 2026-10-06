import type { Root } from "mdast";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks);

export function parseMarkdown(source: string): Root {
  const tree = processor.parse(source);
  return processor.runSync(tree) as Root;
}
