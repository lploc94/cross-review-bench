import type { Pool } from "../db/pool.js";
import { ValidationError } from "../domain/errors.js";
import type { Tenant } from "../domain/tenant.js";
import type { Clock } from "../infra/clock.js";
import * as tenants from "../repositories/tenants.js";

export class TenantService {
  private readonly pool: Pool;
  private readonly clock: Clock;

  constructor(deps: { pool: Pool; clock: Clock }) {
    this.pool = deps.pool;
    this.clock = deps.clock;
  }

  async createTenant(name: string): Promise<Tenant> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw new ValidationError("tenant name must be 1 to 200 characters");
    }
    return tenants.insertTenant(this.pool, trimmed, this.clock.now());
  }
}
