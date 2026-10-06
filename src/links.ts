import { dirname, resolve } from "node:path";
import type { Link, Root } from "mdast";
import { z } from "zod";

export const LinkMapSchema = z.record(z.string(), z.string().min(1));
export type LinkMap = z.infer<typeof LinkMapSchema>;

export interface LinkStats {
  rewritten: number;
  anchorsDropped: number;
  unmatched: number;
}

export function resolveLinkMap(raw: LinkMap, mapDir: string): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const [key, target] of Object.entries(raw)) {
    resolved.set(resolve(mapDir, key), toDocUrl(target));
  }
  return resolved;
}

function toDocUrl(target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  const id = /\/d\/([\w-]+)/.exec(target)?.[1] ?? target.trim();
  return `https://docs.google.com/document/d/${id}`;
}

export function rewriteLinks(tree: Root, sourceFilePath: string, map: Map<string, string>): LinkStats {
  const sourceDir = dirname(resolve(sourceFilePath));
  const stats: LinkStats = { rewritten: 0, anchorsDropped: 0, unmatched: 0 };
  walkLinks(tree, (link) => rewriteLink(link, sourceDir, map, stats));
  return stats;
}

function rewriteLink(link: Link, sourceDir: string, map: Map<string, string>, stats: LinkStats): void {
  const hash = link.url.indexOf("#");
  const rawPath = hash >= 0 ? link.url.slice(0, hash) : link.url;
  if (rawPath === "") return;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawPath)) return;

  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    path = rawPath;
  }

  const target = map.get(resolve(sourceDir, path));
  if (!target) {
    stats.unmatched++;
    return;
  }

  link.url = target;
  stats.rewritten++;
  if (hash >= 0) stats.anchorsDropped++;
}

function walkLinks(node: unknown, visit: (link: Link) => void): void {
  if (!node || typeof node !== "object") return;
  const n = node as { type?: string; children?: unknown[] };
  if (n.type === "link") visit(node as Link);
  if (Array.isArray(n.children)) for (const child of n.children) walkLinks(child, visit);
}
