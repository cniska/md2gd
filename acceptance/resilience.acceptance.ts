import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_MIME } from "./support/google-fake";
import { documentIdOf, expectFailure, type World, withWorld } from "./support/world";

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

const createdDocument = (world: World): string =>
  world.google.driveFiles().find((file) => file.mimeType === DOC_MIME)?.id ?? "no document";

describe("failures end in a readable message", () => {
  test(
    "AC-7 no network ends the run, once md2gd's retries have backed off, naming the network",
    async () => {
      await withWorld(async (world) => {
        await world.init();

        const ran = await world.run([world.write("note.md", "# Note\n")], {
          MD2GD_GOOGLE_ORIGIN: "http://127.0.0.1:1",
        });

        expectFailure(
          ran,
          "md2gd: cannot reach Google for GET /drive/v3/files [google_unreachable]\nresolve: check your network connection, then run the command again\n",
        );
      });
    },
    RETRY_BACKOFF_ALLOWANCE_MS,
  );

  test("AC-7 revoked consent ends the run asking for init", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.revokeRefreshTokens();

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      expectFailure(
        ran,
        "md2gd: Google did not accept md2gd's sign-in for GET /drive/v3/files (401 UNAUTHENTICATED) [google_unauthenticated]\nresolve: md2gd init\n",
      );
    });
  });

  test("AC-7 revoked consent found on a token refresh ends the run asking for init", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.revokeRefreshTokens();
      const token = join(world.configDir, "token.json");
      writeFileSync(token, JSON.stringify({ ...JSON.parse(readFileSync(token, "utf8")), expiryDate: 0 }));

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      expectFailure(
        ran,
        "md2gd: Google no longer accepts md2gd's stored authorization for POST /token (400 invalid_grant) [authorization_revoked]\nresolve: md2gd init\n",
      );
    });
  });

  test("AC-7 Drive permission denied ends the run naming the folder", async () => {
    await withWorld(async (world) => {
      await world.init();
      const folder = world.google.addFolder({ name: "Read only", role: "reader" });

      const ran = await world.run([world.write("note.md", "# Note\n"), "--folder", folder]);

      expectFailure(
        ran,
        `md2gd: cannot write to folder ${folder} (403 insufficientFilePermissions) [folder_unwritable]\nresolve: check the folder URL or id and that you can write to it\n`,
      );
    });
  });

  test("AC-7 lasting rate limiting ends the run naming the rate limit", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.fail("GET", FILES, { status: 403, body: rateLimited, headers: FAST_RETRY }, 100);

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      expectFailure(
        ran,
        "md2gd: Google rate limit reached for GET /drive/v3/files (403 userRateLimitExceeded) [rate_limited]\nresolve: wait a minute, then run the command again\n",
      );
    });
  });

  test("AC-7 lasting 429 responses end the run naming the rate limit", async () => {
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

      expectFailure(
        ran,
        "md2gd: Google rate limit reached for GET /drive/v3/files (429 RESOURCE_EXHAUSTED) [rate_limited]\nresolve: wait a minute, then run the command again\n",
      );
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

      expectFailure(
        ran,
        `md2gd: Google is unavailable for POST /v1/documents/${createdDocument(world)}:batchUpdate (503 UNAVAILABLE) [google_unavailable]\nresolve: run the command again later\n`,
      );
      expect(count(world.google.requests, "POST", BATCH_UPDATE)).toBe(1);
    });
  });

  test("AC-20 a write whose connection drops is not resent", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.fail("POST", BATCH_UPDATE, "drop");

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      expectFailure(
        ran,
        `md2gd: cannot reach Google for POST /v1/documents/${createdDocument(world)}:batchUpdate [google_unreachable]\nresolve: check your network connection, then run the command again\n`,
      );
      expect(count(world.google.requests, "POST", BATCH_UPDATE)).toBe(1);
    });
  });

  test("AC-20 a permission error on a read is a client error and is not retried", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.google.fail("GET", FILES, { status: 403, body: permissionDenied, headers: FAST_RETRY }, 100);

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      expectFailure(
        ran,
        "md2gd: Google denied GET /drive/v3/files (403 insufficientFilePermissions) [google_denied]\nresolve: check that your Google account can open and edit the file\n",
      );
      expect(count(world.google.requests, "GET", FILES)).toBe(1);
    });
  });
});
