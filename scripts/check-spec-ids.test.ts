import { describe, expect, test } from "bun:test";
import { findSpecIds } from "./check-spec-ids";

// Built at runtime so this file never trips the check it tests.
const id = (family: string, n: string) => `${family}-${n}`;

describe("findSpecIds", () => {
  test("reports each line naming a spec ID, by line number", () => {
    const text = ["ok", `// see ${id("FR", "12")}`, `test("x (${id("NF", "14a")})")`].join("\n");
    expect(findSpecIds(text)).toEqual([2, 3]);
  });

  test("ignores look-alikes inside longer words and other prefixes", () => {
    expect(findSpecIds(`UTF-16 ISO-8601 LAST-1 ${id("D", "2")}`)).toEqual([]);
  });
});
