import type { Pool } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";
import { MAX_QUOTA_BYTES, type Tenant } from "../domain/tenant.js";
import type { Clock } from "../infra/clock.js";
import * as tenants from "../repositories/tenantRepo.js";

export class TenantService {
  private readonly pool: Pool;
  private readonly clock: Clock;

  constructor(deps: { pool: Pool; clock: Clock }) {
    this.pool = deps.pool;
    this.clock = deps.clock;
  }

  async createTenant(name: string, quotaBytes: number): Promise<Tenant> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw new ValidationError("a tenant name has 1 to 200 characters");
    }
    assertQuota(quotaBytes);
    return tenants.insertTenant(this.pool, {
      name: trimmed,
      quotaBytes,
      createdAt: this.clock.now(),
    });
  }

  async getTenant(id: string): Promise<Tenant> {
    const tenant = await tenants.findTenant(this.pool, id);
    if (!tenant) throw NotFoundError.resource("tenant", id);
    return tenant;
  }

  /**
   * Change the quota. Lowering it below the current usage is allowed: nothing is removed, but no
   * new bytes fit until usage drops under the quota again.
   */
  async setQuota(id: string, quotaBytes: number): Promise<Tenant> {
    assertQuota(quotaBytes);
    const tenant = await tenants.updateQuota(this.pool, id, quotaBytes);
    if (!tenant) throw NotFoundError.resource("tenant", id);
    return tenant;
  }
}

function assertQuota(quotaBytes: number): void {
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0 || quotaBytes > MAX_QUOTA_BYTES) {
    throw new ValidationError(`a quota is a whole number of bytes from 0 to ${MAX_QUOTA_BYTES}`);
  }
}
