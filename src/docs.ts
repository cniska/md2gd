/**
 * Minimal typed subset of the Google Docs API `batchUpdate` request shapes we
 * emit. Field names and structures mirror the official reference:
 * https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request
 *
 * We model only what we use; the API accepts partial objects with a `fields`
 * mask naming which properties to apply.
 */

export type Unit = "PT";

export interface Dimension {
  magnitude: number;
  unit: Unit;
}

export type NamedStyleType =
  | "NORMAL_TEXT"
  | "TITLE"
  | "SUBTITLE"
  | "HEADING_1"
  | "HEADING_2"
  | "HEADING_3"
  | "HEADING_4"
  | "HEADING_5"
  | "HEADING_6";

export interface Range {
  startIndex: number;
  endIndex: number;
}

export interface ParagraphStyle {
  namedStyleType?: NamedStyleType;
  lineSpacing?: number;
  spaceAbove?: Dimension;
  spaceBelow?: Dimension;
}

export interface WeightedFontFamily {
  fontFamily: string;
  weight?: number;
}

export interface RgbColor {
  red?: number;
  green?: number;
  blue?: number;
}

export interface OptionalColor {
  color?: { rgbColor: RgbColor };
}

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  link?: { url: string };
  weightedFontFamily?: WeightedFontFamily;
  foregroundColor?: OptionalColor;
  backgroundColor?: OptionalColor;
}

export interface InsertTextRequest {
  insertText: {
    text: string;
    location: { index: number };
  };
}

export interface UpdateParagraphStyleRequest {
  updateParagraphStyle: {
    paragraphStyle: ParagraphStyle;
    fields: string;
    range: Range;
  };
}

export interface UpdateTextStyleRequest {
  updateTextStyle: {
    textStyle: TextStyle;
    fields: string;
    range: Range;
  };
}

export type BulletPreset = "BULLET_DISC_CIRCLE_SQUARE" | "NUMBERED_DECIMAL_ALPHA_ROMAN" | "BULLET_CHECKBOX";

export interface CreateParagraphBulletsRequest {
  createParagraphBullets: {
    range: Range;
    bulletPreset: BulletPreset;
  };
}

export type DocRequest =
  | InsertTextRequest
  | UpdateParagraphStyleRequest
  | UpdateTextStyleRequest
  | CreateParagraphBulletsRequest;

/** Index of the first insertable position in a freshly created document body. */
export const BODY_START_INDEX = 1;

export function pt(magnitude: number): Dimension {
  return { magnitude, unit: "PT" };
}
