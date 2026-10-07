import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { createRefuser, isMissingFile, systemReasonOf } from "./coded-error";
import { TOKEN_PATH } from "./config";
import { parseJsonAs } from "./json";

export const StoredTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiryDate: z.number(),
});

export type StoredToken = z.infer<typeof StoredTokenSchema>;

const refuse = createRefuser<{
  token_unparsed: { path: string; problem: string };
  token_unreadable: { path: string; reason: string };
  token_unwritable: { path: string; reason: string };
}>({
  token_unparsed: {
    message: ({ path, problem }) => `stored token is not a valid token: ${path} (${problem})`,
    resolve: () => "md2gd init",
  },
  token_unreadable: {
    message: ({ path, reason }) => `cannot read stored token ${path}: ${reason}`,
    resolve: ({ path }) => `make ${path} readable, then run the command again`,
  },
  token_unwritable: {
    message: ({ path, reason }) => `cannot store token in ${path}: ${reason}`,
    resolve: ({ path }) => `make ${path} and ${dirname(path)} writable, then run the command again`,
  },
});

export function isExpired(token: StoredToken, now: number, skewMs = 60_000): boolean {
  return now >= token.expiryDate - skewMs;
}

export function saveToken(token: StoredToken, path: string = TOKEN_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(token, null, 2), { mode: 0o600 });
  } catch (error) {
    throw refuse("token_unwritable", { path, reason: systemReasonOf(error) }, error);
  }
}

export async function loadToken(path: string = TOKEN_PATH): Promise<StoredToken | null> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw refuse("token_unreadable", { path, reason: systemReasonOf(error) }, error);
  }
  const parsed = parseJsonAs(StoredTokenSchema, text);
  if (!parsed.ok) throw refuse("token_unparsed", { path, problem: parsed.problem }, parsed.cause);
  return parsed.data;
}
