import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRefuser, hasCode, isMissingFile, systemReasonOf } from "./coded-error";
import { CLIENT_SECRET_PATH, REDIRECT_HOST } from "./config";
import { buildAuthUrl, type ClientSecret, createPkce, exchangeCode, parseClientSecret, randomToken } from "./oauth";
import { openInBrowser } from "./open";
import { saveToken } from "./tokens";

const CONSENT_TIMEOUT_MINUTES = 5;

const refuse = createRefuser<{
  not_set_up: { path: string };
  client_secret_not_found: { path: string };
  client_secret_unreadable: { path: string; reason: string };
  client_secret_unwritable: { path: string; reason: string };
  consent_denied: { error: string };
  consent_state_mismatch: object;
  consent_timeout: { minutes: number };
}>({
  not_set_up: {
    message: ({ path }) => `not set up: no client secret at ${path}`,
    resolve: () => "md2gd init --client <client_secret.json>",
  },
  client_secret_not_found: {
    message: ({ path }) => `client secret not found: ${path}`,
    resolve: () => "md2gd init --client <client_secret.json>",
  },
  client_secret_unreadable: {
    message: ({ path, reason }) => `cannot read client secret ${path}: ${reason}`,
    resolve: ({ path }) => `make ${path} readable, then run the command again`,
  },
  client_secret_unwritable: {
    message: ({ path, reason }) => `cannot store client secret in ${path}: ${reason}`,
    resolve: ({ path }) =>
      `make ${path} and ${dirname(path)} writable, then run md2gd init --client <client_secret.json>`,
  },
  consent_denied: {
    message: ({ error }) => `Google consent was denied (${error})`,
    resolve: () => "md2gd init",
  },
  consent_state_mismatch: {
    message: () => "the consent callback's state did not match; stopped for safety",
    resolve: () => "md2gd init",
  },
  consent_timeout: {
    message: ({ minutes }) => `timed out after ${minutes} minutes waiting for Google consent`,
    resolve: () => "md2gd init",
  },
});

async function readClientSecret(path: string, missing: "not_set_up" | "client_secret_not_found"): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    if (isMissingFile(error)) throw refuse(missing, { path }, error);
    throw refuse("client_secret_unreadable", { path, reason: systemReasonOf(error) }, error);
  }
}

export async function loadStoredClientSecret(path: string = CLIENT_SECRET_PATH): Promise<ClientSecret> {
  return parseClientSecret(await readClientSecret(path, "not_set_up"), path);
}

export async function storeClientSecret(clientPath: string, path: string = CLIENT_SECRET_PATH): Promise<void> {
  const raw = await readClientSecret(clientPath, "client_secret_not_found");
  parseClientSecret(raw, clientPath);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, raw, { mode: 0o600 });
  } catch (error) {
    throw refuse("client_secret_unwritable", { path, reason: systemReasonOf(error) }, error);
  }
}

export async function runInit(clientPath: string | undefined, log: (message: string) => void): Promise<void> {
  if (clientPath) await storeClientSecret(clientPath);
  const client = await loadStoredClientSecret();

  const state = randomToken(16);
  const { verifier, challenge } = await createPkce();
  const { code, redirectUri } = await captureAuthCode(client, state, challenge, log);
  const token = await exchangeCode(client, code, redirectUri, verifier, Date.now());
  saveToken(token);
  log("Authenticated. Run: md2gd <file.md>");
}

export function captureAuthCode(
  client: ClientSecret,
  state: string,
  challenge: string,
  log: (message: string) => void,
  open: (url: string) => void = openInBrowser,
  timeoutMinutes: number = CONSENT_TIMEOUT_MINUTES,
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
          queueMicrotask(() => finish(() => reject(refuse("consent_denied", { error }))));
          return new Response("md2gd: authorization was denied. You can close this tab.");
        }
        if (!code) return new Response("md2gd: waiting for authorization…");
        if (params.get("state") !== state) {
          queueMicrotask(() => finish(() => reject(refuse("consent_state_mismatch", {}))));
          return new Response("md2gd: state mismatch. You can close this tab.");
        }
        queueMicrotask(() => finish(() => resolve({ code, redirectUri })));
        return new Response("md2gd: authorized. You can close this tab.");
      },
    });

    const redirectUri = `http://${REDIRECT_HOST}:${server.port}`;
    timer = setTimeout(
      () => finish(() => reject(refuse("consent_timeout", { minutes: timeoutMinutes }))),
      timeoutMinutes * 60_000,
    );

    let authUrl: string;
    try {
      authUrl = buildAuthUrl(client.clientId, redirectUri, { state, codeChallenge: challenge });
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    log(`Opening your browser to authorize md2gd. If it doesn't open, visit:\n${authUrl}`);
    try {
      open(authUrl);
    } catch (error) {
      if (!hasCode(error, "browser_unopenable")) finish(() => reject(error));
    }
  });
}
