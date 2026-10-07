import { z } from "zod";
import { type CodedError, createFaulter, createRefuser, hasCode, oneLine } from "./coded-error";
import { parseJsonAs } from "./json";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type Sleep = (ms: number) => Promise<void>;

const SERVER_ERROR_STATUS = new Set([500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const GoogleErrorBodySchema = z.looseObject({
  error: z.union([
    z.string(),
    z.looseObject({
      message: z.string().optional(),
      status: z.string().optional(),
      errors: z.array(z.looseObject({ reason: z.string().optional() })).default([]),
    }),
  ]),
  error_description: z.string().optional(),
});
const ATTEMPTS = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const DETAIL_LENGTH = 300;

const ResponseCodeSchema = z.enum([
  "rate_limited",
  "google_unauthenticated",
  "google_denied",
  "google_unavailable",
  "google_rejected",
]);

export type ResponseCode = z.infer<typeof ResponseCodeSchema>;

export interface ResponseStatus {
  readonly status: number;
  readonly reason: string | null;
}

export interface RequestMeta {
  readonly method: string;
  readonly path: string;
}

export interface ResponseMeta extends RequestMeta, ResponseStatus {
  readonly detail: string;
}

export type ResponseError = CodedError<ResponseCode, ResponseMeta>;

type FaultCode = Extract<ResponseCode, "google_rejected">;

export function statusOf({ status, reason }: ResponseStatus): string {
  return reason ? `${status} ${reason}` : `${status}`;
}

const refuse = createRefuser<
  Record<Exclude<ResponseCode, FaultCode>, ResponseMeta> & { google_unreachable: RequestMeta }
>({
  google_unreachable: {
    message: ({ method, path }) => `cannot reach Google for ${method} ${path}`,
    resolve: () => "check your network connection, then run the command again",
  },
  rate_limited: {
    message: (meta) => `Google rate limit reached for ${meta.method} ${meta.path} (${statusOf(meta)})`,
    resolve: () => "wait a minute, then run the command again",
  },
  google_unauthenticated: {
    message: (meta) => `Google did not accept md2gd's sign-in for ${meta.method} ${meta.path} (${statusOf(meta)})`,
    resolve: () => "md2gd init",
  },
  google_denied: {
    message: (meta) => `Google denied ${meta.method} ${meta.path} (${statusOf(meta)})`,
    resolve: () => "check that your Google account can open and edit the file",
  },
  google_unavailable: {
    message: (meta) => `Google is unavailable for ${meta.method} ${meta.path} (${statusOf(meta)})`,
    resolve: () => "run the command again later",
  },
});

const fault = createFaulter<Record<FaultCode, ResponseMeta>>({
  google_rejected: {
    message: (meta) =>
      `Google rejected ${meta.method} ${meta.path} (${statusOf(meta)})${meta.detail ? `: ${meta.detail}` : ""}`,
  },
});

export function isResponseError(error: unknown, ...codes: ResponseCode[]): error is ResponseError {
  return hasCode(error, ...codes);
}

export async function fetchWithRetry(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  sleep: Sleep = Bun.sleep,
): Promise<Response> {
  const method = init.method?.toUpperCase() ?? "GET";
  const isWrite = method === "POST";
  for (let attempt = 1; ; attempt++) {
    const last = attempt === ATTEMPTS;
    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch (error) {
      if (last || isWrite) throw refuse("google_unreachable", { method, path: new URL(url).pathname }, error);
      await sleep(backoff(attempt));
      continue;
    }
    const retryable = (await isRateLimited(res)) || (!isWrite && SERVER_ERROR_STATUS.has(res.status));
    if (last || !retryable) return res;
    await res.body?.cancel();
    await sleep(retryAfter(res) ?? backoff(attempt));
  }
}

export async function responseErrorOf(res: Response, method: string, url: string): Promise<ResponseError> {
  const body = await googleErrorOf(res);
  const meta: ResponseMeta = {
    method,
    path: new URL(url).pathname,
    status: res.status,
    reason: body.reason,
    detail: body.detail,
  };
  if (rateLimited(res.status, body.reasons)) return refuse("rate_limited", meta);
  if (res.status === 401) return refuse("google_unauthenticated", meta);
  if (res.status === 403 || res.status === 404) return refuse("google_denied", meta);
  if (res.status >= 500) return refuse("google_unavailable", meta);
  return fault("google_rejected", meta);
}

interface GoogleErrorBody {
  reason: string | null;
  reasons: string[];
  detail: string;
}

async function googleErrorOf(res: Response): Promise<GoogleErrorBody> {
  const text = await res.clone().text();
  const parsed = parseJsonAs(GoogleErrorBodySchema, text);
  if (!parsed.ok) return { reason: null, reasons: [], detail: detailOf(text) };
  const { error, error_description } = parsed.data;
  if (typeof error === "string") return { reason: error, reasons: [error], detail: detailOf(error_description ?? "") };
  const reasons = error.errors.flatMap((entry) => (entry.reason === undefined ? [] : [entry.reason]));
  return {
    reason: error.errors[0]?.reason ?? error.status ?? null,
    reasons,
    detail: detailOf(error.message ?? ""),
  };
}

function detailOf(text: string): string {
  return oneLine(text).slice(0, DETAIL_LENGTH);
}

function rateLimited(status: number, reasons: readonly string[]): boolean {
  return status === 429 || (status === 403 && reasons.some((reason) => RATE_LIMIT_REASONS.has(reason)));
}

async function isRateLimited(res: Response): Promise<boolean> {
  return rateLimited(res.status, res.status === 403 ? (await googleErrorOf(res)).reasons : []);
}

function backoff(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

function retryAfter(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
  return ms > 0 ? Math.min(ms, MAX_DELAY_MS) : undefined;
}
