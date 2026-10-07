import { z } from "zod";
import { createFaulter, createRefuser } from "./coded-error";
import { SCOPES, TOKEN_PATH } from "./config";
import { googleEndpoint } from "./google-origin";
import {
  type FetchFn,
  fetchWithRetry,
  isResponseError,
  type RequestMeta,
  type ResponseMeta,
  responseErrorOf,
  statusOf,
} from "./http";
import { parseJsonAs } from "./json";
import { isExpired, loadToken, type StoredToken, saveToken } from "./tokens";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const ClientSecretSchema = z.object({
  installed: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) }),
});

export interface ClientSecret {
  clientId: string;
  clientSecret: string;
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
});

const refuse = createRefuser<{
  authorization_revoked: ResponseMeta;
  client_rejected: ResponseMeta;
  client_secret_invalid: { path: string; problem: string };
  not_authenticated: { path: string };
}>({
  authorization_revoked: {
    message: (meta) =>
      `Google no longer accepts md2gd's stored authorization for ${meta.method} ${meta.path} (${statusOf(meta)})`,
    resolve: () => "md2gd init",
  },
  client_rejected: {
    message: (meta) => `Google rejected md2gd's OAuth client for ${meta.method} ${meta.path} (${statusOf(meta)})`,
    resolve: () => "md2gd init --client <client_secret.json>",
  },
  client_secret_invalid: {
    message: ({ path, problem }) => `not an installed-app client secret: ${path} (${problem})`,
    resolve: () => "md2gd init --client <client_secret.json>",
  },
  not_authenticated: {
    message: ({ path }) => `not signed in to Google: no token at ${path}`,
    resolve: () => "md2gd init",
  },
});

const fault = createFaulter<{ token_response_invalid: RequestMeta & { problem: string }; no_refresh_token: object }>({
  no_refresh_token: { message: () => "Google granted offline consent without a refresh token" },
  token_response_invalid: {
    message: (meta) => `unexpected token response from Google for ${meta.method} ${meta.path} (${meta.problem})`,
  },
});

export function parseClientSecret(json: string, path: string): ClientSecret {
  const parsed = parseJsonAs(ClientSecretSchema, json);
  if (!parsed.ok) throw refuse("client_secret_invalid", { path, problem: parsed.problem }, parsed.cause);
  return { clientId: parsed.data.installed.client_id, clientSecret: parsed.data.installed.client_secret };
}

export interface AuthUrlParams {
  state: string;
  codeChallenge: string;
}

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
  return `${googleEndpoint(AUTH_ENDPOINT)}?${query.toString()}`;
}

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Buffer.from(buffer).toString("base64url");
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(new Uint8Array(digest)).toString("base64url") };
}

async function postToken(fetchFn: FetchFn, body: URLSearchParams): Promise<z.infer<typeof TokenResponseSchema>> {
  const url = googleEndpoint(TOKEN_ENDPOINT);
  const res = await fetchWithRetry(fetchFn, url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const error = await responseErrorOf(res, "POST", url);
    throw error.meta.reason === "invalid_client" ? refuse("client_rejected", error.meta, error) : error;
  }
  const parsed = parseJsonAs(TokenResponseSchema, await res.text());
  if (!parsed.ok) {
    throw fault(
      "token_response_invalid",
      { method: "POST", path: new URL(url).pathname, problem: parsed.problem },
      parsed.cause,
    );
  }
  return parsed.data;
}

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
  if (!res.refresh_token) throw fault("no_refresh_token", {});
  return { accessToken: res.access_token, refreshToken: res.refresh_token, expiryDate: now + res.expires_in * 1000 };
}

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
  const res = await postToken(fetchFn, body).catch((error: unknown) => {
    const revoked = isResponseError(error, "google_rejected") && error.meta.reason === "invalid_grant";
    throw revoked ? refuse("authorization_revoked", error.meta, error) : error;
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? refresh,
    expiryDate: now + res.expires_in * 1000,
  };
}

export async function getAccessToken(
  client: ClientSecret,
  now: number,
  fetchFn: FetchFn = fetch,
  path: string = TOKEN_PATH,
): Promise<string> {
  const cached = await loadToken(path);
  if (!cached) throw refuse("not_authenticated", { path });
  if (!isExpired(cached, now)) return cached.accessToken;

  const refreshed = await refreshToken(client, cached.refreshToken, now, fetchFn);
  saveToken(refreshed, path);
  return refreshed.accessToken;
}
