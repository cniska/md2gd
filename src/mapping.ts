import { mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { createRefuser, isMissingFile, systemReasonOf } from "./coded-error";
import { CONFIG_PATH } from "./config";
import { parseJsonAs } from "./json";

export const ConfigSchema = z
  .looseObject({
    docs: z.record(z.string(), z.string().min(1)).readonly().default({}),
  })
  .readonly();

export type Config = z.infer<typeof ConfigSchema>;

const refuse = createRefuser<{
  config_unparsed: { path: string };
  config_invalid: { path: string; problem: string };
  config_unreadable: { path: string; reason: string };
  config_unwritable: { path: string; reason: string };
}>({
  config_unparsed: {
    message: ({ path }) => `config.json is not JSON: ${path}`,
    resolve: ({ path }) => `fix the JSON in ${path}, or move the file aside to start with no remembered docs`,
  },
  config_invalid: {
    message: ({ path, problem }) => `config.json is not a valid md2gd config: ${path} (${problem})`,
    resolve: ({ path }) =>
      `make "docs" in ${path} an object of file path → doc id, or move the file aside to start with no remembered docs`,
  },
  config_unreadable: {
    message: ({ path, reason }) => `cannot read config.json ${path}: ${reason}`,
    resolve: ({ path }) => `make ${path} readable, then run the command again`,
  },
  config_unwritable: {
    message: ({ path, reason }) => `cannot write config.json ${path}: ${reason}`,
    resolve: ({ path }) => `make ${path} and ${dirname(path)} writable, then run the command again`,
  },
});

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return resolve(filePath);
  }
}

export async function loadConfig(path: string = CONFIG_PATH): Promise<Config> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    if (isMissingFile(error)) return { docs: {} };
    throw refuse("config_unreadable", { path, reason: systemReasonOf(error) }, error);
  }
  const parsed = parseJsonAs(ConfigSchema, text);
  if (parsed.ok) return parsed.data;
  if (parsed.failure === "unparsed") throw refuse("config_unparsed", { path }, parsed.cause);
  throw refuse("config_invalid", { path, problem: parsed.problem }, parsed.cause);
}

function writeConfig(path: string, config: Config): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    throw refuse("config_unwritable", { path, reason: systemReasonOf(error) }, error);
  }
}

export async function lookupDoc(config: Config, filePath: string): Promise<string | null> {
  return config.docs[await canonicalPath(filePath)] ?? null;
}

export async function recordDoc(filePath: string, documentId: string, path: string = CONFIG_PATH): Promise<void> {
  const current = await loadConfig(path);
  writeConfig(path, { ...current, docs: { ...current.docs, [await canonicalPath(filePath)]: documentId } });
}
