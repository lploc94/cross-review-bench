import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 for S3 requests, header-based. Streamed bodies are signed as
 * `UNSIGNED-PAYLOAD` (the body is not hashed up front, so it can be sent as it arrives); small
 * bodies the client holds in memory carry their sha256.
 *
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */
export const ALGORITHM = "AWS4-HMAC-SHA256";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_PAYLOAD_HASH = sha256Hex("");

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SigningScope {
  readonly region: string;
  readonly service: string;
}

export interface RequestToSign {
  readonly method: string;
  /** The URL as it will be sent; its path must already be URI-encoded (see `encodeKeyPath`). */
  readonly url: URL;
  /** Headers to sign and send, besides host, x-amz-date and x-amz-content-sha256. */
  readonly headers: Readonly<Record<string, string>>;
  /** Hex sha256 of the body, or UNSIGNED_PAYLOAD. */
  readonly payloadHash: string;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 percent-encoding: everything but A–Z a–z 0–9 - _ . ~ is escaped. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** An object key as a URL path: each segment encoded, the slashes kept. */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

/** `20130524T000000Z` */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Query parameters encoded and sorted by name, then value, as SigV4 requires. */
export function canonicalQueryString(search: string): string {
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (query === "") return "";
  return query
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const equals = pair.indexOf("=");
      const name = equals < 0 ? pair : pair.slice(0, equals);
      const value = equals < 0 ? "" : pair.slice(equals + 1);
      return [encodeRfc3986(decodeQueryComponent(name)), encodeRfc3986(decodeQueryComponent(value))];
    })
    .sort(([nameA = "", valueA = ""], [nameB = "", valueB = ""]) =>
      nameA < nameB ? -1 : nameA > nameB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** Header values trimmed with inner runs of spaces collapsed. */
function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export interface CanonicalRequest {
  readonly canonical: string;
  readonly signedHeaders: string;
}

/** The canonical request over every header in `headers` (names are lowercased). */
export function canonicalRequest(
  method: string,
  url: URL,
  headers: Readonly<Record<string, string>>,
  payloadHash: string,
): CanonicalRequest {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), canonicalHeaderValue(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = entries.map(([name]) => name).join(";");
  const canonical = [
    method.toUpperCase(),
    url.pathname === "" ? "/" : url.pathname,
    canonicalQueryString(url.search),
    entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  return { canonical, signedHeaders };
}

export function credentialScope(date: Date, scope: SigningScope): string {
  return `${amzDate(date).slice(0, 8)}/${scope.region}/${scope.service}/aws4_request`;
}

export function signingKey(secretAccessKey: string, date: Date, scope: SigningScope): Buffer {
  const day = hmac(`AWS4${secretAccessKey}`, amzDate(date).slice(0, 8));
  const region = hmac(day, scope.region);
  const service = hmac(region, scope.service);
  return hmac(service, "aws4_request");
}

export function stringToSign(date: Date, scope: SigningScope, canonical: string): string {
  return [ALGORITHM, amzDate(date), credentialScope(date, scope), sha256Hex(canonical)].join("\n");
}

/** The signature of a canonical request, as hex. */
export function signature(
  credentials: Credentials,
  date: Date,
  scope: SigningScope,
  canonical: string,
): string {
  return createHmac("sha256", signingKey(credentials.secretAccessKey, date, scope))
    .update(stringToSign(date, scope, canonical), "utf8")
    .digest("hex");
}

/**
 * Sign a request: returns every header to send, including `authorization`, `host`, `x-amz-date`
 * and `x-amz-content-sha256`. All of them are signed.
 */
export function signRequest(
  request: RequestToSign,
  credentials: Credentials,
  scope: SigningScope,
  date: Date,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = value;
  }
  headers.host = request.url.host;
  headers["x-amz-date"] = amzDate(date);
  headers["x-amz-content-sha256"] = request.payloadHash;
  const { canonical, signedHeaders } = canonicalRequest(
    request.method,
    request.url,
    headers,
    request.payloadHash,
  );
  const sig = signature(credentials, date, scope, canonical);
  headers.authorization =
    `${ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope(date, scope)}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return headers;
}
