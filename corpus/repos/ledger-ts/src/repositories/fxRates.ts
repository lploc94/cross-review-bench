import type { Queryable } from "../db/pool.js";
import { toCurrencyCode, type CurrencyCode } from "../domain/currency.js";
import type { FxRate } from "../domain/fx.js";
import { firstRow, requireRow, toBigInt } from "./mapping.js";

interface FxRateRow {
  base: string;
  quote: string;
  rate_scaled: string;
  effective_at: Date;
}

const COLUMNS = "base, quote, rate_scaled, effective_at";

function mapRate(row: FxRateRow): FxRate {
  return {
    base: toCurrencyCode(row.base),
    quote: toCurrencyCode(row.quote),
    rateScaled: toBigInt(row.rate_scaled),
    effectiveAt: row.effective_at,
  };
}

export interface NewFxRate {
  readonly tenantId: string;
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  readonly rateScaled: bigint;
  readonly effectiveAt: Date;
}

/**
 * Record a rate for a pair from `effectiveAt` on. Writing the same pair and instant again
 * replaces the rate, so a seed file can be loaded more than once.
 */
export async function upsertRate(db: Queryable, rate: NewFxRate): Promise<FxRate> {
  const result = await db.query<FxRateRow>(
    `INSERT INTO fx_rates (tenant_id, base, quote, rate_scaled, effective_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, base, quote, effective_at)
     DO UPDATE SET rate_scaled = EXCLUDED.rate_scaled
     RETURNING ${COLUMNS}`,
    [rate.tenantId, rate.base, rate.quote, rate.rateScaled, rate.effectiveAt],
  );
  return mapRate(requireRow(result.rows, "upsertRate"));
}

/** The rate in effect at `at`: the latest one whose effective_at is not after it. */
export async function findEffectiveRate(
  db: Queryable,
  tenantId: string,
  base: CurrencyCode,
  quote: CurrencyCode,
  at: Date,
): Promise<FxRate | null> {
  const result = await db.query<FxRateRow>(
    `SELECT ${COLUMNS} FROM fx_rates
     WHERE tenant_id = $1 AND base = $2 AND quote = $3 AND effective_at <= $4
     ORDER BY effective_at DESC
     LIMIT 1`,
    [tenantId, base, quote, at],
  );
  const row = firstRow(result.rows);
  return row ? mapRate(row) : null;
}
