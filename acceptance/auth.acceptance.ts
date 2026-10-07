import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { documentIdOf, expectFailure, withWorld } from "./support/world";

const CONSENT_PATH = "/o/oauth2/v2/auth";
const DOC_URL = /^https:\/\/docs\.google\.com\/document\/d\/[\w-]+\/edit$/;

const consents = (opened: readonly string[]): string[] => opened.filter((url) => url.includes(CONSENT_PATH));

describe("one-time setup", () => {
  test("AC-4 init opens consent once, stores the client secret, and caches the token", async () => {
    await withWorld(async (world) => {
      const secret = world.writeClientSecret();
      const ran = await world.run(["init", "--client", secret]);

      expect(ran.exitCode).toBe(0);
      expect(consents(world.opened())).toHaveLength(1);
      expect(readFileSync(join(world.configDir, "client_secret.json"), "utf8")).toBe(readFileSync(secret, "utf8"));
      expect(existsSync(join(world.configDir, "token.json"))).toBe(true);
    });
  });

  test("AC-4 a conversion after init completes without opening a browser", async () => {
    await withWorld(async (world) => {
      await world.init();
      const openedAfterInit = world.opened().length;

      const ran = await world.run([world.write("note.md", "# Note\n\nBody.\n")]);

      documentIdOf(ran);
      expect(world.opened()).toHaveLength(openedAfterInit);
    });
  });

  test("AC-4 running init again leaves one set of credentials", async () => {
    await withWorld(async (world) => {
      await world.init();
      await world.init();

      expect(readdirSync(world.configDir).sort()).toEqual(["client_secret.json", "token.json"]);
      documentIdOf(await world.run([world.write("note.md", "# Note\n")]));
    });
  });
});

describe("requests stay on the configured Google origin", () => {
  test("AC-8 init and a create send every request to MD2GD_GOOGLE_ORIGIN and print the Google Docs URL", async () => {
    await withWorld(async (world) => {
      await world.init();
      const ran = await world.run([world.write("note.md", "# Note\n\nBody.\n")]);

      expect(ran.exitCode).toBe(0);
      expect(ran.stdout.trim()).toMatch(DOC_URL);
      for (const url of world.opened()) expect(url.startsWith(`${world.google.origin}/`)).toBe(true);
      const paths = world.google.requests.map((request) => request.path);
      expect(paths).toContain(CONSENT_PATH);
      expect(paths).toContain("/token");
      expect(paths).toContain("/drive/v3/files");
      expect(paths.some((path) => path.startsWith("/v1/documents/"))).toBe(true);
    });
  });

  test.todo("AC-8 an update sends every request to MD2GD_GOOGLE_ORIGIN", () => {});

  test("AC-8 init refuses an MD2GD_GOOGLE_ORIGIN that is not an http(s) origin and exits at once", async () => {
    await withWorld(async (world) => {
      const started = performance.now();
      const ran = await world.run(["init", "--client", world.writeClientSecret()], { MD2GD_GOOGLE_ORIGIN: "nope" });

      expect(performance.now() - started).toBeLessThan(5000);
      expectFailure(
        ran,
        "md2gd: MD2GD_GOOGLE_ORIGIN must be an http or https origin, got: nope [google_origin_invalid]\nresolve: unset MD2GD_GOOGLE_ORIGIN or set it to an http(s) origin\n",
      );
      expect(world.google.requests).toEqual([]);
    });
  });
});

describe("credential storage and scope", () => {
  test("AC-21 init creates the config directory and credential files readable by the owner only", async () => {
    await withWorld(async (world) => {
      await world.init();

      expect(statSync(world.configDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(world.configDir, "client_secret.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(world.configDir, "token.json")).mode & 0o777).toBe(0o600);
    });
  });

  test("AC-21 the consent request asks for exactly the drive scope", async () => {
    await withWorld(async (world) => {
      await world.init();

      const consent = consents(world.opened());
      expect(consent).toHaveLength(1);
      expect(new URL(consent[0] ?? "").searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive");
    });
  });

  test.failing("AC-21 an access token Google has expired is refreshed without opening a browser", async () => {
    await withWorld(async (world) => {
      await world.init();
      const openedAfterInit = world.opened().length;
      world.google.expireAccessTokens();

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      documentIdOf(ran);
      expect(world.opened()).toHaveLength(openedAfterInit);
      const refreshes = world.google.requests.filter(
        (request) => request.path === "/token" && request.body.includes("grant_type=refresh_token"),
      );
      expect(refreshes.length).toBeGreaterThan(0);
    });
  });

  test("AC-21 after the config directory is deleted a conversion asks for init and init consents afresh", async () => {
    await withWorld(async (world) => {
      await world.init();
      rmSync(world.configDir, { recursive: true, force: true });

      const refused = await world.run([world.write("note.md", "# Note\n")]);
      expectFailure(
        refused,
        `md2gd: not set up: no client secret at ${join(world.configDir, "client_secret.json")} [not_set_up]\nresolve: md2gd init --client <client_secret.json>\n`,
      );

      await world.init();
      expect(consents(world.opened())).toHaveLength(2);
      documentIdOf(await world.run([world.write("note.md", "# Note\n")]));
    });
  });
});

describe("consent callback protection", () => {
  test("AC-22 init rejects a consent callback whose state does not match", async () => {
    await withWorld(async (world) => {
      world.google.consent = "forge-state";

      const ran = await world.run(["init", "--client", world.writeClientSecret()]);

      expectFailure(
        ran,
        "md2gd: the consent callback's state did not match; stopped for safety [consent_state_mismatch]\nresolve: md2gd init\n",
      );
      expect(existsSync(join(world.configDir, "token.json"))).toBe(false);
      expect(world.google.requests.some((request) => request.path === "/token")).toBe(false);
    });
  });

  test("AC-22 init presents a PKCE S256 verifier matching its challenge", async () => {
    await withWorld(async (world) => {
      await world.init();

      const consent = world.google.requests.find((request) => request.path === CONSENT_PATH);
      const exchange = world.google.requests.find((request) => request.path === "/token");
      expect(consent?.query.code_challenge_method).toBe("S256");
      const verifier = new URLSearchParams(exchange?.body ?? "").get("code_verifier") ?? "";
      expect(verifier).not.toBe("");
      const digest = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
      expect(consent?.query.code_challenge).toBe(digest);
    });
  });

  test("AC-22 init exits non-zero without a token when consent is denied", async () => {
    await withWorld(async (world) => {
      world.google.consent = "deny";

      const ran = await world.run(["init", "--client", world.writeClientSecret()]);

      expectFailure(ran, "md2gd: Google consent was denied (access_denied) [consent_denied]\nresolve: md2gd init\n");
      expect(existsSync(join(world.configDir, "token.json"))).toBe(false);
    });
  });

  test.todo("AC-22 init exits non-zero without a token when consent times out — md2gd waits a fixed 5 minutes", () => {});
});
