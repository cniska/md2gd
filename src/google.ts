import { DEFAULT_FOLDER_NAME } from "./config";
import type { DocRequest, DocumentResource } from "./docs";
import type { DocsClient } from "./executor";
import type { FetchFn } from "./oauth";

const DOCS_API = "https://docs.googleapis.com/v1/documents";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";

export interface GoogleClientOptions {
  getToken: () => Promise<string>;
  fetchFn?: FetchFn;
  folderName?: string;
}

/** Shareable edit URL for a created document. */
export function documentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

/** Pull Google's human-readable reason out of an error response body. */
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** DocsClient backed by the live Google Docs + Drive REST APIs. */
export class GoogleDocsClient implements DocsClient {
  private readonly getToken: () => Promise<string>;
  private readonly fetchFn: FetchFn;
  private readonly folderName: string;

  constructor(options: GoogleClientOptions) {
    this.getToken = options.getToken;
    this.fetchFn = options.fetchFn ?? fetch;
    this.folderName = options.folderName ?? DEFAULT_FOLDER_NAME;
  }

  async createDocument(title: string, folderId?: string): Promise<{ documentId: string }> {
    // Create the doc directly inside its parent folder via Drive. A Drive file's
    // id is the Docs document id, so this avoids the add-parent-to-rooted-file
    // move (which fails under Drive's single-parent model). The parent is the
    // caller's `--folder` if given, else md2gd's own default folder.
    const parent = folderId ?? (await this.ensureFolder());
    try {
      const doc = (await this.json("POST", `${DRIVE_API}?fields=id`, {
        name: title,
        mimeType: DOC_MIME,
        parents: [parent],
      })) as { id: string };
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
    await this.json("POST", `${DOCS_API}/${documentId}:batchUpdate`, { requests });
  }

  async getDocument(documentId: string): Promise<DocumentResource> {
    return (await this.json("GET", `${DOCS_API}/${documentId}`)) as DocumentResource;
  }

  async renameDocument(documentId: string, name: string): Promise<void> {
    // The Docs document id is its Drive file id, so the title is renamed via Drive.
    await this.json("PATCH", `${DRIVE_API}/${documentId}`, { name });
  }

  async moveDocument(documentId: string, folderId: string): Promise<void> {
    // A Drive file has a single parent, so a move adds the new folder and removes
    // the current one(s). Fetch the current parents first to know what to remove.
    const meta = (await this.json("GET", `${DRIVE_API}/${documentId}?fields=parents`)) as { parents?: string[] };
    const remove = (meta.parents ?? []).join(",");
    const query = `addParents=${encodeURIComponent(folderId)}${remove ? `&removeParents=${encodeURIComponent(remove)}` : ""}`;
    try {
      await this.json("PATCH", `${DRIVE_API}/${documentId}?${query}`, {});
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
    const found = (await this.json("GET", `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`)) as {
      files?: { id: string }[];
    };
    const existing = found.files?.[0]?.id;
    if (existing) return existing;

    const created = (await this.json("POST", DRIVE_API, { name: this.folderName, mimeType: FOLDER_MIME })) as {
      id: string;
    };
    return created.id;
  }

  private async json(method: string, url: string, body?: unknown): Promise<unknown> {
    const token = await this.getToken();
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await this.fetchFn(url, init);
    if (!res.ok) throw new Error(`md2gd: Google API ${method} failed (${res.status}): ${await errorMessage(res)}`);
    return res.json();
  }
}
