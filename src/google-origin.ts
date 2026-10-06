import { z } from "zod";

const ORIGIN_VARIABLE = "MD2GD_GOOGLE_ORIGIN";

const OriginSchema = z
  .url({ protocol: /^https?$/, abort: true })
  .refine((value) => new URL(value).origin === value.replace(/\/$/, ""));

export function googleEndpoint(url: string, env: Record<string, string | undefined> = process.env): string {
  const override = env[ORIGIN_VARIABLE];
  if (!override) return url;
  const parsed = OriginSchema.safeParse(override);
  if (!parsed.success) throw new Error(`md2gd: ${ORIGIN_VARIABLE} must be an http or https origin, got: ${override}`);
  const target = new URL(url);
  return new URL(`${target.pathname}${target.search}`, parsed.data).toString();
}
