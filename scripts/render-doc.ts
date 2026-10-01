#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CLIENT_SECRET_PATH, TOKEN_PATH } from "../src/config";
import { fetchWithRetry } from "../src/http";
import { type ClientSecret, parseClientSecret, refreshToken } from "../src/oauth";
import { parseDocId } from "../src/pipeline";
import { isExpired, type StoredToken, StoredTokenSchema } from "../src/tokens";

const USAGE = `Render a Markdown file through the real CLI into a scratch Google Doc and capture evidence.

Usage:
  bun run render -- <file.md> [--rerender] [--keep] [--out <dir>] [--title <t>] [--links <map.json>]

  --rerender   Run the CLI a second time with --update against the same doc (clear-and-rewrite path)
  --keep       Leave the doc in Drive instead of trashing it
  --out <dir>  Evidence directory (default .verify/<timestamp>)

Credentials: MD2GD_CLIENT_SECRET_JSON and MD2GD_TOKEN_JSON if set, else the stored md2gd config.`;

const SCRATCH_FOLDER = "md2gd-verify";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DOCS_API = "https://docs.googleapis.com/v1/documents";

const TextRunSchema = z.object({ content: z.string().optional() }).passthrough();
const ParagraphSchema = z
  .object({
    elements: z.array(z.object({ textRun: TextRunSchema.optional() }).passthrough()).default([]),
    paragraphStyle: z.object({ namedStyleType: z.string().optional() }).passthrough().optional(),
    bullet: z.object({ nestingLevel: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

type Element = {
  paragraph?: z.infer<typeof ParagraphSchema>;
  table?: { tableRows: { tableCells: { content: Element[] }[] }[] };
};

const ElementSchema: z.ZodType<Element> = z.lazy(() =>
  z
    .object({
      paragraph: ParagraphSchema.optional(),
      table: z
        .object({
          tableRows: z.array(z.object({ tableCells: z.array(z.object({ content: z.array(ElementSchema) })) })),
        })
        .optional(),
    })
    .passthrough(),
);

export const DocumentSchema = z
  .object({ title: z.string(), body: z.object({ content: z.array(ElementSchema) }) })
  .passthrough();

/**
 * A plain-text view of a document's structure, one line per paragraph, so an
 * agent can read heading levels, list nesting, and table shape without the raw JSON.
 */
export function describeDocument(doc: z.infer<typeof DocumentSchema>): string {
  return [`title: ${doc.title}`, ...describeElements(doc.body.content, "")].join("\n");
}

function describeElements(elements: Element[], indent: string): string[] {
  const lines: string[] = [];
  for (const element of elements) {
    if (element.paragraph) {
      const { paragraph } = element;
      const text = paragraph.elements
        .map((e) => e.textRun?.content ?? "")
        .join("")
        .replace(/\n$/, "");
      const style = paragraph.paragraphStyle?.namedStyleType ?? "?";
      const bullet = paragraph.bullet ? ` bullet@${paragraph.bullet.nestingLevel ?? 0}` : "";
      lines.push(`${indent}[${style}${bullet}] ${JSON.stringify(text)}`);
    } else if (element.table) {
      const rows = element.table.tableRows;
      lines.push(`${indent}[TABLE ${rows.length}x${rows[0]?.tableCells.length ?? 0}]`);
      rows.forEach((row, r) => {
        row.tableCells.forEach((cell, c) => {
          lines.push(`${indent}  (${r},${c})`);
          lines.push(...describeElements(cell.content, `${indent}    `));
        });
      });
    }
  }
  return lines;
}

interface Args {
  file: string;
  rerender: boolean;
  keep: boolean;
  out: string;
  passthrough: string[];
}

/** The harness's own arguments; null when they don't parse, so usage is shown. */
export function parseCliArgs(argv: string[]): Args | null {
  let file: string | undefined;
  let rerender = false;
  let keep = false;
  let out = join(".verify", new Date().toISOString().replace(/[:.]/g, "-"));
  const passthrough: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--rerender") rerender = true;
    else if (arg === "--keep") keep = true;
    else if (arg === "--out" || arg === "--title" || arg === "--links") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) return null;
      if (arg === "--out") out = value;
      else passthrough.push(arg, arg === "--links" ? resolve(value) : value);
    } else if (!arg.startsWith("-") && !file) file = arg;
    else return null;
  }
  return file ? { file: resolve(file), rerender, keep, out: resolve(out), passthrough } : null;
}

async function loadCredentials(): Promise<{ secretJson: string; client: ClientSecret; token: StoredToken }> {
  const secretJson = process.env.MD2GD_CLIENT_SECRET_JSON ?? (await readIfExists(CLIENT_SECRET_PATH));
  const tokenJson = process.env.MD2GD_TOKEN_JSON ?? (await readIfExists(TOKEN_PATH));
  if (!secretJson || !tokenJson) {
    throw new Error(
      `render: no credentials. Set MD2GD_CLIENT_SECRET_JSON and MD2GD_TOKEN_JSON, or run \`md2gd init\` (looked in ${CLIENT_SECRET_PATH}, ${TOKEN_PATH})`,
    );
  }
  return { secretJson, client: parseClientSecret(secretJson), token: StoredTokenSchema.parse(JSON.parse(tokenJson)) };
}

async function readIfExists(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
}

async function google(token: string, method: string, url: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetchWithRetry(fetch, url, init);
  if (!res.ok) throw new Error(`render: ${method} ${url} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function ensureScratchFolder(token: string): Promise<string> {
  const q = `name='${SCRATCH_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`;
  const found = z
    .object({ files: z.array(z.object({ id: z.string() })) })
    .parse(await (await google(token, "GET", `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`)).json());
  if (found.files[0]) return found.files[0].id;
  const created = await google(token, "POST", DRIVE_API, {
    name: SCRATCH_FOLDER,
    mimeType: "application/vnd.google-apps.folder",
  });
  return z.object({ id: z.string() }).parse(await created.json()).id;
}

/**
 * A throwaway HOME holding a copy of the credentials, so the CLI's token refresh
 * and file-to-doc mapping writes never touch the user's real md2gd config.
 */
function createIsolatedHome(secretJson: string, token: StoredToken): string {
  const home = mkdtempSync(join(tmpdir(), "md2gd-render-"));
  const configDir = process.platform === "darwin" ? join(home, ".md2gd") : join(home, ".config", "md2gd");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, "client_secret.json"), secretJson, { mode: 0o600 });
  writeFileSync(join(configDir, "token.json"), JSON.stringify(token), { mode: 0o600 });
  chmodSync(home, 0o700);
  return home;
}

function runCli(home: string, cliArgs: string[], log: string[]): string {
  const result = spawnSync("bun", ["run", "src/cli.ts", ...cliArgs], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    encoding: "utf8",
  });
  log.push(
    `$ md2gd ${cliArgs.join(" ")}`,
    `exit: ${result.status}`,
    `stdout: ${result.stdout}`,
    `stderr: ${result.stderr}`,
  );
  if (result.status !== 0) throw new Error(`render: CLI exited ${result.status}: ${result.stderr.trim()}`);
  const url = result.stdout.trim().split("\n").at(-1) ?? "";
  if (!url.startsWith("https://docs.google.com/document/d/"))
    throw new Error(`render: unexpected stdout: ${result.stdout}`);
  return url;
}

function renderPages(pdfPath: string, outDir: string): string[] {
  const probe = spawnSync("pdftoppm", ["-v"], { encoding: "utf8" });
  if (probe.error) return [];
  spawnSync("pdftoppm", ["-png", "-r", "80", pdfPath, join(outDir, "page")]);
  return Array.from(new Bun.Glob("page-*.png").scanSync(outDir)).sort();
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  const { secretJson, client, token: stored } = await loadCredentials();
  const token = isExpired(stored, Date.now()) ? await refreshToken(client, stored.refreshToken, Date.now()) : stored;
  const folderId = await ensureScratchFolder(token.accessToken);

  if (existsSync(args.out) && readdirSync(args.out).length > 0) {
    throw new Error(`render: ${args.out} is not empty; pass a new --out so old evidence isn't mixed in`);
  }
  mkdirSync(args.out, { recursive: true });
  const home = createIsolatedHome(secretJson, token);
  const log: string[] = [];
  let documentId: string | undefined;
  try {
    const url = runCli(home, [args.file, "--folder", folderId, ...args.passthrough], log);
    documentId = parseDocId(url);
    if (args.rerender) runCli(home, [args.file, "--update", documentId, ...args.passthrough], log);

    const raw = await (await google(token.accessToken, "GET", `${DOCS_API}/${documentId}`)).json();
    writeFileSync(join(args.out, "document.json"), JSON.stringify(raw, null, 2));
    writeFileSync(join(args.out, "outline.txt"), `${describeDocument(DocumentSchema.parse(raw))}\n`);

    const pdf = await google(token.accessToken, "GET", `${DRIVE_API}/${documentId}/export?mimeType=application/pdf`);
    const pdfPath = join(args.out, "document.pdf");
    writeFileSync(pdfPath, new Uint8Array(await pdf.arrayBuffer()));
    const pages = renderPages(pdfPath, args.out);

    process.stdout.write(
      [
        `doc: ${url}`,
        `evidence: ${args.out}`,
        "  cli.log  document.json  outline.txt  document.pdf",
        pages.length > 0 ? `  ${pages.join("  ")}` : "  (no PNG pages: pdftoppm not installed)",
        "",
      ].join("\n"),
    );
  } finally {
    writeFileSync(join(args.out, "cli.log"), `${log.join("\n")}\n`);
    rmSync(home, { recursive: true, force: true });
    if (documentId && !args.keep) {
      await google(token.accessToken, "PATCH", `${DRIVE_API}/${documentId}?supportsAllDrives=true`, { trashed: true });
      process.stdout.write(`trashed: ${documentId}\n`);
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
