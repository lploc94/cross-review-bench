/**
 * A stored file. `contentType` is what the bytes were sniffed as; `declaredType` is what the
 * uploader claimed and is kept for reference only.
 */
export const FILE_STATUSES = ["pending_scan", "available", "quarantined", "deleted"] as const;

export type FileStatus = (typeof FILE_STATUSES)[number];

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export interface FileRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly declaredType: string | null;
  readonly originalName: string;
  readonly storageDriver: string;
  readonly storageKey: string;
  readonly status: FileStatus;
  readonly image: ImageDimensions | null;
  readonly scanAttempts: number;
  readonly nextScanAt: Date | null;
  readonly scannedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly objectDeletedAt: Date | null;
}

/** Only scanned, clean files are served. */
export function isDownloadable(file: Pick<FileRecord, "status">): boolean {
  return file.status === "available";
}

/** The strong entity tag of a file's bytes: its sha256 in quotes. */
export function etagOf(file: Pick<FileRecord, "sha256">): string {
  return `"${file.sha256}"`;
}

/**
 * Whether an `If-None-Match` header value matches `etag`: `*`, or a comma-separated list of
 * entity tags compared weakly (a `W/` prefix is ignored), as RFC 9110 prescribes for this header.
 */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  return trimmed
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === etag);
}
