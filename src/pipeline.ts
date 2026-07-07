import type { Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { CONFIG_PATH } from "./config";
import type { DocsClient } from "./executor";
import { executeDocument, updateDocument } from "./executor";
import { lookupDoc } from "./mapping";
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

/** Read and validate a Markdown file, returning its parsed AST. */
async function loadTree(filePath: string): Promise<Root> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) throw new Error(`md2gd: file not found: ${filePath}`);

  const source = await file.text();
  if (source.trim().length === 0) throw new Error(`md2gd: file is empty: ${filePath}`);

  return parseMarkdown(source);
}

/**
 * Read a Markdown file and produce a **new** Google Doc via the given client.
 * Returns the new document id. Rejects with a clear message on missing/empty input.
 */
export async function convertFile(filePath: string, options: ConvertOptions, client: DocsClient): Promise<string> {
  const tree = await loadTree(filePath);
  const title = options.title ?? deriveTitle(tree, filePath);
  return executeDocument(client, title, planDocument(tree));
}

/**
 * Re-render a Markdown file into an **existing** document (stable-URL mode).
 * Translates the `drive.file` 404 — raised when the target isn't a doc md2gd
 * created (or no longer exists) — into an actionable message (FR-43).
 */
export async function updateFile(
  filePath: string,
  options: ConvertOptions,
  client: DocsClient,
  documentId: string,
): Promise<void> {
  const tree = await loadTree(filePath);
  const title = options.title ?? deriveTitle(tree, filePath);
  try {
    await updateDocument(client, documentId, title, planDocument(tree));
  } catch (error) {
    if (error instanceof Error && /\(404\)/.test(error.message)) {
      throw new Error(
        `md2gd: cannot update document ${documentId} — md2gd can only update documents it created, and the document must still exist`,
      );
    }
    throw error;
  }
}

/** Extract a Google Docs document id from a full edit URL or accept a bare id. */
export function parseDocId(input: string): string {
  const match = input.match(/\/d\/([\w-]+)/);
  return match?.[1] ?? input.trim();
}

/**
 * Resolve which document an `--update` run targets: an explicit url/id argument
 * if given, otherwise the doc previously created from this file (FR-42).
 */
export async function resolveUpdateTarget(
  filePath: string,
  updateTarget: string | undefined,
  configPath: string = CONFIG_PATH,
): Promise<string> {
  if (updateTarget) return parseDocId(updateTarget);
  const remembered = await lookupDoc(filePath, configPath);
  if (!remembered) {
    throw new Error(`md2gd: no document remembered for ${filePath}. Convert it once first, or pass --update <url|id>.`);
  }
  return remembered;
}
