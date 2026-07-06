import { describe, expect, test } from "bun:test";
import { runCli } from "./cli";
import { NAME, VERSION } from "./version";

describe("runCli", () => {
  test("no args prints help and exits 0", () => {
    const r = runCli([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("--help prints help and exits 0", () => {
    for (const flag of ["help", "--help", "-h"]) {
      const r = runCli([flag]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Usage:");
    }
  });

  test("--version prints name and version and exits 0", () => {
    for (const flag of ["version", "--version", "-V"]) {
      const r = runCli([flag]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(`${NAME} v${VERSION}`);
    }
  });

  test("unimplemented conversion exits non-zero with a clear message", () => {
    const r = runCli(["some.md"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(NAME);
  });
});
