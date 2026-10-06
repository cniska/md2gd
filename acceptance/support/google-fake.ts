import { z } from "zod";
import { A4, DocsDocument, InvalidDocsRequest, type PageSetup } from "./docs-document";
import { BatchUpdateBody, type DocsRequest } from "./docs-requests";
import { startDropProxy } from "./drop-proxy";

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DOC_MIME = "application/vnd.google-apps.document";
const ROOT = "root";

export type Role = "owner" | "writer" | "reader";

export type DriveFile = {
  readonly id: string;
  name: string;
  readonly mimeType: string;
  parents: string[];
  trashed: boolean;
  readonly sharedDrive: boolean;
  readonly role: Role | undefined;
};

export type Consent = "grant" | "deny" | "forge-state";

export type Recorded = {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: string;
};

export type FaultResponse = {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
};

type Fault = {
  readonly method: string;
  readonly path: RegExp;
  remaining: number;
  readonly answer: FaultResponse | "drop";
};

type Grant = { readonly redirectUri: string; readonly challenge: string; readonly scope: string };

export const CLIENT = { clientId: "acceptance-client.apps.googleusercontent.com", clientSecret: "acceptance-secret" };

const CreateBody = z.strictObject({
  name: z.string(),
  mimeType: z.enum([FOLDER_MIME, DOC_MIME]),
  parents: z.array(z.string()).length(1).optional(),
});
const PatchBody = z.strictObject({ name: z.string().optional() });

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers });

const driveError = (status: number, reason: string, message: string): Response =>
  json(status, { error: { code: status, message, errors: [{ message, domain: "global", reason }] } });

const docsError = (status: number, statusName: string, message: string): Response =>
  json(status, { error: { code: status, message, status: statusName } });

const notFound = (id: string): Response => driveError(404, "notFound", `File not found: ${id}.`);

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(new Uint8Array(digest)).toString("base64url");
}
export class GoogleFake {
  readonly requests: Recorded[] = [];
  consent: Consent = "grant";
  page: PageSetup = A4;
  private readonly files = new Map<string, DriveFile>();
  private readonly documents = new Map<string, DocsDocument>();
  private readonly grants = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, number>();
  private readonly refreshTokens = new Set<string>();
  private readonly faults: Fault[] = [];
  private counter = 0;
  private server: ReturnType<typeof Bun.serve> | undefined;
  private proxy: { port: number; stop: () => void } | undefined;

  get origin(): string {
    if (!this.proxy) throw new Error("the Google fake is not started");
    return `http://127.0.0.1:${this.proxy.port}`;
  }

  start(): this {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handle(request) });
    this.proxy = startDropProxy(this.server.port ?? 0, (method, path) => this.dropDecision(method, path));
    return this;
  }

  stop(): void {
    this.proxy?.stop();
    this.server?.stop(true);
  }

  fail(method: string, path: RegExp, answer: FaultResponse | "drop", times = 1): void {
    this.faults.push({ method, path, remaining: times, answer });
  }

  expireAccessTokens(): void {
    for (const token of this.accessTokens.keys()) this.accessTokens.set(token, 0);
  }

  revokeRefreshTokens(): void {
    this.refreshTokens.clear();
    this.expireAccessTokens();
  }

  addFolder(options: { name: string; role?: Role; sharedDrive?: boolean }): string {
    return this.addFile({ ...options, mimeType: FOLDER_MIME, parent: ROOT }).id;
  }

  addDocument(options: {
    name: string;
    role?: Role;
    sharedDrive?: boolean;
    parent?: string;
    trashed?: boolean;
    content?: readonly DocsRequest[];
  }): string {
    const file = this.addFile({ ...options, mimeType: DOC_MIME, parent: options.parent ?? ROOT });
    file.trashed = options.trashed ?? false;
    const document = this.documents.get(file.id);
    if (document && options.content && options.content.length > 0) document.apply(options.content);
    return file.id;
  }

  file(id: string): DriveFile {
    const file = this.files.get(id);
    if (!file) throw new Error(`no Drive file ${id}`);
    return file;
  }

  driveFiles(): readonly DriveFile[] {
    return [...this.files.values()];
  }

  document(id: string): unknown {
    const document = this.documents.get(id);
    if (!document) throw new Error(`no document ${id}`);
    return document.resource(this.file(id).name);
  }

  private addFile(options: {
    name: string;
    mimeType: string;
    parent: string;
    role?: Role | undefined;
    sharedDrive?: boolean | undefined;
  }): DriveFile {
    this.counter += 1;
    const id = `${options.mimeType === FOLDER_MIME ? "folder" : "doc"}${this.counter}${"x".repeat(20)}`;
    const file: DriveFile = {
      id,
      name: options.name,
      mimeType: options.mimeType,
      parents: [options.parent],
      trashed: false,
      sharedDrive: options.sharedDrive ?? false,
      role: options.role ?? "owner",
    };
    this.files.set(id, file);
    if (options.mimeType === DOC_MIME) this.documents.set(id, new DocsDocument(id, this.page));
    return file;
  }

  private takeFault(method: string, path: string): Fault | undefined {
    const fault = this.faults.find(
      (f) => f.remaining > 0 && f.answer !== "drop" && f.method === method && f.path.test(path),
    );
    if (fault) fault.remaining -= 1;
    return fault;
  }

  private dropDecision(method: string, path: string): "drop" | "pass" {
    const fault = this.faults.find(
      (f) => f.remaining > 0 && f.answer === "drop" && f.method === method && f.path.test(path),
    );
    if (!fault) return "pass";
    fault.remaining -= 1;
    this.requests.push({ method, path, query: {}, body: "" });
    return "drop";
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "GET" ? "" : await request.text();
    this.requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    });
    const fault = this.takeFault(request.method, url.pathname);
    if (fault && fault.answer !== "drop") return json(fault.answer.status, fault.answer.body, fault.answer.headers);

    if (request.method === "GET" && url.pathname === "/o/oauth2/v2/auth") return this.consentPage(url);
    if (request.method === "POST" && url.pathname === "/token") return this.token(new URLSearchParams(body));

    if (!this.authorized(request))
      return docsError(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");

    const allDrives = url.searchParams.get("supportsAllDrives") === "true";
    const fileId = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)?.[1];
    const documentPath = /^\/v1\/documents\/([^/:]+)(:batchUpdate)?$/.exec(url.pathname);

    if (url.pathname === "/drive/v3/files" && request.method === "GET") return this.listFiles(url);
    if (url.pathname === "/drive/v3/files" && request.method === "POST") return this.createFile(body, allDrives);
    if (fileId && request.method === "GET") return this.getFile(fileId, url, allDrives);
    if (fileId && request.method === "PATCH") return this.patchFile(fileId, url, body, allDrives);
    if (documentPath?.[1] && request.method === "GET" && !documentPath[2]) return this.getDocument(documentPath[1]);
    if (documentPath?.[1] && request.method === "POST" && documentPath[2])
      return this.batchUpdate(documentPath[1], body);
    return new Response("Not Found", { status: 404 });
  }

  private consentPage(url: URL): Response {
    const params = url.searchParams;
    const redirectUri = params.get("redirect_uri") ?? "";
    const state = params.get("state") ?? "";
    const valid =
      params.get("client_id") === CLIENT.clientId &&
      params.get("response_type") === "code" &&
      params.get("code_challenge_method") === "S256" &&
      (params.get("code_challenge") ?? "") !== "" &&
      state !== "" &&
      redirectUri.startsWith("http://127.0.0.1:");
    if (!valid) return new Response("Error 400: invalid_request", { status: 400 });
    const target = new URL(redirectUri);
    if (this.consent === "deny") {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("state", state);
    } else {
      this.counter += 1;
      const code = `code-${this.counter}`;
      this.grants.set(code, {
        redirectUri,
        challenge: params.get("code_challenge") ?? "",
        scope: params.get("scope") ?? "",
      });
      target.searchParams.set("code", code);
      target.searchParams.set("state", this.consent === "forge-state" ? "forged" : state);
    }
    return Response.redirect(target.toString(), 302);
  }

  private async token(form: URLSearchParams): Promise<Response> {
    const invalidGrant = json(400, { error: "invalid_grant", error_description: "Bad Request" });
    if (form.get("client_id") !== CLIENT.clientId || form.get("client_secret") !== CLIENT.clientSecret)
      return json(401, { error: "invalid_client", error_description: "Unauthorized" });
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code") ?? "";
      const grant = this.grants.get(code);
      if (!grant || grant.redirectUri !== form.get("redirect_uri")) return invalidGrant;
      if ((await s256(form.get("code_verifier") ?? "")) !== grant.challenge) return invalidGrant;
      this.grants.delete(code);
      this.counter += 1;
      const refresh = `refresh-${this.counter}`;
      this.refreshTokens.add(refresh);
      return json(200, { ...this.issueAccessToken(), refresh_token: refresh, scope: grant.scope });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (!this.refreshTokens.has(form.get("refresh_token") ?? "")) return invalidGrant;
      return json(200, this.issueAccessToken());
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  private issueAccessToken(): Record<string, unknown> {
    this.counter += 1;
    const token = `access-${this.counter}`;
    this.accessTokens.set(token, Date.now() + 3600_000);
    return { access_token: token, expires_in: 3599, token_type: "Bearer" };
  }

  private authorized(request: Request): boolean {
    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    return (this.accessTokens.get(token) ?? 0) > Date.now();
  }

  private visible(id: string, allDrives: boolean): DriveFile | undefined {
    const file = this.files.get(id);
    if (!file || file.role === undefined) return undefined;
    if (file.sharedDrive && !allDrives) return undefined;
    return file;
  }

  private listFiles(url: URL): Response {
    const query = /^name='([^']*)' and mimeType='([^']*)' and trashed=false$/.exec(url.searchParams.get("q") ?? "");
    if (!query) return driveError(400, "invalid", "Invalid Value");
    const [, name, mimeType] = query;
    const files = [...this.files.values()]
      .filter((file) => file.role !== undefined && !file.sharedDrive && !file.trashed)
      .filter((file) => file.name === name && file.mimeType === mimeType)
      .map((file) => ({ id: file.id }));
    return json(200, { files });
  }

  private writableFolder(id: string, allDrives: boolean): Response | undefined {
    const folder = this.visible(id, allDrives);
    if (!folder) return notFound(id);
    if (folder.role === "reader")
      return driveError(
        403,
        "insufficientFilePermissions",
        "The user does not have sufficient permissions for this file.",
      );
    if (folder.mimeType !== FOLDER_MIME)
      return driveError(400, "invalidParent", "The specified parent is not a folder.");
    return undefined;
  }

  private createFile(body: string, allDrives: boolean): Response {
    const parsed = CreateBody.safeParse(JSON.parse(body || "null"));
    if (!parsed.success) return driveError(400, "badRequest", z.prettifyError(parsed.error));
    const parent = parsed.data.parents?.[0] ?? ROOT;
    if (parent !== ROOT) {
      const refused = this.writableFolder(parent, allDrives);
      if (refused) return refused;
    }
    const file = this.addFile({
      name: parsed.data.name,
      mimeType: parsed.data.mimeType,
      parent,
      sharedDrive: parent === ROOT ? false : this.file(parent).sharedDrive,
    });
    return json(200, { id: file.id });
  }

  private getFile(id: string, url: URL, allDrives: boolean): Response {
    const file = this.visible(id, allDrives);
    if (!file) return notFound(id);
    const all: Record<string, unknown> = {
      kind: "drive#file",
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parents: file.parents,
      trashed: file.trashed,
    };
    const fields = url.searchParams.get("fields");
    if (!fields) return json(200, { kind: all.kind, id: all.id, name: all.name, mimeType: all.mimeType });
    return json(200, Object.fromEntries(fields.split(",").map((field) => [field, all[field]])));
  }

  private patchFile(id: string, url: URL, body: string, allDrives: boolean): Response {
    const file = this.visible(id, allDrives);
    if (!file) return notFound(id);
    const parsed = PatchBody.safeParse(JSON.parse(body || "{}"));
    if (!parsed.success) return driveError(400, "badRequest", z.prettifyError(parsed.error));
    if (file.role === "reader")
      return driveError(
        403,
        "insufficientFilePermissions",
        "The user does not have sufficient permissions for this file.",
      );
    const add = url.searchParams.get("addParents");
    const remove = url.searchParams.get("removeParents");
    if (add) {
      const refused = this.writableFolder(add, allDrives);
      if (refused) return refused;
    }
    if (remove?.split(",").some((parent) => !file.parents.includes(parent)))
      return driveError(400, "badRequest", "Invalid removeParents.");
    const kept = file.parents.filter((parent) => !remove?.split(",").includes(parent));
    file.parents = add ? [...kept, add] : kept;
    if (parsed.data.name !== undefined) file.name = parsed.data.name;
    return json(200, { kind: "drive#file", id: file.id, name: file.name, mimeType: file.mimeType });
  }

  private documentAccess(id: string, write: boolean): DocsDocument | Response {
    const file = this.files.get(id);
    const document = this.documents.get(id);
    if (!file || !document) return docsError(404, "NOT_FOUND", "Requested entity was not found.");
    if (file.role === undefined || (write && file.role === "reader"))
      return docsError(403, "PERMISSION_DENIED", "The caller does not have permission");
    return document;
  }

  private getDocument(id: string): Response {
    const access = this.documentAccess(id, false);
    if (access instanceof Response) return access;
    return json(200, access.resource(this.file(id).name));
  }

  private batchUpdate(id: string, body: string): Response {
    const access = this.documentAccess(id, true);
    if (access instanceof Response) return access;
    const parsed = BatchUpdateBody.safeParse(JSON.parse(body || "null"));
    if (!parsed.success)
      return docsError(400, "INVALID_ARGUMENT", `Invalid JSON payload received. ${z.prettifyError(parsed.error)}`);
    try {
      access.apply(parsed.data.requests);
    } catch (error) {
      if (error instanceof InvalidDocsRequest) return docsError(400, "INVALID_ARGUMENT", error.message);
      throw error;
    }
    return json(200, {
      documentId: id,
      replies: parsed.data.requests.map(() => ({})),
      writeControl: { requiredRevisionId: `rev-${access.revision}` },
    });
  }
}
