import { z } from "zod";

const ParseFailureSchema = z.enum(["unparsed", "invalid"]);

type ParseFailure = z.infer<typeof ParseFailureSchema>;

export type Parsed<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: ParseFailure; readonly problem: string; readonly cause: unknown };

export function parseJsonAs<T>(schema: z.ZodType<T>, text: string): Parsed<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, failure: "unparsed", problem: "not JSON", cause: error };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, failure: "invalid", problem: problemOf(parsed.error), cause: parsed.error };
}

function problemOf(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}
