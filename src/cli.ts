#!/usr/bin/env bun
import { parseArgs } from "./args";
import { documentUrl, GoogleDocsClient } from "./google";
import { loadStoredClientSecret, runInit } from "./init";
import { getAccessToken } from "./oauth";
import { convertFile } from "./pipeline";
import { NAME, VERSION } from "./version";

const HELP = `${NAME} v${VERSION}

Convert a Markdown file into a professionally styled Google Doc.

Usage:
  ${NAME} init --client <client_secret.json>   One-time setup (browser consent)
  ${NAME} <file.md> [--title <t>] [--open]     Convert and print the doc URL

Options:
  --title <t>      Override the document title (defaults to the H1 or filename)
  --open           Open the created doc in your browser
  -h, --help       Show this help
  -V, --version    Show version
`;

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function runConvert(file: string, title: string | undefined, open: boolean): Promise<void> {
  const secret = await loadStoredClientSecret();
  const client = new GoogleDocsClient({ getToken: () => getAccessToken(secret, Date.now()) });
  const documentId = await convertFile(file, { title }, client);
  const url = documentUrl(documentId);
  process.stdout.write(`${url}\n`);
  if (open) Bun.spawn(["open", url]);
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
        await runConvert(command.file, command.title, command.open);
        return;
    }
  } catch (error) {
    // Clear, non-crashing message; never dump a raw stack as primary output.
    fail(error instanceof Error ? error.message : `${NAME}: ${String(error)}`);
  }
}

if (import.meta.main) await main();
