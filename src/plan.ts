import type { List, ListItem, Root, RootContent } from "mdast";
import type { BulletPreset } from "./docs";
import { buildTablePlan, type TablePlan } from "./table";

/**
 * Where a block sits. Google Docs has no block container — a quote and a list
 * item exist only as styling on each paragraph — so every block carries the
 * containers it was nested in and the converter composes their styling onto it.
 */
export interface BlockContext {
  quoteDepth: number;
  list?: ListPlacement;
}

export interface ListPlacement {
  /** Identifies the outermost list, so its consecutive items share one bullet range. */
  id: number;
  /** 0 for an item of the outermost list, one more per nested list. */
  depth: number;
  /** The quote depth the outermost list sits at; quotes opened inside its items count beyond it. */
  quoteBase: number;
  /** The outermost list's preset; undefined for a task list, whose items carry a glyph instead. */
  preset?: BulletPreset;
  /** True on an item's first block, which carries the item's marker. */
  first: boolean;
  /** The glyph leading a task-list item's first block. */
  prefix?: string;
}

/** A block the converter renders as paragraphs: anything but a container or a table. */
export interface Leaf {
  node: RootContent;
  context: BlockContext;
}

/** A run of consecutive leaves, converted linearly at execution time. */
export interface LinearSegment {
  kind: "linear";
  leaves: Leaf[];
  /** True when this run immediately follows a table, so its first block needs space above it. */
  afterTable: boolean;
}

/** A table, resolved against a live document GET at execution time. */
export interface TableSegment {
  kind: "table";
  table: TablePlan;
}

export type Segment = LinearSegment | TableSegment;

interface ItemState {
  prefix?: string;
  started: boolean;
}

interface WalkContext {
  quoteDepth: number;
  list?: { id: number; depth: number; quoteBase: number; preset?: BulletPreset; item: ItemState };
}

/**
 * Split a document into an ordered list of segments. Quotes and list items are
 * walked at any depth into leaves that remember their containers; tables become
 * their own segments wherever they sit, because their cell indices only exist
 * after insertion. This is the boundary that lets the executor interleave
 * deterministic batches with the insert-then-read-back table flow.
 */
export function planDocument(root: Root): Segment[] {
  const segments: Segment[] = [];
  let leaves: Leaf[] = [];
  let nextListId = 0;

  const flush = (): void => {
    if (leaves.length > 0) {
      const afterTable = segments[segments.length - 1]?.kind === "table";
      segments.push({ kind: "linear", leaves, afterTable });
      leaves = [];
    }
  };

  const emit = (node: RootContent, context: WalkContext): void => {
    const list = context.list;
    if (!list) {
      leaves.push({ node, context: { quoteDepth: context.quoteDepth } });
      return;
    }
    const first = !list.item.started;
    list.item.started = true;
    const placement: ListPlacement = {
      id: list.id,
      depth: list.depth,
      quoteBase: list.quoteBase,
      preset: list.preset,
      first,
    };
    if (first && list.item.prefix) placement.prefix = list.item.prefix;
    leaves.push({ node, context: { quoteDepth: context.quoteDepth, list: placement } });
  };

  const walkList = (list: List, context: WalkContext): void => {
    const task = isTaskList(list);
    const parent = context.list;
    const id = parent ? parent.id : nextListId++;
    const depth = parent ? parent.depth + 1 : 0;
    const quoteBase = parent ? parent.quoteBase : context.quoteDepth;
    // The outermost list decides the preset for the whole nested range; nested
    // lists inherit it, and a task list's range has none.
    const preset = parent ? parent.preset : task ? undefined : bulletPreset(list);
    for (const item of list.children) {
      const itemContext: WalkContext = {
        quoteDepth: context.quoteDepth,
        list: { id, depth, quoteBase, preset, item: { prefix: itemPrefix(item, task), started: false } },
      };
      // An empty item still holds its place, so the items after it keep their numbers.
      const children: RootContent[] = item.children.length > 0 ? item.children : [{ type: "paragraph", children: [] }];
      walk(children, itemContext);
    }
  };

  const walk = (nodes: RootContent[], context: WalkContext): void => {
    for (const node of nodes) {
      switch (node.type) {
        case "table":
          flush();
          segments.push({ kind: "table", table: buildTablePlan(node) });
          break;
        case "blockquote":
          walk(node.children, { ...context, quoteDepth: context.quoteDepth + 1 });
          break;
        case "list":
          walkList(node, context);
          break;
        case "thematicBreak":
          // Ignored: a bordered rule looks poor in Docs, and headings already
          // carry space above, so a thematic break contributes nothing.
          break;
        default:
          emit(node, context);
      }
    }
  };

  walk(root.children, { quoteDepth: 0 });
  flush();
  return segments;
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
