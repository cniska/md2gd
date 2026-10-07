import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { parseJsonAs } from "./json";

const Pair = z.object({ name: z.string(), count: z.number() });

describe("parseJsonAs", () => {
  test("returns the data when the JSON matches the schema", () => {
    expect(parseJsonAs(Pair, '{"name":"a","count":1}')).toEqual({ ok: true, data: { name: "a", count: 1 } });
  });

  test("names text that is not JSON", () => {
    expect(parseJsonAs(Pair, "<html>")).toEqual({
      ok: false,
      failure: "unparsed",
      problem: "not JSON",
      cause: expect.any(SyntaxError),
    });
  });

  test("names each bad field next to its own problem", () => {
    expect(parseJsonAs(Pair, '{"name":1}')).toEqual({
      ok: false,
      failure: "invalid",
      problem:
        "name: Invalid input: expected string, received number; count: Invalid input: expected number, received undefined",
      cause: expect.any(z.ZodError),
    });
  });

  test("names the whole body when the value itself is the wrong shape", () => {
    expect(parseJsonAs(Pair, "[]")).toEqual({
      ok: false,
      failure: "invalid",
      problem: "body: Invalid input: expected object, received array",
      cause: expect.any(z.ZodError),
    });
  });
});
