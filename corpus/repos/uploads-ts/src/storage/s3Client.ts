import { Readable, Transform, type TransformCallback } from "node:stream";
import { StorageError } from "../domain/errors.js";
import { discardResponse, readResponseText, responseStream } from "../infra/http.js";
import { systemClock, type Clock } from "../infra/clock.js";
import { childElement, childElements, childText, parseXml, type XmlElement } from "../infra/xml.js";
import {
  EMPTY_PAYLOAD_HASH,
  encodeKeyPath,
  encodeRfc3986,
  signRequest,
  UNSIGNED_PAYLOAD,
  type Credentials,
} from "./s3Signer.js";

/**
 * A minimal S3 client over Node's built-in fetch: path-style URLs (`<endpoint>/<bucket>/<key>`),
 * SigV4 headers, XML responses parsed in-repo. It covers the operations the S3 storage driver
 * uses; failures are StorageErrors carrying the S3 error code.
 */
export interface S3ClientOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: Credentials;
  /** Longest wait for a response, and longest pause while sending a request body. */
  readonly requestTimeoutMs: number;
  readonly clock?: Clock;
}

export interface ObjectHead {
  readonly size: number;
  readonly etag: string | null;
  readonly contentType: string | null;
}

export interface ListedObject {
  readonly key: string;
  readonly size: number;
}

export interface ListObjectsResult {
  readonly objects: ListedObject[];
  readonly commonPrefixes: string[];
  readonly nextContinuationToken: string | null;
}

export interface ListObjectsOptions {
  readonly prefix?: string;
  readonly delimiter?: string;
  readonly continuationToken?: string;
  readonly maxKeys?: number;
}

/** Error documents are small; listings of 1000 keys stay well under this. */
const MAX_XML_RESPONSE_BYTES = 8 * 1024 * 1024;

interface SendOptions {
  readonly method: "GET" | "HEAD" | "PUT" | "POST" | "DELETE";
  readonly key?: string;
  readonly query?: Record<string, string | undefined>;
  readonly headers?: Record<string, string>;
  /** A streamed body, sent as UNSIGNED-PAYLOAD with this exact length. */
  readonly stream?: { readonly body: Readable; readonly contentLength: number };
  /** What the request was for, in error messages. */
  readonly operation: string;
}

/** Fails the body stream when no bytes flow for `ms` milliseconds. */
class IdleWatchdog extends Transform {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ms: number,
    private readonly onIdle: () => void,
  ) {
    super();
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(this.onIdle, this.ms);
    this.timer.unref();
  }

  disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  override _transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.arm();
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    this.disarm();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.disarm();
    callback(error);
  }
}

function assertObjectKey(key: string): void {
  const segments = key.split("/");
  if (key.length === 0 || segments.some((s) => s === "" || s === "." || s === "..")) {
    // URL parsing would resolve or drop such segments and address a different object.
    throw new StorageError(`invalid object key ${JSON.stringify(key)}`, { storageCode: "InvalidKey" });
  }
}

export class S3Client {
  private readonly options: S3ClientOptions;
  private readonly clock: Clock;

  constructor(options: S3ClientOptions) {
    this.options = { ...options, endpoint: options.endpoint.replace(/\/+$/, "") };
    this.clock = options.clock ?? systemClock;
  }

  get bucket(): string {
    return this.options.bucket;
  }

  private url(key: string | undefined, query: Record<string, string | undefined> = {}): URL {
    let path = `/${encodeRfc3986(this.options.bucket)}`;
    if (key !== undefined) {
      assertObjectKey(key);
      path += `/${encodeKeyPath(key)}`;
    }
    const search = Object.entries(query)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => (value === "" ? name : `${name}=${encodeRfc3986(value)}`))
      .join("&");
    return new URL(`${this.options.endpoint}${path}${search ? `?${search}` : ""}`);
  }

  /**
   * Send one signed request. Resolves with any response (callers check the status); rejects with
   * a StorageError when no response arrives, or with the body stream's own error when the body
   * failed while being sent.
   */
  private async send(options: SendOptions): Promise<Response> {
    const url = this.url(options.key, options.query);
    const controller = new AbortController();
    const timeoutError = () =>
      new StorageError(`S3 ${options.operation} timed out`, { storageCode: "RequestTimeout" });
    let body: ReadableStream<Uint8Array> | undefined;
    let payloadHash = EMPTY_PAYLOAD_HASH;
    const headers: Record<string, string> = { ...options.headers };
    // Set when the body stream fails: that error, not fetch's wrapper, is what the caller needs.
    const source: { error: Error | null } = { error: null };
    let watchdog: IdleWatchdog | null = null;

    if (options.stream) {
      payloadHash = UNSIGNED_PAYLOAD;
      headers["content-length"] = String(options.stream.contentLength);
      watchdog = new IdleWatchdog(this.options.requestTimeoutMs, () => controller.abort());
      const input = options.stream.body;
      input.once("error", (err) => {
        source.error = err;
        watchdog?.destroy(err);
      });
      input.pipe(watchdog);
      body = Readable.toWeb(watchdog) as ReadableStream<Uint8Array>;
    }

    const signed = signRequest(
      { method: options.method, url, headers, payloadHash },
      this.options.credentials,
      { region: this.options.region, service: "s3" },
      this.clock.now(),
    );
    // fetch derives Host from the URL itself; the signed value is the same.
    delete signed.host;

    // The wait for the response headers is bounded; while a streamed body is being sent, the
    // watchdog bounds each pause instead, and the wait starts once the body is through.
    let responseTimer: NodeJS.Timeout | null = null;
    const startResponseTimer = () => {
      responseTimer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    };
    if (watchdog) watchdog.once("end", startResponseTimer);
    else startResponseTimer();
    try {
      const init: RequestInit & { duplex?: "half" } = {
        method: options.method,
        headers: signed,
        signal: controller.signal,
        redirect: "manual",
      };
      if (body !== undefined) init.body = body;
      if (options.stream) init.duplex = "half";
      const response = await fetch(url, init);
      return response;
    } catch (err) {
      if (source.error !== null) throw source.error;
      if (controller.signal.aborted) throw timeoutError();
      throw new StorageError(`S3 ${options.operation} failed: ${describe(err)}`, {
        storageCode: "RequestFailed",
        cause: err,
      });
    } finally {
      if (responseTimer) clearTimeout(responseTimer);
      watchdog?.disarm();
      if (options.stream) options.stream.body.destroy();
    }
  }

  /** Turn an error response into a StorageError with the S3 code from its XML body. */
  private async failure(response: Response, operation: string, key?: string): Promise<StorageError> {
    let code = response.status === 404 ? "NoSuchKey" : `HTTP${response.status}`;
    let message = `HTTP ${response.status}`;
    try {
      const text = await readResponseText(response, MAX_XML_RESPONSE_BYTES);
      if (text.trim() !== "") {
        const error = parseXml(text);
        code = childText(error, "Code") ?? code;
        message = childText(error, "Message") ?? message;
      }
    } catch {
      // The status alone has to do.
    }
    const subject = key === undefined ? "" : ` ${key}`;
    return new StorageError(`S3 ${operation}${subject} failed: ${code}: ${message}`, {
      storageCode: code,
    });
  }

  async putObject(
    key: string,
    body: Readable,
    options: { contentLength: number; contentType: string },
  ): Promise<{ etag: string | null }> {
    const response = await this.send({
      method: "PUT",
      key,
      operation: "PutObject",
      headers: { "content-type": options.contentType },
      stream: { body, contentLength: options.contentLength },
    });
    if (!response.ok) throw await this.failure(response, "PutObject", key);
    await discardResponse(response);
    return { etag: response.headers.get("etag") };
  }

  /** The object's bytes, streamed. */
  async getObject(key: string): Promise<Readable> {
    const headers = { "accept-encoding": "identity" };
    const response = await this.send({ method: "GET", key, operation: "GetObject", headers });
    if (!response.ok) throw await this.failure(response, "GetObject", key);
    return responseStream(response);
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    const response = await this.send({ method: "HEAD", key, operation: "HeadObject" });
    if (response.status === 404) {
      await discardResponse(response);
      return null;
    }
    if (!response.ok) throw await this.failure(response, "HeadObject", key);
    await discardResponse(response);
    const length = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new StorageError(`S3 HeadObject ${key} returned no usable Content-Length`, {
        storageCode: "InvalidResponse",
      });
    }
    return {
      size: length,
      etag: response.headers.get("etag"),
      contentType: response.headers.get("content-type"),
    };
  }

  /** Delete an object. S3 answers 204 whether or not it existed. */
  async deleteObject(key: string): Promise<void> {
    const response = await this.send({ method: "DELETE", key, operation: "DeleteObject" });
    if (!response.ok && response.status !== 404) {
      throw await this.failure(response, "DeleteObject", key);
    }
    await discardResponse(response);
  }

  async copyObject(sourceKey: string, targetKey: string): Promise<void> {
    assertObjectKey(sourceKey);
    const response = await this.send({
      method: "PUT",
      key: targetKey,
      operation: "CopyObject",
      headers: {
        "x-amz-copy-source": `/${encodeRfc3986(this.options.bucket)}/${encodeKeyPath(sourceKey)}`,
      },
    });
    if (!response.ok) throw await this.failure(response, "CopyObject", sourceKey);
    // CopyObject can answer 200 and still fail: the error is then in the body.
    const document = parseXml(await readResponseText(response, MAX_XML_RESPONSE_BYTES));
    if (document.name === "Error") {
      throw new StorageError(
        `S3 CopyObject ${sourceKey} failed: ${childText(document, "Code") ?? "unknown error"}`,
        { storageCode: childText(document, "Code") ?? "InternalError" },
      );
    }
  }

  /** One page of a ListObjectsV2 listing. */
  async listObjectsV2(options: ListObjectsOptions = {}): Promise<ListObjectsResult> {
    const response = await this.send({
      method: "GET",
      operation: "ListObjectsV2",
      query: {
        "list-type": "2",
        prefix: options.prefix,
        delimiter: options.delimiter,
        "continuation-token": options.continuationToken,
        "max-keys": options.maxKeys === undefined ? undefined : String(options.maxKeys),
      },
      headers: { "accept-encoding": "identity" },
    });
    if (!response.ok) throw await this.failure(response, "ListObjectsV2");
    const document = parseXml(await readResponseText(response, MAX_XML_RESPONSE_BYTES));
    return parseListing(document);
  }

  /** Every object under `prefix`, following continuation tokens. */
  async *listAll(prefix: string, delimiter?: string): AsyncGenerator<ListObjectsResult> {
    let continuationToken: string | undefined;
    do {
      const page = await this.listObjectsV2({
        prefix,
        ...(delimiter === undefined ? {} : { delimiter }),
        ...(continuationToken === undefined ? {} : { continuationToken }),
      });
      yield page;
      continuationToken = page.nextContinuationToken ?? undefined;
    } while (continuationToken !== undefined);
  }
}

function parseListing(document: XmlElement): ListObjectsResult {
  if (document.name !== "ListBucketResult") {
    throw new StorageError(`unexpected ListObjectsV2 response <${document.name}>`, {
      storageCode: "InvalidResponse",
    });
  }
  const objects = childElements(document, "Contents").map((entry) => {
    const key = childText(entry, "Key");
    const size = Number(childText(entry, "Size"));
    if (key === undefined || !Number.isSafeInteger(size)) {
      throw new StorageError("malformed ListObjectsV2 entry", { storageCode: "InvalidResponse" });
    }
    return { key, size };
  });
  const commonPrefixes = childElements(document, "CommonPrefixes")
    .map((entry) => childText(entry, "Prefix"))
    .filter((prefix): prefix is string => prefix !== undefined);
  const truncated = childText(document, "IsTruncated") === "true";
  const token = childElement(document, "NextContinuationToken")?.text ?? null;
  if (truncated && !token) {
    throw new StorageError("truncated ListObjectsV2 response without a continuation token", {
      storageCode: "InvalidResponse",
    });
  }
  return { objects, commonPrefixes, nextContinuationToken: truncated ? token : null };
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
    return `${err.message}${cause}`;
  }
  return String(err);
}
