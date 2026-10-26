import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/**
 * A typed client for the uploads API, used by `scripts/uploadctl.ts` and usable from other
 * services. Every call checks the exact status the API documents for success and throws an
 * ApiError for anything else, so a changed or unexpected answer is never taken for success.
 */

export interface FileInfo {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly declaredType: string | null;
  readonly originalName: string;
  readonly status: "pending_scan" | "available" | "quarantined";
  readonly image: { readonly width: number; readonly height: number } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FilePage {
  readonly data: FileInfo[];
  readonly nextCursor: string | null;
}

export interface UploadSessionInfo {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly offset: number;
  readonly state: string;
  readonly declaredType: string | null;
  readonly overwrite: boolean;
  readonly fileId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface TenantUsage {
  readonly id: string;
  readonly name: string;
  readonly quotaBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly createdAt: string;
}

export interface SignedUrlInfo {
  /** Path and query; resolve it against the API's base URL. */
  readonly url: string;
  readonly expiresAt: string;
}

export interface StoredFile {
  readonly file: FileInfo;
  /** true for 201 (a new file), false for 200 (an existing file was replaced). */
  readonly created: boolean;
}

export interface DownloadedFile {
  readonly body: Readable;
  readonly contentType: string | null;
  readonly size: number | null;
  readonly etag: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  /** The Upload-Offset header of the response, when it had one. */
  readonly uploadOffset: number | null;

  constructor(status: number, code: string, message: string, details: unknown, uploadOffset: number | null) {
    super(`HTTP ${status} ${code}: ${message}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.uploadOffset = uploadOffset;
  }
}

export interface UploadsClientOptions {
  /** Where the API is served, e.g. `https://files.example.test`. */
  readonly baseUrl: string;
  /** An API key, `up_<prefix>_<secret>`. */
  readonly token: string;
  readonly fetch?: typeof fetch;
}

export interface ResumableUploadOptions {
  /** Bytes per PATCH request. */
  readonly chunkSize?: number;
  readonly contentType?: string;
  readonly overwrite?: boolean;
  /** Continue this session instead of creating one. */
  readonly sessionId?: string;
  readonly onProgress?: (uploaded: number, total: number) => void;
}

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
/** How often in a row a chunk is resent after the server reported another offset. */
const MAX_OFFSET_RESYNCS = 3;

/** A file path as a URL path: each segment percent-encoded, the slashes kept. */
export function encodeFilePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function parseOffset(response: Response): number | null {
  const header = response.headers.get("upload-offset");
  if (header === null || !/^\d{1,16}$/.test(header)) return null;
  return Number(header);
}

export class UploadsClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: UploadsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: RequestInit["body"]; streamed?: boolean } = {},
  ): Promise<Response> {
    const request: RequestInit & { duplex?: "half" } = {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...init.headers },
      redirect: "error",
    };
    if (init.body !== undefined) request.body = init.body;
    if (init.streamed) request.duplex = "half";
    return this.fetchImpl(`${this.baseUrl}${path}`, request);
  }

  private async json(method: string, path: string, body?: unknown): Promise<Response> {
    return this.request(
      method,
      path,
      body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
  }

  /** Throw an ApiError unless the response has one of the `expected` statuses. */
  private async expect(response: Response, ...expected: number[]): Promise<Response> {
    if (expected.includes(response.status)) return response;
    let code = "unexpected_status";
    let message = `expected HTTP ${expected.join(" or ")}`;
    let details: unknown;
    const text = await response.text().catch(() => "");
    try {
      const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown; details?: unknown } };
      if (parsed.error && typeof parsed.error.code === "string") {
        code = parsed.error.code;
        message = typeof parsed.error.message === "string" ? parsed.error.message : message;
        details = parsed.error.details;
      }
    } catch {
      // Not an API error document; keep the generic description.
    }
    throw new ApiError(response.status, code, message, details, parseOffset(response));
  }

  /** Upload a whole file in one request. `size` is required for a stream body. */
  async putFile(
    path: string,
    body: Uint8Array | Readable,
    options: { size?: number; contentType?: string; overwrite?: boolean } = {},
  ): Promise<StoredFile> {
    const headers: Record<string, string> = {
      "content-type": options.contentType ?? "application/octet-stream",
    };
    const query = options.overwrite ? "?overwrite=true" : "";
    let response: Response;
    if (body instanceof Readable) {
      if (options.size === undefined) throw new Error("putFile needs the size of a stream body");
      headers["content-length"] = String(options.size);
      response = await this.request("PUT", `/v1/files/${encodeFilePath(path)}${query}`, {
        headers,
        body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
        streamed: true,
      });
    } else {
      response = await this.request("PUT", `/v1/files/${encodeFilePath(path)}${query}`, {
        headers,
        body: new Uint8Array(body),
      });
    }
    await this.expect(response, ...(options.overwrite ? [201, 200] : [201]));
    return { file: (await response.json()) as FileInfo, created: response.status === 201 };
  }

  private async download(path: string): Promise<DownloadedFile> {
    const response = await this.expect(await this.request("GET", path), 200);
    const length = response.headers.get("content-length");
    return {
      body: response.body
        ? Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
        : Readable.from([]),
      contentType: response.headers.get("content-type"),
      size: length === null ? null : Number(length),
      etag: response.headers.get("etag"),
    };
  }

  getFile(path: string): Promise<DownloadedFile> {
    return this.download(`/v1/files/${encodeFilePath(path)}`);
  }

  getFileById(id: string): Promise<DownloadedFile> {
    return this.download(`/v1/files/by-id/${encodeURIComponent(id)}`);
  }

  async getMeta(id: string): Promise<FileInfo> {
    const response = await this.expect(
      await this.json("GET", `/v1/files/by-id/${encodeURIComponent(id)}/meta`),
      200,
    );
    return (await response.json()) as FileInfo;
  }

  async list(options: { after?: string; limit?: number } = {}): Promise<FilePage> {
    const query = new URLSearchParams();
    if (options.after !== undefined) query.set("after", options.after);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await this.expect(await this.json("GET", `/v1/files${suffix}`), 200);
    return (await response.json()) as FilePage;
  }

  /** Every file, page after page. */
  async *listAll(limit?: number): AsyncGenerator<FileInfo> {
    let after: string | undefined;
    do {
      const page = await this.list({
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
      });
      yield* page.data;
      after = page.nextCursor ?? undefined;
    } while (after !== undefined);
  }

  async deleteFile(path: string): Promise<void> {
    await this.expect(await this.request("DELETE", `/v1/files/${encodeFilePath(path)}`), 204);
  }

  async createSignedUrl(id: string, expiresIn: number): Promise<SignedUrlInfo> {
    const response = await this.expect(
      await this.json("POST", `/v1/files/by-id/${encodeURIComponent(id)}/signed-url`, { expiresIn }),
      200,
    );
    return (await response.json()) as SignedUrlInfo;
  }

  async getTenant(): Promise<TenantUsage> {
    const response = await this.expect(await this.json("GET", "/v1/tenant"), 200);
    return (await response.json()) as TenantUsage;
  }

  async createUpload(input: {
    path: string;
    size: number;
    contentType?: string;
    overwrite?: boolean;
  }): Promise<UploadSessionInfo> {
    const query = input.overwrite ? "?overwrite=true" : "";
    const body: Record<string, unknown> = { path: input.path, size: input.size };
    if (input.contentType !== undefined) body.contentType = input.contentType;
    const response = await this.expect(await this.json("POST", `/v1/uploads${query}`, body), 201);
    return (await response.json()) as UploadSessionInfo;
  }

  /** The session's current offset and total size. */
  async getUploadOffset(id: string): Promise<{ offset: number; size: number }> {
    const response = await this.expect(
      await this.request("HEAD", `/v1/uploads/${encodeURIComponent(id)}`),
      200,
    );
    const offset = parseOffset(response);
    const size = Number(response.headers.get("upload-length"));
    if (offset === null || !Number.isSafeInteger(size)) {
      throw new ApiError(response.status, "invalid_response", "missing Upload-Offset or Upload-Length", undefined, null);
    }
    return { offset, size };
  }

  /** Send one chunk starting at `offset`; returns the new offset. */
  async uploadChunk(id: string, offset: number, chunk: Uint8Array): Promise<number> {
    const response = await this.expect(
      await this.request("PATCH", `/v1/uploads/${encodeURIComponent(id)}`, {
        headers: {
          "content-type": "application/offset+octet-stream",
          "upload-offset": String(offset),
        },
        body: new Uint8Array(chunk),
      }),
      204,
    );
    const next = parseOffset(response);
    if (next === null) {
      throw new ApiError(response.status, "invalid_response", "missing Upload-Offset", undefined, null);
    }
    return next;
  }

  async completeUpload(id: string): Promise<StoredFile> {
    const response = await this.expect(
      await this.request("POST", `/v1/uploads/${encodeURIComponent(id)}/complete`),
      201,
      200,
    );
    return { file: (await response.json()) as FileInfo, created: response.status === 201 };
  }

  async abortUpload(id: string): Promise<void> {
    await this.expect(await this.request("DELETE", `/v1/uploads/${encodeURIComponent(id)}`), 204);
  }

  /**
   * Upload a local file through a resumable session, chunk by chunk, then complete it. When the
   * server reports another offset (a chunk that arrived although its answer was lost), the upload
   * continues from the server's offset.
   */
  async uploadFileResumable(
    localPath: string,
    remotePath: string,
    options: ResumableUploadOptions = {},
  ): Promise<StoredFile> {
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("chunkSize must be a positive integer");
    const handle = await open(localPath, "r");
    try {
      const { size } = await handle.stat();
      let sessionId = options.sessionId;
      let offset = 0;
      if (sessionId === undefined) {
        const session = await this.createUpload({
          path: remotePath,
          size,
          ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
          ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
        });
        sessionId = session.id;
      } else {
        const progress = await this.getUploadOffset(sessionId);
        if (progress.size !== size) {
          throw new Error(`session ${sessionId} expects ${progress.size} bytes, the file has ${size}`);
        }
        offset = progress.offset;
      }
      const buffer = Buffer.alloc(Math.min(chunkSize, Math.max(size, 1)));
      let resyncs = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (bytesRead === 0) throw new Error(`${localPath} shrank while it was being uploaded`);
        try {
          offset = await this.uploadChunk(sessionId, offset, buffer.subarray(0, bytesRead));
          resyncs = 0;
        } catch (err) {
          if (
            err instanceof ApiError &&
            err.code === "offset_mismatch" &&
            err.uploadOffset !== null &&
            resyncs < MAX_OFFSET_RESYNCS
          ) {
            offset = err.uploadOffset;
            resyncs++;
            continue;
          }
          throw err;
        }
        options.onProgress?.(offset, size);
      }
      return await this.completeUpload(sessionId);
    } finally {
      await handle.close();
    }
  }
}
