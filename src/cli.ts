#!/usr/bin/env bun
import type { Command } from "./args";
import { parseArgs } from "./args";
import { documentUrl, GoogleDocsClient } from "./google";
import { loadStoredClientSecret, runInit } from "./init";
import { lookupDoc, recordDoc } from "./mapping";
import { getAccessToken } from "./oauth";
import { openInBrowser } from "./open";
import { convertFile, resolveUpdateTarget, updateFile } from "./pipeline";
import { NAME, VERSION } from "./version";

const HELP = `${NAME} v${VERSION}

Convert a Markdown file into a professionally styled Google Doc.

Usage:
  ${NAME} init --client <client_secret.json>                 One-time setup (browser consent)
  ${NAME} <file.md> [--title <t>] [--folder <url|id>] [--open]  Convert into a new doc, print its URL
  ${NAME} <file.md> --update [<url|id>] [--title <t>]        Re-render into an existing doc

Options:
  --title <t>          Override the document title (defaults to the H1 or filename)
  --folder <url|id>    Create the doc in this Drive folder (URL or id) instead of the md2gd folder
  --update [<url|id>]  Re-render into an existing doc instead of creating a new one.
                       With no argument, targets the doc previously made from this file.
  --open               Open the doc in your browser
  -h, --help           Show this help
  -V, --version        Show version
`;

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function finish(url: string, open: boolean): void {
  process.stdout.write(`${url}\n`);
  if (open) openInBrowser(url);
}

async function runConvert(command: Extract<Command, { kind: "convert" }>): Promise<void> {
  const { file, title, open, update, updateTarget, folder } = command;
  const secret = await loadStoredClientSecret();
  const client = new GoogleDocsClient({ getToken: () => getAccessToken(secret, Date.now()) });

  if (update) {
    // Stable-URL mode: re-render in place, so the URL persists. A --folder here
    // moves the doc into that folder (relocate) rather than creating a new one.
    const documentId = await resolveUpdateTarget(file, updateTarget);
    await updateFile(file, { title, folder }, client, documentId);
    finish(documentUrl(documentId), open);
    return;
  }

  // New doc. Note any prior doc from this file (so the destructive overwrite is
  // never implicit — the user must opt in with --update), then record the new one.
  const previous = await lookupDoc(file);
  const documentId = await convertFile(file, { title, folder }, client);
  await recordDoc(file, documentId);
  if (previous) {
    process.stderr.write(`${NAME}: previously created ${documentUrl(previous)} — pass --update to overwrite it\n`);
  }
  finish(documentUrl(documentId), open);
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));

  try {
    switch (command.kind) {
      case "help":
        process.stdout.write(`${HELP}\n`);
        return;
      case "version":
        process.stdout.write(`${NAME} v${VERSION}\n`);
        return;
      case "error":
        fail(`${NAME}: ${command.message}\n\n${HELP}`);
        return;
      case "init":
        await runInit(command.clientPath, (message) => process.stdout.write(`${message}\n`));
        return;
      case "convert":
        await runConvert(command);
        return;
    }
  } catch (error) {
    // Clear, non-crashing message; never dump a raw stack as primary output.
    fail(error instanceof Error ? error.message : `${NAME}: ${String(error)}`);
  }
}

if (import.meta.main) await main();
