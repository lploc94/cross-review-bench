import type { Queryable } from "../db/pool.js";

export interface MutationRecord {
  readonly mutationId: string;
  readonly collection: string;
  readonly docId: string;
  readonly hlc: string;
}

/**
 * Record mutations as received from the device and return the ids that were not recorded
 * before. A mutation already recorded (a retried push) is left alone. A concurrent transaction
 * inserting the same id makes this one wait for it, then skip the id.
 */
export async function claimMutations(
  db: Queryable,
  userId: string,
  deviceId: string,
  mutations: readonly MutationRecord[],
  receivedAt: Date,
): Promise<Set<string>> {
  if (mutations.length === 0) return new Set();
  const result = await db.query<{ mutation_id: string }>(
    `INSERT INTO mutations (user_id, mutation_id, device_id, collection, doc_id, hlc, received_at)
     SELECT $1, m.id, $2, m.collection, m.doc_id, m.hlc, $3
       FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[])
            WITH ORDINALITY AS m(id, collection, doc_id, hlc, ord)
      ORDER BY m.ord
     ON CONFLICT (user_id, mutation_id) DO NOTHING
     RETURNING mutation_id`,
    [
      userId,
      deviceId,
      receivedAt,
      mutations.map((m) => m.mutationId),
      mutations.map((m) => m.collection),
      mutations.map((m) => m.docId),
      mutations.map((m) => m.hlc),
    ],
  );
  return new Set(result.rows.map((row) => row.mutation_id));
}
