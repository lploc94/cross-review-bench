/** A resumable upload: chunks are appended at `offset` until it reaches `size`, then completed. */
export const UPLOAD_SESSION_STATES = ["open", "completed", "aborted", "expired"] as const;

export type UploadSessionState = (typeof UPLOAD_SESSION_STATES)[number];

export interface UploadSession {
  readonly id: string;
  readonly tenantId: string;
  readonly path: string;
  readonly size: number;
  readonly declaredType: string | null;
  readonly originalName: string;
  readonly overwrite: boolean;
  readonly offset: number;
  readonly partCount: number;
  readonly state: UploadSessionState;
  readonly chunkToken: string | null;
  readonly chunkLeaseExpiresAt: Date | null;
  readonly fileId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
}

/** The state a client should see: an open session past its expiry is expired, swept or not. */
export function effectiveState(session: UploadSession, now: Date): UploadSessionState {
  if (session.state === "open" && session.expiresAt.getTime() <= now.getTime()) return "expired";
  return session.state;
}

/** Whether another request is writing a chunk right now. */
export function hasActiveChunk(session: UploadSession, now: Date): boolean {
  return (
    session.chunkToken !== null &&
    session.chunkLeaseExpiresAt !== null &&
    session.chunkLeaseExpiresAt.getTime() > now.getTime()
  );
}

/** Bytes the session still expects. */
export function remainingBytes(session: UploadSession): number {
  return session.size - session.offset;
}
