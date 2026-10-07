import { describe, expect, test } from "bun:test";
import { CodedError } from "./coded-error";
import { openInBrowser } from "./open";

describe("openInBrowser", () => {
  test("leaves an error that is not the system's own to the caller", () => {
    const broken = () => {
      throw Object.assign(new TypeError("bad argument"), { code: "ERR_INVALID_ARG_TYPE" });
    };
    expect(() => openInBrowser("https://example.test/doc", broken)).toThrow(TypeError);
  });

  test("leaves an md2gd error to the caller, though it carries a code", () => {
    const coded = new CodedError("sample_opener", "inner", {}, "r", "refusal");
    expect(() =>
      openInBrowser("https://example.test/doc", () => {
        throw coded;
      }),
    ).toThrow(coded);
  });

  test("launches the platform opener with the URL", () => {
    const launched: string[][] = [];
    openInBrowser("https://example.test/doc", (command) => {
      launched.push(command);
    });
    expect(launched).toHaveLength(1);
    expect(launched[0]?.at(-1)).toBe("https://example.test/doc");
  });

  test("refuses when no browser opener can be launched", () => {
    const missing = () => {
      throw Object.assign(new Error('Executable not found in $PATH: "xdg-open"'), { code: "ENOENT" });
    };
    expect(() => openInBrowser("https://example.test/doc", missing)).toThrow(
      expect.objectContaining({
        code: "browser_unopenable",
        kind: "refusal",
        meta: { url: "https://example.test/doc", reason: "no such file or directory" },
      }),
    );
  });
});
