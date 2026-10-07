import { describe, expect, test } from "bun:test";
import { googleEndpoint } from "./google-origin";

describe("googleEndpoint", () => {
  test("leaves a Google URL unchanged when no origin override is set", () => {
    expect(googleEndpoint("https://docs.googleapis.com/v1/documents", {})).toBe(
      "https://docs.googleapis.com/v1/documents",
    );
  });

  test("replaces only the origin, keeping the path", () => {
    const env = { MD2GD_GOOGLE_ORIGIN: "http://127.0.0.1:4321" };
    expect(googleEndpoint("https://oauth2.googleapis.com/token", env)).toBe("http://127.0.0.1:4321/token");
    expect(googleEndpoint("https://www.googleapis.com/drive/v3/files", env)).toBe(
      "http://127.0.0.1:4321/drive/v3/files",
    );
  });

  test("ignores an empty override", () => {
    expect(googleEndpoint("https://accounts.google.com/o/oauth2/v2/auth", { MD2GD_GOOGLE_ORIGIN: "" })).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
  });

  test("rejects an override that is not an http(s) origin", () => {
    expect(() => googleEndpoint("https://docs.googleapis.com/v1/documents", { MD2GD_GOOGLE_ORIGIN: "nope" })).toThrow(
      expect.objectContaining({ code: "google_origin_invalid", kind: "refusal", meta: { value: "nope" } }),
    );
    expect(() =>
      googleEndpoint("https://docs.googleapis.com/v1/documents", { MD2GD_GOOGLE_ORIGIN: "http://127.0.0.1:1/path" }),
    ).toThrow(expect.objectContaining({ code: "google_origin_invalid", meta: { value: "http://127.0.0.1:1/path" } }));
  });
});
