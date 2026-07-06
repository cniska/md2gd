import { describe, expect, test } from "bun:test";
import { buildAuthUrl, exchangeCode, type FetchFn, parseClientSecret, refreshToken } from "./oauth";

const CLIENT = { clientId: "cid", clientSecret: "secret" };

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 400 });
}

describe("parseClientSecret", () => {
  test("reads client id and secret from an installed-app file", () => {
    const json = JSON.stringify({ installed: { client_id: "x", client_secret: "y", redirect_uris: [] } });
    expect(parseClientSecret(json)).toEqual({ clientId: "x", clientSecret: "y" });
  });
});

describe("buildAuthUrl", () => {
  test("requests offline access and forces consent to get a refresh token", () => {
    const url = new URL(buildAuthUrl("cid", "http://127.0.0.1:9000"));
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

describe("exchangeCode", () => {
  test("posts the code and stamps an absolute expiry", async () => {
    let sentBody = "";
    const mockFetch: FetchFn = (_url, init) => {
      sentBody = String(init.body);
      return Promise.resolve(jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
    };
    const token = await exchangeCode(CLIENT, "the-code", "http://127.0.0.1:9000", 1_000, mockFetch);
    expect(sentBody).toContain("grant_type=authorization_code");
    expect(sentBody).toContain("code=the-code");
    expect(token).toEqual({ accessToken: "at", refreshToken: "rt", expiryDate: 1_000 + 3600 * 1000 });
  });

  test("throws when Google returns no refresh token", async () => {
    const mockFetch: FetchFn = () => Promise.resolve(jsonResponse({ access_token: "at", expires_in: 3600 }));
    await expect(exchangeCode(CLIENT, "c", "http://127.0.0.1:9000", 0, mockFetch)).rejects.toThrow(/refresh token/);
  });
});

describe("refreshToken", () => {
  test("preserves the existing refresh token and re-stamps expiry", async () => {
    const mockFetch: FetchFn = () => Promise.resolve(jsonResponse({ access_token: "new", expires_in: 1800 }));
    const token = await refreshToken(CLIENT, "keep-me", 5_000, mockFetch);
    expect(token).toEqual({ accessToken: "new", refreshToken: "keep-me", expiryDate: 5_000 + 1800 * 1000 });
  });

  test("throws on a non-ok token response", async () => {
    const mockFetch: FetchFn = () => Promise.resolve(jsonResponse({ error: "bad" }, false));
    await expect(refreshToken(CLIENT, "r", 0, mockFetch)).rejects.toThrow(/token request failed/);
  });
});
