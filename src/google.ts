import { z } from "zod";
import { createFaulter, createRefuser } from "./coded-error";
import { DEFAULT_FOLDER_NAME } from "./config";
import { type DocRequest, type DocumentResource, DocumentResourceSchema } from "./docs";
import type { DocsClient } from "./executor";
import { googleEndpoint } from "./google-origin";
import {
  type FetchFn,
  fetchWithRetry,
  isResponseError,
  type RequestMeta,
  type ResponseMeta,
  responseErrorOf,
  type Sleep,
  statusOf,
} from "./http";
import { parseJsonAs } from "./json";

const DOCS_API = "https://docs.googleapis.com/v1/documents";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";

const DriveFileSchema = z.looseObject({ id: z.string().min(1) });
const DriveFileListSchema = z.looseObject({ files: z.array(DriveFileSchema).default([]) });
const DriveParentsSchema = z.looseObject({ parents: z.array(z.string()).default([]) });

export interface GoogleClientOptions {
  getToken: () => Promise<string>;
  fetchFn?: FetchFn;
  sleep?: Sleep;
  folderName?: string;
}

export function documentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

function driveUrl(path = "", params: Record<string, string> = {}): string {
  const url = new URL(googleEndpoint(`${DRIVE_API}${path}`));
  url.search = new URLSearchParams({ ...params, supportsAllDrives: "true" }).toString();
  return url.toString();
}

const refuse = createRefuser<{
  document_inaccessible: ResponseMeta & { documentId: string };
  folder_unwritable: ResponseMeta & { folderId: string };
}>({
  document_inaccessible: {
    message: (meta) => `cannot open document ${meta.documentId} (${statusOf(meta)})`,
    resolve: () => "check the doc URL or id and that you can edit it",
  },
  folder_unwritable: {
    message: (meta) => `cannot write to folder ${meta.folderId} (${statusOf(meta)})`,
    resolve: () => "check the folder URL or id and that you can write to it",
  },
});

const fault = createFaulter<{
  google_response_invalid: RequestMeta & { problem: string };
}>({
  google_response_invalid: {
    message: (meta) => `unexpected response from Google for ${meta.method} ${meta.path} (${meta.problem})`,
  },
});

function folderRefusal(error: unknown, folderId: string): unknown {
  const unwritable =
    isResponseError(error, "google_denied") ||
    (isResponseError(error, "google_rejected") && error.meta.reason === "invalidParent");
  if (!unwritable) return error;
  return refuse("folder_unwritable", { ...error.meta, folderId }, error);
}

export class GoogleDocsClient implements DocsClient {
  private readonly getToken: () => Promise<string>;
  private readonly fetchFn: FetchFn;
  private readonly sleep: Sleep | undefined;
  private readonly folderName: string;

  constructor(options: GoogleClientOptions) {
    this.getToken = options.getToken;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep;
    this.folderName = options.folderName ?? DEFAULT_FOLDER_NAME;
  }

  async createDocument(title: string, folderId?: string): Promise<{ documentId: string }> {
    const parent = folderId ?? (await this.ensureFolder());
    try {
      const doc = await this.json(DriveFileSchema, "POST", driveUrl("", { fields: "id" }), {
        name: title,
        mimeType: DOC_MIME,
        parents: [parent],
      });
      return { documentId: doc.id };
    } catch (error) {
      throw folderId ? folderRefusal(error, folderId) : error;
    }
  }

  async batchUpdate(documentId: string, requests: DocRequest[]): Promise<void> {
    await this.json(z.unknown(), "POST", googleEndpoint(`${DOCS_API}/${documentId}:batchUpdate`), { requests });
  }

  async getDocument(documentId: string): Promise<DocumentResource> {
    try {
      return await this.json(DocumentResourceSchema, "GET", googleEndpoint(`${DOCS_API}/${documentId}`));
    } catch (error) {
      if (!isResponseError(error, "google_denied")) throw error;
      throw refuse("document_inaccessible", { ...error.meta, documentId }, error);
    }
  }

  async renameDocument(documentId: string, name: string): Promise<void> {
    await this.json(z.unknown(), "PATCH", driveUrl(`/${documentId}`), { name });
  }

  async moveDocument(documentId: string, folderId: string): Promise<void> {
    const meta = await this.json(DriveParentsSchema, "GET", driveUrl(`/${documentId}`, { fields: "parents" }));
    const remove = meta.parents.join(",");
    const params: Record<string, string> = { addParents: folderId };
    if (remove) params.removeParents = remove;
    try {
      await this.json(z.unknown(), "PATCH", driveUrl(`/${documentId}`, params), {});
    } catch (error) {
      throw folderRefusal(error, folderId);
    }
  }

  private async ensureFolder(): Promise<string> {
    const q = `name='${this.folderName}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    const found = await this.json(
      DriveFileListSchema,
      "GET",
      googleEndpoint(`${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`),
    );
    const existing = found.files[0]?.id;
    if (existing) return existing;

    const created = await this.json(DriveFileSchema, "POST", googleEndpoint(DRIVE_API), {
      name: this.folderName,
      mimeType: FOLDER_MIME,
    });
    return created.id;
  }

  private async json<T>(schema: z.ZodType<T>, method: string, url: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetchWithRetry(this.fetchFn, url, init, this.sleep);
    if (!res.ok) throw await responseErrorOf(res, method, url);
    const parsed = parseJsonAs(schema, await res.text());
    if (!parsed.ok) {
      throw fault(
        "google_response_invalid",
        { method, path: new URL(url).pathname, problem: parsed.problem },
        parsed.cause,
      );
    }
    return parsed.data;
  }
}
