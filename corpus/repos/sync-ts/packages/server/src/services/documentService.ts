import { isCollectionName } from "@sync/shared";
import type { Pool } from "../db/pool.js";
import type { AuthContext } from "../domain/accounts.js";
import { NotFoundError } from "../domain/errors.js";
import { findDocument, type StoredDocument } from "../repositories/documents.js";

/** Read access to the materialised documents of the caller's user. */
export class DocumentService {
  private readonly pool: Pool;

  constructor(deps: { pool: Pool }) {
    this.pool = deps.pool;
  }

  async get(auth: AuthContext, collection: string, docId: string): Promise<StoredDocument> {
    if (!isCollectionName(collection)) {
      throw new NotFoundError(`unknown collection ${collection}`, { collection });
    }
    const doc = await findDocument(this.pool, auth.userId, collection, docId);
    if (!doc) throw NotFoundError.resource("document", `${collection}/${docId}`);
    return doc;
  }
}
