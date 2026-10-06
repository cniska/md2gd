#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "scripts"];
const SPEC_ID = /\b(?:FR|ST|NF|AU|AC|TS)-\d+/;

export function findSpecIds(text: string): number[] {
  return text.split("\n").flatMap((line, i) => (SPEC_ID.test(line) ? [i + 1] : []));
}

async function main(): Promise<void> {
  const hits: string[] = [];
  for (const root of ROOTS) {
    if (!existsSync(root)) throw new Error(`check-spec-ids: ${root}/ not found`);
    for (const path of new Bun.Glob("**/*.ts").scanSync(root)) {
      const file = join(root, path);
      for (const line of findSpecIds(await Bun.file(file).text())) hits.push(`${file}:${line}`);
    }
  }
  if (hits.length === 0) return;
  process.stderr.write(`Spec IDs belong in SPEC.md, not code, comments, or test names:\n${hits.join("\n")}\n`);
  process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
