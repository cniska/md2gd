export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type Sleep = (ms: number) => Promise<void>;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const ATTEMPTS = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

/**
 * Fetch, retrying rate limiting, server errors, and dropped connections with
 * exponential backoff, as Google's API guidance asks of clients. A rate-limited
 * request is rejected before it applies, so retrying it never repeats a write.
 * Once retries run out, the last response is returned for the caller to report.
 */
export async function fetchWithRetry(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  sleep: Sleep = Bun.sleep,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt === ATTEMPTS;
    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch {
      if (last) throw new Error("md2gd: cannot reach Google — check your network connection");
      await sleep(backoff(attempt));
      continue;
    }
    if (last || !RETRYABLE_STATUS.has(res.status)) return res;
    await sleep(retryAfter(res) ?? backoff(attempt));
  }
}

function backoff(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

function retryAfter(res: Response): number | undefined {
  const seconds = Number(res.headers.get("retry-after"));
  return seconds > 0 ? Math.min(seconds * 1000, MAX_DELAY_MS) : undefined;
}
