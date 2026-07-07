/** The command that opens a URL in the default browser on this platform. */
function opener(url: string): string[] {
  switch (process.platform) {
    case "darwin":
      return ["open", url];
    case "win32":
      return ["cmd", "/c", "start", "", url];
    default:
      return ["xdg-open", url]; // Linux and other Unixes
  }
}

/** Open a URL in the user's default browser. Best-effort: fire-and-forget. */
export function openInBrowser(url: string): void {
  Bun.spawn(opener(url));
}
