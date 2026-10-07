import { dirname, resolve } from "node:path";
import type { Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { createRefuser, isMissingFile, systemReasonOf } from "./coded-error";
import type { DocsClient } from "./executor";
import { executeDocument, updateDocument } from "./executor";
import { parseJsonAs } from "./json";
import { LinkMapSchema, type LinkStats, resolveLinkMap, rewriteLinks } from "./links";
import { type Config, lookupDoc } from "./mapping";
import { parseMarkdown } from "./parse";
import { planDocument } from "./plan";

const LINKS_RESOLVE = "pass --links a JSON object of path → URL";

const refuse = createRefuser<{
  file_not_found: { path: string };
  file_unreadable: { path: string; reason: string };
  file_not_markdown: { path: string };
  file_empty: { path: string };
  link_map_not_found: { path: string };
  link_map_unreadable: { path: string; reason: string };
  link_map_unparsed: { path: string };
  link_map_invalid: { path: string; problem: string };
  no_document_remembered: { path: string };
}>({
  file_not_found: {
    message: ({ path }) => `file not found: ${path}`,
    resolve: () => "check the path, then run the command again",
  },
  file_unreadable: {
    message: ({ path, reason }) => `cannot read ${path}: ${reason}`,
    resolve: ({ path }) => `make ${path} readable, then run the command again`,
  },
  file_not_markdown: {
    message: ({ path }) => `not a Markdown file (binary content or not UTF-8): ${path}`,
    resolve: ({ path }) => `save ${path} as UTF-8 text, then run the command again`,
  },
  file_empty: {
    message: ({ path }) => `file is empty: ${path}`,
    resolve: ({ path }) => `add content to ${path}, then run the command again`,
  },
  link_map_not_found: {
    message: ({ path }) => `link map not found: ${path}`,
    resolve: () => "check the --links path, then run the command again",
  },
  link_map_unreadable: {
    message: ({ path, reason }) => `cannot read link map ${path}: ${reason}`,
    resolve: ({ path }) => `make ${path} readable, then run the command again`,
  },
  link_map_unparsed: { message: ({ path }) => `link map is not JSON: ${path}`, resolve: () => LINKS_RESOLVE },
  link_map_invalid: {
    message: ({ path, problem }) => `link map is not a JSON object of path → URL: ${path} (${problem})`,
    resolve: () => LINKS_RESOLVE,
  },
  no_document_remembered: {
    message: ({ path }) => `no document remembered for ${path}`,
    resolve: ({ path }) => `md2gd ${shellWord(path)} --update <url|id>`,
  },
});

interface ReadCodes {
  missing: "file_not_found" | "link_map_not_found";
  unreadable: "file_unreadable" | "link_map_unreadable";
}

function shellWord(text: string): string {
  return /^[\w./~:@%+=,-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

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

async function readInput(path: string, codes: ReadCodes): Promise<Uint8Array> {
  try {
    return await Bun.file(path).bytes();
  } catch (error) {
    if (isMissingFile(error)) throw refuse(codes.missing, { path }, error);
    throw refuse(codes.unreadable, { path, reason: systemReasonOf(error) }, error);
  }
}

function decodeMarkdown(bytes: Uint8Array, filePath: string): string {
  if (bytes.includes(0)) throw refuse("file_not_markdown", { path: filePath });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw refuse("file_not_markdown", { path: filePath }, error);
  }
}

async function loadTree(filePath: string): Promise<Root> {
  const source = decodeMarkdown(
    await readInput(filePath, { missing: "file_not_found", unreadable: "file_unreadable" }),
    filePath,
  );
  if (source.trim().length === 0) throw refuse("file_empty", { path: filePath });

  return parseMarkdown(source);
}

async function applyLinkMap(tree: Root, filePath: string, options: ConvertOptions): Promise<void> {
  if (!options.links) return;
  const map = await loadLinkMap(options.links);
  options.onLinks?.(rewriteLinks(tree, filePath, map));
}

async function loadLinkMap(mapPath: string): Promise<Map<string, string>> {
  const parsed = parseJsonAs(
    LinkMapSchema,
    new TextDecoder().decode(
      await readInput(mapPath, { missing: "link_map_not_found", unreadable: "link_map_unreadable" }),
    ),
  );
  if (!parsed.ok) {
    if (parsed.failure === "unparsed") throw refuse("link_map_unparsed", { path: mapPath }, parsed.cause);
    throw refuse("link_map_invalid", { path: mapPath, problem: parsed.problem }, parsed.cause);
  }
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
): Promise<void> {
  const tree = await loadTree(filePath);
  await applyLinkMap(tree, filePath, options);
  const title = options.title ?? deriveTitle(tree, filePath);
  const folderId = options.folder ? parseFolderId(options.folder) : undefined;
  await updateDocument(client, documentId, title, planDocument(tree), folderId);
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
  config: Config,
): Promise<string> {
  if (updateTarget) return parseDocId(updateTarget);
  const remembered = await lookupDoc(config, filePath);
  if (remembered === null) throw refuse("no_document_remembered", { path: filePath });
  return remembered;
}
