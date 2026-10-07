#!/usr/bin/env bun
import type { Command } from "./args";
import { parseArgs } from "./args";
import { createRefuser, hasCode, reportOf } from "./coded-error";
import { documentUrl, GoogleDocsClient } from "./google";
import { loadStoredClientSecret, runInit } from "./init";
import type { LinkStats } from "./links";
import { loadConfig, lookupDoc, recordDoc } from "./mapping";
import { getAccessToken } from "./oauth";
import { openInBrowser } from "./open";
import { convertFile, resolveUpdateTarget, updateFile } from "./pipeline";
import { NAME, VERSION } from "./version";

const HELP = `${NAME} v${VERSION}

Convert a Markdown file into a professionally styled Google Doc.

Usage:
  ${NAME} init [--client <client_secret.json>]                                                      One-time setup (browser consent)
  ${NAME} <file.md> [--title <t>] [--folder <url|id>] [--links <map>] [--open]                      Convert into a new doc, print its URL
  ${NAME} <file.md> --update [<url|id>] [--title <t>] [--folder <url|id>] [--links <map>] [--open]  Re-render into an existing doc

Options:
  --title <t>          Override the document title (defaults to the H1 or filename)
  --folder <url|id>    Create the doc in this Drive folder (URL or id) instead of the md2gd folder
  --links <map.json>   Rewrite relative links to other docs in this path→URL map into live Doc links
  --update [<url|id>]  Re-render into an existing doc instead of creating a new one.
                       With no argument, targets the doc previously made from this file.
  --open               Open the doc in your browser
  -h, --help           Show this help
  -V, --version        Show version
`;

const refuse = createRefuser<{ usage: { problem: string } }>({
  usage: { message: ({ problem }) => problem, resolve: () => `${NAME} --help` },
});

function fail(error: unknown): void {
  process.stderr.write(reportOf(error));
  process.exitCode = hasCode(error, "usage") ? 2 : 1;
}

function reportLinks(stats: LinkStats): void {
  if (stats.rewritten === 0 && stats.unmatched === 0) return;
  const parts = [`${stats.rewritten} cross-link${stats.rewritten === 1 ? "" : "s"} linked`];
  if (stats.anchorsDropped > 0) parts.push(`${stats.anchorsDropped} anchor(s) dropped`);
  if (stats.unmatched > 0) parts.push(`${stats.unmatched} unmatched`);
  process.stderr.write(`${NAME}: ${parts.join(", ")}\n`);
}

async function runConvert(command: Extract<Command, { kind: "convert" }>): Promise<void> {
  const { file, title, open, update, updateTarget, folder, links } = command;
  const secret = await loadStoredClientSecret();
  const client = new GoogleDocsClient({ getToken: () => getAccessToken(secret, Date.now()) });
  const config = await loadConfig();
  const options = { title, folder, links, onLinks: reportLinks };

  let documentId: string;
  if (update) {
    documentId = await resolveUpdateTarget(file, updateTarget, config);
    await updateFile(file, options, client, documentId);
  } else {
    documentId = await convertFile(file, options, client);
  }
  const url = documentUrl(documentId);
  process.stdout.write(`${url}\n`);
  const previous = update ? null : await lookupDoc(config, file);
  if (previous !== null) {
    process.stderr.write(`${NAME}: previously created ${documentUrl(previous)} — pass --update to overwrite it\n`);
  }
  const unopened = open ? openFailure(url) : null;
  await recordDoc(file, documentId);
  if (unopened !== null) throw unopened;
}

function openFailure(url: string): unknown {
  try {
    openInBrowser(url);
    return null;
  } catch (error) {
    return error;
  }
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2), process.env.HOME);

  try {
    switch (command.kind) {
      case "help":
        process.stdout.write(`${HELP}\n`);
        return;
      case "version":
        process.stdout.write(`${NAME} v${VERSION}\n`);
        return;
      case "error":
        fail(refuse("usage", { problem: command.message }));
        return;
      case "init":
        await runInit(command.clientPath, (message) => process.stdout.write(`${message}\n`));
        return;
      case "convert":
        await runConvert(command);
        return;
    }
  } catch (error) {
    fail(error);
  }
}

if (import.meta.main) await main();
