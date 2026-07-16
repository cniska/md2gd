import { dirname, resolve } from "node:path";
import type { Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { CONFIG_PATH } from "./config";
import type { DocsClient } from "./executor";
import { executeDocument, updateDocument } from "./executor";
import { LinkMapSchema, type LinkStats, resolveLinkMap, rewriteLinks } from "./links";
import { lookupDoc, recordDoc } from "./mapping";
import { parseMarkdown } from "./parse";
import { planDocument } from "./plan";

/** Title from the first H1, else the file's base name title-cased. */
export function deriveTitle(tree: Root, filePath: string): string {
  const h1 = tree.children.find((node) => node.type === "heading" && node.depth === 1);
  if (h1) {
    const text = mdastToString(h1).trim();
    if (text) return text;
  }
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return titleCaseFilename(stem);
}

/**
 * Turn a file stem into a document title: split on `-`, `_`, and spaces, then
 * capitalise each word's first letter (leaving the rest as-is, so acronyms like
 * `API` survive). `service-readiness-review` → "Service Readiness Review".
 */
function titleCaseFilename(stem: string): string {
  const titled = stem
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return titled || stem;
}

export interface ConvertOptions {
  title?: string;
  /** Destination Drive folder for a new doc, as a folder URL or bare id. */
  folder?: string;
  /** Path to a link map; relative cross-doc links resolve against it. */
  links?: string;
  /** Reports what the link rewrite changed, so the CLI can summarise it. */
  onLinks?: (stats: LinkStats) => void;
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
 * When a `--links` map is given, rewrite the tree's relative cross-doc links to
 * the mapped Doc URLs and report what changed. A missing or malformed map fails
 * here, before any document is written.
 */
async function applyLinkMap(tree: Root, filePath: string, options: ConvertOptions): Promise<void> {
  if (!options.links) return;
  const map = await loadLinkMap(options.links);
  options.onLinks?.(rewriteLinks(tree, filePath, map));
}

async function loadLinkMap(mapPath: string): Promise<Map<string, string>> {
  const file = Bun.file(mapPath);
  if (!(await file.exists())) throw new Error(`md2gd: link map not found: ${mapPath}`);
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error(`md2gd: link map is not valid JSON: ${mapPath}`);
  }
  const parsed = LinkMapSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`md2gd: link map must be a JSON object of path → url: ${mapPath}`);
  return resolveLinkMap(parsed.data, dirname(resolve(mapPath)));
}

/**
 * Read a Markdown file and produce a **new** Google Doc via the given client.
 * Returns the new document id. Rejects with a clear message on missing/empty input.
 */
export async function convertFile(filePath: string, options: ConvertOptions, client: DocsClient): Promise<string> {
  const tree = await loadTree(filePath);
  await applyLinkMap(tree, filePath, options);
  const title = options.title ?? deriveTitle(tree, filePath);
  const folderId = options.folder ? parseFolderId(options.folder) : undefined;
  return executeDocument(client, title, planDocument(tree), folderId);
}

/**
 * Re-render a Markdown file into an **existing** document (stable-URL mode). An
 * inaccessible or missing target is translated by `updateDocument` at the
 * read-before-destroy step into an actionable message.
 */
export async function updateFile(
  filePath: string,
  options: ConvertOptions,
  client: DocsClient,
  documentId: string,
  configPath: string = CONFIG_PATH,
): Promise<void> {
  const tree = await loadTree(filePath);
  await applyLinkMap(tree, filePath, options);
  const title = options.title ?? deriveTitle(tree, filePath);
  const folderId = options.folder ? parseFolderId(options.folder) : undefined;
  await updateDocument(client, documentId, title, planDocument(tree), folderId);
  // Remember this file → doc binding, so a later no-argument `--update` finds it.
  // This is what adopts a doc first targeted explicitly (`--update <url|id>`) —
  // including one md2gd did not create — into the seamless regenerate loop (FR-42).
  await recordDoc(filePath, documentId, configPath);
}

/** Extract a Google Docs document id from a full edit URL or accept a bare id. */
export function parseDocId(input: string): string {
  const match = input.match(/\/d\/([\w-]+)/);
  return match?.[1] ?? input.trim();
}

/** Extract a Drive folder id from a folder URL (`/folders/<id>`) or accept a bare id. */
export function parseFolderId(input: string): string {
  const match = input.match(/\/folders\/([\w-]+)/);
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
