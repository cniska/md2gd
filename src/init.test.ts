import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { captureAuthCode, loadStoredClientSecret, storeClientSecret } from "./init";
import { openInBrowser } from "./open";

const SECRET = JSON.stringify({ installed: { client_id: "cid", client_secret: "cs" } });

function scratch(tag: string): string {
  const dir = `${tmpdir()}/md2gd-init-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("loadStoredClientSecret", () => {
  test("reads the stored client secret", async () => {
    const path = `${scratch("stored")}/client_secret.json`;
    writeFileSync(path, SECRET);
    expect(await loadStoredClientSecret(path)).toEqual({ clientId: "cid", clientSecret: "cs" });
  });

  test("refuses a run before setup", async () => {
    const path = `${scratch("unset")}/client_secret.json`;
    await expect(loadStoredClientSecret(path)).rejects.toThrow(
      expect.objectContaining({ code: "not_set_up", kind: "refusal", meta: { path } }),
    );
  });

  test("refuses a stored secret it may not read", async () => {
    const path = `${scratch("locked")}/client_secret.json`;
    writeFileSync(path, SECRET);
    chmodSync(path, 0o000);
    await expect(loadStoredClientSecret(path)).rejects.toThrow(
      expect.objectContaining({ code: "client_secret_unreadable", meta: { path, reason: "permission denied" } }),
    );
  });

  test("refuses a stored secret path that is a directory as unreadable, not as missing setup", async () => {
    const path = `${scratch("dir")}/client_secret.json`;
    mkdirSync(path);
    await expect(loadStoredClientSecret(path)).rejects.toThrow(
      expect.objectContaining({ code: "client_secret_unreadable", meta: { path, reason: "is a directory" } }),
    );
  });
});

describe("storeClientSecret", () => {
  test("copies the given secret into the config directory", async () => {
    const dir = scratch("copy");
    const source = `${dir}/downloaded.json`;
    writeFileSync(source, SECRET);
    const target = `${dir}/config/client_secret.json`;
    await storeClientSecret(source, target);
    expect(readFileSync(target, "utf8")).toBe(SECRET);
  });

  test("refuses a secret file that does not exist", async () => {
    const dir = scratch("missing");
    const source = `${dir}/absent.json`;
    await expect(storeClientSecret(source, `${dir}/config/client_secret.json`)).rejects.toThrow(
      expect.objectContaining({ code: "client_secret_not_found", meta: { path: source } }),
    );
  });

  test("refuses a secret file that is not an installed-app secret, storing nothing", async () => {
    const dir = scratch("invalid");
    const source = `${dir}/web.json`;
    writeFileSync(source, JSON.stringify({ web: {} }));
    const target = `${dir}/config/client_secret.json`;
    await expect(storeClientSecret(source, target)).rejects.toThrow(
      expect.objectContaining({ code: "client_secret_invalid", meta: expect.objectContaining({ path: source }) }),
    );
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test("refuses a config directory it may not write", async () => {
    const dir = scratch("readonly");
    const source = `${dir}/downloaded.json`;
    writeFileSync(source, SECRET);
    mkdirSync(`${dir}/config`, { mode: 0o500 });
    const target = `${dir}/config/client_secret.json`;
    await expect(storeClientSecret(source, target)).rejects.toThrow(
      expect.objectContaining({
        code: "client_secret_unwritable",
        meta: { path: target, reason: "permission denied" },
      }),
    );
  });
});

describe("captureAuthCode", () => {
  const client = { clientId: "cid", clientSecret: "cs" };

  const missingOpener = (url: string) =>
    openInBrowser(url, () => {
      throw Object.assign(new Error("Executable not found"), { code: "ENOENT" });
    });

  test("keeps waiting for consent when no browser can be launched, until the consent times out", async () => {
    const flow = captureAuthCode(client, "st8", "chal", () => {}, missingOpener, 0.001);
    await expect(flow).rejects.toThrow(
      expect.objectContaining({ code: "consent_timeout", kind: "refusal", meta: { minutes: 0.001 } }),
    );
  });

  test("ends the flow at once on any other failure to launch", async () => {
    const flow = captureAuthCode(
      client,
      "st8",
      "chal",
      () => {},
      () => {
        throw Object.assign(new TypeError("bad argument"), { code: "ERR_INVALID_ARG_TYPE" });
      },
    );
    await expect(flow).rejects.toThrow(TypeError);
  });
});
