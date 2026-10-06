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

export const SCOPES = ["https://www.googleapis.com/auth/drive"];

export const REDIRECT_HOST = "127.0.0.1";

export const DEFAULT_FOLDER_NAME = "md2gd";
