import { describe, expect, test } from "bun:test";
import { CodedError, createFaulter, createRefuser, reportOf, systemReasonOf } from "./coded-error";

const refuse = createRefuser<{ sample_refusal: { path: string } }>({
  sample_refusal: {
    message: ({ path }) => `file not found: ${path}`,
    resolve: ({ path }) => `check the path ${path}`,
  },
});

describe("createRefuser", () => {
  test("builds a refusal carrying its code, meta, message and resolve", () => {
    const error = refuse("sample_refusal", { path: "a.md" });

    expect(error).toBeInstanceOf(CodedError);
    expect(error).toMatchObject({
      code: "sample_refusal",
      kind: "refusal",
      meta: { path: "a.md" },
      message: "file not found: a.md",
      resolve: "check the path a.md",
    });
  });

  test("refuses a table declaring a code another table already declared", () => {
    expect(() =>
      createRefuser<{ sample_refusal: object }>({ sample_refusal: { message: () => "again", resolve: () => "again" } }),
    ).toThrow("error code sample_refusal is declared by two tables");
  });
});

describe("createFaulter", () => {
  test("builds a fault whose resolve asks for an issue", () => {
    const fault = createFaulter<{ sample_fault: { at: string } }>({
      sample_fault: { message: ({ at }) => `lost ${at}` },
    });

    expect(fault("sample_fault", { at: "x" })).toMatchObject({
      code: "sample_fault",
      kind: "fault",
      meta: { at: "x" },
      message: "lost x",
      resolve: "this is a bug in md2gd; file an issue at https://github.com/cniska/md2gd/issues with the lines above",
    });
  });
});

describe("a cause", () => {
  test("is carried for whoever debugs the error, and kept out of the report", () => {
    const cause = new Error("ECONNREFUSED 127.0.0.1:443");
    const error = refuse("sample_refusal", { path: "a.md" }, cause);
    expect(error.cause).toBe(cause);
    expect(reportOf(error)).toBe("md2gd: file not found: a.md [sample_refusal]\nresolve: check the path a.md\n");
  });
});

describe("reportOf", () => {
  test("prints a refusal as its cause with its code, then its resolve", () => {
    expect(reportOf(refuse("sample_refusal", { path: "a.md" }))).toBe(
      "md2gd: file not found: a.md [sample_refusal]\nresolve: check the path a.md\n",
    );
  });
});

describe("systemReasonOf", () => {
  test("names a known system error by its plain reason", () => {
    expect(systemReasonOf(Object.assign(new Error("EACCES: permission denied, open '/x'"), { code: "EACCES" }))).toBe(
      "permission denied",
    );
  });

  test("folds an unknown system error's message onto one line", () => {
    expect(systemReasonOf(Object.assign(new Error("EIO: i/o error\n  at read"), { code: "EIO" }))).toBe(
      "EIO: i/o error at read",
    );
  });
});

describe("reportOf, for what is not a refusal", () => {
  const BUG_LINE =
    "resolve: this is a bug in md2gd; file an issue at https://github.com/cniska/md2gd/issues with the lines above\n";

  test("prints a fault with the request to file an issue", () => {
    const fault = createFaulter<{ sample_report_fault: { at: string } }>({
      sample_report_fault: { message: ({ at }) => `lost ${at}` },
    });
    expect(reportOf(fault("sample_report_fault", { at: "x" }))).toBe(
      `md2gd: lost x [sample_report_fault]\n${BUG_LINE}`,
    );
  });

  test("prints an uncoded error as the fault unexpected, on one line and without a stack", () => {
    expect(reportOf(new Error("boom\n    at somewhere"))).toBe(`md2gd: boom at somewhere [unexpected]\n${BUG_LINE}`);
  });

  test("keeps the report to two lines when a message or resolve carries a newline", () => {
    const refuseLined = createRefuser<{ sample_lined: { path: string } }>({
      sample_lined: { message: ({ path }) => `cannot read ${path}`, resolve: ({ path }) => `fix ${path}` },
    });
    expect(reportOf(refuseLined("sample_lined", { path: "a\nb.md" }))).toBe(
      "md2gd: cannot read a b.md [sample_lined]\nresolve: fix a b.md\n",
    );
  });

  test("prints a value it cannot turn into text as the fault unexpected", () => {
    expect(reportOf(Object.create(null))).toBe(`md2gd: an error md2gd could not print [unexpected]\n${BUG_LINE}`);
  });

  test("every module's codes are distinct, so the CLI loads", async () => {
    expect(await import("./cli")).toBeDefined();
  });

  test("prints a thrown value that is not an error as the fault unexpected", () => {
    expect(reportOf("plain")).toBe(`md2gd: plain [unexpected]\n${BUG_LINE}`);
  });
});
