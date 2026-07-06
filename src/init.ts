import { chmodSync, mkdirSync } from "node:fs";
import { CLIENT_SECRET_PATH, CONFIG_DIR, REDIRECT_HOST } from "./config";
import { buildAuthUrl, type ClientSecret, exchangeCode, parseClientSecret } from "./oauth";
import { saveToken } from "./tokens";

/** Load the stored OAuth client secret, guiding the user to `init` if absent. */
export async function loadStoredClientSecret(): Promise<ClientSecret> {
  const file = Bun.file(CLIENT_SECRET_PATH);
  if (!(await file.exists())) {
    throw new Error("md2gd: not set up; run `md2gd init --client <client_secret.json>`");
  }
  return parseClientSecret(await file.text());
}

async function storeClientSecret(clientPath: string): Promise<void> {
  const raw = await Bun.file(clientPath).text();
  parseClientSecret(raw); // validate before persisting
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await Bun.write(CLIENT_SECRET_PATH, raw);
  chmodSync(CLIENT_SECRET_PATH, 0o600);
}

/**
 * One-time setup: optionally store a downloaded client secret, then run the
 * installed-app consent flow once and cache the resulting token. Interactive
 * (opens a browser, runs a loopback server) so it is verified by running, not
 * by unit tests.
 */
export async function runInit(clientPath: string | undefined, log: (message: string) => void): Promise<void> {
  if (clientPath) await storeClientSecret(clientPath);
  const client = await loadStoredClientSecret();

  const { code, redirectUri } = await captureAuthCode(client, log);
  const token = await exchangeCode(client, code, redirectUri, Date.now());
  await saveToken(token);
  log("Authenticated. Run: md2gd <file.md>");
}

function captureAuthCode(
  client: ClientSecret,
  log: (message: string) => void,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = Bun.serve({
      hostname: REDIRECT_HOST,
      port: 0,
      fetch(req) {
        const code = new URL(req.url).searchParams.get("code");
        if (!code) return new Response("md2gd: waiting for authorization…");
        queueMicrotask(() => {
          server.stop();
          resolve({ code, redirectUri });
        });
        return new Response("md2gd: authorized. You can close this tab.");
      },
    });

    const redirectUri = `http://${REDIRECT_HOST}:${server.port}`;
    const authUrl = buildAuthUrl(client.clientId, redirectUri);
    log(`Opening your browser to authorize md2gd. If it doesn't open, visit:\n${authUrl}`);
    try {
      Bun.spawn(["open", authUrl]);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
