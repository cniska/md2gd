import type { Root, RootContent } from "mdast";
import { buildTablePlan, type TablePlan } from "./table";

/** A run of consecutive non-table blocks, converted linearly at execution time. */
export interface LinearSegment {
  kind: "linear";
  nodes: RootContent[];
}

/** A table, resolved against a live document GET at execution time. */
export interface TableSegment {
  kind: "table";
  table: TablePlan;
}

export type Segment = LinearSegment | TableSegment;

/**
 * Split a document into an ordered list of segments. Tables become their own
 * segments because their cell indices only exist after insertion; everything
 * between tables is a linear run that converts deterministically. This is the
 * boundary that lets the executor interleave deterministic batches with the
 * insert-then-read-back table flow.
 */
export function planDocument(root: Root): Segment[] {
  const segments: Segment[] = [];
  let linear: RootContent[] = [];

  const flush = (): void => {
    if (linear.length > 0) {
      segments.push({ kind: "linear", nodes: linear });
      linear = [];
    }
  };

  for (const node of root.children) {
    if (node.type === "table") {
      flush();
      segments.push({ kind: "table", table: buildTablePlan(node) });
    } else {
      linear.push(node);
    }
  }
  flush();

  return segments;
}
