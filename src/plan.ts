import type { List, ListItem, Root, RootContent } from "mdast";
import type { BulletPreset } from "./docs";
import { buildTablePlan, type TablePlan } from "./table";

/**
 * Where a block sits within its container. A list item exists in Docs only as
 * bullets and indents on its paragraphs, so every block carries its list
 * placement for the converter to render.
 */
export interface BlockContext {
  list?: ListPlacement;
  /** The block is a GFM table cell's content, which is inline only and sits flush in its cell. */
  tableCell?: true;
}

export interface ListPlacement {
  /** Identifies the outermost list, so its consecutive items share one bullet range. */
  id: number;
  /** 0 for an item of the outermost list, one more per nested list. */
  depth: number;
  /** The outermost list's preset; undefined for a task list, whose items carry a glyph instead. */
  preset?: BulletPreset;
  /** The item's own list is loose (blank lines between items), so its items space like paragraphs. */
  loose: boolean;
  /** True on an item's first block, which carries the item's marker. */
  first: boolean;
  /** The glyph leading a task-list item's first block. */
  prefix?: string;
}

/** A block the converter renders as paragraphs: anything but a quote or a table. */
export interface Leaf {
  node: RootContent;
  context: BlockContext;
}

/** A run of consecutive leaves, converted linearly at execution time. */
export interface LinearSegment {
  kind: "linear";
  leaves: Leaf[];
  /** True when this run immediately follows a table or quote, so its first block needs space above it. */
  afterTable: boolean;
}

/** A table, resolved against a live document GET at execution time. */
export interface TableSegment {
  kind: "table";
  table: TablePlan;
}

/**
 * A blockquote. Docs has no quote style, and paragraph borders join only across
 * identical indents, so a quote is a one-cell table: the only Docs container
 * that holds any block under one continuous accent.
 */
export interface QuoteSegment {
  kind: "quote";
  segments: Segment[];
}

export type Segment = LinearSegment | TableSegment | QuoteSegment;

interface ItemState {
  prefix?: string;
  started: boolean;
}

interface ListWalk {
  id: number;
  depth: number;
  preset?: BulletPreset;
  loose: boolean;
  item: ItemState;
}

/**
 * Split a document into an ordered tree of segments. List items are walked at
 * any depth into leaves that remember their list placement; tables and quotes
 * become their own segments wherever they sit, because their cell indices only
 * exist after insertion. This is the boundary that lets the executor interleave
 * deterministic batches with the insert-then-read-back table flow.
 */
export function planDocument(root: Root): Segment[] {
  let nextListId = 0;

  const collect = (nodes: RootContent[]): Segment[] => {
    const segments: Segment[] = [];
    let leaves: Leaf[] = [];

    const flush = (): void => {
      if (leaves.length > 0) {
        const previous = segments[segments.length - 1]?.kind;
        segments.push({ kind: "linear", leaves, afterTable: previous === "table" || previous === "quote" });
        leaves = [];
      }
    };

    const emit = (node: RootContent, list: ListWalk | undefined): void => {
      if (!list) {
        leaves.push({ node, context: {} });
        return;
      }
      const first = !list.item.started;
      list.item.started = true;
      const placement: ListPlacement = {
        id: list.id,
        depth: list.depth,
        preset: list.preset,
        loose: list.loose,
        first,
      };
      if (first && list.item.prefix) placement.prefix = list.item.prefix;
      leaves.push({ node, context: { list: placement } });
    };

    const place = (segment: TableSegment | QuoteSegment, list: ListWalk | undefined): void => {
      flush();
      if (list) list.item.started = true;
      segments.push(segment);
    };

    const walkList = (list: List, parent: ListWalk | undefined): void => {
      const task = isTaskList(list);
      const id = parent ? parent.id : nextListId++;
      const depth = parent ? parent.depth + 1 : 0;
      // The outermost list decides the preset for the whole nested range; nested
      // lists inherit it, and a task list's range has none.
      const preset = parent ? parent.preset : task ? undefined : bulletPreset(list);
      for (const item of list.children) {
        const walk: ListWalk = {
          id,
          depth,
          preset,
          loose: list.spread === true,
          item: { prefix: itemPrefix(item, task), started: false },
        };
        // An item's marker rides on a paragraph, so an empty item, or one that
        // opens with a table or quote, gets an empty first one to carry it.
        const opener = item.children[0]?.type;
        const needsMarker = opener === undefined || opener === "table" || opener === "blockquote";
        const children: RootContent[] = needsMarker
          ? [{ type: "paragraph", children: [] }, ...item.children]
          : item.children;
        visit(children, walk);
      }
    };

    const visit = (children: RootContent[], list: ListWalk | undefined): void => {
      for (const node of children) {
        switch (node.type) {
          case "table":
            place({ kind: "table", table: buildTablePlan(node) }, list);
            break;
          case "blockquote":
            place({ kind: "quote", segments: collect(node.children) }, list);
            break;
          case "list":
            walkList(node, list);
            break;
          case "thematicBreak":
            // Ignored: a bordered rule looks poor in Docs, and headings already
            // carry space above, so a thematic break contributes nothing.
            break;
          default:
            emit(node, list);
        }
      }
    };

    visit(nodes, undefined);
    flush();
    return segments;
  };

  return collect(root.children);
}

/** A GFM task list — at least one item carries a boolean checked state. */
function isTaskList(list: List): boolean {
  return list.children.some((item) => typeof item.checked === "boolean");
}

/**
 * Leading text marker for an item in a task list (which uses no bullet preset):
 * a checkbox glyph preserving checked state, or a plain bullet for a non-task
 * item mixed into the list. Non-task lists return undefined — their marker comes
 * from a `createParagraphBullets` preset instead.
 */
function itemPrefix(item: ListItem, taskList: boolean): string | undefined {
  if (typeof item.checked === "boolean") return item.checked ? "☑ " : "☐ ";
  return taskList ? "• " : undefined;
}

// Known limitation: one preset applies to the whole (possibly nested) list, so a
// list of one type nested inside another still renders with the outer preset's
// per-level glyphs. Correct per-level presets for mixed nesting would need
// separate bullet requests per contiguous same-type run. The target documents
// use flat single-type lists, so this is documented rather than implemented.
function bulletPreset(list: List): BulletPreset {
  return list.ordered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE";
}
