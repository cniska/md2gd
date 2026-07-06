import { chmodSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { TOKEN_PATH } from "./config";

/** The cached OAuth token in the normalized form md2gd persists. */
export const StoredTokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Absolute expiry as epoch milliseconds. */
  expiryDate: z.number(),
});

export type StoredToken = z.infer<typeof StoredTokenSchema>;

/** Treat a token as expired slightly early so a request never races the clock. */
export function isExpired(token: StoredToken, now: number, skewMs = 60_000): boolean {
  return now >= token.expiryDate - skewMs;
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || ".";
}

/** Persist the token in a user-scoped file with owner-only permissions (AU-2). */
export async function saveToken(token: StoredToken, path: string = TOKEN_PATH): Promise<void> {
  mkdirSync(dirOf(path), { recursive: true, mode: 0o700 });
  await Bun.write(path, JSON.stringify(token, null, 2));
  chmodSync(path, 0o600);
}

/** Load the cached token, or null if none is stored yet. */
export async function loadToken(path: string = TOKEN_PATH): Promise<StoredToken | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return StoredTokenSchema.parse(JSON.parse(await file.text()));
}
