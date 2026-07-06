/** User-scoped location for md2gd's stored client secret, token, and config. */
export const CONFIG_DIR = `${process.env.HOME ?? "."}/.md2gd`;

export const CLIENT_SECRET_PATH = `${CONFIG_DIR}/client_secret.json`;
export const TOKEN_PATH = `${CONFIG_DIR}/token.json`;
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`;

/**
 * Minimal OAuth scopes: create/write only files this app touches, plus the Docs
 * scope for document editing. Never the broad all-files Drive scope.
 */
export const SCOPES = ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/documents"];

/** Loopback redirect target for the installed-app consent flow. */
export const REDIRECT_HOST = "127.0.0.1";

/** Name of the Drive folder md2gd creates and drops generated docs into. */
export const DEFAULT_FOLDER_NAME = "md2gd";
