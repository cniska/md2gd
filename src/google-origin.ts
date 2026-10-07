import { z } from "zod";
import { createRefuser } from "./coded-error";

const ORIGIN_VARIABLE = "MD2GD_GOOGLE_ORIGIN";

const OriginSchema = z
  .url({ protocol: /^https?$/, abort: true })
  .refine((value) => new URL(value).origin === value.replace(/\/$/, ""));

const refuse = createRefuser<{ google_origin_invalid: { value: string } }>({
  google_origin_invalid: {
    message: ({ value }) => `${ORIGIN_VARIABLE} must be an http or https origin, got: ${value}`,
    resolve: () => `unset ${ORIGIN_VARIABLE} or set it to an http(s) origin`,
  },
});

export function googleEndpoint(url: string, env: Record<string, string | undefined> = process.env): string {
  const override = env[ORIGIN_VARIABLE];
  if (!override) return url;
  const parsed = OriginSchema.safeParse(override);
  if (!parsed.success) throw refuse("google_origin_invalid", { value: override });
  const target = new URL(url);
  return new URL(`${target.pathname}${target.search}`, parsed.data).toString();
}
