import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type BlockView,
  type DocView,
  fontOf,
  magnitude,
  type ParagraphView,
  paragraph,
  styleAt,
  type TableView,
  viewOf,
} from "./support/doc-view";
import { documentIdOf, type World, withWorld } from "./support/world";

const SAMPLE = readFileSync(join(import.meta.dir, "..", "examples", "sample.md"), "utf8");

const DOCS_URL = /^https:\/\/docs\.google\.com\/document\/d\/([\w-]+)\/edit$/;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";

const ROUNDING_PT = 0.01;
const PRESET_TEXT_INDENT_PER_LEVEL_PT = 36;
const BODY_FONT_SIZE_PT = 11;
const AVERAGE_GLYPH_EM = 0.6;

async function render(world: World, markdown: string, name = "conversion.md"): Promise<DocView> {
  await world.init();
  return viewOf(world.google.document(documentIdOf(await world.run([world.write(name, markdown)]))));
}

const BorderWidth = z.object({ width: z.object({ magnitude: z.number() }) });
const borderWidth = (border: unknown): number => BorderWidth.safeParse(border).data?.width.magnitude ?? 0;

const textOf = (text: string): string => text.replace(/\n$/, "");
const visibleRuns = (p: ParagraphView) => p.runs.filter((r) => textOf(r.text) !== "");

const columnWidths = (table: TableView): number[] => table.columns.map((column) => magnitude(column.width) ?? 0);
const totalWidth = (table: TableView): number => columnWidths(table).reduce((sum, width) => sum + width, 0);

function isQuote(table: TableView): boolean {
  const cell = table.rows[0]?.[0];
  return (
    table.rows.length === 1 &&
    table.rows[0]?.length === 1 &&
    cell !== undefined &&
    borderWidth(cell.style.borderLeft) > 0 &&
    borderWidth(cell.style.borderTop) === 0 &&
    borderWidth(cell.style.borderRight) === 0 &&
    borderWidth(cell.style.borderBottom) === 0
  );
}

function onlyCell(table: TableView) {
  const cell = table.rows[0]?.[0];
  if (!cell) throw new Error("the table has no cell");
  return cell;
}

function holding(view: DocView, text: string): TableView {
  const found = view.tables.filter((t) =>
    t.rows.some((row) => row.some((cell) => cell.blocks.some((b) => b.kind === "paragraph" && b.text === text))),
  );
  const [only] = found;
  if (found.length !== 1 || !only)
    throw new Error(`expected one table directly holding "${text}", found ${found.length}`);
  return only;
}

function paragraphStarting(view: DocView, prefix: string): ParagraphView {
  const found = view.paragraphs.filter((p) => p.text.startsWith(prefix));
  const [only] = found;
  if (found.length !== 1 || !only)
    throw new Error(`expected one paragraph starting "${prefix}", found ${found.length}`);
  return only;
}

function glyphOf(view: DocView, p: ParagraphView): Record<string, unknown> {
  if (!p.bullet) throw new Error(`"${p.text}" has no bullet`);
  const level = view.lists[p.bullet.listId]?.[p.bullet.nestingLevel];
  if (!level) throw new Error(`"${p.text}" names a list level the document does not define`);
  return level;
}

function cellText(table: TableView, row: number, column: number): string {
  return (table.rows[row]?.[column]?.blocks ?? []).map((b) => (b.kind === "paragraph" ? b.text : "[table]")).join("\n");
}

function signature(view: DocView, blocks: readonly BlockView[]): unknown[] {
  return blocks.map((block) =>
    block.kind === "paragraph"
      ? {
          text: block.text,
          namedStyle: block.style.namedStyleType,
          shaded: block.style.shading !== undefined,
          bullet: block.bullet ? { level: block.bullet.nestingLevel, glyph: glyphOf(view, block) } : undefined,
          runs: visibleRuns(block).map((r) => ({
            text: textOf(r.text),
            bold: r.style.bold === true,
            italic: r.style.italic === true,
            strikethrough: r.style.strikethrough === true,
            font: fontOf(r.style),
            link: z.object({ url: z.string() }).safeParse(r.style.link).data?.url,
          })),
        }
      : { quote: isQuote(block), rows: block.rows.map((row) => row.map((cell) => signature(view, cell.blocks))) },
  );
}

function between(blocks: readonly BlockView[]): readonly BlockView[] | undefined {
  const marker = (text: string) => blocks.findIndex((b) => b.kind === "paragraph" && b.text === text);
  const begin = marker("BEGIN");
  if (begin !== -1) return blocks.slice(begin + 1, marker("END"));
  for (const block of blocks) {
    if (block.kind !== "table") continue;
    for (const cell of block.rows.flat()) {
      const found = between(cell.blocks);
      if (found) return found;
    }
  }
  return undefined;
}

function marked(view: DocView): readonly BlockView[] {
  const found = between(view.blocks);
  if (!found) throw new Error("no BEGIN … END run of blocks in the document");
  return found;
}

const quoted = (markdown: string, prefix: string): string =>
  markdown
    .split("\n")
    .map((line) => (line === "" ? prefix.trimEnd() : `${prefix}${line}`))
    .join("\n");
const indented = (markdown: string, spaces: number): string =>
  markdown
    .split("\n")
    .map((line) => (line === "" ? "" : `${" ".repeat(spaces)}${line}`))
    .join("\n");

const BLOCKS = `BEGIN

### Nested heading

Text with **bold**, *italic*, ***both***, \`inline code\`, ~~gone~~, and a [link](https://example.com/page).

\`\`\`ts
const answer = 42;
\`\`\`

| Key | Value |
| :-- | --: |
| **Lead** — rest | \`code\` |

![Alt text of an image](https://example.com/image.png)

> An inner quote

END`;

const LISTS = `BEGIN

Bullets:

- bullet
  - sub bullet
    - sub sub bullet

Numbers:

1. first
   1. first a
2. second

Tasks:

- [x] done
- [ ] open

END`;

describe("creating a document", () => {
  test("AC-1 converting the sample creates one Google Doc in md2gd's own folder, prints its URL, and exits zero", async () => {
    await withWorld(async (world) => {
      await world.init();
      const ran = await world.run([world.write("sample.md", SAMPLE)]);

      expect(ran.exitCode).toBe(0);
      const id = DOCS_URL.exec(ran.stdout.trim())?.[1];
      expect(id).toBeDefined();
      expect(ran.stdout.trim().split("\n")).toHaveLength(1);
      const docs = world.google.driveFiles().filter((f) => f.mimeType === DOC_MIME);
      expect(docs.map((d) => d.id)).toEqual([id ?? ""]);
      const [parent] = world.google.file(id ?? "").parents;
      const folder = world.google.file(parent ?? "");
      expect(folder).toMatchObject({ name: "md2gd", mimeType: FOLDER_MIME, parents: ["root"], trashed: false });
    });
  });

  test("AC-1 a second run reuses md2gd's folder", async () => {
    await withWorld(async (world) => {
      await world.init();
      const input = world.write("sample.md", SAMPLE);
      const first = documentIdOf(await world.run([input]));
      const second = documentIdOf(await world.run([input]));

      expect(second).not.toBe(first);
      expect(world.google.file(second).parents).toEqual(world.google.file(first).parents);
      expect(world.google.driveFiles().filter((f) => f.mimeType === FOLDER_MIME && f.name === "md2gd")).toHaveLength(1);
    });
  });
});

describe("the sample's core constructs", () => {
  test("AC-2 the title is the Markdown's H1, and the sample's headings carry their level's style", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");

      expect(view.title).toBe("Service Readiness Review");
      expect(paragraph(view, "Service Readiness Review").style.namedStyleType).toBe("HEADING_1");
      for (const h2 of ["Summary", "Findings", "Priorities", "Launch checklist", "Configuration", "Rollout"])
        expect(paragraph(view, h2).style.namedStyleType).toBe("HEADING_2");
    });
  });

  test("AC-2 headings of levels one through six carry the heading style of their level", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n");

      expect(view.title).toBe("One");
      expect(
        ["One", "Two", "Three", "Four", "Five", "Six"].map((text) => paragraph(view, text).style.namedStyleType),
      ).toEqual(["HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"]);
    });
  });

  test("AC-2 bold, italic, bold+italic, inline code, strikethrough, and links carry their formatting", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");
      const summary = paragraphStarting(view, "The service is");
      const rollout = paragraphStarting(view, "Progress so far");

      expect(styleAt(summary, "broadly ready")).toMatchObject({ bold: true });
      expect(styleAt(summary, "broadly ready").italic).toBeUndefined();
      expect(styleAt(summary, "blocking")).toMatchObject({ italic: true });
      expect(styleAt(summary, "blocking").bold).toBeUndefined();
      expect(styleAt(summary, "minor")).toMatchObject({ bold: true, italic: true });
      expect(fontOf(styleAt(summary, "config.json"))).toBe("Roboto Mono");
      expect(fontOf(styleAt(summary, " at boot"))).not.toBe("Roboto Mono");
      expect(styleAt(rollout, "slow")).toMatchObject({ strikethrough: true });
      expect(styleAt(rollout, " steady").strikethrough).toBeUndefined();
      expect(styleAt(rollout, "runbook")).toMatchObject({ link: { url: "https://example.com/runbook" } });
      expect(styleAt(rollout, " and the dashboard").link).toBeUndefined();
    });
  });

  test("AC-2 a bulleted list nested three levels deep carries each level's indentation and marker", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");
      const items = ["Observability", "Metrics", "Request latency histograms"].map((text) => paragraph(view, text));

      expect(items.map((p) => p.bullet?.nestingLevel)).toEqual([0, 1, 2]);
      expect(new Set(items.map((p) => p.bullet?.listId)).size).toBe(1);
      expect(items.map((p) => glyphOf(view, p).glyphSymbol)).toEqual(["●", "○", "■"]);
    });
  });

  test("AC-2 a numbered list nested three levels deep carries each level's indentation and marker", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "# Numbers\n\n1. One\n   1. One A\n      1. One A i\n2. Two\n");
      const items = ["One", "One A", "One A i", "Two"].map((text) => paragraph(view, text));

      expect(items.map((p) => p.bullet?.nestingLevel)).toEqual([0, 1, 2, 0]);
      expect(new Set(items.map((p) => p.bullet?.listId)).size).toBe(1);
      expect(items.map((p) => glyphOf(view, p).glyphType)).toEqual(["DECIMAL", "ALPHA", "ROMAN", "DECIMAL"]);
    });
  });

  test("AC-2 every table has its header row", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");
      const tables = view.tables.filter((t) => !isQuote(t));

      expect(tables.map((t) => [cellText(t, 0, 0), cellText(t, 0, 1)])).toEqual([
        ["Status", "Area"],
        ["Team", "On call"],
      ]);
      for (const table of tables) {
        const [header, body] = table.rows;
        for (const cell of header ?? [])
          for (const block of cell.blocks)
            if (block.kind === "paragraph")
              for (const r of visibleRuns(block)) expect(r.style.bold, `header "${block.text}"`).toBe(true);
        expect(header?.every((cell) => cell.style.backgroundColor !== undefined)).toBe(true);
        expect(body?.some((cell) => cell.style.backgroundColor !== undefined)).toBe(false);
      }
    });
  });

  test("AC-2 a horizontal rule produces no output", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");
      const at = (text: string) => view.blocks.findIndex((b) => b.kind === "paragraph" && b.text === text);

      expect(at("Reviewed by the Platform Team.")).toBe(at("Rollout timeline") + 1);
      expect(view.paragraphs.some((p) => /^[-*_]{3,}$/.test(p.text))).toBe(false);
    });
  });
});

describe("the sample's degrading and set-apart constructs", () => {
  test("AC-3 task lists render as checkboxes that keep their checked state", async () => {
    await withWorld(async (world) => {
      await world.init();
      const ran = await world.run([world.write("sample.md", SAMPLE)]);
      const view = viewOf(world.google.document(documentIdOf(ran)));

      expect(ran.exitCode).toBe(0);
      paragraph(view, "☑ Load test passed");
      paragraph(view, "☑ Rollback plan documented");
      paragraph(view, "☐ Billing webhook secret rotated");
      paragraph(view, "☐ Runbook linked in the on-call channel");
      expect(view.paragraphs.some((p) => p.text.includes("[x]") || p.text.includes("[ ]"))).toBe(false);
    });
  });

  test("AC-3 fenced and indented code blocks are monospace and shaded apart from prose", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");
      const blocks = [paragraphStarting(view, "const config = {"), paragraph(view, "GET /healthz\v200 OK")];
      const prose = paragraph(view, "Fenced block with a language hint:");

      for (const block of blocks) {
        expect(block.style.shading).toBeDefined();
        for (const r of visibleRuns(block)) expect(fontOf(r.style)).toBe("Roboto Mono");
      }
      expect(prose.style.shading).toBeUndefined();
      for (const r of visibleRuns(prose)) expect(fontOf(r.style)).not.toBe("Roboto Mono");
    });
  });

  test("AC-3 a blockquote is set apart from body text by its own accented container", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");
      const quote = holding(
        view,
        "Ship the blockers first, then measure for a week before enabling exports.\vA partial rollout is fine; a silent one is not.",
      );

      expect(isQuote(quote)).toBe(true);
      expect(view.blocks.some((b) => b.kind === "paragraph" && b.text.startsWith("Ship the blockers"))).toBe(false);
      expect(view.paragraphs.some((p) => p.text.startsWith(">"))).toBe(false);
    });
  });

  test("AC-3 an image becomes its alt text", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");

      paragraph(view, "Rollout timeline");
      expect(view.paragraphs.some((p) => p.text.includes("![") || p.text.includes("placehold.co"))).toBe(false);
    });
  });

  test("AC-3 a footnote becomes readable text", async () => {
    await withWorld(async (world) => {
      const view = await render(world, SAMPLE, "sample.md");

      paragraph(
        view,
        "Diagram embedding is a superset feature; if unsupported it degrades to readable text rather than failing the run.",
      );
      expect(view.paragraphs.some((p) => p.text.includes("[^1]"))).toBe(false);
    });
  });

  test.failing("AC-3 raw HTML, a construct the feature list does not name, becomes readable text without its markup", async () => {
    await withWorld(async (world) => {
      await world.init();
      const ran = await world.run([
        world.write(
          "unlisted.md",
          "# Unlisted\n\nPress <kbd>Ctrl</kbd> to copy.\n\n<details>\n<summary>More</summary>\n\nHidden text\n\n</details>\n",
        ),
      ]);
      const view = viewOf(world.google.document(documentIdOf(ran)));

      expect(ran.exitCode).toBe(0);
      expect(view.paragraphs.map((p) => p.text).join("\n")).toContain("Ctrl");
      expect(view.paragraphs.some((p) => /<\/?[a-z]+>/.test(p.text))).toBe(false);
    });
  });
});

describe("text and typography", () => {
  const TYPOGRAPHY =
    "Hyvää yötä — äänestys käynnissä 2020–2026 → “lainaus” ja ‘toinen’ ✅ ❌ 🕐 🟠 🟡 🔴 👍🏽 👨‍👩‍👧 Öljy";

  test("AC-15 Finnish text, color emoji, dashes, arrows, and curly quotes reach the document unchanged", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        `# Äänestys — “tila” → ✅\n\n${TYPOGRAPHY}\n\n| Tila | Huomio |\n| --- | --- |\n| 🟠 Korkea | ${TYPOGRAPHY} |\n`,
      );

      expect(view.title).toBe("Äänestys — “tila” → ✅");
      expect(paragraph(view, "Äänestys — “tila” → ✅").style.namedStyleType).toBe("HEADING_1");
      expect(view.paragraphs.filter((p) => p.text === TYPOGRAPHY)).toHaveLength(2);
      expect(cellText(view.tables[0] as TableView, 1, 0)).toBe("🟠 Korkea");
    });
  });

  test("AC-15 an emoji stays on the line of the text that follows it", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Status\n\n✅ Working as intended\n\n| Status | Area |\n| --- | --- |\n| 🔴 Blocker | Billing |\n| 🕐 Pending | Exports |\n",
      );

      paragraph(view, "✅ Working as intended");
      paragraph(view, "🔴 Blocker");
      paragraph(view, "🕐 Pending");
    });
  });

  test("AC-15 formatting around an emoji covers exactly its text", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Status\n\nBefore 🟠 **bold after emoji** then *🔴 italic with emoji* and `code 🕐` end.\n\n| Status |\n| --- |\n| 🟡 **Medium** — still open |\n",
      );
      const prose = paragraph(view, "Before 🟠 bold after emoji then 🔴 italic with emoji and code 🕐 end.");
      const cell = paragraph(view, "🟡 Medium — still open");

      expect(styleAt(prose, "Before 🟠 ").bold).toBeUndefined();
      expect(styleAt(prose, "bold after emoji")).toMatchObject({ bold: true });
      expect(styleAt(prose, " then ")).not.toHaveProperty("bold");
      expect(styleAt(prose, "🔴 italic with emoji")).toMatchObject({ italic: true });
      expect(styleAt(prose, " and ")).not.toHaveProperty("italic");
      expect(fontOf(styleAt(prose, "code 🕐"))).toBe("Roboto Mono");
      expect(fontOf(styleAt(prose, " end."))).not.toBe("Roboto Mono");
      expect(styleAt(cell, "🟡 ")).not.toHaveProperty("bold");
      expect(styleAt(cell, "Medium")).toMatchObject({ bold: true });
      expect(styleAt(cell, " — still open")).not.toHaveProperty("bold");
    });
  });
});

describe("tables", () => {
  test("AC-16 a cell's bold lead-in, em-dash, and inline code keep their formatting", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Findings\n\n| Severity | Finding |\n| --- | --- |\n| 🔴 High | **Webhook secret** — `WebhookSecret` is hard-coded; see `sk_test_`. |\n",
      );
      const cell = paragraph(view, "Webhook secret — WebhookSecret is hard-coded; see sk_test_.");

      expect(cell.tableDepth).toBe(1);
      expect(styleAt(cell, "Webhook secret")).toMatchObject({ bold: true });
      expect(styleAt(cell, " — ")).not.toHaveProperty("bold");
      expect(fontOf(styleAt(cell, "WebhookSecret"))).toBe("Roboto Mono");
      expect(fontOf(styleAt(cell, "sk_test_"))).toBe("Roboto Mono");
      expect(fontOf(styleAt(cell, " is hard-coded; see "))).not.toBe("Roboto Mono");
    });
  });

  test("AC-16 a column's alignment applies to every cell in it, header included, and an unaligned column is left-aligned", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Aligned\n\n| Left | Center | Right | Plain |\n| :-- | :-: | --: | --- |\n| l1 | c1 | r1 | p1 |\n| l2 | c2 | r2 | p2 |\n",
      );
      const table = view.tables[0] as TableView;
      const alignment = (column: number) =>
        table.rows.map((row) => {
          const [block] = row[column]?.blocks ?? [];
          return block?.kind === "paragraph" ? (block.style.alignment ?? "START") : "no paragraph";
        });

      expect(alignment(0)).toEqual(["START", "START", "START"]);
      expect(alignment(1)).toEqual(["CENTER", "CENTER", "CENTER"]);
      expect(alignment(2)).toEqual(["END", "END", "END"]);
      expect(alignment(3)).toEqual(["START", "START", "START"]);
    });
  });

  test("AC-16 adjacent tables of different shapes stay separate and are sized independently", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        [
          "# Tables",
          "| Id | Owner | Description |\n| --- | --- | --- |\n| 1 | Ops | A long description of the first finding that needs most of the page to read comfortably. |",
          "| Description of the area under review, written out at some length | Id |\n| --- | --- |\n| The second table leads with its long column instead of ending with it | 2 |",
          "**Ownership**",
          "| A | B | C | D |\n| --- | --- | --- | --- |\n| a | b | c | d |",
        ].join("\n\n"),
      );
      const [three, two, four] = view.tables;

      expect(view.tables.map((t) => t.columns.length)).toEqual([3, 2, 4]);
      expect(view.tables.map((t) => t.rows.length)).toEqual([2, 2, 2]);
      const [, , description = 0] = columnWidths(three as TableView);
      const [lead = 0, id = 0] = columnWidths(two as TableView);
      expect(description).toBeGreaterThan(view.contentWidth / 2);
      expect(lead).toBeGreaterThan(id);
      for (const table of [three, two, four] as TableView[])
        expect(totalWidth(table)).toBeCloseTo(view.contentWidth, 1);
    });
  });

  test("AC-16 a long-text column takes the width while a one-word column holds its widest cell on one line", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        [
          "# Severity",
          "",
          "| Severity | Description |",
          "| --- | --- |",
          "| Moderate | Sessions do not set HttpOnly or SameSite on the refresh cookie, so a script injected anywhere on the origin can read it and replay the session from another machine. |",
          "| Low | Exports cannot be cancelled once started, which ties up a worker for the full length of a large report even after the user has navigated away. |",
        ].join("\n"),
      );
      const table = view.tables[0] as TableView;
      const [severity = 0, description = 0] = columnWidths(table);
      const cell = table.rows[1]?.[0]?.style ?? {};
      const padding = (magnitude(cell.paddingLeft) ?? 0) + (magnitude(cell.paddingRight) ?? 0);

      expect(description).toBeGreaterThan(severity);
      expect(description).toBeGreaterThan(view.contentWidth / 2);
      expect(severity).toBeGreaterThanOrEqual("Moderate".length * AVERAGE_GLYPH_EM * BODY_FONT_SIZE_PT + padding);
    });
  });

  test("AC-16 a blank answer column is sized for what will be written into it, not for its header", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        [
          "# Questionnaire",
          "",
          "| Question | Answer |",
          "| --- | --- |",
          "| What peak request rate do you expect in the first month after launch? | |",
          "| Who owns the on-call rotation for the billing service during the rollout? | |",
        ].join("\n"),
      );
      const [question = 0, answer = 0] = columnWidths(view.tables[0] as TableView);

      expect(answer).toBeGreaterThanOrEqual(view.contentWidth / 3);
      expect(question + answer).toBeCloseTo(view.contentWidth, 1);
    });
  });

  test("AC-16 a table whose body is blank throughout shares the page equally between its columns", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Sign-off\n\n| Name | Signature | Date |\n| --- | --- | --- |\n| | | |\n| | | |\n",
      );
      const widths = columnWidths(view.tables[0] as TableView);

      for (const width of widths) expect(width).toBeCloseTo(view.contentWidth / 3, 1);
    });
  });

  test.failing("AC-16 a table whose body is blank throughout shares the page equally even when one header is long", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Sign-off\n\n| Name | Signature of the approving engineering manager | Date |\n| --- | --- | --- |\n| | | |\n| | | |\n",
      );
      const widths = columnWidths(view.tables[0] as TableView);

      for (const width of widths) expect(width).toBeCloseTo(view.contentWidth / 3, 1);
    });
  });

  test("AC-16 no table exceeds the page width, however wide its content", async () => {
    await withWorld(async (world) => {
      const long = "an unbroken run of descriptive words that would happily take the whole page on its own";
      const view = await render(
        world,
        [
          "# Wide",
          `| ${Array.from({ length: 8 }, (_, i) => `Heading number ${i}`).join(" | ")} |`,
          `| ${Array.from({ length: 8 }, () => "---").join(" | ")} |`,
          `| ${Array.from({ length: 8 }, () => long).join(" | ")} |`,
          "",
          `| Short | ${long} |`,
          "| --- | --- |",
          `| ${long} | x |`,
          "",
          `> | ${long} | ${long} | ${long} |`,
          "> | --- | --- | --- |",
          `> | ${long} | ${long} | ${long} |`,
        ].join("\n"),
      );

      const top = view.tables.filter((t) => t.tableDepth === 0);
      expect(top).toHaveLength(3);
      for (const table of top) expect(totalWidth(table)).toBeLessThanOrEqual(view.contentWidth + ROUNDING_PT);
      const quote = top.find(isQuote) as TableView;
      const inner = onlyCell(quote).blocks.find((b): b is TableView => b.kind === "table") as TableView;
      const room =
        totalWidth(quote) -
        (magnitude(onlyCell(quote).style.paddingLeft) ?? 0) -
        (magnitude(onlyCell(quote).style.paddingRight) ?? 0);
      expect(totalWidth(inner)).toBeLessThanOrEqual(room + ROUNDING_PT);
    });
  });
});

describe("source conventions", () => {
  test("AC-17 underscores, asterisks, slashes, and semicolons inside inline code stay literal", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Code\n\nKeys like `sk_test_` and `_not_italic_`, a wildcard `*`, `**not bold**`, `POST /api/auth/resend-confirmation`, and `HttpOnly; SameSite=Strict`.\n",
      );
      const p = paragraph(
        view,
        "Keys like sk_test_ and _not_italic_, a wildcard *, **not bold**, POST /api/auth/resend-confirmation, and HttpOnly; SameSite=Strict.",
      );

      for (const code of [
        "sk_test_",
        "_not_italic_",
        "*",
        "**not bold**",
        "POST /api/auth/resend-confirmation",
        "HttpOnly; SameSite=Strict",
      ]) {
        const style = styleAt(p, code);
        expect(fontOf(style), code).toBe("Roboto Mono");
        expect(style.bold, code).toBeUndefined();
        expect(style.italic, code).toBeUndefined();
        expect(style.link, code).toBeUndefined();
      }
    });
  });

  test("AC-17 single-line breaks inside a paragraph render as separate lines", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "# Lines\n\nFirst line\nSecond line\nThird line\n");
      const text = view.paragraphs.map((p) => p.text).join("\n");

      expect(text).toMatch(/First line[\v\n]Second line[\v\n]Third line/);
    });
  });

  test("AC-17 a run of Key: value lines renders as one tightly spaced block", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Review\n\n**Date:** July 5, 2026\n**Subject:** Readiness review\n**Classification:** Confidential\n\nFirst body paragraph.\n\nSecond body paragraph.\n",
      );
      const lines = view.paragraphs
        .filter((p) => p.tableDepth === 0)
        .flatMap((p, i, all) => {
          const previous = all[i - 1];
          const gap = (magnitude(previous?.style.spaceBelow) ?? 0) + (magnitude(p.style.spaceAbove) ?? 0);
          return p.text.split("\v").map((text, line) => ({ text, gap: line === 0 ? gap : 0, p }));
        });
      const gapBefore = (prefix: string): number => {
        const found = lines.find((l) => l.text.startsWith(prefix));
        if (!found) throw new Error(`no line starting "${prefix}"`);
        return found.gap;
      };
      const date = lines.find((l) => l.text.startsWith("Date:"));

      expect(date?.text).toBe("Date: July 5, 2026");
      expect(styleAt(date?.p as ParagraphView, "Date:")).toMatchObject({ bold: true });
      expect(styleAt(date?.p as ParagraphView, " July 5, 2026")).not.toHaveProperty("bold");
      const paragraphGap = gapBefore("Second body paragraph.");
      expect(gapBefore("Subject:")).toBeLessThan(paragraphGap);
      expect(gapBefore("Classification:")).toBeLessThan(paragraphGap);
      expect(gapBefore("First body paragraph.")).toBeGreaterThanOrEqual(paragraphGap);
    });
  });

  test("AC-17 a bold-only line renders as a caption outside the heading outline", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Findings\n\n**Customer journey**\n\n| Step | State |\n| --- | --- |\n| Sign-up | Done |\n",
      );
      const caption = paragraph(view, "Customer journey");

      expect(caption.style.namedStyleType).toBe("NORMAL_TEXT");
      expect(visibleRuns(caption).every((r) => r.style.bold === true)).toBe(true);
      expect(caption.style.keepWithNext).toBe(true);
      expect(magnitude(caption.style.spaceAbove) ?? 0).toBeGreaterThan(magnitude(caption.style.spaceBelow) ?? 0);
      expect(view.paragraphs.filter((p) => String(p.style.namedStyleType).startsWith("HEADING_"))).toHaveLength(1);
    });
  });

  test("AC-17 a bare domain stays plain text, unchanged", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Hosts\n\nThe app runs at partybook-one.vercel.app and staging-api.internal.example.com today.\n",
      );
      const p = paragraph(view, "The app runs at partybook-one.vercel.app and staging-api.internal.example.com today.");

      expect(p.runs.some((r) => r.style.link !== undefined)).toBe(false);
      expect(p.runs.some((r) => r.style.underline !== undefined)).toBe(false);
    });
  });
});

describe("blocks nested in quotes and list items", () => {
  async function nestedAgainstTop(world: World, snippet: string, wrap: (markdown: string) => string) {
    await world.init();
    const top = viewOf(world.google.document(documentIdOf(await world.run([world.write("top.md", snippet)]))));
    const nested = viewOf(
      world.google.document(documentIdOf(await world.run([world.write("nested.md", wrap(snippet))]))),
    );
    return { top, nested };
  }

  for (const [where, wrap] of [
    ["a quote", (md: string) => quoted(md, "> ")],
    ["a quote three deep", (md: string) => quoted(md, "> > > ")],
    ["a quote inside a list item", (md: string) => `- Item\n\n${indented(quoted(md, "> "), 2)}`],
    ["a list item inside a quote", (md: string) => quoted(`- Item\n\n${indented(md, 2)}`, "> ")],
  ] as const) {
    test(`AC-18 every block in ${where} renders as it does at the top level`, async () => {
      await withWorld(async (world) => {
        const blocks = await nestedAgainstTop(world, BLOCKS, wrap);
        expect(signature(blocks.nested, marked(blocks.nested))).toEqual(signature(blocks.top, marked(blocks.top)));
      });
    });
  }

  for (const [where, wrap] of [
    ["a quote", (md: string) => quoted(md, "> ")],
    ["a quote three deep", (md: string) => quoted(md, "> > > ")],
  ] as const) {
    test(`AC-18 every list in ${where} renders as it does at the top level`, async () => {
      await withWorld(async (world) => {
        const lists = await nestedAgainstTop(world, LISTS, wrap);
        expect(signature(lists.nested, marked(lists.nested))).toEqual(signature(lists.top, marked(lists.top)));
      });
    });
  }

  for (const [depth, wrap] of [
    [0, (md: string) => `- Item\n\n${indented(md, 2)}`],
    [1, (md: string) => `- Item\n  - Deeper\n\n${indented(md, 4)}`],
    [2, (md: string) => `1. Item\n   1. Deeper\n      1. Deepest\n\n${indented(md, 9)}`],
  ] as const) {
    test(`AC-18 every block in a list item at depth ${depth} renders as at the top level, aligned under the item's text`, async () => {
      await withWorld(async (world) => {
        const blocks = await nestedAgainstTop(world, BLOCKS, wrap);
        const inside = marked(blocks.nested);

        expect(signature(blocks.nested, inside)).toEqual(signature(blocks.top, marked(blocks.top)));
        const indent = PRESET_TEXT_INDENT_PER_LEVEL_PT * (depth + 1);
        for (const block of inside)
          if (block.kind === "paragraph" && block.text !== "") {
            expect(magnitude(block.style.indentStart), block.text).toBe(indent);
            expect(magnitude(block.style.indentFirstLine), block.text).toBe(indent);
          }
      });
    });
  }

  test("AC-18 a quote is one container with a single left accent around everything in it, and a nested quote draws its own", async () => {
    await withWorld(async (world) => {
      const view = await render(world, `# Quote\n\n${quoted(BLOCKS, "> ")}\n`);
      const top = view.tables.filter((t) => t.tableDepth === 0);

      expect(top).toHaveLength(1);
      const outer = top[0] as TableView;
      expect(isQuote(outer)).toBe(true);
      expect(between(onlyCell(outer).blocks)).toBeDefined();
      const inner = holding(view, "An inner quote");
      expect(isQuote(inner)).toBe(true);
      expect(onlyCell(outer).blocks).toContain(inner);
    });
  });

  test("AC-18 an ordered list counts on through an item's later blocks", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Steps\n\n1. First step\n\n   A later paragraph of the first step.\n\n   ```\n   run --now\n   ```\n\n2. Second step\n",
      );

      expect(paragraph(view, "Second step").bullet?.listId).toBe(paragraph(view, "First step").bullet?.listId);
      expect(paragraph(view, "A later paragraph of the first step.").bullet).toBeUndefined();
    });
  });

  test("AC-18 quotes at the same depth sit at the same position and width whatever they hold or follow", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        [
          "# Quotes",
          "A paragraph.",
          "> After a paragraph",
          "- A list item",
          "> After a list",
          "| A | B |\n| --- | --- |\n| a | b |",
          "> | Holding | A table |\n> | --- | --- |\n> | x | y |",
          "```\ncode\n```",
          "> After code\n>\n> - holding a list",
        ].join("\n\n"),
      );
      const quotes = view.tables.filter((t) => t.tableDepth === 0 && isQuote(t));

      expect(quotes).toHaveLength(4);
      for (const quote of quotes) expect(totalWidth(quote)).toBeCloseTo(view.contentWidth, 1);
    });
  });

  test("AC-18 a table nested in a quote or a list item is a real table sized to its container", async () => {
    await withWorld(async (world) => {
      const table = "| Key | Value |\n| --- | --- |\n| k | v |";
      const view = await render(
        world,
        `# Nested\n\n${quoted(table, "> ")}\n\n${quoted(table.replace(/k \|/, "k2 |"), "> > ")}\n\n- Item\n\n${indented(table.replace(/k \|/, "k3 |"), 2)}\n`,
      );
      const roomIn = (quote: TableView): number => {
        const style = onlyCell(quote).style;
        return totalWidth(quote) - (magnitude(style.paddingLeft) ?? 0) - (magnitude(style.paddingRight) ?? 0);
      };
      const inQuote = holding(view, "k");
      const quote = view.tables.find((t) => onlyCell(t).blocks.includes(inQuote)) as TableView;
      const inDeepQuote = holding(view, "k2");
      const deepQuote = view.tables.find(
        (t) => t.rows.length === 1 && t.rows[0]?.length === 1 && onlyCell(t).blocks.includes(inDeepQuote),
      ) as TableView;
      const inItem = holding(view, "k3");

      expect(totalWidth(inQuote)).toBeCloseTo(roomIn(quote), 1);
      expect(totalWidth(inDeepQuote)).toBeCloseTo(roomIn(deepQuote), 1);
      expect(inItem.tableDepth).toBe(0);
      expect(totalWidth(inItem)).toBeCloseTo(view.contentWidth, 1);
    });
  });

  test("AC-18 a quote or table inside a list item sits at its container's edge, and an ordered list restarts after it", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Restart\n\n1. One\n\n   | T |\n   | --- |\n   | v |\n\n2. Two\n\nBetween.\n\n1. Uno\n\n   > quoted in an item\n\n2. Dos\n",
      );
      const table = holding(view, "v");
      const quote = holding(view, "quoted in an item");

      expect(table.tableDepth).toBe(0);
      expect(totalWidth(table)).toBeCloseTo(view.contentWidth, 1);
      expect(quote.tableDepth).toBe(0);
      expect(totalWidth(quote)).toBeCloseTo(view.contentWidth, 1);
      expect(paragraph(view, "Two").bullet?.listId).not.toBe(paragraph(view, "One").bullet?.listId);
      expect(paragraph(view, "Dos").bullet?.listId).not.toBe(paragraph(view, "Uno").bullet?.listId);
    });
  });

  test("AC-18 an item that opens with a quote, table, or list carries its marker on an empty line above it", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Openers\n\n- > opening quote\n\nThen.\n\n- | Opening table |\n  | --- |\n  | cell |\n\nAnd.\n\n- - opening list\n",
      );
      const markerBefore = (table: TableView): ParagraphView | undefined => {
        const at = view.blocks.indexOf(table);
        return view.blocks
          .slice(0, at)
          .reverse()
          .find((b): b is BlockView & ParagraphView => b.kind === "paragraph" && b.bullet !== undefined);
      };

      for (const opener of [holding(view, "opening quote"), holding(view, "Opening table")]) {
        const marker = markerBefore(opener);
        expect(marker?.text).toBe("");
        expect(marker?.bullet?.nestingLevel).toBe(0);
      }
      const nested = paragraph(view, "opening list");
      const at = view.blocks.indexOf(nested as BlockView);
      const marker = view.blocks[at - 1];
      expect(marker?.kind === "paragraph" ? [marker.text, marker.bullet?.nestingLevel] : []).toEqual(["", 0]);
      expect(nested.bullet?.nestingLevel).toBe(1);
    });
  });

  test("AC-18 a task item's later blocks sit at its checkbox rather than under its text", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "# Tasks\n\n- [ ] Open task\n\n  A later paragraph of the task.\n");
      const item = paragraph(view, "☐ Open task");
      const later = paragraph(view, "A later paragraph of the task.");

      expect(later.bullet).toBeUndefined();
      expect(magnitude(later.style.indentStart) ?? 0).toBe(magnitude(item.style.indentStart) ?? 0);
      expect(magnitude(later.style.indentFirstLine) ?? 0).toBe(magnitude(item.style.indentFirstLine) ?? 0);
    });
  });

  test("AC-18 a quote that starts or ends with a table or another quote keeps a thin blank line at that edge, and only then", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Edges\n\n> | T |\n> | --- |\n> | v |\n\nBetween.\n\n> > inner quote\n\nAnd.\n\n> Just text\n",
      );
      const edges = (quote: TableView) => {
        const blocks = onlyCell(quote).blocks;
        return [blocks[0], blocks[blocks.length - 1]];
      };
      const tableQuote = view.tables.find((t) => isQuote(t) && onlyCell(t).blocks.includes(holding(view, "v")));
      const quoteQuote = view.tables.find(
        (t) => isQuote(t) && t.tableDepth === 0 && onlyCell(t).blocks.includes(holding(view, "inner quote")),
      );

      for (const quote of [tableQuote, quoteQuote]) {
        expect(quote).toBeDefined();
        for (const edge of edges(quote as TableView)) {
          expect(edge?.kind).toBe("paragraph");
          if (edge?.kind !== "paragraph") continue;
          expect(edge.text).toBe("");
          expect(magnitude(edge.style.spaceAbove) ?? 0).toBe(0);
          expect(magnitude(edge.style.spaceBelow) ?? 0).toBe(0);
        }
      }
      const plain = edges(holding(view, "Just text"));
      expect(plain.map((b) => (b?.kind === "paragraph" ? b.text : "table"))).toEqual(["Just text", "Just text"]);
    });
  });

  test("AC-18 two lists of the same kind with nothing between them stay two lists", async () => {
    await withWorld(async (world) => {
      const view = await render(world, "# Lists\n\n1. a\n2. b\n\n1) c\n\nThen.\n\n- d\n\n* e\n");

      expect(paragraph(view, "b").bullet?.listId).toBe(paragraph(view, "a").bullet?.listId);
      expect(paragraph(view, "c").bullet?.listId).not.toBe(paragraph(view, "a").bullet?.listId);
      expect(paragraph(view, "e").bullet?.listId).not.toBe(paragraph(view, "d").bullet?.listId);
    });
  });

  test("AC-18 a nested list takes the outer list's marker style", async () => {
    await withWorld(async (world) => {
      const view = await render(
        world,
        "# Markers\n\n1. numbered\n   - bulleted inside\n\nThen.\n\n- bulleted\n  1. numbered inside\n",
      );
      const inNumbered = paragraph(view, "bulleted inside");
      const inBulleted = paragraph(view, "numbered inside");

      expect(inNumbered.bullet?.listId).toBe(paragraph(view, "numbered").bullet?.listId);
      expect(glyphOf(view, inNumbered)).toMatchObject({ glyphType: "ALPHA" });
      expect(glyphOf(view, inNumbered).glyphSymbol).toBeUndefined();
      expect(inBulleted.bullet?.listId).toBe(paragraph(view, "bulleted").bullet?.listId);
      expect(glyphOf(view, inBulleted)).toMatchObject({ glyphSymbol: "○" });
    });
  });
});
