import { createRefuser, isSystemError, systemReasonOf } from "./coded-error";

type Spawn = (command: string[]) => unknown;

const refuse = createRefuser<{ browser_unopenable: { url: string; reason: string } }>({
  browser_unopenable: {
    message: ({ url, reason }) => `cannot open a browser for ${url}: ${reason}`,
    resolve: () => "open the URL printed above yourself",
  },
});

function opener(url: string): string[] {
  switch (process.platform) {
    case "darwin":
      return ["open", url];
    case "win32":
      return ["cmd", "/c", "start", "", url];
    default:
      return ["xdg-open", url];
  }
}

export function openInBrowser(url: string, spawn: Spawn = Bun.spawn): void {
  try {
    spawn(opener(url));
  } catch (error) {
    throw isSystemError(error) ? refuse("browser_unopenable", { url, reason: systemReasonOf(error) }, error) : error;
  }
}
