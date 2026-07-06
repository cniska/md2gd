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
});
