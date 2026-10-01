import { z } from "zod";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type Sleep = (ms: number) => Promise<void>;

const SERVER_ERROR_STATUS = new Set([500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const ErrorReasonsSchema = z.looseObject({
  error: z.looseObject({ errors: z.array(z.looseObject({ reason: z.string().optional() })).default([]) }),
});
const ATTEMPTS = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

/**
 * Fetch, retrying with exponential backoff as Google's API guidance asks of
 * clients. Rate limiting is always retried: Google rejects a rate-limited request
 * before it applies. Server errors and dropped connections are retried only for
 * requests other than POST — a POST (a Docs `batchUpdate`, a Drive create) may
 * already have applied, and resending it would duplicate content. Once retries
 * run out, the last response is returned for the caller to report.
 */
export async function fetchWithRetry(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  sleep: Sleep = Bun.sleep,
): Promise<Response> {
  const isWrite = init.method?.toUpperCase() === "POST";
  for (let attempt = 1; ; attempt++) {
    const last = attempt === ATTEMPTS;
    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch (cause) {
      if (last || isWrite) throw new Error("md2gd: cannot reach Google — check your network connection", { cause });
      await sleep(backoff(attempt));
      continue;
    }
    const retryable = (await isRateLimited(res)) || (!isWrite && SERVER_ERROR_STATUS.has(res.status));
    if (last || !retryable) return res;
    await res.body?.cancel();
    await sleep(retryAfter(res) ?? backoff(attempt));
  }
}

/**
 * Whether Google refused the request for rate limiting: a 429, or the 403 Drive
 * sends instead, told apart from a permission 403 by its error reason.
 */
export async function isRateLimited(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const parsed = ErrorReasonsSchema.safeParse(
    await res
      .clone()
      .json()
      .catch(() => undefined),
  );
  return parsed.success && parsed.data.error.errors.some((e) => RATE_LIMIT_REASONS.has(e.reason ?? ""));
}

function backoff(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

/** `Retry-After` as a wait in milliseconds, given either as seconds or as an HTTP date. */
function retryAfter(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
  return ms > 0 ? Math.min(ms, MAX_DELAY_MS) : undefined;
}
