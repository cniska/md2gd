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

export interface AuthUrlParams {
  /** Opaque anti-forgery value echoed back on the redirect. */
  state: string;
  /** PKCE S256 code challenge. */
  codeChallenge: string;
}

/**
 * Build the consent URL. `access_type=offline` + `prompt=consent` ensure a
 * refresh token; `state` and PKCE (`code_challenge`) protect the loopback
 * callback against auth-code injection.
 */
export function buildAuthUrl(clientId: string, redirectUri: string, params: AuthUrlParams): string {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_ENDPOINT}?${query.toString()}`;
}

/** A URL-safe random token (base64url), used for `state` and PKCE verifiers. */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Buffer.from(buffer).toString("base64url");
}

/** Create a PKCE verifier and its S256 challenge. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(new Uint8Array(digest)).toString("base64url") };
}

async function postToken(fetchFn: FetchFn, body: URLSearchParams): Promise<z.infer<typeof TokenResponseSchema>> {
  const res = await fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text();
    if (detail.includes("invalid_grant")) {
      throw new Error("md2gd: stored authorization is no longer valid; run `md2gd init` again");
    }
    throw new Error(`md2gd: token request failed (${res.status})`);
  }
  return TokenResponseSchema.parse(await res.json());
}

/** Exchange an authorization code for tokens, stamping an absolute expiry. */
export async function exchangeCode(
  client: ClientSecret,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  now: number,
  fetchFn: FetchFn = fetch,
): Promise<StoredToken> {
  const body = new URLSearchParams({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
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
  // Google may rotate the refresh token; keep the new one if returned.
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? refresh,
    expiryDate: now + res.expires_in * 1000,
  };
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
