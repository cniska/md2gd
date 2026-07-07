import { mkdirSync, writeFileSync } from "node:fs";
import { CLIENT_SECRET_PATH, CONFIG_DIR, REDIRECT_HOST } from "./config";
import { buildAuthUrl, type ClientSecret, createPkce, exchangeCode, parseClientSecret, randomToken } from "./oauth";
import { openInBrowser } from "./open";
import { saveToken } from "./tokens";

/** How long to wait for the browser consent before giving up. */
const CONSENT_TIMEOUT_MS = 300_000;

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
  // Write with owner-only perms atomically — no world-readable window.
  writeFileSync(CLIENT_SECRET_PATH, raw, { mode: 0o600 });
}

/**
 * One-time setup: optionally store a downloaded client secret, then run the
 * installed-app consent flow once and cache the resulting token. Interactive
 * (opens a browser, runs a loopback server) so it is verified by running.
 */
export async function runInit(clientPath: string | undefined, log: (message: string) => void): Promise<void> {
  if (clientPath) await storeClientSecret(clientPath);
  const client = await loadStoredClientSecret();

  const state = randomToken(16);
  const { verifier, challenge } = await createPkce();
  const { code, redirectUri } = await captureAuthCode(client, state, challenge, log);
  const token = await exchangeCode(client, code, redirectUri, verifier, Date.now());
  await saveToken(token);
  log("Authenticated. Run: md2gd <file.md>");
}

function captureAuthCode(
  client: ClientSecret,
  state: string,
  challenge: string,
  log: (message: string) => void,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.stop();
      action();
    };

    const server = Bun.serve({
      hostname: REDIRECT_HOST,
      port: 0,
      fetch(req) {
        const params = new URL(req.url).searchParams;
        const error = params.get("error");
        const code = params.get("code");

        if (error) {
          queueMicrotask(() => finish(() => reject(new Error(`md2gd: authorization denied (${error})`))));
          return new Response("md2gd: authorization was denied. You can close this tab.");
        }
        if (!code) return new Response("md2gd: waiting for authorization…");
        if (params.get("state") !== state) {
          queueMicrotask(() => finish(() => reject(new Error("md2gd: state mismatch; aborting for safety"))));
          return new Response("md2gd: state mismatch. You can close this tab.");
        }
        queueMicrotask(() => finish(() => resolve({ code, redirectUri })));
        return new Response("md2gd: authorized. You can close this tab.");
      },
    });

    const redirectUri = `http://${REDIRECT_HOST}:${server.port}`;
    timer = setTimeout(
      () => finish(() => reject(new Error("md2gd: timed out waiting for authorization (5 min)"))),
      CONSENT_TIMEOUT_MS,
    );

    const authUrl = buildAuthUrl(client.clientId, redirectUri, { state, codeChallenge: challenge });
    log(`Opening your browser to authorize md2gd. If it doesn't open, visit:\n${authUrl}`);
    openInBrowser(authUrl);
  });
}
