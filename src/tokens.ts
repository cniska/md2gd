import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { TOKEN_PATH } from "./config";

export const StoredTokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiryDate: z.number(),
});

export type StoredToken = z.infer<typeof StoredTokenSchema>;

export function isExpired(token: StoredToken, now: number, skewMs = 60_000): boolean {
  return now >= token.expiryDate - skewMs;
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || ".";
}

export function saveToken(token: StoredToken, path: string = TOKEN_PATH): void {
  mkdirSync(dirOf(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(token, null, 2), { mode: 0o600 });
}

export async function loadToken(path: string = TOKEN_PATH): Promise<StoredToken | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return StoredTokenSchema.parse(JSON.parse(await file.text()));
}
