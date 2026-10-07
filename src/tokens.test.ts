import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isExpired, loadToken, type StoredToken, saveToken } from "./tokens";

const token: StoredToken = { accessToken: "a", refreshToken: "r", expiryDate: 1_000_000 };

describe("isExpired", () => {
  test("is false well before expiry", () => {
    expect(isExpired(token, 900_000)).toBe(false);
  });

  test("is true past expiry", () => {
    expect(isExpired(token, 1_000_001)).toBe(true);
  });

  test("is true inside the safety skew before expiry", () => {
    expect(isExpired(token, 990_000, 60_000)).toBe(true);
  });
});

describe("saveToken / loadToken", () => {
  test("round-trips a token through disk", async () => {
    const path = `${tmpdir()}/md2gd-token-${Date.now()}.json`;
    await saveToken(token, path);
    expect(await loadToken(path)).toEqual(token);
  });

  test("loadToken returns null when no token is stored", async () => {
    expect(await loadToken(`${tmpdir()}/md2gd-absent-${Date.now()}.json`)).toBeNull();
  });

  test("loadToken refuses a stored token that is not JSON", async () => {
    const path = `${tmpdir()}/md2gd-token-corrupt-${Date.now()}.json`;
    writeFileSync(path, "{ not json");
    await expect(loadToken(path)).rejects.toThrow(
      expect.objectContaining({
        code: "token_unparsed",
        kind: "refusal",
        meta: { path, problem: "not JSON" },
        cause: expect.any(SyntaxError),
      }),
    );
  });

  test("loadToken refuses a stored token missing its fields", async () => {
    const path = `${tmpdir()}/md2gd-token-partial-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify({ accessToken: "a" }));
    await expect(loadToken(path)).rejects.toThrow(
      expect.objectContaining({
        code: "token_unparsed",
        meta: {
          path,
          problem:
            "refreshToken: Invalid input: expected string, received undefined; expiryDate: Invalid input: expected number, received undefined",
        },
      }),
    );
  });

  test("loadToken refuses a stored token with an empty refresh token", async () => {
    const path = `${tmpdir()}/md2gd-token-empty-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify({ ...token, refreshToken: "" }));
    await expect(loadToken(path)).rejects.toThrow(expect.objectContaining({ code: "token_unparsed" }));
  });

  test("loadToken refuses a stored token it may not read", async () => {
    const path = `${tmpdir()}/md2gd-token-locked-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify(token));
    chmodSync(path, 0o000);
    await expect(loadToken(path)).rejects.toThrow(
      expect.objectContaining({ code: "token_unreadable", meta: { path, reason: "permission denied" } }),
    );
  });

  test("saveToken refuses a directory it may not write", () => {
    const dir = `${tmpdir()}/md2gd-token-ro-${Date.now()}`;
    mkdirSync(dir, { mode: 0o500 });
    const path = `${dir}/token.json`;
    expect(() => saveToken(token, path)).toThrow(
      expect.objectContaining({ code: "token_unwritable", meta: { path, reason: "permission denied" } }),
    );
  });
});
