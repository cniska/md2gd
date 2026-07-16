import { dirname, resolve } from "node:path";
import type { Link, Root } from "mdast";
import { z } from "zod";

/** A path → Doc-URL map as loaded from a `--links` JSON file. */
export const LinkMapSchema = z.record(z.string(), z.string().min(1));
export type LinkMap = z.infer<typeof LinkMapSchema>;

/** What a rewrite pass changed, so the CLI can report it. */
export interface LinkStats {
  rewritten: number;
  anchorsDropped: number;
  unmatched: number;
}

/**
 * Turn a raw path → target map into absolute-source-path → followable Doc URL.
 * Keys resolve relative to the map file's own directory (like tsconfig paths),
 * so the map is self-contained and portable: it resolves the same regardless of
 * the working directory md2gd runs from. A target given as a bare id or an edit
 * URL is normalised to an https Doc URL. Pure: lexical path math only.
 */
export function resolveLinkMap(raw: LinkMap, mapDir: string): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const [key, target] of Object.entries(raw)) {
    resolved.set(resolve(mapDir, key), toDocUrl(target));
  }
  return resolved;
}

/** A full http(s) target passes through; a bare id or edit URL becomes a Doc URL. */
function toDocUrl(target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  const id = /\/d\/([\w-]+)/.exec(target)?.[1] ?? target.trim();
  return `https://docs.google.com/document/d/${id}`;
}

/**
 * Rewrite every relative link whose target is a mapped document to that
 * document's Doc URL, so cross-doc references become live hyperlinks (they
 * otherwise render as plain text, since a relative path is not followable from a
 * Doc). The link text is untouched; only the destination changes. Any
 * `#fragment` on a matched link is dropped — a Doc URL cannot address a Markdown
 * heading. Links with a scheme (http, mailto, …), in-page anchors, and targets
 * absent from the map are left as they are. Mutates the tree and reports what it
 * changed. Pure: lexical resolution against `sourceFilePath`, no I/O.
 */
export function rewriteLinks(tree: Root, sourceFilePath: string, map: Map<string, string>): LinkStats {
  const sourceDir = dirname(resolve(sourceFilePath));
  const stats: LinkStats = { rewritten: 0, anchorsDropped: 0, unmatched: 0 };
  walkLinks(tree, (link) => rewriteLink(link, sourceDir, map, stats));
  return stats;
}

function rewriteLink(link: Link, sourceDir: string, map: Map<string, string>, stats: LinkStats): void {
  // Split the fragment off the raw href: only a literal `#` delimits it, so an
  // encoded `%23` stays part of the path rather than being read as an anchor.
  const hash = link.url.indexOf("#");
  const rawPath = hash >= 0 ? link.url.slice(0, hash) : link.url;
  // An in-page anchor (`#section`) or empty target is not a cross-doc link.
  if (rawPath === "") return;
  // A link that already carries a scheme (http, mailto, javascript, …) points
  // somewhere real or unsafe; the scheme gate in inline.ts decides its fate. A
  // scheme is a literal colon, so this holds on the still-encoded path.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawPath)) return;

  // Decode only the path for lookup, so a percent-encoded name matches its
  // filesystem-spelled key; a malformed sequence throws, so fall back to raw.
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

/** Depth-first visit of every `link` node; links never nest, so no special-casing. */
function walkLinks(node: unknown, visit: (link: Link) => void): void {
  if (!node || typeof node !== "object") return;
  const n = node as { type?: string; children?: unknown[] };
  if (n.type === "link") visit(node as Link);
  if (Array.isArray(n.children)) for (const child of n.children) walkLinks(child, visit);
}
