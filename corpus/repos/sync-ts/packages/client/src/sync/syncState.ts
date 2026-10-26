import { SyncError } from "@sync/shared";

export interface SyncOutcomeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** What an application shows about synchronisation: running, last success, last failure. */
export interface SyncState {
  readonly syncing: boolean;
  /** Physical time (epoch ms) of the end of the last successful sync. */
  readonly lastSyncedAt: number | null;
  /** The error of the last sync if it failed; cleared by the next success. */
  readonly lastError: (SyncOutcomeError & { readonly at: number }) | null;
}

export type SyncStateListener = (state: SyncState) => void;

export const INITIAL_SYNC_STATE: SyncState = Object.freeze({
  syncing: false,
  lastSyncedAt: null,
  lastError: null,
});

/** The SyncError fields of any failure; errors that are not SyncErrors count as not retryable. */
export function describeSyncError(err: unknown): SyncOutcomeError {
  if (err instanceof SyncError) return { code: err.code, message: err.message, retryable: err.retryable };
  return { code: "internal", message: err instanceof Error ? err.message : String(err), retryable: false };
}

/** Holds the SyncState and tells listeners about each change. */
export class SyncStateTracker {
  private state: SyncState = INITIAL_SYNC_STATE;
  private readonly listeners = new Set<SyncStateListener>();
  private readonly onListenerError: (err: unknown) => void;

  constructor(onListenerError: (err: unknown) => void) {
    this.onListenerError = onListenerError;
  }

  get current(): SyncState {
    return this.state;
  }

  on(listener: SyncStateListener): () => void {
    const entry: SyncStateListener = (state) => listener(state);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  started(): void {
    this.update({ ...this.state, syncing: true });
  }

  succeeded(at: number): void {
    this.update({ syncing: false, lastSyncedAt: at, lastError: null });
  }

  failed(err: unknown, at: number): void {
    this.update({ ...this.state, syncing: false, lastError: { ...describeSyncError(err), at } });
  }

  private update(next: SyncState): void {
    this.state = Object.freeze(next);
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state);
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }
}
