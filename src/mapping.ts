import { mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { CONFIG_PATH } from "./config";

/**
 * The persisted config. Only `docs` — a canonical-path → document-id map used
 * for `--update` without an explicit target — is managed here; `passthrough`
 * preserves any other keys future config may add, so writing never clobbers them.
 */
export const ConfigSchema = z.looseObject({
  docs: z.record(z.string(), z.string()).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Expand a leading `~` and resolve to a canonical absolute path (symlinks too). */
export async function canonicalPath(filePath: string): Promise<string> {
  const expanded = filePath.startsWith("~/") ? `${process.env.HOME ?? ""}${filePath.slice(1)}` : filePath;
  try {
    return await realpath(expanded);
  } catch {
    // File may not exist (or realpath unsupported here); fall back to a resolved path.
    return resolve(expanded);
  }
}

async function readConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { docs: {} };
  try {
    return ConfigSchema.parse(JSON.parse(await file.text()));
  } catch {
    // A corrupt config must never abort a conversion — treat it as empty.
    return { docs: {} };
  }
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || ".";
}

function writeConfig(path: string, config: Config): void {
  mkdirSync(dirOf(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** The document id previously created from this file, if any. */
export async function lookupDoc(filePath: string, path: string = CONFIG_PATH): Promise<string | undefined> {
  const config = await readConfig(path);
  return config.docs[await canonicalPath(filePath)];
}

/** Remember that this file was rendered into this document, for a later `--update`. */
export async function recordDoc(filePath: string, documentId: string, path: string = CONFIG_PATH): Promise<void> {
  const config = await readConfig(path);
  config.docs[await canonicalPath(filePath)] = documentId;
  writeConfig(path, config);
}
