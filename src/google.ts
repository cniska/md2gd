import { z } from "zod";
import { DEFAULT_FOLDER_NAME } from "./config";
import { type DocRequest, type DocumentResource, DocumentResourceSchema } from "./docs";
import type { DocsClient } from "./executor";
import { googleEndpoint } from "./google-origin";
import { type FetchFn, fetchWithRetry, isRateLimited, type Sleep } from "./http";

const DOCS_API = "https://docs.googleapis.com/v1/documents";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";

const DriveFileSchema = z.looseObject({ id: z.string() });
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

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
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
      if (folderId && error instanceof Error && /\((?:403|404)\)/.test(error.message)) {
        throw new Error(
          `md2gd: cannot create in folder ${folderId} — check the folder URL and that you can write to it`,
        );
      }
      throw error;
    }
  }

  async batchUpdate(documentId: string, requests: DocRequest[]): Promise<void> {
    await this.json(z.unknown(), "POST", googleEndpoint(`${DOCS_API}/${documentId}:batchUpdate`), { requests });
  }

  async getDocument(documentId: string): Promise<DocumentResource> {
    return this.json(DocumentResourceSchema, "GET", googleEndpoint(`${DOCS_API}/${documentId}`));
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
      if (error instanceof Error && /\((?:403|404)\)/.test(error.message)) {
        throw new Error(
          `md2gd: cannot move into folder ${folderId} — check the folder URL and that you can write to it`,
        );
      }
      throw error;
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
    if (await isRateLimited(res)) throw new Error("md2gd: Google API rate limit reached — wait a minute and try again");
    if (!res.ok) throw new Error(`md2gd: Google API ${method} failed (${res.status}): ${await errorMessage(res)}`);
    const parsed = schema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join(".") || "body";
      throw new Error(
        `md2gd: unexpected response from Google API ${method} ${new URL(url).pathname} (${where}: ${issue?.message})`,
      );
    }
    return parsed.data;
  }
}
