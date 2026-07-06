/** A parsed command line. Pure data so parsing is unit-tested without I/O. */
export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init"; clientPath?: string }
  | { kind: "convert"; file: string; title?: string; open: boolean }
  | { kind: "error"; message: string };

function takeValue(args: string[], i: number, flag: string): string | { error: string } {
  const value = args[i + 1];
  if (value === undefined || value.startsWith("-")) return { error: `${flag} needs a value` };
  return value;
}

export function parseArgs(argv: string[]): Command {
  const first = argv[0];

  if (argv.length === 0 || first === "help" || first === "--help" || first === "-h") return { kind: "help" };
  if (first === "version" || first === "--version" || first === "-V") return { kind: "version" };

  if (first === "init") {
    let clientPath: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--client") {
        const value = takeValue(argv, i, "--client");
        if (typeof value !== "string") return { kind: "error", message: value.error };
        clientPath = value;
        i++;
      } else {
        return { kind: "error", message: `unknown option: ${argv[i]}` };
      }
    }
    return { kind: "init", clientPath };
  }

  // Otherwise the first argument is the input file, followed by options.
  let title: string | undefined;
  let open = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--open") {
      open = true;
    } else if (arg === "--title") {
      const value = takeValue(argv, i, "--title");
      if (typeof value !== "string") return { kind: "error", message: value.error };
      title = value;
      i++;
    } else {
      return { kind: "error", message: `unknown option: ${arg}` };
    }
  }

  if (first === undefined || first.startsWith("-")) return { kind: "error", message: "expected a markdown file path" };
  return { kind: "convert", file: first, title, open };
}
