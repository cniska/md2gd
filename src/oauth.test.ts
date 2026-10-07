import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { FetchFn } from "./http";
import { buildAuthUrl, createPkce, exchangeCode, getAccessToken, parseClientSecret, refreshToken } from "./oauth";

const CLIENT = { clientId: "cid", clientSecret: "secret" };

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 400 });
}

describe("parseClientSecret", () => {
  test("reads client id and secret from an installed-app file", () => {
    const json = JSON.stringify({ installed: { client_id: "x", client_secret: "y", redirect_uris: [] } });
    expect(parseClientSecret(json, "cs.json")).toEqual({ clientId: "x", clientSecret: "y" });
  });

  test("refuses a file that is not JSON", () => {
    expect(() => parseClientSecret("{ nope", "cs.json")).toThrow(
      expect.objectContaining({
        code: "client_secret_invalid",
        kind: "refusal",
        meta: expect.objectContaining({ path: "cs.json" }),
      }),
    );
  });

  test("refuses a secret with an empty client id, before any consent is asked", () => {
    const json = JSON.stringify({ installed: { client_id: "", client_secret: "y" } });
    expect(() => parseClientSecret(json, "cs.json")).toThrow(
      expect.objectContaining({ code: "client_secret_invalid", meta: expect.objectContaining({ path: "cs.json" }) }),
    );
  });

  test("refuses a web-app secret, which lacks the installed-app block", () => {
    const json = JSON.stringify({ web: { client_id: "x", client_secret: "y" } });
    expect(() => parseClientSecret(json, "cs.json")).toThrow(
      expect.objectContaining({
        code: "client_secret_invalid",
        meta: { path: "cs.json", problem: "installed: Invalid input: expected object, received undefined" },
      }),
    );
  });
});

describe("buildAuthUrl", () => {
  test("requests offline access, forces consent, and carries state + PKCE", () => {
    const url = new URL(buildAuthUrl("cid", "http://127.0.0.1:9000", { state: "st8", codeChallenge: "chal" }));
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("createPkce", () => {
  test("produces a verifier and a distinct challenge", async () => {
    const { verifier, challenge } = await createPkce();
    expect(verifier.length).toBeGreaterThan(20);
    expect(challenge.length).toBeGreaterThan(20);
    expect(challenge).not.toBe(verifier);
  });
});

describe("exchangeCode", () => {
  test("posts the code and stamps an absolute expiry", async () => {
    let sentBody = "";
    const mockFetch: FetchFn = (_url, init) => {
      sentBody = String(init.body);
      return Promise.resolve(jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
    };
    const token = await exchangeCode(CLIENT, "the-code", "http://127.0.0.1:9000", "verifier1", 1_000, mockFetch);
    expect(sentBody).toContain("grant_type=authorization_code");
    expect(sentBody).toContain("code=the-code");
    expect(sentBody).toContain("code_verifier=verifier1");
    expect(token).toEqual({ accessToken: "at", refreshToken: "rt", expiryDate: 1_000 + 3600 * 1000 });
  });

  test("leaves a code exchange Google refuses a fault, not a revoked authorization", async () => {
    const mockFetch: FetchFn = () => Promise.resolve(jsonResponse({ error: "invalid_grant" }, false));
    await expect(exchangeCode(CLIENT, "c", "http://127.0.0.1:9000", "v", 0, mockFetch)).rejects.toThrow(
      expect.objectContaining({ code: "google_rejected", kind: "fault" }),
    );
  });

  test("names a consent that returns no refresh token a fault", async () => {
    const mockFetch: FetchFn = () => Promise.resolve(jsonResponse({ access_token: "at", expires_in: 3600 }));
    await expect(exchangeCode(CLIENT, "c", "http://127.0.0.1:9000", "v", 0, mockFetch)).rejects.toThrow(
      expect.objectContaining({ code: "no_refresh_token", kind: "fault" }),
    );
  });
});

describe("getAccessToken", () => {
  test("refuses a run with no stored token", async () => {
    const path = `${tmpdir()}/md2gd-no-token-${Date.now()}.json`;
    await expect(getAccessToken(CLIENT, 0, fetch, path)).rejects.toThrow(
      expect.objectContaining({ code: "not_authenticated", kind: "refusal", meta: { path } }),
    );
  });
});

describe("refreshToken", () => {
  test("preserves the existing refresh token and re-stamps expiry", async () => {
    const mockFetch: FetchFn = () => Promise.resolve(jsonResponse({ access_token: "new", expires_in: 1800 }));
    const token = await refreshToken(CLIENT, "keep-me", 5_000, mockFetch);
    expect(token).toEqual({ accessToken: "new", refreshToken: "keep-me", expiryDate: 5_000 + 1800 * 1000 });
  });

  test("leaves a token request Google rejects for another reason a fault, with its reason", async () => {
    const mockFetch: FetchFn = () => Promise.resolve(jsonResponse({ error: "unsupported_grant_type" }, false));
    await expect(refreshToken(CLIENT, "r", 0, mockFetch)).rejects.toThrow(
      expect.objectContaining({
        code: "google_rejected",
        kind: "fault",
        meta: expect.objectContaining({ path: "/token", status: 400, reason: "unsupported_grant_type" }),
      }),
    );
  });

  test("refuses a refresh token Google has revoked", async () => {
    const mockFetch: FetchFn = () =>
      Promise.resolve(
        jsonResponse({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, false),
      );
    await expect(refreshToken(CLIENT, "r", 0, mockFetch)).rejects.toThrow(
      expect.objectContaining({
        code: "authorization_revoked",
        kind: "refusal",
        meta: expect.objectContaining({ status: 400, reason: "invalid_grant" }),
      }),
    );
  });

  test("refuses a client Google does not recognise", async () => {
    const mockFetch: FetchFn = () =>
      Promise.resolve(new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }));
    await expect(refreshToken(CLIENT, "r", 0, mockFetch)).rejects.toThrow(
      expect.objectContaining({
        code: "client_rejected",
        meta: expect.objectContaining({ method: "POST", path: "/token", status: 401, reason: "invalid_client" }),
      }),
    );
  });

  test("names a token response missing the access token a fault", async () => {
    const mockFetch: FetchFn = () => Promise.resolve(jsonResponse({ expires_in: 3600 }));
    await expect(refreshToken(CLIENT, "r", 0, mockFetch)).rejects.toThrow(
      expect.objectContaining({ code: "token_response_invalid", kind: "fault" }),
    );
  });
});
