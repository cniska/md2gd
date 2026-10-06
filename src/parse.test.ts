import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "./parse";

describe("parseMarkdown", () => {
  test("parses an ATX heading into a heading node with its depth", () => {
    const root = parseMarkdown("# Report\n");
    expect(root.children).toHaveLength(1);
    const heading = root.children[0];
    expect(heading.type).toBe("heading");
    if (heading.type !== "heading") throw new Error("expected heading");
    expect(heading.depth).toBe(1);
  });

  test("converts a soft line break inside a paragraph into a hard break", () => {
    const root = parseMarkdown("**Date:** July 5\n**Classification:** Confidential\n");
    expect(root.children).toHaveLength(1);
    const para = root.children[0];
    if (para.type !== "paragraph") throw new Error("expected paragraph");
    expect(para.children.some((c) => c.type === "break")).toBe(true);
  });
});
