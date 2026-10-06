import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLIENT, GoogleFake } from "./google-fake";

export type Ran = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

const REPO = resolve(import.meta.dir, "../..");
const BINARY = process.env.MD2GD_BIN ?? join(REPO, ".acceptance", "md2gd");
const WORLD_DIR = /^md2gd-acceptance-(\d+)-/;
const RUN_TIMEOUT_MS = 30_000;

const OPENER = `#!/bin/sh
printf '%s\\n' "$1" >> "$MD2GD_OPENED_LOG"
case "$1" in
  */o/oauth2/v2/auth*) curl -s -L -o /dev/null "$1" ;;
esac
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function freshRoot(): string {
  const tmp = tmpdir();
  for (const entry of readdirSync(tmp)) {
    const owner = WORLD_DIR.exec(entry)?.[1];
    if (owner !== undefined && !alive(Number(owner))) rmSync(join(tmp, entry), { recursive: true, force: true });
  }
  return mkdtempSync(join(tmp, `md2gd-acceptance-${process.pid}-`));
}
export class World {
  readonly root = freshRoot();
  readonly home = join(this.root, "home");
  readonly work = join(this.root, "work");
  readonly google = new GoogleFake().start();
  private readonly bin = join(this.root, "bin");
  private readonly openedLog = join(this.root, "opened.log");

  constructor() {
    if (!existsSync(BINARY))
      throw new Error(`no md2gd binary at ${BINARY}; build it with bun run test:acceptance or set MD2GD_BIN`);
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.work, { recursive: true });
    mkdirSync(this.bin, { recursive: true });
    for (const name of ["open", "xdg-open"]) {
      writeFileSync(join(this.bin, name), OPENER);
      chmodSync(join(this.bin, name), 0o755);
    }
  }

  get configDir(): string {
    return process.platform === "darwin" ? join(this.home, ".md2gd") : join(this.home, ".config", "md2gd");
  }

  env(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, ".config"),
      PATH: `${this.bin}:/usr/bin:/bin`,
      MD2GD_GOOGLE_ORIGIN: this.google.origin,
      MD2GD_OPENED_LOG: this.openedLog,
      ...overrides,
    };
  }

  write(path: string, content: string): string {
    const full = join(this.work, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  }

  fixture(name: string): string {
    return this.write(name, readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8"));
  }

  opened(): readonly string[] {
    return existsSync(this.openedLog) ? readFileSync(this.openedLog, "utf8").trim().split("\n").filter(Boolean) : [];
  }

  async run(args: readonly string[], env: Record<string, string> = {}): Promise<Ran> {
    const child = Bun.spawn([BINARY, ...args], {
      cwd: this.work,
      env: this.env(env),
      stdout: "pipe",
      stderr: "pipe",
      timeout: RUN_TIMEOUT_MS,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  writeClientSecret(): string {
    return this.write(
      "client_secret.json",
      JSON.stringify({ installed: { client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret } }),
    );
  }

  async init(): Promise<Ran> {
    const ran = await this.run(["init", "--client", this.writeClientSecret()]);
    if (ran.exitCode !== 0) throw new Error(`md2gd init failed:\n${ran.stdout}\n${ran.stderr}`);
    return ran;
  }

  dispose(): void {
    this.google.stop();
    rmSync(this.root, { recursive: true, force: true });
  }
}

const DOC_URL = /^https:\/\/docs\.google\.com\/document\/d\/([\w-]+)\/edit$/;

export function documentIdOf(ran: Ran): string {
  const id = DOC_URL.exec(ran.stdout.trim())?.[1];
  if (ran.exitCode !== 0 || id === undefined)
    throw new Error(`expected one document URL on stdout (exit ${ran.exitCode}):\n${ran.stdout}\n${ran.stderr}`);
  return id;
}
export async function withWorld<T>(body: (world: World) => Promise<T>): Promise<T> {
  const world = new World();
  try {
    return await body(world);
  } finally {
    world.dispose();
  }
}
