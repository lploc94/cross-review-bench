import type { CollectionName } from "@sync/shared";

/** A document that changed in the local replica, after the change was committed. */
export interface DocumentChange {
  readonly collection: CollectionName;
  readonly id: string;
  /** All fields of the document after the change. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** The fields this change set, sorted. */
  readonly changedFields: readonly string[];
  /** `local` for `set`, `remote` for writes pulled from the server. */
  readonly source: "local" | "remote";
}

export type ChangeListener = (change: DocumentChange) => void;

/** Default handling of a listener's error: rethrown on a later tick, outside the client's code. */
export function rethrowLater(err: unknown): void {
  queueMicrotask(() => {
    throw err;
  });
}

/**
 * Change notifications. Listeners run synchronously after the change is committed; one that
 * throws does not stop the others, and its error goes to `onListenerError` (by default it is
 * rethrown on a later tick, like an error in any other event handler).
 */
export class ChangeEmitter {
  private readonly listeners = new Set<ChangeListener>();
  private readonly onListenerError: (err: unknown) => void;

  constructor(onListenerError: (err: unknown) => void = rethrowLater) {
    this.onListenerError = onListenerError;
  }

  /** Subscribe; returns the function that unsubscribes. */
  on(listener: ChangeListener): () => void {
    // Wrapped so the same function subscribed twice is called twice and unsubscribed once.
    const entry: ChangeListener = (change) => listener(change);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  emit(changes: readonly DocumentChange[]): void {
    for (const change of changes) {
      for (const listener of [...this.listeners]) {
        try {
          listener(change);
        } catch (err) {
          this.onListenerError(err);
        }
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
