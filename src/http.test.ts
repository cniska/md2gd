import { describe, expect, test } from "bun:test";
import { type FetchFn, fetchWithRetry } from "./http";

/** Replies with each queued status in turn (an Error entry throws like a dropped connection). */
function sequence(replies: (number | Error | Response)[]): { fetchFn: FetchFn; calls: () => number } {
  let i = 0;
  const fetchFn: FetchFn = () => {
    const reply = replies[Math.min(i++, replies.length - 1)];
    if (reply instanceof Error) return Promise.reject(reply);
    if (reply instanceof Response) return Promise.resolve(reply);
    return Promise.resolve(new Response("{}", { status: reply }));
  };
  return { fetchFn, calls: () => i };
}

function recordSleeps(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    waits.push(ms);
    return Promise.resolve();
  };
  return { waits, sleep };
}

describe("fetchWithRetry", () => {
  test("returns a success without waiting", async () => {
    const { fetchFn, calls } = sequence([200]);
    const { sleep, waits } = recordSleeps();
    const res = await fetchWithRetry(fetchFn, "u", {}, sleep);
    expect(res.status).toBe(200);
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  test("returns a client error at once, never retrying it", async () => {
    const { fetchFn, calls } = sequence([404, 200]);
    const { sleep, waits } = recordSleeps();
    expect((await fetchWithRetry(fetchFn, "u", {}, sleep)).status).toBe(404);
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  test("retries rate limiting and server errors with exponential backoff", async () => {
    const { fetchFn, calls } = sequence([429, 503, 500, 200]);
    const { sleep, waits } = recordSleeps();
    expect((await fetchWithRetry(fetchFn, "u", {}, sleep)).status).toBe(200);
    expect(calls()).toBe(4);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  test("waits as long as Retry-After asks, within a cap", async () => {
    const { fetchFn } = sequence([
      new Response("", { status: 429, headers: { "retry-after": "7" } }),
      new Response("", { status: 429, headers: { "retry-after": "3600" } }),
      200,
    ]);
    const { sleep, waits } = recordSleeps();
    await fetchWithRetry(fetchFn, "u", {}, sleep);
    expect(waits).toEqual([7000, 30000]);
  });

  test("waits until a Retry-After date, within the same cap", async () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const { fetchFn } = sequence([new Response("", { status: 429, headers: { "retry-after": at } }), 200]);
    const { sleep, waits } = recordSleeps();
    await fetchWithRetry(fetchFn, "u", {}, sleep);
    expect(waits[0]).toBeGreaterThan(3000);
    expect(waits[0]).toBeLessThanOrEqual(5000);
  });

  test("hands back the last response once retries run out", async () => {
    const { fetchFn, calls } = sequence([429]);
    const { sleep, waits } = recordSleeps();
    expect((await fetchWithRetry(fetchFn, "u", {}, sleep)).status).toBe(429);
    expect(calls()).toBe(4);
    expect(waits).toHaveLength(3);
  });

  test("retries a dropped connection, then reports it as a network problem", async () => {
    const { fetchFn, calls } = sequence([new TypeError("Unable to connect")]);
    const { sleep } = recordSleeps();
    const error = await fetchWithRetry(fetchFn, "u", {}, sleep).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("md2gd: cannot reach Google — check your network connection");
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(calls()).toBe(4);
  });

  test("never retries a server error on a write, which may already have applied", async () => {
    const { fetchFn, calls } = sequence([503, 200]);
    const { sleep, waits } = recordSleeps();
    expect((await fetchWithRetry(fetchFn, "u", { method: "POST" }, sleep)).status).toBe(503);
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  test("still retries rate limiting on a write, which Google rejects before applying", async () => {
    const { fetchFn, calls } = sequence([429, 200]);
    const { sleep } = recordSleeps();
    expect((await fetchWithRetry(fetchFn, "u", { method: "POST" }, sleep)).status).toBe(200);
    expect(calls()).toBe(2);
  });

  test("reports a dropped write at once rather than resending it", async () => {
    const { fetchFn, calls } = sequence([new TypeError("Unable to connect"), 200]);
    const { sleep } = recordSleeps();
    await expect(fetchWithRetry(fetchFn, "u", { method: "POST" }, sleep)).rejects.toThrow(
      "md2gd: cannot reach Google — check your network connection",
    );
    expect(calls()).toBe(1);
  });

  test("retries Drive's rate limiting, which arrives as a 403 with a rate-limit reason", async () => {
    const limited = () =>
      new Response(JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }), { status: 403 });
    const { fetchFn, calls } = sequence([limited(), 200]);
    const { sleep } = recordSleeps();
    expect((await fetchWithRetry(fetchFn, "u", { method: "POST" }, sleep)).status).toBe(200);
    expect(calls()).toBe(2);
  });

  test("returns a permission 403 at once", async () => {
    const denied = new Response(JSON.stringify({ error: { errors: [{ reason: "forbidden" }] } }), { status: 403 });
    const { fetchFn, calls } = sequence([denied, 200]);
    const { sleep } = recordSleeps();
    expect((await fetchWithRetry(fetchFn, "u", {}, sleep)).status).toBe(403);
    expect(calls()).toBe(1);
  });

  test("recovers when the connection comes back", async () => {
    const { fetchFn } = sequence([new TypeError("Unable to connect"), 200]);
    const { sleep } = recordSleeps();
    expect((await fetchWithRetry(fetchFn, "u", {}, sleep)).status).toBe(200);
  });
});
