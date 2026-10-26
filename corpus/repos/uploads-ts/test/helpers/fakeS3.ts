import { createHash, randomUUID } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { S3Client } from "../../src/storage/s3Client.js";
import {
  ALGORITHM,
  canonicalQueryString,
  sha256Hex,
  signature,
  signRequest,
  UNSIGNED_PAYLOAD,
  type Credentials,
} from "../../src/storage/s3Signer.js";
import { childElements, childText, escapeXml, parseXml } from "../../src/infra/xml.js";
import { systemClock, type Clock } from "../../src/infra/clock.js";

/**
 * An in-process S3 server for tests: path-style requests on 127.0.0.1, every request's SigV4
 * signature verified against the test credentials, objects and multipart uploads kept in memory
 * and open to inspection. It implements the operations the S3 driver uses and the multipart ones:
 *
 *   PutObject, GetObject (with Range), HeadObject, DeleteObject, CopyObject, ListObjectsV2,
 *   CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload,
 *   ListMultipartUploads
 */
export const TEST_CREDENTIALS: Credentials = {
  accessKeyId: "AKIDTESTUPLOADS0001",
  secretAccessKey: "test-secret-access-key-for-the-fake-s3",
};
export const TEST_REGION = "test-region-1";
export const TEST_BUCKET = "uploads-test";

export interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string;
  readonly etag: string;
  readonly lastModified: Date;
}

export interface PendingUpload {
  readonly key: string;
  readonly initiated: Date;
  readonly parts: Map<number, { body: Buffer; etag: string }>;
}

export interface RecordedRequest {
  readonly operation: string;
  readonly method: string;
  readonly key: string | null;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: IncomingHttpHeaders;
  readonly bodyLength: number;
}

export interface InjectedFailure {
  readonly status: number;
  readonly code: string;
  readonly message?: string;
}

class S3Failure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly key?: string,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function md5Etag(body: Buffer): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

function xml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

function parseQuery(raw: string): Record<string, string> {
  const query: Record<string, string> = {};
  for (const pair of raw.split("&")) {
    if (pair === "") continue;
    const equals = pair.indexOf("=");
    const name = decodeURIComponent(equals < 0 ? pair : pair.slice(0, equals));
    query[name] = equals < 0 ? "" : decodeURIComponent(pair.slice(equals + 1));
  }
  return query;
}

export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly uploads = new Map<string, PendingUpload>();
  readonly requests: RecordedRequest[] = [];
  /** Parts smaller than this (other than the last) fail CompleteMultipartUpload, like S3's 5 MiB. */
  minPartSize = 5 * 1024 * 1024;
  private readonly failures: { operation: string; failure: InjectedFailure; remaining: number }[] = [];

  private constructor(
    private readonly server: http.Server,
    readonly endpoint: string,
    readonly bucket: string,
    readonly credentials: Credentials,
    readonly region: string,
  ) {}

  static async start(
    options: { bucket?: string; credentials?: Credentials; region?: string } = {},
  ): Promise<FakeS3> {
    let fake: FakeS3 | null = null;
    const server = http.createServer((req, res) => {
      void fake?.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    fake = new FakeS3(
      server,
      `http://127.0.0.1:${port}`,
      options.bucket ?? TEST_BUCKET,
      options.credentials ?? TEST_CREDENTIALS,
      options.region ?? TEST_REGION,
    );
    return fake;
  }

  /** An S3Client for this server (or with other credentials, to test refusals). */
  client(options: { credentials?: Credentials; clock?: Clock; requestTimeoutMs?: number } = {}): S3Client {
    return new S3Client({
      endpoint: this.endpoint,
      region: this.region,
      bucket: this.bucket,
      credentials: options.credentials ?? this.credentials,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      clock: options.clock ?? systemClock,
    });
  }

  /** Make the next `times` requests of `operation` fail with `failure` (after authentication). */
  failNext(operation: string, failure: InjectedFailure, times = 1): void {
    this.failures.push({ operation, failure, remaining: times });
  }

  operations(): string[] {
    return this.requests.map((request) => request.operation);
  }

  putObject(key: string, body: Buffer, contentType = "application/octet-stream"): void {
    this.objects.set(key, { body, contentType, etag: md5Etag(body), lastModified: new Date() });
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  /**
   * A signed request straight to the server, for operations the application's client does not
   * implement (the multipart API).
   */
  async signedFetch(
    method: string,
    key: string | null,
    options: { query?: string; body?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const path = key === null ? `/${this.bucket}` : `/${this.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const url = new URL(`${this.endpoint}${path}${options.query ? `?${options.query}` : ""}`);
    const body = options.body;
    const headers = signRequest(
      {
        method,
        url,
        headers: {
          ...options.headers,
          ...(body ? { "content-length": String(body.length) } : {}),
        },
        payloadHash: sha256Hex(body ?? ""),
      },
      this.credentials,
      { region: this.region, service: "s3" },
      new Date(),
    );
    delete headers.host;
    const init: RequestInit = { method, headers };
    if (body) init.body = new Uint8Array(body);
    return fetch(url, init);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let operation = "Unknown";
    let key: string | null = null;
    try {
      const rawUrl = req.url ?? "/";
      const queryStart = rawUrl.indexOf("?");
      const rawPath = queryStart < 0 ? rawUrl : rawUrl.slice(0, queryStart);
      const rawQuery = queryStart < 0 ? "" : rawUrl.slice(queryStart + 1);
      const query = parseQuery(rawQuery);
      const segments = rawPath.split("/").slice(1).map(decodeURIComponent);
      const bucket = segments[0] ?? "";
      key = segments.length > 1 ? segments.slice(1).join("/") : null;
      const body = await this.readBody(req);
      operation = this.operationOf(req.method ?? "GET", key, query, req.headers);
      this.requests.push({
        operation,
        method: req.method ?? "GET",
        key,
        query,
        headers: req.headers,
        bodyLength: body.length,
      });
      this.verifySignature(req, rawPath, rawQuery, body);
      if (bucket !== this.bucket) {
        throw new S3Failure(404, "NoSuchBucket", `the bucket ${bucket} does not exist`);
      }
      this.injectedFailure(operation);
      await this.dispatch(operation, key, query, req, res, body);
    } catch (err) {
      const failure =
        err instanceof S3Failure ? err : new S3Failure(500, "InternalError", (err as Error).message);
      const document =
        req.method === "HEAD"
          ? ""
          : xml(
              `<Error><Code>${failure.code}</Code><Message>${escapeXml(failure.message)}</Message>` +
                `${key ? `<Key>${escapeXml(key)}</Key>` : ""}<RequestId>${randomUUID()}</RequestId></Error>`,
            );
      res.writeHead(failure.status, { "content-type": "application/xml" });
      res.end(document);
    }
  }

  private async readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += (chunk as Buffer).length;
      if (length > MAX_BODY_BYTES) throw new S3Failure(400, "EntityTooLarge", "body too large");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private operationOf(
    method: string,
    key: string | null,
    query: Record<string, string>,
    headers: IncomingHttpHeaders,
  ): string {
    if (key === null) {
      if (method === "GET" && query["list-type"] === "2") return "ListObjectsV2";
      if (method === "GET" && "uploads" in query) return "ListMultipartUploads";
      return "Unsupported";
    }
    switch (method) {
      case "PUT":
        if ("partNumber" in query && "uploadId" in query) return "UploadPart";
        return headers["x-amz-copy-source"] ? "CopyObject" : "PutObject";
      case "GET":
        return "GetObject";
      case "HEAD":
        return "HeadObject";
      case "DELETE":
        return "uploadId" in query ? "AbortMultipartUpload" : "DeleteObject";
      case "POST":
        if ("uploads" in query) return "CreateMultipartUpload";
        if ("uploadId" in query) return "CompleteMultipartUpload";
        return "Unsupported";
      default:
        return "Unsupported";
    }
  }

  private verifySignature(req: IncomingMessage, rawPath: string, rawQuery: string, body: Buffer): void {
    const authorization = req.headers.authorization;
    if (!authorization) throw new S3Failure(403, "AccessDenied", "the request is not signed");
    const match =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/.exec(
        authorization,
      );
    if (!match) throw new S3Failure(400, "AuthorizationHeaderMalformed", "malformed Authorization header");
    const [, accessKeyId, day, region, signedHeaderList = "", presented] = match;
    if (accessKeyId !== this.credentials.accessKeyId) {
      throw new S3Failure(403, "InvalidAccessKeyId", "unknown access key");
    }
    if (region !== this.region) {
      throw new S3Failure(400, "AuthorizationHeaderMalformed", `wrong region ${region}`);
    }
    const amzDate = req.headers["x-amz-date"];
    if (typeof amzDate !== "string" || !/^\d{8}T\d{6}Z$/.test(amzDate) || amzDate.slice(0, 8) !== day) {
      throw new S3Failure(403, "AccessDenied", "missing or inconsistent x-amz-date");
    }
    const payloadHash = req.headers["x-amz-content-sha256"];
    if (typeof payloadHash !== "string") {
      throw new S3Failure(400, "InvalidRequest", "missing x-amz-content-sha256");
    }
    if (payloadHash !== UNSIGNED_PAYLOAD && payloadHash !== sha256Hex(body)) {
      throw new S3Failure(400, "XAmzContentSHA256Mismatch", "the body does not match its hash");
    }
    const signedHeaders = signedHeaderList.split(";");
    for (const required of ["host", "x-amz-date", "x-amz-content-sha256"]) {
      if (!signedHeaders.includes(required)) {
        throw new S3Failure(403, "AccessDenied", `${required} must be signed`);
      }
    }
    const canonicalHeaders = signedHeaders
      .map((name) => {
        const value = req.headers[name];
        const text = Array.isArray(value) ? value.join(",") : (value ?? "");
        return `${name}:${text.trim().replace(/\s+/g, " ")}\n`;
      })
      .join("");
    const canonical = [
      req.method ?? "GET",
      rawPath,
      canonicalQueryString(rawQuery),
      canonicalHeaders,
      signedHeaderList,
      payloadHash,
    ].join("\n");
    const date = new Date(
      `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
    );
    const scope = { region: this.region, service: "s3" };
    const expected = signature(this.credentials, date, scope, canonical);
    if (expected !== presented) {
      throw new S3Failure(403, "SignatureDoesNotMatch", `${ALGORITHM} signature does not match`);
    }
  }

  private injectedFailure(operation: string): void {
    const index = this.failures.findIndex((entry) => entry.operation === operation);
    if (index < 0) return;
    const entry = this.failures[index];
    if (!entry) return;
    entry.remaining--;
    if (entry.remaining <= 0) this.failures.splice(index, 1);
    throw new S3Failure(entry.failure.status, entry.failure.code, entry.failure.message ?? "injected failure");
  }

  private requireObject(key: string): StoredObject {
    const object = this.objects.get(key);
    if (!object) throw new S3Failure(404, "NoSuchKey", "The specified key does not exist.", key);
    return object;
  }

  private requireUpload(uploadId: string | undefined): PendingUpload {
    const upload = uploadId === undefined ? undefined : this.uploads.get(uploadId);
    if (!upload) throw new S3Failure(404, "NoSuchUpload", "The specified upload does not exist.");
    return upload;
  }

  private async dispatch(
    operation: string,
    key: string | null,
    query: Record<string, string>,
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    if (key === null) {
      if (operation === "ListObjectsV2") return this.listObjects(query, res);
      if (operation === "ListMultipartUploads") return this.listUploads(query, res);
      throw new S3Failure(405, "MethodNotAllowed", "unsupported bucket operation");
    }
    switch (operation) {
      case "PutObject": {
        if (req.headers["content-length"] === undefined) {
          throw new S3Failure(411, "MissingContentLength", "You must provide the Content-Length HTTP header.");
        }
        const contentType = req.headers["content-type"] ?? "binary/octet-stream";
        this.putObject(key, body, contentType);
        res.writeHead(200, { etag: this.requireObject(key).etag });
        res.end();
        return;
      }
      case "GetObject":
        return this.getObject(key, req, res);
      case "HeadObject": {
        const object = this.requireObject(key);
        res.writeHead(200, {
          "content-length": String(object.body.length),
          "content-type": object.contentType,
          etag: object.etag,
          "last-modified": object.lastModified.toUTCString(),
        });
        res.end();
        return;
      }
      case "DeleteObject":
        this.objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      case "CopyObject": {
        const header = String(req.headers["x-amz-copy-source"]);
        const [sourceBucket = "", ...rest] = decodeURIComponent(header.replace(/^\//, "")).split("/");
        if (sourceBucket !== this.bucket) throw new S3Failure(404, "NoSuchBucket", "no such source bucket");
        const source = this.requireObject(rest.join("/"));
        this.objects.set(key, { ...source, lastModified: new Date() });
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          xml(
            `<CopyObjectResult><LastModified>${new Date().toISOString()}</LastModified>` +
              `<ETag>${escapeXml(source.etag)}</ETag></CopyObjectResult>`,
          ),
        );
        return;
      }
      case "CreateMultipartUpload": {
        const uploadId = randomUUID();
        this.uploads.set(uploadId, { key, initiated: new Date(), parts: new Map() });
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          xml(
            `<InitiateMultipartUploadResult><Bucket>${this.bucket}</Bucket><Key>${escapeXml(key)}</Key>` +
              `<UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
          ),
        );
        return;
      }
      case "UploadPart": {
        const upload = this.requireUpload(query.uploadId);
        const partNumber = Number(query.partNumber);
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
          throw new S3Failure(400, "InvalidArgument", "Part number must be an integer between 1 and 10000");
        }
        const etag = md5Etag(body);
        upload.parts.set(partNumber, { body, etag });
        res.writeHead(200, { etag });
        res.end();
        return;
      }
      case "CompleteMultipartUpload":
        return this.completeUpload(key, query, body, res);
      case "AbortMultipartUpload":
        this.requireUpload(query.uploadId);
        this.uploads.delete(query.uploadId ?? "");
        res.writeHead(204);
        res.end();
        return;
      default:
        throw new S3Failure(405, "MethodNotAllowed", `unsupported operation ${operation}`);
    }
  }

  private getObject(key: string, req: IncomingMessage, res: ServerResponse): void {
    const object = this.requireObject(key);
    const total = object.body.length;
    const range = req.headers.range;
    if (range === undefined) {
      res.writeHead(200, {
        "content-length": String(total),
        "content-type": object.contentType,
        etag: object.etag,
        "accept-ranges": "bytes",
      });
      res.end(object.body);
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start: number;
    let end: number;
    if (!match || (match[1] === "" && match[2] === "")) {
      throw new S3Failure(416, "InvalidRange", "The requested range is not satisfiable");
    }
    if (match[1] === "") {
      const suffix = Number(match[2]);
      start = Math.max(total - suffix, 0);
      end = total - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
    }
    if (start >= total || start > end) {
      throw new S3Failure(416, "InvalidRange", "The requested range is not satisfiable");
    }
    res.writeHead(206, {
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${total}`,
      "content-type": object.contentType,
      etag: object.etag,
    });
    res.end(object.body.subarray(start, end + 1));
  }

  private listObjects(query: Record<string, string>, res: ServerResponse): void {
    const prefix = query.prefix ?? "";
    const delimiter = query.delimiter ?? "";
    const maxKeys = Math.min(Number(query["max-keys"] ?? "1000"), 1000);
    const after = query["continuation-token"]
      ? Buffer.from(query["continuation-token"], "base64url").toString("utf8")
      : (query["start-after"] ?? "");
    const contents: string[] = [];
    const prefixes: string[] = [];
    let lastReturned = "";
    let truncated = false;
    for (const key of [...this.objects.keys()].sort()) {
      if (!key.startsWith(prefix) || key <= after) continue;
      let entry = key;
      let isPrefix = false;
      if (delimiter !== "") {
        const cut = key.indexOf(delimiter, prefix.length);
        if (cut >= 0) {
          entry = key.slice(0, cut + delimiter.length);
          isPrefix = true;
        }
      }
      if (isPrefix && prefixes.includes(entry)) continue;
      if (after.startsWith(entry) && isPrefix) continue;
      if (contents.length + prefixes.length >= maxKeys) {
        truncated = true;
        break;
      }
      if (isPrefix) prefixes.push(entry);
      else contents.push(entry);
      // Continue after everything a common prefix rolls up.
      lastReturned = isPrefix ? `${entry}\uffff` : entry;
    }
    const items = contents
      .map((key) => {
        const object = this.objects.get(key);
        return (
          `<Contents><Key>${escapeXml(key)}</Key><Size>${object?.body.length ?? 0}</Size>` +
          `<ETag>${escapeXml(object?.etag ?? "")}</ETag></Contents>`
        );
      })
      .join("");
    const common = prefixes
      .map((entry) => `<CommonPrefixes><Prefix>${escapeXml(entry)}</Prefix></CommonPrefixes>`)
      .join("");
    const token = truncated
      ? `<NextContinuationToken>${Buffer.from(lastReturned, "utf8").toString("base64url")}</NextContinuationToken>`
      : "";
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(
      xml(
        `<ListBucketResult><Name>${this.bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix>` +
          `<KeyCount>${contents.length + prefixes.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>` +
          `<IsTruncated>${truncated}</IsTruncated>${token}${items}${common}</ListBucketResult>`,
      ),
    );
  }

  private listUploads(query: Record<string, string>, res: ServerResponse): void {
    const prefix = query.prefix ?? "";
    const uploads = [...this.uploads.entries()]
      .filter(([, upload]) => upload.key.startsWith(prefix))
      .sort(([, a], [, b]) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(
        ([uploadId, upload]) =>
          `<Upload><Key>${escapeXml(upload.key)}</Key><UploadId>${uploadId}</UploadId>` +
          `<Initiated>${upload.initiated.toISOString()}</Initiated></Upload>`,
      )
      .join("");
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(
      xml(
        `<ListMultipartUploadsResult><Bucket>${this.bucket}</Bucket><Prefix>${escapeXml(prefix)}</Prefix>` +
          `<IsTruncated>false</IsTruncated>${uploads}</ListMultipartUploadsResult>`,
      ),
    );
  }

  private completeUpload(
    key: string,
    query: Record<string, string>,
    body: Buffer,
    res: ServerResponse,
  ): void {
    const upload = this.requireUpload(query.uploadId);
    if (upload.key !== key) throw new S3Failure(404, "NoSuchUpload", "the upload belongs to another key");
    let document;
    try {
      document = parseXml(body.toString("utf8"));
    } catch {
      throw new S3Failure(400, "MalformedXML", "The XML you provided was not well-formed");
    }
    const listed = childElements(document, "Part").map((part) => ({
      number: Number(childText(part, "PartNumber")),
      etag: childText(part, "ETag") ?? "",
    }));
    if (listed.length === 0) throw new S3Failure(400, "MalformedXML", "no parts listed");
    const bodies: Buffer[] = [];
    const md5s: Buffer[] = [];
    listed.forEach((entry, index) => {
      const previous = listed[index - 1];
      if (previous && previous.number >= entry.number) {
        throw new S3Failure(400, "InvalidPartOrder", "The list of parts was not in ascending order.");
      }
      const part = upload.parts.get(entry.number);
      if (!part || part.etag !== entry.etag) {
        throw new S3Failure(400, "InvalidPart", `part ${entry.number} was not uploaded or its ETag differs`);
      }
      if (index < listed.length - 1 && part.body.length < this.minPartSize) {
        throw new S3Failure(400, "EntityTooSmall", "Your proposed upload is smaller than the minimum allowed object size.");
      }
      bodies.push(part.body);
      md5s.push(Buffer.from(part.etag.replace(/"/g, ""), "hex"));
    });
    const object = Buffer.concat(bodies);
    const etag = `"${createHash("md5").update(Buffer.concat(md5s)).digest("hex")}-${listed.length}"`;
    this.objects.set(key, {
      body: object,
      contentType: "application/octet-stream",
      etag,
      lastModified: new Date(),
    });
    this.uploads.delete(query.uploadId ?? "");
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(
      xml(
        `<CompleteMultipartUploadResult><Bucket>${this.bucket}</Bucket><Key>${escapeXml(key)}</Key>` +
          `<ETag>${escapeXml(etag)}</ETag></CompleteMultipartUploadResult>`,
      ),
    );
  }
}
