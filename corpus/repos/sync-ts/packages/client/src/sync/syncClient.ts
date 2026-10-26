import {
  DEFAULT_MAX_DRIFT_MS,
  EMPTY_DOC_STATE,
  Hlc,
  MutationValidationError,
  SyncError,
  cryptoRandom,
  fieldWritesOf,
  formatHlc,
  isCollectionName,
  isDocId,
  isValidNodeId,
  mergeWrites,
  randomNodeId,
  randomUuid,
  validateFieldWrites,
  type CollectionName,
  type FieldsOf,
  type Mutation,
  type PhysicalClock,
  type RandomSource,
} from "@sync/shared";
import { openDatabase, type SqliteDatabase } from "../store/database.js";
import { DocsStore, type StoredDoc } from "../store/docsStore.js";
import { MetaStore } from "../store/metaStore.js";
import { migrate } from "../store/migrator.js";
import { OutboxStore } from "../store/outboxStore.js";
import type { SyncTransport } from "../transport/transport.js";
import { ChangeEmitter, rethrowLater, type ChangeListener, type DocumentChange } from "./changes.js";
import { pullChanges } from "./pullPhase.js";
import { pushOutbox } from "./pushPhase.js";
import { SingleFlight } from "./singleFlight.js";
import { SyncStateTracker, type SyncState, type SyncStateListener } from "./syncState.js";

/** Mutations sent in one push request. */
export const PUSH_BATCH = 100;
/** Events asked for in one pull request. */
export const PULL_LIMIT = 500;

export interface SyncClientOptions {
  /** SQLite file of the local replica, or `:memory:`. */
  readonly dbPath: string;
  readonly transport: SyncTransport;
  /** Physical time of the replica's hybrid logical clock (`systemClock` in applications). */
  readonly clock: PhysicalClock;
  /**
   * This replica's HLC node id. Chosen at random and stored when the database is created; when
   * given, it must match the stored one.
   */
  readonly nodeId?: string;
  /** Source of node ids and mutation ids; crypto randomness by default. */
  readonly random?: RandomSource;
  /** How far ahead of the local clock a remote timestamp may be. */
  readonly maxDriftMs?: number;
  /** Mutations per push request, 1 to 500 (the server's default maximum). */
  readonly pushBatchSize?: number;
  /** Events per pull request, 1 to 1000 (the server's default maximum). */
  readonly pullLimit?: number;
  /** Receives errors thrown by change listeners; by default they are rethrown asynchronously. */
  readonly onListenerError?: (err: unknown) => void;
}

export interface TypedDocument<C extends CollectionName> {
  readonly collection: C;
  readonly id: string;
  readonly fields: FieldsOf<C>;
}

export interface SyncResult {
  /** Local mutations the server acknowledged. */
  readonly pushed: number;
  /** Remote events received. */
  readonly pulled: number;
  /** Remote field writes that replaced a local value. */
  readonly applied: number;
}

/** The client was closed; it cannot read, write or sync any more. */
export class ClientClosedError extends SyncError {
  constructor() {
    super("client_closed", "the sync client is closed");
  }
}

function checkRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}, got ${value}`);
  }
  return value;
}

interface ClientParts {
  readonly db: SqliteDatabase;
  readonly docs: DocsStore;
  readonly outbox: OutboxStore;
  readonly meta: MetaStore;
  readonly hlc: Hlc;
  readonly transport: SyncTransport;
  readonly random: RandomSource;
  readonly pushBatchSize: number;
  readonly pullLimit: number;
  readonly emitter: ChangeEmitter;
  readonly syncState: SyncStateTracker;
  readonly clock: PhysicalClock;
}

/** One write of `setMany`. */
export interface LocalWrite<C extends CollectionName = CollectionName> {
  readonly collection: C;
  readonly id: string;
  readonly fields: FieldsOf<C>;
}

/** A page of `list`. */
export interface ListPage {
  readonly limit: number;
  /** The last id of the previous page; omit for the first page. */
  readonly afterId?: string;
}

/** Validate a local write; returns the parsed field values. */
function checkLocalWrite(write: LocalWrite): Record<string, unknown> {
  if (!isCollectionName(write.collection)) {
    throw new MutationValidationError(`unknown collection ${JSON.stringify(write.collection)}`, [
      { field: "", message: "unknown collection" },
    ]);
  }
  if (!isDocId(write.id)) {
    throw new MutationValidationError(`invalid document id ${JSON.stringify(write.id)}`, [
      { field: "", message: "document ids are 1 to 64 letters, digits, '_' or '-'" },
    ]);
  }
  return validateFieldWrites(write.collection, write.fields);
}

/**
 * An offline-first replica. Writes apply locally at once and wait in the outbox; `sync()` pushes
 * the outbox to the server and pulls everything other devices wrote, merging field by field with
 * last-writer-wins on hybrid logical clock timestamps.
 */
export class SyncClient {
  readonly nodeId: string;
  private readonly parts: ClientParts;
  private readonly flight = new SingleFlight<SyncResult>();
  private closed = false;

  private constructor(parts: ClientParts) {
    this.parts = parts;
    this.nodeId = parts.hlc.node;
  }

  /** Open the replica at `dbPath`, creating or migrating its schema. */
  static open(options: SyncClientOptions): SyncClient {
    const pushBatchSize = checkRange("pushBatchSize", options.pushBatchSize ?? PUSH_BATCH, 1, 500);
    const pullLimit = checkRange("pullLimit", options.pullLimit ?? PULL_LIMIT, 1, 1_000);
    if (options.nodeId !== undefined && !isValidNodeId(options.nodeId)) {
      throw new RangeError(`invalid node id ${JSON.stringify(options.nodeId)}`);
    }
    const random = options.random ?? cryptoRandom;
    const onListenerError = options.onListenerError ?? rethrowLater;
    const db = openDatabase(options.dbPath);
    try {
      migrate(db);
      const meta = new MetaStore(db);
      const node = db.transaction(() => {
        const stored = meta.nodeId();
        if (stored !== null && options.nodeId !== undefined && stored !== options.nodeId) {
          throw new SyncError(
            "node_id_mismatch",
            `this database belongs to node ${stored}, not ${options.nodeId}`,
          );
        }
        const nodeId = stored ?? options.nodeId ?? randomNodeId(random);
        if (stored === null) meta.setNodeId(nodeId);
        return nodeId;
      }).immediate();
      const hlc = new Hlc({ node, clock: options.clock, maxDriftMs: options.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS });
      // The next timestamp is greater than both the stored one and the physical clock.
      const lastHlc = meta.lastHlc();
      if (lastHlc) hlc.restore(lastHlc);
      return new SyncClient({
        db,
        docs: new DocsStore(db),
        outbox: new OutboxStore(db),
        meta,
        hlc,
        transport: options.transport,
        random,
        pushBatchSize,
        pullLimit,
        emitter: new ChangeEmitter(onListenerError),
        syncState: new SyncStateTracker(onListenerError),
        clock: options.clock,
      });
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /**
   * Set fields of a document (creating it if needed): applied to the replica and queued for the
   * server in one transaction. Throws a MutationValidationError for an unknown collection or
   * field, an invalid id or a value of the wrong type.
   */
  set<C extends CollectionName>(collection: C, id: string, fields: FieldsOf<C>): Mutation {
    const [mutation] = this.setMany([{ collection, id, fields }]);
    if (!mutation) throw new Error("setMany returned no mutation");
    return mutation;
  }

  /**
   * Several `set`s in one transaction: every write is validated first, then all are applied and
   * queued together, each as its own mutation in the given order, or none is.
   */
  setMany(writes: readonly LocalWrite[]): Mutation[] {
    this.assertOpen();
    const checked = writes.map((write) => ({ ...write, fields: checkLocalWrite(write) }));
    const { db, docs, outbox, meta, hlc, random } = this.parts;
    const results = db.transaction(() =>
      checked.map((write) => {
        const ts = hlc.now();
        const mutation: Mutation = {
          mutationId: randomUuid(random),
          collection: write.collection,
          docId: write.id,
          op: "set",
          fields: write.fields,
          hlc: formatHlc(ts),
        };
        const merged = mergeWrites(docs.get(write.collection, write.id) ?? EMPTY_DOC_STATE, fieldWritesOf(mutation));
        docs.put(write.collection, write.id, merged.state);
        outbox.append(mutation);
        meta.setLastHlc(ts);
        const change: DocumentChange = {
          collection: write.collection,
          id: write.id,
          fields: merged.state.fields,
          changedFields: merged.applied.map((w) => w.field),
          source: "local",
        };
        return { mutation, change };
      }),
    )();
    this.parts.emitter.emit(results.map((r) => r.change));
    return results.map((r) => r.mutation);
  }

  get<C extends CollectionName>(collection: C, id: string): TypedDocument<C> | null {
    this.assertOpen();
    const doc = this.parts.docs.get(collection, id);
    return doc ? toTyped(collection, doc) : null;
  }

  /**
   * The documents of the collection in id order: all of them, or one page of at most `limit`
   * documents with ids after `afterId`.
   */
  list<C extends CollectionName>(collection: C, page?: ListPage): TypedDocument<C>[] {
    this.assertOpen();
    const docs = page
      ? this.parts.docs.listPage(collection, page.afterId ?? null, checkRange("limit", page.limit, 1, 10_000))
      : this.parts.docs.list(collection);
    return docs.map((doc) => toTyped(collection, doc));
  }

  /** Local mutations not yet acknowledged by the server. */
  pendingCount(): number {
    this.assertOpen();
    return this.parts.outbox.count();
  }

  /** The pull cursor: the last server sequence number applied locally. */
  pullCursor(): number {
    this.assertOpen();
    return this.parts.meta.pullAfter();
  }

  /** Be told about every committed change, local or remote. Returns the unsubscribe function. */
  onChange(listener: ChangeListener): () => void {
    return this.parts.emitter.on(listener);
  }

  /** Whether a sync is running, when the last one succeeded, and how the last one failed. */
  syncState(): SyncState {
    return this.parts.syncState.current;
  }

  /** Be told whenever the sync state changes. Returns the unsubscribe function. */
  onSyncState(listener: SyncStateListener): () => void {
    return this.parts.syncState.on(listener);
  }

  /**
   * Push the outbox, then pull until the server has nothing more. While a sync runs, another
   * call returns the running sync's promise; writes made meanwhile may wait for the next sync.
   * A failure rejects with a SyncError whose `retryable` says whether calling `sync()` again
   * later can succeed; nothing acknowledged or applied before the failure is lost or repeated.
   */
  sync(): Promise<SyncResult> {
    if (this.closed) return Promise.reject(new ClientClosedError());
    return this.flight.run(() => this.runSync());
  }

  /** Close the replica, after the running sync (if any) has settled. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flight.current?.catch(() => undefined);
    this.parts.db.close();
  }

  private async runSync(): Promise<SyncResult> {
    const { syncState, clock } = this.parts;
    syncState.started();
    try {
      const result = await this.pushThenPull();
      syncState.succeeded(clock.now());
      return result;
    } catch (err) {
      syncState.failed(err, clock.now());
      throw err;
    }
  }

  private async pushThenPull(): Promise<SyncResult> {
    const { db, docs, outbox, meta, hlc, transport, emitter } = this.parts;
    const pushed = await pushOutbox({ db, outbox, meta, hlc, transport, batchSize: this.parts.pushBatchSize });
    const pulled = await pullChanges({
      db,
      docs,
      meta,
      hlc,
      transport,
      limit: this.parts.pullLimit,
      onChanges: (changes) => emitter.emit(changes),
    });
    return { pushed: pushed.pushed, pulled: pulled.pulled, applied: pulled.applied };
  }

  private assertOpen(): void {
    if (this.closed) throw new ClientClosedError();
  }
}

function toTyped<C extends CollectionName>(collection: C, doc: StoredDoc): TypedDocument<C> {
  return { collection, id: doc.id, fields: doc.fields as FieldsOf<C> };
}
