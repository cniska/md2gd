#!/usr/bin/env bun
import { NAME, VERSION } from "./version";

export interface CliResult {
  /** Text to print to stdout. */
  stdout: string;
  /** Text to print to stderr. */
  stderr: string;
  /** Process exit code. */
  exitCode: number;
}

const HELP = `${NAME} v${VERSION}

Convert a Markdown file into a professionally styled Google Doc.

Usage:
  ${NAME} <file.md> [options]

Options:
  -h, --help       Show this help
  -V, --version    Show version
`;

function isHelp(arg: string | undefined): boolean {
  return arg === "help" || arg === "--help" || arg === "-h";
}

function isVersion(arg: string | undefined): boolean {
  return arg === "version" || arg === "--version" || arg === "-V";
}

/**
 * Pure entry point: maps argv to output and an exit code without touching the
 * process, so it can be unit-tested offline.
 */
export function runCli(argv: string[]): CliResult {
  const first = argv[0];

  if (argv.length === 0 || isHelp(first)) {
    return { stdout: HELP, stderr: "", exitCode: 0 };
  }
  if (isVersion(first)) {
    return { stdout: `${NAME} v${VERSION}`, stderr: "", exitCode: 0 };
  }

  // Conversion is implemented in later slices.
  return {
    stdout: "",
    stderr: `${NAME}: conversion not yet implemented`,
    exitCode: 1,
  };
}

async function main(): Promise<void> {
  const result = runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

if (import.meta.main) await main();
