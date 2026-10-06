import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { citationProblems } from "./criteria";

const ROOT = join(import.meta.dir, "..");

const spec = readFileSync(join(ROOT, "SPEC.md"), "utf8");
const acceptance = readdirSync(import.meta.dir)
  .filter((file) => file.endsWith(".acceptance.ts"))
  .map((file) => readFileSync(join(import.meta.dir, file), "utf8"));

const VALID_SPEC = `
- **FR-1** — Does one thing.
- **FR-2** — Does another.
- **NF-1** — Is fast.
- **D-1** — Ships a binary.
- **AC-1** — Running it does one thing fast. (FR-1, NF-1)
- **AC-2** — Running it does another. (FR-2)
`;
const VALID_TESTS = [`test("AC-1 it does one thing", () => {});\ntest.todo("AC-2 it does another");`];

describe("the spec and the acceptance suite", () => {
  test("md2gd's spec and acceptance tests cite each other completely", () => {
    expect(citationProblems(spec, acceptance)).toEqual([]);
  });
});

describe("the citation check", () => {
  test("passes a spec and suite that cite each other completely", () => {
    expect(citationProblems(VALID_SPEC, VALID_TESTS)).toEqual([]);
  });

  test("finds no criteria or no tests as a problem rather than passing vacuously", () => {
    expect(citationProblems("", [])).toEqual(["no acceptance criteria found in the spec", "no acceptance tests found"]);
  });

  test("flags an acceptance test whose name cites no criterion", () => {
    const tests = [`${VALID_TESTS[0]}\ntest("it does a third thing", () => {});`];
    expect(citationProblems(VALID_SPEC, tests)).toEqual(['acceptance test "it does a third thing" cites no criterion']);
  });

  test("flags an acceptance test citing a criterion the spec lacks", () => {
    const tests = [`${VALID_TESTS[0]}\ntest.failing("AC-9 it does nothing", () => {});`];
    expect(citationProblems(VALID_SPEC, tests)).toEqual([
      'acceptance test "AC-9 it does nothing" cites AC-9, which the spec does not define',
    ]);
  });

  test("flags a criterion with neither a test nor a todo", () => {
    expect(citationProblems(VALID_SPEC, [`test("AC-1 it does one thing", () => {});`])).toEqual([
      "AC-2 has no acceptance test or todo",
    ]);
  });

  test("flags a sub-numbered id", () => {
    const spec = VALID_SPEC.replace("- **FR-2** — Does another.", "- **FR-1a** — Does another.").replace(
      "(FR-2)",
      "(FR-1a)",
    );
    expect(citationProblems(spec, VALID_TESTS)).toContain("FR-1a is not a family and a whole number");
  });

  test("flags a family not numbered from 1 without gaps", () => {
    const spec = VALID_SPEC.replace("- **FR-2** — Does another.", "- **FR-3** — Does another.").replace(
      "(FR-2)",
      "(FR-3)",
    );
    expect(citationProblems(spec, VALID_TESTS)).toEqual(["FR is numbered FR-1, FR-3 instead of from 1 without gaps"]);
  });

  test("flags a criterion that cites no requirement", () => {
    const spec = VALID_SPEC.replace("Running it does another. (FR-2)", "Running it does another.");
    expect(citationProblems(spec, VALID_TESTS)).toEqual(["AC-2 cites no requirement", "FR-2 is cited by no criterion"]);
  });

  test("flags a criterion citing a requirement the spec lacks", () => {
    const spec = VALID_SPEC.replace("(FR-2)", "(FR-2, FR-7)");
    expect(citationProblems(spec, VALID_TESTS)).toEqual(["AC-2 cites FR-7, which the spec does not define"]);
  });

  test("flags a requirement no criterion cites", () => {
    const spec = VALID_SPEC.replace("(FR-1, NF-1)", "(FR-1)");
    expect(citationProblems(spec, VALID_TESTS)).toEqual(["NF-1 is cited by no criterion"]);
  });

  test("does not require deliverables or constraints to be cited", () => {
    const spec = `${VALID_SPEC}- **TS-1** — Runs on Bun.\n`;
    expect(citationProblems(spec, VALID_TESTS)).toEqual([]);
  });

  test("flags an id mentioned in prose that the spec does not define", () => {
    const spec = `${VALID_SPEC}\nSee FR-9 for details.\n`;
    expect(citationProblems(spec, VALID_TESTS)).toEqual(["FR-9 is mentioned but not defined"]);
  });
});
