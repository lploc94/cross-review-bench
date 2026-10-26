import { docKey, type DocState } from "@sync/shared";
import type { Queryable } from "../db/pool.js";
import { toRecord, toSafeInteger } from "./mapping.js";

export interface DocRef {
  readonly collection: string;
  readonly docId: string;
}

export interface StoredDocument extends DocState {
  readonly collection: string;
  readonly docId: string;
  readonly updatedSeq: number;
  readonly updatedAt: Date;
}

export interface DocumentWrite extends DocState {
  readonly collection: string;
  readonly docId: string;
  readonly updatedSeq: number;
}

interface DocumentRow {
  collection: string;
  doc_id: string;
  fields: unknown;
  field_hlcs: unknown;
  updated_seq: string;
  updated_at: Date;
}

function toDocument(row: DocumentRow): StoredDocument {
  return {
    collection: row.collection,
    docId: row.doc_id,
    fields: toRecord<unknown>(row.fields, "documents.fields"),
    fieldHlcs: toRecord<string>(row.field_hlcs, "documents.field_hlcs"),
    updatedSeq: toSafeInteger(row.updated_seq, "documents.updated_seq"),
    updatedAt: row.updated_at,
  };
}

const COLUMNS = "collection, doc_id, fields, field_hlcs, updated_seq, updated_at";

export async function findDocument(
  db: Queryable,
  userId: string,
  collection: string,
  docId: string,
): Promise<StoredDocument | null> {
  const result = await db.query<DocumentRow>(
    `SELECT ${COLUMNS} FROM documents WHERE user_id = $1 AND collection = $2 AND doc_id = $3`,
    [userId, collection, docId],
  );
  const row = result.rows[0];
  return row ? toDocument(row) : null;
}

/** The stored documents among `refs`, keyed by docKey(collection, docId). */
export async function loadDocuments(
  db: Queryable,
  userId: string,
  refs: readonly DocRef[],
): Promise<Map<string, StoredDocument>> {
  const found = new Map<string, StoredDocument>();
  if (refs.length === 0) return found;
  const result = await db.query<DocumentRow>(
    `SELECT ${COLUMNS}
       FROM documents
      WHERE user_id = $1
        AND (collection, doc_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
    [userId, refs.map((r) => r.collection), refs.map((r) => r.docId)],
  );
  for (const row of result.rows) {
    const doc = toDocument(row);
    found.set(docKey(doc.collection, doc.docId), doc);
  }
  return found;
}

/** Insert or replace the materialised state of documents; each document at most once. */
export async function saveDocuments(
  db: Queryable,
  userId: string,
  docs: readonly DocumentWrite[],
  updatedAt: Date,
): Promise<void> {
  if (docs.length === 0) return;
  await db.query(
    `INSERT INTO documents (user_id, collection, doc_id, fields, field_hlcs, updated_seq, updated_at)
     SELECT $1, d.collection, d.doc_id, d.fields::jsonb, d.field_hlcs::jsonb, d.updated_seq, $2
       FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[])
            AS d(collection, doc_id, fields, field_hlcs, updated_seq)
     ON CONFLICT (user_id, collection, doc_id) DO UPDATE
       SET fields = EXCLUDED.fields,
           field_hlcs = EXCLUDED.field_hlcs,
           updated_seq = EXCLUDED.updated_seq,
           updated_at = EXCLUDED.updated_at`,
    [
      userId,
      updatedAt,
      docs.map((d) => d.collection),
      docs.map((d) => d.docId),
      docs.map((d) => JSON.stringify(d.fields)),
      docs.map((d) => JSON.stringify(d.fieldHlcs)),
      docs.map((d) => d.updatedSeq),
    ],
  );
}

/**
 * One page of the user's documents in (collection, doc_id) order, starting after `after`
 * (null for the first page).
 */
export async function listDocumentsPage(
  db: Queryable,
  userId: string,
  after: DocRef | null,
  limit: number,
): Promise<StoredDocument[]> {
  const result = await db.query<DocumentRow>(
    `SELECT ${COLUMNS}
       FROM documents
      WHERE user_id = $1
        AND ($2::text IS NULL OR (collection, doc_id) > ($2::text, $3::text))
      ORDER BY collection, doc_id
      LIMIT $4`,
    [userId, after?.collection ?? null, after?.docId ?? null, limit],
  );
  return result.rows.map(toDocument);
}

/** Number of documents of the user, per collection. */
export async function countDocumentsByCollection(db: Queryable, userId: string): Promise<Map<string, number>> {
  const result = await db.query<{ collection: string; count: string }>(
    "SELECT collection, count(*) AS count FROM documents WHERE user_id = $1 GROUP BY collection ORDER BY collection",
    [userId],
  );
  return new Map(result.rows.map((row) => [row.collection, toSafeInteger(row.count, "count")]));
}
