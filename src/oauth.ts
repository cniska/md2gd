import { z } from "zod";
import { SCOPES } from "./config";
import { isExpired, loadToken, type StoredToken, saveToken } from "./tokens";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** A Google "installed app" (desktop) client secret file. */
const ClientSecretSchema = z.object({
  installed: z.object({ client_id: z.string(), client_secret: z.string() }),
});

export interface ClientSecret {
  clientId: string;
  clientSecret: string;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
});

export function parseClientSecret(json: string): ClientSecret {
  const parsed = ClientSecretSchema.parse(JSON.parse(json));
  return { clientId: parsed.installed.client_id, clientSecret: parsed.installed.client_secret };
}

/** Build the consent URL; `access_type=offline` + `prompt=consent` ensure a refresh token. */
export function buildAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function postToken(fetchFn: FetchFn, body: URLSearchParams): Promise<z.infer<typeof TokenResponseSchema>> {
  const res = await fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`md2gd: token request failed (${res.status})`);
  return TokenResponseSchema.parse(await res.json());
}

/** Exchange an authorization code for tokens, stamping an absolute expiry. */
export async function exchangeCode(
  client: ClientSecret,
  code: string,
  redirectUri: string,
  now: number,
  fetchFn: FetchFn = fetch,
): Promise<StoredToken> {
  const body = new URLSearchParams({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await postToken(fetchFn, body);
  if (!res.refresh_token) throw new Error("md2gd: no refresh token returned; re-run init");
  return { accessToken: res.access_token, refreshToken: res.refresh_token, expiryDate: now + res.expires_in * 1000 };
}

/** Refresh an access token, preserving the existing refresh token. */
export async function refreshToken(
  client: ClientSecret,
  refresh: string,
  now: number,
  fetchFn: FetchFn = fetch,
): Promise<StoredToken> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  const res = await postToken(fetchFn, body);
  return { accessToken: res.access_token, refreshToken: refresh, expiryDate: now + res.expires_in * 1000 };
}

/**
 * Return a valid access token, refreshing and re-persisting it if the cached one
 * is expired. Throws if there is no cached token (the user must run `init`).
 */
export async function getAccessToken(client: ClientSecret, now: number, fetchFn: FetchFn = fetch): Promise<string> {
  const cached = await loadToken();
  if (!cached) throw new Error("md2gd: not authenticated; run `md2gd init` first");
  if (!isExpired(cached, now)) return cached.accessToken;

  const refreshed = await refreshToken(client, cached.refreshToken, now, fetchFn);
  await saveToken(refreshed);
  return refreshed.accessToken;
}
