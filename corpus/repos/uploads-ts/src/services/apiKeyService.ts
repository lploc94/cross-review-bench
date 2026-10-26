import type { Pool } from "../db/pool.js";
import {
  generateApiKey,
  hashSecret,
  parseApiKey,
  secretHashesMatch,
  type ApiKeyRecord,
} from "../domain/apiKey.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";
import { partitionScopes } from "../domain/scopes.js";
import type { Clock } from "../infra/clock.js";
import * as apiKeys from "../repositories/apiKeyRepo.js";
import { isUniqueViolation } from "../repositories/mapping.js";
import * as tenants from "../repositories/tenantRepo.js";

/** Who is calling: established by the auth plugin for every authenticated request. */
export interface AuthContext {
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly scopes: readonly string[];
}

export interface IssuedApiKey {
  readonly key: ApiKeyRecord;
  /** The full `up_…` token. It is shown once; only its hash is stored. */
  readonly token: string;
}

// Compared against when the prefix is unknown, so a miss costs the same hash and compare as a hit.
const UNKNOWN_KEY_HASH = hashSecret("unknown api key");
const MAX_PREFIX_ATTEMPTS = 5;

export class ApiKeyService {
  private readonly pool: Pool;
  private readonly clock: Clock;

  constructor(deps: { pool: Pool; clock: Clock }) {
    this.pool = deps.pool;
    this.clock = deps.clock;
  }

  /** Resolve a bearer token to its tenant and scopes; null for unknown, wrong or revoked keys. */
  async authenticate(token: string): Promise<AuthContext | null> {
    const parsed = parseApiKey(token);
    if (!parsed) return null;
    const record = await apiKeys.findApiKeyByPrefix(this.pool, parsed.prefix);
    const presented = hashSecret(parsed.secret);
    const matches = secretHashesMatch(record?.secretHash ?? UNKNOWN_KEY_HASH, presented);
    if (!record || !matches || record.revokedAt !== null) return null;
    return { tenantId: record.tenantId, apiKeyId: record.id, scopes: record.scopes };
  }

  async issueKey(tenantId: string, name: string, scopes: readonly string[]): Promise<IssuedApiKey> {
    const { valid, unknown } = partitionScopes(scopes);
    if (unknown.length > 0) {
      throw new ValidationError(`unknown scopes: ${unknown.join(", ")}`, { unknown });
    }
    if (valid.length === 0) {
      throw new ValidationError("an API key needs at least one scope");
    }
    if (!(await tenants.findTenant(this.pool, tenantId))) {
      throw NotFoundError.resource("tenant", tenantId);
    }
    for (let attempt = 1; ; attempt++) {
      const generated = generateApiKey();
      try {
        const key = await apiKeys.insertApiKey(this.pool, {
          tenantId,
          name,
          prefix: generated.prefix,
          secretHash: generated.secretHash,
          scopes: valid,
          createdAt: this.clock.now(),
        });
        return { key, token: generated.token };
      } catch (err) {
        // A prefix collision is possible (36^8 prefixes); draw a new key and try again.
        if (!isUniqueViolation(err) || attempt >= MAX_PREFIX_ATTEMPTS) throw err;
      }
    }
  }

  listKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    return apiKeys.listApiKeys(this.pool, tenantId);
  }

  async revokeKey(tenantId: string, id: string): Promise<ApiKeyRecord> {
    const key = await apiKeys.revokeApiKey(this.pool, tenantId, id, this.clock.now());
    if (!key) throw NotFoundError.resource("api key", id);
    return key;
  }
}
