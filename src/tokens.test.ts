import { describe, expect, test } from "bun:test";
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
});
