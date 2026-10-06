import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { A4 } from "./support/docs-document";
import { documentIdOf, withWorld } from "./support/world";

type Node = Record<string, unknown>;

const record = (value: unknown): Node => (typeof value === "object" && value !== null ? (value as Node) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function shape(content: unknown): unknown[] {
  return list(content).flatMap((raw): unknown[] => {
    const element = record(raw);
    if (element.sectionBreak) return [];
    const at = [element.startIndex, element.endIndex];
    const paragraph = record(element.paragraph);
    if (element.paragraph) {
      const bullet = record(paragraph.bullet);
      return [
        {
          at,
          text: list(paragraph.elements)
            .map((run) => record(record(run).textRun).content)
            .join(""),
          style: record(paragraph.paragraphStyle).namedStyleType,
          level: paragraph.bullet ? (bullet.nestingLevel ?? 0) : null,
        },
      ];
    }
    const table = record(element.table);
    return [
      {
        at,
        table: list(table.tableRows).map((row) =>
          list(record(row).tableCells).map((cell) => ({
            at: [record(cell).startIndex, record(cell).endIndex],
            content: shape(record(cell).content),
          })),
        ),
      },
    ];
  });
}

const fixtures = join(import.meta.dir, "fixtures");

describe("the Google fake against a document Google produced", () => {
  test("AC-2 a document renders into the same paragraphs, tables, and positions Google Docs gave it", async () => {
    const google = JSON.parse(readFileSync(join(fixtures, "probe.google.json"), "utf8"));
    await withWorld(async (world) => {
      world.google.page = A4;
      await world.init();
      const id = documentIdOf(await world.run([world.fixture("probe.md")]));

      expect(shape(record(record(world.google.document(id)).body).content)).toEqual(shape(record(google.body).content));
    });
  });
});
