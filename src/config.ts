/**
 * User-scoped location for md2gd's stored client secret, token, and config.
 * macOS keeps the established `~/.md2gd`; elsewhere (Linux) follows the XDG Base
 * Directory spec: `$XDG_CONFIG_HOME/md2gd`, or `~/.config/md2gd` when unset.
 */
function resolveConfigDir(): string {
  const home = process.env.HOME ?? ".";
  if (process.platform === "darwin") return `${home}/.md2gd`;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg?.startsWith("/") ? xdg : `${home}/.config`;
  return `${base}/md2gd`;
}

export const CONFIG_DIR = resolveConfigDir();

export const CLIENT_SECRET_PATH = `${CONFIG_DIR}/client_secret.json`;
export const TOKEN_PATH = `${CONFIG_DIR}/token.json`;
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`;

/**
 * OAuth scope: `drive` (full Drive access, which also authorises the Docs API's
 * create/batchUpdate). Required so the tool can place docs in folders the user
 * did not create (`--folder`) and update docs it did not itself create — the
 * narrower `drive.file` cannot reach either. See AU-3.
 */
export const SCOPES = ["https://www.googleapis.com/auth/drive"];

/** Loopback redirect target for the installed-app consent flow. */
export const REDIRECT_HOST = "127.0.0.1";

/** Name of the Drive folder md2gd creates and drops generated docs into. */
export const DEFAULT_FOLDER_NAME = "md2gd";
