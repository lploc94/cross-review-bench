import type { PullRequest, PullResponse, PushRequest, PushResponse } from "@sync/shared";

/**
 * How a SyncClient reaches the server. Implementations throw a SyncError: NetworkError when the
 * request did not complete, HttpError for an error status, InvalidResponseError for an answer
 * that breaks the protocol.
 */
export interface SyncTransport {
  push(request: PushRequest): Promise<PushResponse>;
  pull(request: PullRequest): Promise<PullResponse>;
}
