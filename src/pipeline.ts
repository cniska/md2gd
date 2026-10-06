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
  folder?: string;
  links?: string;
  onLinks?: (stats: LinkStats) => void;
}

async function readInput(path: string, label: string): Promise<Uint8Array> {
  try {
    return await Bun.file(path).bytes();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") throw new Error(`md2gd: ${label} not found: ${path}`, { cause: error });
    if (code === "EACCES") throw new Error(`md2gd: cannot read ${path}: permission denied`, { cause: error });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`md2gd: cannot read ${path}: ${reason}`, { cause: error });
  }
}

function decodeMarkdown(bytes: Uint8Array, filePath: string): string {
  const binary = new Error(`md2gd: not a Markdown file (binary content): ${filePath}`);
  if (bytes.includes(0)) throw binary;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw binary;
  }
}

async function loadTree(filePath: string): Promise<Root> {
  const source = decodeMarkdown(await readInput(filePath, "file"), filePath);
  if (source.trim().length === 0) throw new Error(`md2gd: file is empty: ${filePath}`);

  return parseMarkdown(source);
}

async function applyLinkMap(tree: Root, filePath: string, options: ConvertOptions): Promise<void> {
  if (!options.links) return;
  const map = await loadLinkMap(options.links);
  options.onLinks?.(rewriteLinks(tree, filePath, map));
}

async function loadLinkMap(mapPath: string): Promise<Map<string, string>> {
  const source = new TextDecoder().decode(await readInput(mapPath, "link map"));
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error(`md2gd: link map is not valid JSON: ${mapPath}`);
  }
  const parsed = LinkMapSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`md2gd: link map must be a JSON object of path → url: ${mapPath}`);
  return resolveLinkMap(parsed.data, dirname(resolve(mapPath)));
}

export async function convertFile(filePath: string, options: ConvertOptions, client: DocsClient): Promise<string> {
  const tree = await loadTree(filePath);
  await applyLinkMap(tree, filePath, options);
  const title = options.title ?? deriveTitle(tree, filePath);
  const folderId = options.folder ? parseFolderId(options.folder) : undefined;
  return executeDocument(client, title, planDocument(tree), folderId);
}

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
  await recordDoc(filePath, documentId, configPath);
}

export function parseDocId(input: string): string {
  const match = input.match(/\/d\/([\w-]+)/);
  return match?.[1] ?? input.trim();
}

export function parseFolderId(input: string): string {
  const match = input.match(/\/folders\/([\w-]+)/);
  return match?.[1] ?? input.trim();
}

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
