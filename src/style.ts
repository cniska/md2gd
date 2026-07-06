import { type Dimension, type NamedStyleType, type ParagraphStyle, pt } from "./docs";

/**
 * Central style table — the single source of truth for the "clean sensible
 * default" look. Because every document is styled from these fixed values, the
 * same input always produces the same result (reproducibility). Adjusting the
 * look later (e.g. brand fonts/colors) happens here without touching conversion.
 *
 * Spacing intent: body paragraphs breathe via space-below; headings carry more
 * space above than below so a heading groups with the content beneath it.
 */

/** Comfortable body line spacing as a percentage (100 = single). */
const BODY_LINE_SPACING = 115;

interface ParagraphStyleSpec {
  paragraphStyle: ParagraphStyle;
  /** Field mask naming which paragraphStyle properties to apply. */
  fields: string;
}

function spec(style: ParagraphStyle): ParagraphStyleSpec {
  return { paragraphStyle: style, fields: Object.keys(style).join(",") };
}

const NORMAL: ParagraphStyleSpec = spec({
  namedStyleType: "NORMAL_TEXT",
  lineSpacing: BODY_LINE_SPACING,
  spaceBelow: pt(8),
});

interface HeadingSpacing {
  above: Dimension;
  below: Dimension;
}

const HEADING_SPACING: Record<1 | 2 | 3 | 4 | 5 | 6, HeadingSpacing> = {
  1: { above: pt(20), below: pt(6) },
  2: { above: pt(16), below: pt(4) },
  3: { above: pt(14), below: pt(4) },
  4: { above: pt(12), below: pt(2) },
  5: { above: pt(12), below: pt(2) },
  6: { above: pt(12), below: pt(2) },
};

export function normalParagraphStyle(): ParagraphStyleSpec {
  return NORMAL;
}

export function headingParagraphStyle(depth: number): ParagraphStyleSpec {
  const level = Math.min(Math.max(depth, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
  const spacing = HEADING_SPACING[level];
  return spec({
    namedStyleType: `HEADING_${level}` as NamedStyleType,
    spaceAbove: spacing.above,
    spaceBelow: spacing.below,
  });
}
