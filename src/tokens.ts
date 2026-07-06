import { mkdirSync, writeFileSync } from "node:fs";
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

/** Persist the token in a user-scoped file created with owner-only permissions. */
export function saveToken(token: StoredToken, path: string = TOKEN_PATH): void {
  mkdirSync(dirOf(path), { recursive: true, mode: 0o700 });
  // Owner-only perms applied at creation — no brief world-readable window.
  writeFileSync(path, JSON.stringify(token, null, 2), { mode: 0o600 });
}

/** Load the cached token, or null if none is stored yet. */
export async function loadToken(path: string = TOKEN_PATH): Promise<StoredToken | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return StoredTokenSchema.parse(JSON.parse(await file.text()));
}
