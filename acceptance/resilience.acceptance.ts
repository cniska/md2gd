import { describe, expect, test } from "bun:test";
import { documentIdOf, type Ran, withWorld } from "./support/world";

const RETRY_BACKOFF_ALLOWANCE_MS = 20_000;
const FILES = /^\/drive\/v3\/files$/;
const BATCH_UPDATE = /^\/v1\/documents\/[^/]+:batchUpdate$/;
const FAST_RETRY = { "Retry-After": "0.01" };

const driveError = (code: number, domain: string, reason: string, message: string) => ({
  error: { code, message, errors: [{ message, domain, reason }] },
});

const rateLimited = driveError(403, "usageLimits", "userRateLimitExceeded", "User Rate Limit Exceeded");
const permissionDenied = driveError(
  403,
  "global",
  "insufficientFilePermissions",
  "The user does not have sufficient permissions for this file.",
);
const unavailable = { error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } };

function expectReadableFailure(ran: Ran, cause: RegExp): void {
  expect(ran.exitCode).not.toBe(0);
  const message = ran.stderr.trim();
  expect(message.startsWith("md2gd:")).toBe(true);
  expect(message.split("\n")).toHaveLength(1);
  expect(message).not.toContain("    at ");
  expect(message).toMatch(cause);
}

describe("failures end in a readable message", () => {
  test(
    "AC-7 no network ends the run, once md2gd's retries have backed off, with a message naming the network",
    async () => {
      await withWorld(async (world) => {
        await world.init();

        const ran = await world.run([world.write("note.md", "# Note\n")], {
          MD2GD_GOOGLE_ORIGIN: "http://127.0.0.1:1",
        });

        expectReadableFailure(ran, /cannot reach Google/);
      });
    },
    RETRY_BACKOFF_ALLOWANCE_MS,
  );

  test.failing("AC-7 revoked consent ends the run with a message asking for init", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.revokeRefreshTokens();

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      expectReadableFailure(ran, /init/);
    });
  });

  test("AC-7 Drive permission denied ends the run with a message naming the permission", async () => {
    await withWorld(async (world) => {
      await world.init();
      const folder = world.google.addFolder({ name: "Read only", role: "reader" });

      const ran = await world.run([world.write("note.md", "# Note\n"), "--folder", folder]);

      expectReadableFailure(ran, /write to it|permission/);
    });
  });

  test("AC-7 lasting rate limiting ends the run with a message naming the rate limit", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.fail("GET", FILES, { status: 403, body: rateLimited, headers: FAST_RETRY }, 100);

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      expectReadableFailure(ran, /rate limit/);
    });
  });

  test("AC-7 lasting 429 responses end the run with a message naming the rate limit", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.fail(
        "GET",
        FILES,
        {
          status: 429,
          body: { error: { code: 429, message: "Rate Limit Exceeded", status: "RESOURCE_EXHAUSTED" } },
          headers: FAST_RETRY,
        },
        100,
      );

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      expectReadableFailure(ran, /rate limit/);
    });
  });
});

describe("retries", () => {
  const count = (requests: readonly { method: string; path: string }[], method: string, path: RegExp): number =>
    requests.filter((request) => request.method === method && path.test(request.path)).length;

  test("AC-20 a rate-limited write is retried and the run succeeds", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.fail("POST", FILES, { status: 403, body: rateLimited, headers: FAST_RETRY });

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      documentIdOf(ran);
      expect(count(world.google.requests, "POST", FILES)).toBe(3);
    });
  });

  test("AC-20 a server error on a read is retried and the run succeeds", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.fail("GET", FILES, { status: 503, body: unavailable, headers: FAST_RETRY });

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      documentIdOf(ran);
      expect(count(world.google.requests, "GET", FILES)).toBe(2);
    });
  });

  test("AC-20 a dropped connection on a read is retried and the run succeeds", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.fail("GET", FILES, "drop");

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      documentIdOf(ran);
      expect(count(world.google.requests, "GET", FILES)).toBe(2);
    });
  });

  test("AC-20 a write that fails with a server error after it may have applied is not resent", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.fail("POST", BATCH_UPDATE, { status: 503, body: unavailable, headers: FAST_RETRY });

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      expect(ran.exitCode).not.toBe(0);
      expect(count(world.google.requests, "POST", BATCH_UPDATE)).toBe(1);
    });
  });

  test("AC-20 a write whose connection drops is not resent", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.fail("POST", BATCH_UPDATE, "drop");

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      expectReadableFailure(ran, /cannot reach Google/);
      expect(count(world.google.requests, "POST", BATCH_UPDATE)).toBe(1);
    });
  });

  test("AC-20 a permission error on a read is a client error and is not retried", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.fail("GET", FILES, { status: 403, body: permissionDenied, headers: FAST_RETRY }, 100);

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      expectReadableFailure(ran, /permission/);
      expect(count(world.google.requests, "GET", FILES)).toBe(1);
    });
  });
});
