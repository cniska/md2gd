import { describe, expect, test } from "bun:test";
import { inlineRuns } from "./inline";
import { parseMarkdown } from "./parse";
import { buildTablePlan, columnWidths } from "./table";

function firstTable(md: string, contentWidth = 468) {
  const node = parseMarkdown(md).children.find((c) => c.type === "table");
  if (node?.type !== "table") throw new Error("no table parsed");
  const plan = buildTablePlan(node);
  return { ...plan, columnWidths: columnWidths(plan, contentWidth) };
}

const SIMPLE = ["| Step | Status |", "|---|---|", "| Book | Missing |", ""].join("\n");

describe("buildTablePlan", () => {
  test("captures dimensions and treats the first row as a header", () => {
    const plan = firstTable(SIMPLE);
    expect(plan.rows).toBe(2);
    expect(plan.columns).toBe(2);
    expect(plan.header).toBe(true);
    expect(plan.cells[0]?.[0]?.text).toBe("Step");
    expect(plan.cells[1]?.[1]?.text).toBe("Missing");
  });

  test("column widths are fixed points that fill the full page content width", () => {
    const plan = firstTable(SIMPLE);
    expect(plan.columnWidths).toHaveLength(2);
    const total = plan.columnWidths.reduce((s, d) => s + d.magnitude, 0);
    expect(Math.abs(total - 468)).toBeLessThanOrEqual(1);
    for (const w of plan.columnWidths) expect(w.unit).toBe("PT");
  });

  test("column widths fill whatever content width the table's container has", () => {
    const total = firstTable(SIMPLE, 451.28).columnWidths.reduce((s, d) => s + d.magnitude, 0);
    expect(Math.abs(total - 451.28)).toBeLessThanOrEqual(1);
  });

  test("two medium columns beside a long one still fill the full width", () => {
    const md = [
      "| Column | Type | Notes |",
      "|---|---|---|",
      "| business_id | uuid | references business(id) on delete cascade |",
      "| profile_id | uuid | references profiles(id) on delete cascade |",
      "| role | enum | owner, staff |",
      "",
    ].join("\n");
    const total = firstTable(md).columnWidths.reduce((s, d) => s + d.magnitude, 0);
    expect(Math.abs(total - 468)).toBeLessThanOrEqual(1);
  });

  test("a short column beside a very long one is floored, not collapsed", () => {
    const md = ["| Sev | Finding |", "|---|---|", `| 🔴 Critical | ${"x".repeat(300)} |`, ""].join("\n");
    const [sev, finding] = firstTable(md).columnWidths;
    if (!sev || !finding) throw new Error("expected two widths");
    expect(sev.magnitude).toBeGreaterThanOrEqual(50);
    expect(finding.magnitude).toBeGreaterThan(sev.magnitude);
    expect(sev.magnitude + finding.magnitude).toBeLessThanOrEqual(468);
  });

  test("a short emoji column is widened to hold its value on one line", () => {
    const md = ["| Severity | Finding |", "|---|---|", `| 🔴 Critical | ${"x".repeat(400)} |`, ""].join("\n");
    const [sev, finding] = firstTable(md).columnWidths;
    if (!sev || !finding) throw new Error("expected two widths");
    expect(sev.magnitude).toBeGreaterThanOrEqual(75);
    expect(finding.magnitude).toBeGreaterThan(sev.magnitude);
    expect(sev.magnitude + finding.magnitude).toBeLessThanOrEqual(468);
  });

  test("when columns can't all fit, short columns hold the minimum and nothing overflows", () => {
    const wide = "y".repeat(300);
    const md = ["| A | B | C | D |", "|---|---|---|---|", `| ${wide} | ${wide} | ok | ok |`, ""].join("\n");
    const widths = firstTable(md).columnWidths.map((d) => d.magnitude);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(54);
    expect(widths.reduce((s, w) => s + w, 0)).toBeLessThanOrEqual(468);
  });

  test("a blank fill-in column is not starved by its label column", () => {
    const md = ["| Detail | Answer |", "|---|---|", "| Street and number | |", "| Phone and email | |", ""].join("\n");
    const [detail, answer] = firstTable(md).columnWidths;
    if (!detail || !answer) throw new Error("expected two widths");
    expect(answer.magnitude).toBeGreaterThanOrEqual(detail.magnitude);
  });

  test("a table with no content at all shares the page equally", () => {
    const md = ["| Title | Description | Price |", "|---|---|---|", "| | | |", ""].join("\n");
    const widths = firstTable(md).columnWidths.map((d) => d.magnitude);
    for (const w of widths) expect(Math.abs(w - (widths[0] ?? 0))).toBeLessThanOrEqual(1);
  });

  test("a blank-body table shares the page equally even when one header is long", () => {
    const md = [
      "| Name | Signature of the approving engineering manager | Date |",
      "|---|---|---|",
      "| | | |",
      "| | | |",
      "",
    ].join("\n");
    const widths = firstTable(md, 451.28).columnWidths.map((d) => d.magnitude);
    expect(widths).toEqual([150.43, 150.43, 150.42]);
    expect(widths.reduce((s, w) => s + w, 0)).toBeCloseTo(451.28, 6);
  });

  test("an equal split never sums wider than an unrounded container", () => {
    const md = ["| Name | Signature | Date |", "|---|---|---|", "| | | |", ""].join("\n");
    const widths = firstTable(md, 451.2756).columnWidths.map((d) => d.magnitude);
    expect(widths.reduce((s, w) => s + w, 0)).toBeLessThanOrEqual(451.2756);
  });

  test("an equal split never sums a hundredth short of a container whose width carries float error", () => {
    const md = ["| Name | Signature | Date |", "|---|---|---|", "| | | |", ""].join("\n");
    const widths = firstTable(md, 256.03).columnWidths.map((d) => d.magnitude);
    expect(widths.reduce((s, w) => s + w, 0)).toBeCloseTo(256.03, 6);
  });

  test("a header-only table is sized by its headers, not shared equally", () => {
    const md = ["| Name | Signature of the approving engineering manager | Date |", "|---|---|---|", ""].join("\n");
    const [name, signature] = firstTable(md, 451.28).columnWidths;
    if (!name || !signature) throw new Error("expected two widths");
    expect(signature.magnitude).toBeGreaterThan(name.magnitude);
  });

  test("a table with one blank column still sizes its filled columns by content", () => {
    const md = ["| A | B | C |", "|---|---|---|", `| x | ${"long content ".repeat(6)} | |`, ""].join("\n");
    const [a, b] = firstTable(md, 451.28).columnWidths;
    if (!a || !b) throw new Error("expected two widths");
    expect(b.magnitude).toBeGreaterThan(a.magnitude);
  });

  test("a table too narrow for its columns' minimums shares the page equally and exactly", () => {
    const md = [
      "| A | B | C | D | E | F | G | H | I | J |",
      `|${"---|".repeat(10)}`,
      `|${" text |".repeat(10)}`,
      "",
    ].join("\n");
    const widths = firstTable(md, 451.28).columnWidths.map((d) => d.magnitude);
    expect(widths.reduce((s, w) => s + w, 0)).toBeCloseTo(451.28, 6);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(0.0100001);
  });

  test("a longer-content column gets a wider column", () => {
    const md = ["| K | Description |", "|---|---|", "| a | this cell has much longer content than the key |", ""].join(
      "\n",
    );
    const plan = firstTable(md);
    const [key, desc] = plan.columnWidths;
    if (!key || !desc) throw new Error("expected two widths");
    expect(desc.magnitude).toBeGreaterThan(key.magnitude);
  });

  test("preserves rich inline runs inside a cell (bold lead-in, inline code)", () => {
    const md = ["| Sev | Note |", "|---|---|", "| High | **Rotate** the `sk_test_` key |", ""].join("\n");
    const plan = firstTable(md);
    const cell = plan.cells[1]?.[1];
    if (!cell) throw new Error("no cell");
    expect(cell.text).toBe("Rotate the sk_test_ key");
    const { runs } = inlineRuns(cell.content);
    const bold = runs.find((r) => r.style.bold);
    const code = runs.find((r) => r.style.weightedFontFamily);
    expect(bold).toBeDefined();
    expect(code).toBeDefined();
  });

  test("keeps a leading status emoji intact in a cell", () => {
    const md = ["| S | D |", "|---|---|", "| 🟠 High | note |", ""].join("\n");
    const plan = firstTable(md);
    expect(plan.cells[1]?.[0]?.text).toBe("🟠 High");
  });

  test("pads a ragged row so every row has the full column count", () => {
    const md = ["| A | B | C |", "|---|---|---|", "| 1 | 2 |", ""].join("\n");
    const plan = firstTable(md);
    expect(plan.columns).toBe(3);
    expect(plan.cells[1]).toHaveLength(3);
    expect(plan.cells[1]?.[2]?.text).toBe("");
  });
});
