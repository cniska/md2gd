import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BlockView,
  type DocView,
  fontOf,
  magnitude,
  type ParagraphView,
  paragraph,
  run,
  type TableView,
  viewOf,
} from "./support/doc-view";
import { documentIdOf, type World, withWorld } from "./support/world";

const SAMPLE = readFileSync(join(import.meta.dir, "..", "examples", "sample.md"), "utf8");

async function render(world: World, markdown: string, name = "styling.md"): Promise<DocView> {
  await world.init();
  return viewOf(world.google.document(documentIdOf(await world.run([world.write(name, markdown)]))));
}

const spaceAbove = (p: ParagraphView): number => magnitude(p.style.spaceAbove) ?? 0;
const spaceBelow = (p: ParagraphView): number => magnitude(p.style.spaceBelow) ?? 0;

const textRuns = (p: ParagraphView) => p.runs.filter((r) => r.text.trim() !== "");

const isCode = (p: ParagraphView): boolean => p.style.shading !== undefined;

function headingOf(view: DocView, level: 1 | 2 | 3): ParagraphView {
  const found = view.paragraphs.find((p) => p.style.namedStyleType === `HEADING_${level}`);
  if (!found) throw new Error(`no HEADING_${level} paragraph`);
  return found;
}

function blockAfter(view: DocView, text: string): { before: BlockView; after: ParagraphView } {
  const at = view.blocks.findIndex((b) => b.kind === "paragraph" && b.text === text);
  const after = view.blocks[at];
  const before = view.blocks[at - 1];
  if (at < 1 || !before || after?.kind !== "paragraph") throw new Error(`no block before "${text}"`);
  return { before, after };
}

function gapBefore(view: DocView, text: string): number {
  const { before, after } = blockAfter(view, text);
  return (before.kind === "paragraph" ? spaceBelow(before) : 0) + spaceAbove(after);
}

function onlyTable(view: DocView, depth = 0): TableView {
  const found = view.tables.filter((t) => t.tableDepth === depth);
  if (found.length !== 1 || !found[0]) throw new Error(`expected one table at depth ${depth}, found ${found.length}`);
  return found[0];
}

function quoteStartingWith(view: DocView, text: string): TableView {
  const found = view.tables.find((t) =>
    t.rows.some((row) =>
      row.some((cell) => cell.blocks.some((b) => b.kind === "paragraph" && b.text.startsWith(text))),
    ),
  );
  if (!found) throw new Error(`no table holds "${text}"`);
  return found;
}

const dataTables = (view: DocView): TableView[] => view.tables.filter((t) => t.rows.length > 1);

describe("the document's look", () => {
  test("AC-5 body text is set at one reading size with comfortable line spacing", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");
      const body = view.paragraphs.filter(
        (p) =>
          p.style.namedStyleType === "NORMAL_TEXT" &&
          p.tableDepth === 0 &&
          !isCode(p) &&
          p.style.keepWithNext !== true &&
          p.text !== "",
      );

      expect(body.length).toBeGreaterThan(5);
      expect(new Set(body.flatMap((p) => textRuns(p).map((r) => magnitude(r.style.fontSize)))).size).toBe(1);
      for (const p of body) expect(p.style.lineSpacing).toBeGreaterThan(100);
    });
  });

  test("AC-5 H1, H2 and H3 carry their own heading styles with no size override flattening them", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "# Top\n\nText.\n\n## Middle\n\nText.\n\n### Low\n\nText.\n");

      expect(paragraph(view, "Top").style.namedStyleType).toBe("HEADING_1");
      expect(paragraph(view, "Middle").style.namedStyleType).toBe("HEADING_2");
      expect(paragraph(view, "Low").style.namedStyleType).toBe("HEADING_3");
      for (const text of ["Top", "Middle", "Low"])
        expect(run(paragraph(view, text), text).style.fontSize).toBeUndefined();
    });
  });

  test("AC-5 H1 > H2 > H3 > body text by the font size each one renders at", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "# Top\n\nBody.\n\n## Middle\n\nText.\n\n### Low\n\nText.\n");
      const sizeOf = (text: string): number | undefined => {
        const p = paragraph(view, text);
        const named = view.namedTextStyles[String(p.style.namedStyleType)] ?? {};
        return magnitude(run(p, text).style.fontSize ?? named.fontSize);
      };

      const sizes = ["Top", "Middle", "Low", "Body."].map(sizeOf);
      expect(sizes.every((size) => size !== undefined)).toBe(true);
      expect(sizes).toEqual([...sizes].sort((a, b) => (b ?? 0) - (a ?? 0)));
      expect(new Set(sizes).size).toBe(4);
    });
  });

  test("AC-5 headings, paragraphs and lists have space around them", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");

      for (const level of [1, 2] as const) {
        expect(spaceAbove(headingOf(view, level))).toBeGreaterThan(0);
        expect(spaceBelow(headingOf(view, level))).toBeGreaterThan(0);
      }
      expect(gapBefore(view, "Findings")).toBeGreaterThan(0);
      expect(gapBefore(view, "Supporting areas:")).toBeGreaterThan(0);
    });
  });

  test("AC-5 a table's header row is bold on a shaded background, its cells are padded, and its rows do not split", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");
      const tables = dataTables(view);

      expect(tables.length).toBe(2);
      for (const table of tables) {
        const [header, ...body] = table.rows;
        for (const cell of header ?? []) {
          expect(cell.style.backgroundColor).toBeDefined();
          for (const block of cell.blocks)
            if (block.kind === "paragraph") for (const r of textRuns(block)) expect(r.style.bold).toBe(true);
        }
        for (const cell of body.flat()) {
          expect(cell.style.backgroundColor).toBeUndefined();
          for (const side of ["paddingTop", "paddingBottom", "paddingLeft", "paddingRight"])
            expect(magnitude(cell.style[side])).toBeGreaterThan(0);
        }
        for (const style of table.rowStyles) expect(style.preventOverflow).toBe(true);
      }
    });
  });

  test("AC-5 a table keeps Docs' cell borders rather than hiding them", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");

      for (const cell of dataTables(view).flatMap((t) => t.rows.flat()))
        for (const side of ["borderTop", "borderBottom", "borderLeft", "borderRight"]) {
          const border = cell.style[side] as { width?: unknown } | undefined;
          if (border !== undefined) expect(magnitude(border.width)).toBeGreaterThan(0);
        }
    });
  });

  test("AC-5 inline code and code blocks are set in monospace", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");
      const summary = view.paragraphs.find((p) => p.text.startsWith("The service is broadly ready"));
      if (!summary) throw new Error("no summary paragraph");

      expect(fontOf(run(summary, "config.json").style)).toBe("Roboto Mono");
      const code = view.paragraphs.filter(isCode);
      expect(code.length).toBe(2);
      for (const p of code) for (const r of textRuns(p)) expect(fontOf(r.style)).toBe("Roboto Mono");
    });
  });

  test("AC-5 a blockquote is accented with a visible left rule", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");
      const quote = quoteStartingWith(view, "Ship the blockers first");
      const border = quote.rows[0]?.[0]?.style.borderLeft as { width?: unknown } | undefined;

      expect(magnitude(border?.width)).toBeGreaterThan(0);
    });
  });

  test("AC-5 the page keeps Docs' default margins", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");

      expect(view.marginLeft).toBe(72);
      expect(view.marginRight).toBe(72);
    });
  });

  test("AC-5 a link is colored and underlined and stays clickable", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");
      const rollout = view.paragraphs.find((p) => p.text.startsWith("Progress so far"));
      if (!rollout) throw new Error("no rollout paragraph");
      const link = run(rollout, "runbook").style;

      expect(link.link).toEqual({ url: "https://example.com/runbook" });
      expect(link.underline).toBe(true);
      expect(link.foregroundColor).toBeDefined();
    });
  });

  test("AC-5 one typeface sets all non-code text, headings and table cells included", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");
      const body = fontOf(run(paragraph(view, "Service Readiness Review"), "Service Readiness Review").style);
      const prose = view.paragraphs.filter((p) => !isCode(p)).flatMap(textRuns);
      const families = new Set(prose.map((r) => fontOf(r.style)));

      expect(body).toBeDefined();
      expect(body).not.toBe("Roboto Mono");
      expect(families).toEqual(new Set([body, "Roboto Mono"]));
      expect(fontOf(run(paragraph(view, "Platform"), "Platform").style)).toBe(body);
    });
  });

  test("AC-5 converting the same input twice produces the same styling", async () => {
    await withWorld(async (world) => {
      await world.init();
      const input = world.write("sample.md", SAMPLE);
      const first = documentIdOf(await world.run([input]));
      const second = documentIdOf(await world.run([input]));
      const look = (id: string) => {
        const view = viewOf(world.google.document(id));
        return JSON.stringify(
          { blocks: view.blocks, lists: Object.values(view.lists), margins: [view.marginLeft, view.marginRight] },
          (key, value) => (key === "listId" ? undefined : value),
        );
      };

      expect(second).not.toBe(first);
      expect(look(second)).toBe(look(first));
    });
  });
});

describe("spacing pain points", () => {
  test("AC-19 paragraphs are separated by space after them, not by blank lines", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "First.\n\nSecond.\n\nThird.\n");
      const texts = view.blocks.flatMap((b) => (b.kind === "paragraph" ? [b.text] : []));

      expect(texts.slice(0, 3)).toEqual(["First.", "Second.", "Third."]);
      expect(spaceBelow(paragraph(view, "First."))).toBeGreaterThan(0);
      expect(spaceBelow(paragraph(view, "Second."))).toBeGreaterThan(0);
    });
  });

  test("AC-19 a table has space after it", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter table.\n");

      expect(blockAfter(view, "After table.").before.kind).toBe("table");
      expect(gapBefore(view, "After table.")).toBeGreaterThan(0);
    });
  });

  test("AC-19 a code block has space after it", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "Before.\n\n```\nlet x = 1;\n```\n\nAfter code.\n");

      expect(gapBefore(view, "After code.")).toBeGreaterThan(0);
    });
  });

  test("AC-19 a blockquote has space after it", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "Before.\n\n> Quoted.\n\nAfter quote.\n");

      expect(blockAfter(view, "After quote.").before.kind).toBe("table");
      expect(gapBefore(view, "After quote.")).toBeGreaterThan(0);
    });
  });

  test("AC-19 a list has space after it", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "Before.\n\n- one\n- two\n\nAfter list.\n");

      expect(paragraph(view, "two").bullet).toBeDefined();
      expect(gapBefore(view, "After list.")).toBeGreaterThan(0);
    });
  });

  test("AC-19 table cells have padding on all sides", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "| A | B |\n| --- | --- |\n| 1 | 2 |\n");

      for (const cell of onlyTable(view).rows.flat())
        for (const side of ["paddingTop", "paddingBottom", "paddingLeft", "paddingRight"])
          expect(magnitude(cell.style[side])).toBeGreaterThan(0);
    });
  });

  test("AC-19 headings have more space above than below", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "# Top\n\nText.\n\n## Middle\n\nText.\n\n### Low\n\nText.\n");

      for (const text of ["Top", "Middle", "Low"])
        expect(spaceAbove(paragraph(view, text))).toBeGreaterThan(spaceBelow(paragraph(view, text)));
    });
  });

  test("AC-19 a loose list spaces its items like paragraphs", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "Body.\n\n- alpha\n\n- beta\n\n- gamma\n\nEnd.\n");

      expect(paragraph(view, "alpha").bullet).toBeDefined();
      for (const item of ["alpha", "beta"])
        expect(spaceBelow(paragraph(view, item))).toBe(spaceBelow(paragraph(view, "Body.")));
    });
  });

  test("AC-19 a tight list keeps its items closer than paragraphs", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "Body.\n\n- alpha\n- beta\n- gamma\n\nEnd.\n");

      expect(paragraph(view, "alpha").bullet).toBeDefined();
      for (const item of ["alpha", "beta"])
        expect(spaceBelow(paragraph(view, item))).toBeLessThan(spaceBelow(paragraph(view, "Body.")));
    });
  });

  test("AC-19 the first and last blocks in a quote sit flush with its edges", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "Before.\n\n> Opening line.\n>\n> Closing line.\n\nAfter.\n");
      const blocks = quoteStartingWith(view, "Opening line.").rows[0]?.[0]?.blocks ?? [];
      const first = blocks[0];
      const last = blocks[blocks.length - 1];
      if (first?.kind !== "paragraph" || last?.kind !== "paragraph") throw new Error("the quote holds no paragraphs");

      expect(first.text).toBe("Opening line.");
      expect(last.text).toBe("Closing line.");
      expect(spaceAbove(first)).toBe(0);
      expect(spaceBelow(last)).toBe(0);
    });
  });

  test.failing("AC-19 a caption is kept on the same page as the table it introduces", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "Intro.\n\n**Customer journey**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
      const at = view.blocks.findIndex((b) => b.kind === "paragraph" && b.text === "Customer journey");
      const tableAt = view.blocks.findIndex((b) => b.kind === "table");
      const between = view.blocks.slice(at, tableAt);

      expect(at).toBeGreaterThanOrEqual(0);
      expect(tableAt).toBeGreaterThan(at);
      for (const block of between) expect(block.kind === "paragraph" && block.style.keepWithNext).toBe(true);
    });
  });
});
