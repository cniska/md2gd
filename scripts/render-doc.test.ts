import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Cleanup, cleanUp, DocumentSchema, describeDocument, parseCliArgs } from "./render-doc";

const run = (content: string) => ({ textRun: { content } });

describe("describeDocument", () => {
  test("lists each paragraph with its named style and bullet nesting", () => {
    const doc = DocumentSchema.parse({
      title: "Report",
      body: {
        content: [
          { sectionBreak: {} },
          { paragraph: { elements: [run("Report\n")], paragraphStyle: { namedStyleType: "HEADING_1" } } },
          {
            paragraph: {
              elements: [run("nested "), run("item 🙂\n")],
              paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
              bullet: { listId: "l1", nestingLevel: 1 },
            },
          },
        ],
      },
    });
    expect(describeDocument(doc)).toBe(
      ["title: Report", '[HEADING_1] "Report"', '[NORMAL_TEXT bullet@1] "nested item 🙂"'].join("\n"),
    );
  });

  test("shows a table's shape and each cell's paragraphs", () => {
    const cell = (text: string) => ({
      content: [{ paragraph: { elements: [run(`${text}\n`)], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } }],
    });
    const doc = DocumentSchema.parse({
      title: "T",
      body: { content: [{ table: { tableRows: [{ tableCells: [cell("A"), cell("B")] }] } }] },
    });
    expect(describeDocument(doc)).toBe(
      ["title: T", "[TABLE 1x2]", "  (0,0)", '    [NORMAL_TEXT] "A"', "  (0,1)", '    [NORMAL_TEXT] "B"'].join("\n"),
    );
  });
});

describe("parseCliArgs", () => {
  test("takes the file and passes title and links through, links made absolute", () => {
    const args = parseCliArgs(["doc.md", "--title", "T", "--links", "map.json", "--rerender"]);
    expect(args).toMatchObject({
      file: resolve("doc.md"),
      rerender: true,
      keep: false,
      passthrough: ["--title", "T", "--links", resolve("map.json")],
    });
  });

  test("rejects a flag whose value is missing", () => {
    expect(parseCliArgs(["doc.md", "--title"])).toBeNull();
    expect(parseCliArgs(["doc.md", "--out", "--keep"])).toBeNull();
    expect(parseCliArgs(["doc.md", "--links", ""])).toBeNull();
  });

  test("rejects a second file or an unknown flag", () => {
    expect(parseCliArgs(["a.md", "b.md"])).toBeNull();
    expect(parseCliArgs(["a.md", "--update"])).toBeNull();
    expect(parseCliArgs([])).toBeNull();
  });
});

describe("cleanUp", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function run(overrides: Partial<Cleanup> = {}): Cleanup & { trashed: string[]; warnings: string[] } {
    const trashed: string[] = [];
    const warnings: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "md2gd-cleanup-test-"));
    const home = mkdtempSync(join(tmpdir(), "md2gd-cleanup-home-"));
    dirs.push(dir, home);
    return {
      trashed,
      warnings,
      home,
      logPath: join(dir, "cli.log"),
      log: ["$ md2gd doc.md"],
      keep: false,
      findLeftovers: () => Promise.resolve(["left-1", "left-2"]),
      trash: (id) => {
        trashed.push(id);
        return Promise.resolve();
      },
      warn: (message) => warnings.push(message),
      ...overrides,
    };
  }

  test("deletes the credentials copy, writes the log, and trashes the run's doc", async () => {
    const r = run({ documentId: "doc-1" });
    await cleanUp(r);
    expect(existsSync(r.home as string)).toBe(false);
    expect(readFileSync(r.logPath, "utf8")).toBe("$ md2gd doc.md\n");
    expect(r.trashed).toEqual(["doc-1"]);
  });

  test("trashes the docs a run left when it failed before printing its URL", async () => {
    const r = run();
    await cleanUp(r);
    expect(r.trashed).toEqual(["left-1", "left-2"]);
  });

  test("keeps every doc when asked to", async () => {
    const r = run({ documentId: "doc-1", keep: true });
    await cleanUp(r);
    expect(r.trashed).toEqual([]);
  });

  test("still deletes the credentials and trashes when the log can't be written", async () => {
    const r = run({ documentId: "doc-1", logPath: "/nonexistent-dir/cli.log" });
    await cleanUp(r);
    expect(existsSync(r.home as string)).toBe(false);
    expect(r.trashed).toEqual(["doc-1"]);
    expect(r.warnings[0]).toStartWith("render: could not write cli.log");
  });

  test("warns instead of throwing when trashing fails, and tries every doc", async () => {
    const tried: string[] = [];
    const r = run({
      trash: (id) => {
        tried.push(id);
        return id === "left-1" ? Promise.reject(new Error("403")) : Promise.resolve();
      },
    });
    await cleanUp(r);
    expect(tried).toEqual(["left-1", "left-2"]);
    expect(r.warnings).toEqual(["render: could not trash left-1: 403"]);
  });
});
