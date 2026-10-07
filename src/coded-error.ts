import { z } from "zod";
import { NAME } from "./version";

const ErrorKindSchema = z.enum(["refusal", "fault"]);

type ErrorKind = z.infer<typeof ErrorKindSchema>;

export class CodedError<Code extends string = string, Meta extends object = object> extends Error {
  override readonly name = "CodedError";

  constructor(
    readonly code: Code,
    message: string,
    readonly meta: Readonly<Meta>,
    readonly resolve: string,
    readonly kind: ErrorKind,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

export function hasCode<Code extends string>(error: unknown, ...codes: Code[]): error is CodedError<Code> {
  return error instanceof CodedError && codes.some((code) => code === error.code);
}

type RefusalTable<Metas extends Record<string, object>> = {
  readonly [Code in keyof Metas]: {
    readonly message: (meta: Metas[Code]) => string;
    readonly resolve: (meta: Metas[Code]) => string;
  };
};

type FaultTable<Metas extends Record<string, object>> = {
  readonly [Code in keyof Metas]: { readonly message: (meta: Metas[Code]) => string };
};

const BUG = "this is a bug in md2gd; file an issue at https://github.com/cniska/md2gd/issues with the lines above";

const declaredCodes = new Set<string>();

function declareCodes(codes: readonly string[]): void {
  for (const code of codes) {
    if (declaredCodes.has(code)) throw new Error(`error code ${code} is declared by two tables`);
    declaredCodes.add(code);
  }
}

export function createRefuser<Metas extends Record<string, object>>(table: RefusalTable<Metas>) {
  declareCodes(Object.keys(table));
  return <Code extends keyof Metas & string>(
    code: Code,
    meta: Metas[Code],
    cause?: unknown,
  ): CodedError<Code, Metas[Code]> =>
    new CodedError(code, table[code].message(meta), meta, table[code].resolve(meta), "refusal", cause);
}

export function createFaulter<Metas extends Record<string, object>>(table: FaultTable<Metas>) {
  declareCodes(Object.keys(table));
  return <Code extends keyof Metas & string>(
    code: Code,
    meta: Metas[Code],
    cause?: unknown,
  ): CodedError<Code, Metas[Code]> => new CodedError(code, table[code].message(meta), meta, BUG, "fault", cause);
}

const SYSTEM_REASONS: Readonly<Record<string, string>> = {
  EACCES: "permission denied",
  EPERM: "permission denied",
  ENOENT: "no such file or directory",
  EISDIR: "is a directory",
  ENOTDIR: "not a directory",
  EROFS: "read-only file system",
  ENOSPC: "no space left on device",
};

function systemCodeOf(error: unknown): string | null {
  return error instanceof Error && "code" in error ? String(error.code) : null;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function messageOf(error: unknown): string {
  try {
    return oneLine(error instanceof Error ? error.message : String(error));
  } catch {
    return "an error md2gd could not print";
  }
}

export function systemReasonOf(error: unknown): string {
  const code = systemCodeOf(error);
  const known = code === null ? null : (SYSTEM_REASONS[code] ?? null);
  return known ?? messageOf(error);
}

export function isSystemError(error: unknown): boolean {
  const code = systemCodeOf(error);
  return !(error instanceof CodedError) && code !== null && /^E[A-Z0-9]+$/.test(code);
}

export function isMissingFile(error: unknown): boolean {
  return systemCodeOf(error) === "ENOENT";
}

const fault = createFaulter<{ unexpected: { message: string } }>({
  unexpected: { message: ({ message }) => message },
});

function codedOf(error: unknown): CodedError {
  return error instanceof CodedError ? error : fault("unexpected", { message: messageOf(error) }, error);
}

export function reportOf(error: unknown): string {
  const coded = codedOf(error);
  return `${NAME}: ${oneLine(coded.message)} [${coded.code}]\nresolve: ${oneLine(coded.resolve)}\n`;
}
