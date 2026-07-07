import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "./parse";
import { buildTablePlan } from "./table";

function firstTable(md: string) {
  const node = parseMarkdown(md).children.find((c) => c.type === "table");
  if (node?.type !== "table") throw new Error("no table parsed");
  return buildTablePlan(node);
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

  test("column widths are fixed points that sum within the page content width", () => {
    const plan = firstTable(SIMPLE);
    expect(plan.columnWidths).toHaveLength(2);
    const total = plan.columnWidths.reduce((s, d) => s + d.magnitude, 0);
    expect(total).toBeLessThanOrEqual(468);
    expect(total).toBeGreaterThan(400);
    for (const w of plan.columnWidths) expect(w.unit).toBe("PT");
  });

  test("a short column beside a very long one is floored, not collapsed", () => {
    const md = ["| Sev | Finding |", "|---|---|", `| 🔴 Critical | ${"x".repeat(300)} |`, ""].join("\n");
    const [sev, finding] = firstTable(md).columnWidths;
    if (!sev || !finding) throw new Error("expected two widths");
    // The severity column must stay readable (~0.7in), not shrink to a sliver.
    expect(sev.magnitude).toBeGreaterThanOrEqual(50);
    expect(finding.magnitude).toBeGreaterThan(sev.magnitude);
    expect(sev.magnitude + finding.magnitude).toBeLessThanOrEqual(468);
  });

  test("a short emoji column is widened to hold its value on one line", () => {
    // "🔴 Critical" needs ~70pt of content width; the old flat 54pt floor wrapped it.
    const md = ["| Severity | Finding |", "|---|---|", `| 🔴 Critical | ${"x".repeat(400)} |`, ""].join("\n");
    const [sev, finding] = firstTable(md).columnWidths;
    if (!sev || !finding) throw new Error("expected two widths");
    expect(sev.magnitude).toBeGreaterThanOrEqual(75);
    // But it must not run away with the page — the long column still dominates.
    expect(finding.magnitude).toBeGreaterThan(sev.magnitude);
    expect(sev.magnitude + finding.magnitude).toBeLessThanOrEqual(468);
  });

  test("when columns can't all fit, short columns hold the minimum and nothing overflows", () => {
    // Two wide columns plus two short ones over-subscribe the page.
    const wide = "y".repeat(300);
    const md = ["| A | B | C | D |", "|---|---|---|---|", `| ${wide} | ${wide} | ok | ok |`, ""].join("\n");
    const widths = firstTable(md).columnWidths.map((d) => d.magnitude);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(54);
    expect(widths.reduce((s, w) => s + w, 0)).toBeLessThanOrEqual(468);
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
    const bold = cell.runs.find((r) => r.style.bold);
    const code = cell.runs.find((r) => r.style.weightedFontFamily);
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
