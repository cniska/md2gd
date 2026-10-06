import type { AlignType, List, ListItem, Root, RootContent } from "mdast";
import type { BulletPreset } from "./docs";
import { buildTablePlan, type TablePlan } from "./table";

export interface BlockContext {
  list?: ListPlacement;
  cell?: CellPlacement;
}

export interface CellPlacement {
  header: boolean;
  align: AlignType;
}

export interface ListPlacement {
  id: number;
  depth: number;
  preset?: BulletPreset;
  loose: boolean;
  first: boolean;
  prefix?: string;
}

export interface Leaf {
  node: RootContent;
  context: BlockContext;
}

export interface LinearSegment {
  kind: "linear";
  leaves: Leaf[];
  afterTable: boolean;
}

export interface TableSegment {
  kind: "table";
  table: TablePlan;
}

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
      const preset = parent ? parent.preset : outermostPreset(list, task);
      const loose = list.spread === true || list.children.some((item) => item.spread === true);
      for (const item of list.children) {
        const walk: ListWalk = {
          id,
          depth,
          preset,
          loose,
          item: { prefix: itemPrefix(item, task), started: false },
        };
        const opener = item.children[0]?.type;
        const needsMarker = opener === undefined || opener === "table" || opener === "blockquote" || opener === "list";
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

function isTaskList(list: List): boolean {
  return list.children.some((item) => typeof item.checked === "boolean");
}

function itemPrefix(item: ListItem, taskList: boolean): string | undefined {
  if (typeof item.checked === "boolean") return item.checked ? "☑ " : "☐ ";
  return taskList ? "• " : undefined;
}

function outermostPreset(list: List, task: boolean): BulletPreset | undefined {
  if (task) return undefined;
  return list.ordered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE";
}
