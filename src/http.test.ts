import { describe, expect, test } from "bun:test";
import { type FetchFn, fetchWithRetry, responseErrorOf } from "./http";

const FILES_URL = "https://www.googleapis.com/drive/v3/files?q=x";

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

  test("retries a dropped connection, then reports it as a network problem carrying the cause", async () => {
    const dropped = new TypeError("Unable to connect");
    const { fetchFn, calls } = sequence([dropped]);
    const { sleep } = recordSleeps();
    await expect(fetchWithRetry(fetchFn, FILES_URL, {}, sleep)).rejects.toThrow(
      expect.objectContaining({
        code: "google_unreachable",
        kind: "refusal",
        meta: { method: "GET", path: "/drive/v3/files" },
        cause: dropped,
      }),
    );
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
    await expect(fetchWithRetry(fetchFn, FILES_URL, { method: "POST" }, sleep)).rejects.toThrow(
      expect.objectContaining({ code: "google_unreachable", meta: { method: "POST", path: "/drive/v3/files" } }),
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

describe("responseErrorOf", () => {
  test("keeps Google's message on one line, so the report stays two lines", async () => {
    const body = {
      error: {
        code: 400,
        message: "Invalid requests[0]:\n  ✖ bad index\n    → at requests",
        status: "INVALID_ARGUMENT",
      },
    };
    expect(
      (await responseErrorOf(new Response(JSON.stringify(body), { status: 400 }), "POST", FILES_URL)).meta.detail,
    ).toBe("Invalid requests[0]: ✖ bad index → at requests");
    expect(
      (await responseErrorOf(new Response("<html>\n<body>Bad</body>\n</html>", { status: 400 }), "POST", FILES_URL))
        .meta.detail,
    ).toBe("<html> <body>Bad</body> </html>");
  });

  const reply = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const driveBody = (reason: string) => ({ error: { code: 403, message: "m", errors: [{ reason }] } });
  const docsBody = (status: string) => ({ error: { code: 404, message: "Requested entity was not found.", status } });
  const classify = (res: Response) => responseErrorOf(res, "GET", FILES_URL);

  test("takes the reason from Drive's errors list", async () => {
    expect(await classify(reply(403, driveBody("insufficientFilePermissions")))).toMatchObject({
      code: "google_denied",
      kind: "refusal",
      meta: { method: "GET", path: "/drive/v3/files", status: 403, reason: "insufficientFilePermissions" },
    });
  });

  test("takes the reason from the Docs API's status", async () => {
    expect(await classify(reply(404, docsBody("NOT_FOUND")))).toMatchObject({
      code: "google_denied",
      meta: { status: 404, reason: "NOT_FOUND" },
    });
  });

  test("takes the reason from the token endpoint's error string", async () => {
    expect(await classify(reply(400, { error: "invalid_request", error_description: "Bad" }))).toMatchObject({
      meta: { status: 400, reason: "invalid_request" },
    });
  });

  test("has no reason for a body carrying none, or one that is not JSON", async () => {
    expect((await classify(reply(404, { error: { code: 404, message: "gone" } }))).meta.reason).toBeNull();
    expect((await classify(reply(404, "<html>Not Found</html>"))).meta.reason).toBeNull();
    expect((await classify(reply(404, { unrelated: true }))).meta.reason).toBeNull();
  });

  test("names rate limiting, by a 429 or by Drive's 403 reason", async () => {
    expect((await classify(reply(429, {}))).code).toBe("rate_limited");
    expect((await classify(reply(403, driveBody("userRateLimitExceeded")))).code).toBe("rate_limited");
  });

  test("names a 401 as an unaccepted sign-in", async () => {
    expect((await classify(reply(401, docsBody("UNAUTHENTICATED")))).code).toBe("google_unauthenticated");
  });

  test("names a server error as Google being unavailable", async () => {
    expect((await classify(reply(503, docsBody("UNAVAILABLE")))).code).toBe("google_unavailable");
  });

  test("names any other client error a fault in md2gd, carrying Google's message", async () => {
    expect(
      await classify(reply(400, { error: { code: 400, message: "Invalid range", status: "INVALID_ARGUMENT" } })),
    ).toMatchObject({
      code: "google_rejected",
      kind: "fault",
      meta: { status: 400, reason: "INVALID_ARGUMENT", detail: "Invalid range" },
    });
  });
});
